import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/dsh-os-mcp.js', import.meta.url))
const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'node-test', version: '1.0.0' },
}

function client(args = []) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const lines = []
  const parseErrors = []
  let buffer = ''
  let stderr = ''
  let nextId = 1
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      lines.push(line)
      try {
        const message = JSON.parse(line)
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      } catch (error) {
        parseErrors.push({ line, error })
      }
    }
  })
  return {
    lines,
    parseErrors,
    get stderr() { return stderr },
    request(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 5000)
        pending.set(id, message => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    raw(line) {
      child.stdin.write(`${line}\n`)
    },
    async close() {
      if (child.exitCode !== null) return
      child.stdin.end()
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          child.kill()
          resolve()
        }, 1000)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

async function open(t, args = [], protocolVersion = INIT.protocolVersion) {
  const c = client(args)
  t.after(async () => {
    try {
      for (const line of c.lines) {
        const message = JSON.parse(line)
        assert.equal(message.jsonrpc, '2.0')
        assert.ok('result' in message || 'error' in message)
      }
      assert.equal(c.parseErrors.length, 0)
    } finally {
      await c.close()
    }
  })
  const init = await c.request('initialize', { ...INIT, protocolVersion })
  c.notify('notifications/initialized')
  return { c, init }
}

test('initialize negotiates 2025-06-18 and never answers notifications', async t => {
  const { c, init } = await open(t)
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'dsh-os-mcp')
  assert.equal(init.result.serverInfo.version, '0.1.0')
  assert.deepEqual(init.result.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
  })
  await c.request('ping')
  const seen = c.lines.length
  c.notify('notifications/initialized')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(c.lines.length, seen)
  assert.equal(c.parseErrors.length, 0)
})

test('2025-03-26 negotiation omits structured-content fields', async t => {
  const { c, init } = await open(t, [], '2025-03-26')
  assert.equal(init.result.protocolVersion, '2025-03-26')
  const list = await c.request('tools/list')
  assert.equal(list.result.tools.every(tool => tool.outputSchema === undefined), true)
  const call = await c.request('tools/call', { name: 'os_status', arguments: {} })
  assert.equal(call.result.structuredContent, undefined)
  assert.equal(JSON.parse(call.result.content[0].text).ok, true)
})

test('tools/list exposes exactly the read-only surface', async t => {
  const { c } = await open(t)
  const list = await c.request('tools/list')
  assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), [
    'os_find', 'os_help', 'os_status', 'seek_search', 'snip_search', 'trace_search',
  ])
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.equal(tool.outputSchema.required[0], 'ok')
    assert.ok(tool.description.length > 20)
  }
  assert.equal(c.parseErrors.length, 0)
})

test('tools/call serves meta tools and built-in samples', async t => {
  const { c } = await open(t)
  const status = await c.request('tools/call', { name: 'os_status', arguments: {} })
  assert.equal(status.result.structuredContent.mode, 'read-only')
  assert.equal(status.result.structuredContent.connected, false)
  assert.deepEqual(status.result.structuredContent.counts, { meta: 3, capabilities: 3, tools: 6 })
  const found = await c.request('tools/call', { name: 'os_find', arguments: { intent: 'clipboard 剪贴板', k: 2 } })
  assert.equal(found.result.structuredContent.ok, true)
  assert.equal(found.result.structuredContent.matches[0].verb, 'snip_search')
  const seek = await c.request('tools/call', { name: 'os_find', arguments: { intent: 'evidence citation' } })
  assert.equal(seek.result.structuredContent.matches[0].verb, 'seek_search')
  const trace = await c.request('tools/call', { name: 'os_find', arguments: { intent: 'memory decision' } })
  assert.equal(trace.result.structuredContent.matches[0].verb, 'trace_search')
  const help = await c.request('tools/call', { name: 'os_help', arguments: { verb: 'seek_search' } })
  assert.match(help.result.structuredContent.doc, /seek_search/)
  const sample = await c.request('tools/call', { name: 'snip_search', arguments: { query: 'alpha', limit: 2 } })
  assert.equal(sample.result.structuredContent.sample, true)
  assert.equal(sample.result.structuredContent.data.query, 'alpha')
  assert.equal(sample.result.structuredContent.data.items.length, 1)
  assert.equal(c.parseErrors.length, 0)
})

