import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function catalogDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-os-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeCatalog(dir) {
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
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
      },
    ],
  }))
  return file
}

async function call(c, name, args) {
  return c.request('tools/call', { name, arguments: args })
}

async function requestToken(c, capability, args) {
  const requested = await call(c, 'os_request', { capability, arguments: args })
  assert.equal(requested.result.structuredContent.status, 'pending')
  const requestId = requested.result.structuredContent.requestId
  assert.match(requestId, /^req_/)
  const approved = await call(c, 'os_approve', { requestId, adminToken: 'admin-secret' })
  assert.equal(approved.result.structuredContent.status, 'approved')
  const polled = await call(c, 'os_request', { requestId })
  assert.equal(polled.result.structuredContent.status, 'approved')
  assert.match(polled.result.structuredContent.approvalToken, /^dshat_/)
  return { requestId, token: polled.result.structuredContent.approvalToken }
}

test('initialize negotiates 2025-06-18 and never answers notifications', async t => {
  const { c, init } = await open(t)
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'dsh-os-mcp')
  assert.equal(init.result.serverInfo.version, '0.2.0')
  assert.deepEqual(init.result.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
  })
  const pong = await c.request('ping')
  assert.deepEqual(pong.result, {})
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

test('tools/list exposes exactly the read-only surface by default', async t => {
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
  const denied = await call(c, 'os_do', { capability: 'snip_search', arguments: { query: 'x' } })
  assert.equal(denied.error.code, -32602)
  assert.equal(c.parseErrors.length, 0)
})

test('tools/call serves meta tools and built-in samples', async t => {
  const { c } = await open(t)
  const status = await call(c, 'os_status', {})
  assert.equal(status.result.structuredContent.mode, 'read-only')
  assert.equal(status.result.structuredContent.connected, false)
  assert.deepEqual(status.result.structuredContent.counts, { meta: 3, capabilities: 3, tools: 6 })
  assert.equal(status.result.structuredContent.approval.enabled, false)
  assert.equal(status.result.structuredContent.approval.tokenTtlMs, 300000)
  const found = await call(c, 'os_find', { intent: 'clipboard 剪贴板', k: 2 })
  assert.equal(found.result.structuredContent.ok, true)
  assert.equal(found.result.structuredContent.matches[0].verb, 'snip_search')
  const seek = await call(c, 'os_find', { intent: 'evidence citation' })
  assert.equal(seek.result.structuredContent.matches[0].verb, 'seek_search')
  const trace = await call(c, 'os_find', { intent: 'memory decision' })
  assert.equal(trace.result.structuredContent.matches[0].verb, 'trace_search')
  const help = await call(c, 'os_help', { verb: 'seek_search' })
  assert.match(help.result.structuredContent.doc, /seek_search/)
  const sample = await call(c, 'snip_search', { query: 'alpha', limit: 2 })
  assert.equal(sample.result.structuredContent.sample, true)
  assert.equal(sample.result.structuredContent.data.query, 'alpha')
  assert.equal(sample.result.structuredContent.data.items.length, 1)
  assert.equal(c.parseErrors.length, 0)
})