test('invalid calls return JSON-RPC errors and the stream stays usable', async t => {
  const { c } = await open(t)
  const invalid = await c.request('tools/call', { name: 'snip_search', arguments: { query: 42 } })
  assert.equal(invalid.error.code, -32602)
  assert.equal(invalid.error.data.code, 'E_INVALID_ARGUMENT')
  const unknown = await c.request('tools/call', { name: 'nope', arguments: {} })
  assert.equal(unknown.error.code, -32602)
  const method = await c.request('no/such')
  assert.equal(method.error.code, -32601)
  c.raw('{not json')
  await c.request('ping')
  const parseError = c.lines.map(line => JSON.parse(line)).find(message => message.error?.code === -32700)
  assert.ok(parseError)
  assert.equal(c.parseErrors.length, 0)
})

test('resources/list and resources/read serve static documents', async t => {
  const { c } = await open(t)
  const list = await c.request('resources/list')
  assert.deepEqual(list.result.resources.map(resource => resource.uri), [
    'dsh-os://readme', 'dsh-os://catalog', 'dsh-os://approval',
  ])
  const catalog = await c.request('resources/read', { uri: 'dsh-os://catalog' })
  const parsed = JSON.parse(catalog.result.contents[0].text)
  assert.equal(parsed.capabilities.length, 3)
  assert.equal(parsed.allowWrite, false)
  const readme = await c.request('resources/read', { uri: 'dsh-os://readme' })
  assert.match(readme.result.contents[0].text, /read-only/i)
  const missing = await c.request('resources/read', { uri: 'dsh-os://missing' })
  assert.equal(missing.error.code, -32002)
  assert.equal(missing.error.data.code, 'E_NOT_FOUND')
})

test('--catalog replaces samples and hides write cards', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-os-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'catalog.json')
  writeFileSync(file, JSON.stringify({
    capabilities: [
      {
        tool: 'fs_read',
        title: 'Read a file',
        description: 'Read a local path from a custom catalog.',
        readOnly: true,
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
      },
      {
        tool: 'fs_write',
        title: 'Write a file',
        description: 'Write a local path from a custom catalog.',
        readOnly: false,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      },
    ],
  }))
  const readOnly = await open(t, ['--catalog', file])
  const list = await readOnly.c.request('tools/list')
  const names = list.result.tools.map(tool => tool.name)
  assert.ok(names.includes('fs_read'))
  assert.ok(!names.includes('fs_write'))
  assert.ok(!names.includes('snip_search'))
  const unbound = await readOnly.c.request('tools/call', { name: 'fs_read', arguments: { path: '/tmp/x' } })
  assert.equal(unbound.error.code, -32001)
  assert.equal(unbound.error.data.code, 'E_UNAVAILABLE')

  const writeMode = await open(t, ['--catalog', file, '--allow-write'])
  const writeList = await writeMode.c.request('tools/list')
  assert.equal(writeList.result.tools.find(tool => tool.name === 'fs_write').annotations.readOnlyHint, false)
  const denied = await writeMode.c.request('tools/call', { name: 'fs_write', arguments: { path: '/tmp/x' } })
  assert.equal(denied.error.code, -32003)
  assert.equal(denied.error.data.subcode, 'grant_required')
})

test('oversized request lines become JSON-RPC errors without killing stdin', async t => {
  const { c } = await open(t, ['--max-bytes', '1024'])
  c.raw(JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: { name: 'os_help', arguments: { topic: 'x'.repeat(4096) } },
  }))
  const pong = await c.request('ping')
  assert.deepEqual(pong.result, {})
  const error = c.lines.map(line => JSON.parse(line)).find(message => message.error?.code === -32600)
  assert.match(error.error.message, /exceeds 1024 bytes/)
  assert.equal(c.parseErrors.length, 0)
})

test('a broken catalog exits 2 and writes only to stderr', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-os-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'bad.json')
  writeFileSync(file, '{')
  const result = spawnSync(process.execPath, [BIN, '--catalog', file], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /invalid JSON/)
})