test('invalid calls return JSON-RPC errors and the stream stays usable', async t => {
  const { c } = await open(t)
  const invalid = await call(c, 'snip_search', { query: 42 })
  assert.equal(invalid.error.code, -32602)
  assert.equal(invalid.error.data.code, 'E_INVALID_ARGUMENT')
  const unknown = await call(c, 'nope', {})
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

test('--catalog replaces samples and hides write cards while read-only', async t => {
  const file = writeCatalog(catalogDir(t))
  const readOnly = await open(t, ['--catalog', file])
  const list = await readOnly.c.request('tools/list')
  const names = list.result.tools.map(tool => tool.name)
  assert.ok(names.includes('fs_read'))
  assert.ok(!names.includes('fs_write'))
  assert.ok(!names.includes('os_do'))
  assert.ok(!names.includes('snip_search'))
  const unbound = await call(readOnly.c, 'fs_read', { path: '/tmp/x' })
  assert.equal(unbound.error.code, -32001)
  assert.equal(unbound.error.data.code, 'E_UNAVAILABLE')
})

test('--allow-write exposes os_do/os_request and write cards, os_approve only with an admin token', async t => {
  const file = writeCatalog(catalogDir(t))
  const writeMode = await open(t, ['--catalog', file, '--allow-write'])
  const writeList = await writeMode.c.request('tools/list')
  const names = writeList.result.tools.map(tool => tool.name)
  assert.ok(names.includes('fs_write'))
  assert.ok(names.includes('os_do'))
  assert.ok(names.includes('os_request'))
  assert.ok(!names.includes('os_approve'))
  assert.equal(writeList.result.tools.find(tool => tool.name === 'fs_write').annotations.readOnlyHint, false)
  const denied = await call(writeMode.c, 'fs_write', { path: '/tmp/x' })
  assert.equal(denied.error.code, -32003)
  assert.equal(denied.error.data.subcode, 'grant_required')
  assert.equal(denied.error.data.nextTools[0].capability, 'os_request')
  assert.deepEqual(denied.error.data.nextTools[0].args, { capability: 'fs_write', arguments: { path: '/tmp/x' } })

  const adminMode = await open(t, ['--catalog', file, '--allow-write', '--admin-token', 'admin-secret'])
  const adminList = await adminMode.c.request('tools/list')
  assert.ok(adminList.result.tools.map(tool => tool.name).includes('os_approve'))
})

test('write calls without a token fail with -32003 and data.nextTools', async t => {
  const file = writeCatalog(catalogDir(t))
  const { c } = await open(t, ['--catalog', file, '--allow-write'])
  const denied = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/x' } })
  assert.equal(denied.error.code, -32003)
  assert.equal(denied.error.data.code, 'E_DENIED')
  assert.equal(denied.error.data.subcode, 'grant_required')
  assert.equal(denied.error.data.tool, 'fs_write')
  assert.deepEqual(denied.error.data.nextTools[0].args, { capability: 'fs_write', arguments: { path: '/tmp/x' } })
  const bogus = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/x' }, approvalToken: 'dshat_bogus' })
  assert.equal(bogus.error.code, -32003)
  assert.equal(bogus.error.data.subcode, 'token_invalid')
})

test('approved token executes once, is bound to args, and replay is rejected', async t => {
  const file = writeCatalog(catalogDir(t))
  const { c } = await open(t, ['--catalog', file, '--allow-write', '--admin-token', 'admin-secret'])
  const pending = await call(c, 'os_request', { capability: 'fs_write', arguments: { path: '/tmp/a' }, reason: 'test' })
  const { requestId, approvalToken } = pending.result.structuredContent
  assert.equal(approvalToken, undefined)
  const wrong = await call(c, 'os_approve', { requestId, adminToken: 'wrong' })
  assert.equal(wrong.error.code, -32003)
  assert.equal(wrong.error.data.subcode, 'admin_required')
  const approved = await call(c, 'os_approve', { requestId, adminToken: 'admin-secret' })
  assert.equal(approved.result.structuredContent.status, 'approved')
  assert.equal(approved.result.structuredContent.approvalToken, undefined)
  const polled = await call(c, 'os_request', { requestId })
  const token = polled.result.structuredContent.approvalToken
  assert.match(token, /^dshat_/)
  assert.ok(polled.result.structuredContent.tokenExpiresAt > Date.now())
  assert.equal(polled.result.structuredContent.nextTools[0].capability, 'os_do')

  const executed = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/a' }, approvalToken: token })
  assert.equal(executed.result.structuredContent.ok, true)
  assert.equal(executed.result.structuredContent.status, 'authorized')
  assert.equal(executed.result.structuredContent.simulated, true)
  assert.equal(executed.result.structuredContent.requestId, requestId)
  assert.equal(executed.result.structuredContent.handles[0], `dsh://requests/${requestId}`)

  const replay = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/a' }, approvalToken: token })
  assert.equal(replay.error.code, -32003)
  assert.equal(replay.error.data.subcode, 'token_used')
  assert.equal(replay.error.data.nextTools[0].capability, 'os_request')

  const second = await requestToken(c, 'fs_write', { path: '/tmp/a' })
  assert.notEqual(second.token, token)
  const mismatch = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/b' }, approvalToken: second.token })
  assert.equal(mismatch.error.code, -32003)
  assert.equal(mismatch.error.data.subcode, 'token_mismatch')
  const stillValid = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/a' }, approvalToken: second.token })
  assert.equal(stillValid.result.structuredContent.ok, true)
})

test('--approve CLI approves a file-backed request for a running server', async t => {
  const dir = catalogDir(t)
  const file = writeCatalog(dir)
  const store = join(dir, 'requests.json')
  const { c } = await open(t, ['--catalog', file, '--allow-write', '--request-store', store])
  const requested = await call(c, 'os_request', { capability: 'fs_write', arguments: { path: '/tmp/cli' } })
  const requestId = requested.result.structuredContent.requestId
  assert.equal(requested.result.structuredContent.status, 'pending')
  assert.match(readFileSync(store, 'utf8'), new RegExp(requestId))
  const approved = spawnSync(process.execPath, [BIN, '--approve', requestId, '--request-store', store], { encoding: 'utf8' })
  assert.equal(approved.status, 0, approved.stderr)
  const parsed = JSON.parse(approved.stdout)
  assert.equal(parsed.status, 'approved')
  assert.equal(parsed.requestId, requestId)
  assert.equal(parsed.approvalToken, undefined)
  const polled = await call(c, 'os_request', { requestId })
  assert.equal(polled.result.structuredContent.status, 'approved')
  assert.ok(polled.result.structuredContent.tokenExpiresAt > Date.now())
  const token = polled.result.structuredContent.approvalToken
  assert.match(token, /^dshat_/)
  const executed = await call(c, 'os_do', { capability: 'fs_write', arguments: { path: '/tmp/cli' }, approvalToken: token })
  assert.equal(executed.result.structuredContent.ok, true)
})

test('resources/read serves dsh:// request handles without secrets', async t => {
  const file = writeCatalog(catalogDir(t))
  const { c } = await open(t, ['--catalog', file, '--allow-write', '--admin-token', 'admin-secret'])
  const requested = await call(c, 'os_request', { capability: 'fs_write', arguments: { path: '/tmp/handle' } })
  const requestId = requested.result.structuredContent.requestId
  const handle = requested.result.structuredContent.handles[0]
  assert.equal(handle, `dsh://requests/${requestId}`)
  const read = await c.request('resources/read', { uri: handle })
  const record = JSON.parse(read.result.contents[0].text)
  assert.equal(record.requestId, requestId)
  assert.equal(record.status, 'pending')
  assert.equal(record.approvalToken, undefined)
  assert.equal(record.tokenHash, undefined)
  const missing = await c.request('resources/read', { uri: 'dsh://requests/req_missing' })
  assert.equal(missing.error.code, -32002)
  const unknown = await c.request('resources/read', { uri: 'dsh://nope/1' })
  assert.equal(unknown.error.code, -32002)
  const listed = await c.request('resources/list')
  assert.ok(listed.result.resources.some(resource => resource.uri === handle))
})

test('resources/read never returns more than 32 KiB', async t => {
  const dir = catalogDir(t)
  const file = join(dir, 'big.json')
  const capabilities = Array.from({ length: 64 }, (_, index) => ({
    tool: `bulk_${index}`,
    title: `Bulk capability ${index}`,
    description: `Bulk capability ${index} with a long description. ${'x'.repeat(900)}`,
    readOnly: true,
    keywords: Array.from({ length: 16 }, (_, keyword) => `keyword-${index}-${keyword}-${'y'.repeat(80)}`),
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }))
  writeFileSync(file, JSON.stringify({ capabilities }))
  const { c } = await open(t, ['--catalog', file])
  const read = await c.request('resources/read', { uri: 'dsh-os://catalog' })
  const text = read.result.contents[0].text
  assert.ok(Buffer.byteLength(text) <= 32 * 1024, `resource is ${Buffer.byteLength(text)} bytes`)
  assert.match(text, /\[truncated at 32768 bytes\]/)
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
  const file = join(catalogDir(t), 'bad.json')
  writeFileSync(file, '{')
  const result = spawnSync(process.execPath, [BIN, '--catalog', file], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /invalid JSON/)
})

test('startup flags are validated and metadata versions agree', async () => {
  const noAllow = spawnSync(process.execPath, [BIN, '--admin-token', 'secret'], { encoding: 'utf8' })
  assert.equal(noAllow.status, 2)
  assert.match(noAllow.stderr, /requires --allow-write/)
  const noStore = spawnSync(process.execPath, [BIN, '--approve', 'req_x'], { encoding: 'utf8' })
  assert.equal(noStore.status, 2)
  assert.match(noStore.stderr, /requires --request-store/)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.2.0')
  const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })
  assert.equal(version.stdout.trim(), '0.2.0')
})
