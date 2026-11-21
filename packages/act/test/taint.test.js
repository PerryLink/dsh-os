import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}

function setup(allow, config) {
  const ctx = fakeContext()
  if (allow !== undefined) ctx._services.set('allow', allow)
  const service = apply(ctx, config)
  return { ctx, service }
}

function workdir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-act-taint-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Records every capability and grants only `granted` (all when omitted). */
function recorder(granted, calls = []) {
  return {
    calls,
    async check(request) {
      calls.push(request.capability)
      return { granted: granted === undefined || granted.has(request.capability) }
    },
    async request(request) { return request },
  }
}

test('a normal write needs only the base capability, not the tainted one', async t => {
  const root = workdir(t)
  const file = join(root, 'normal.txt')
  const allow = recorder()
  const { service } = setup(allow, { workdir: root })

  const result = await service.invoke('fs.write', { path: file, text: 'plain' }, { subject: 'tester' })
  assert.equal(result.ok, true)
  assert.deepEqual(allow.calls, ['act:invoke:fs.write'])
  assert.equal(readFileSync(file, 'utf8'), 'plain')
})

test('meta.tainted requires a second :tainted Grant and never writes without it', async t => {
  const root = workdir(t)
  const file = join(root, 'tainted.txt')
  const allow = recorder(new Set(['act:invoke:fs.write']))
  const { service } = setup(allow, { workdir: root })

  const denied = await service.invoke('fs.write', { path: file, text: 'from clipboard' }, { subject: 'tester', tainted: true })
  assert.deepEqual(denied, {
    ok: false,
    code: 'grant_required',
    actionId: 'fs.write',
    capability: 'act:invoke:fs.write:tainted',
    tainted: true,
    hint: 'Call allow_request for capability "act:invoke:fs.write:tainted" with the target scope, then retry.',
  })
  assert.deepEqual(allow.calls, ['act:invoke:fs.write', 'act:invoke:fs.write:tainted'])
  assert.equal(existsSync(file), false)
})

test('both Grants let a tainted write execute; the checks are ordered base then tainted', async t => {
  const root = workdir(t)
  const file = join(root, 'allowed.txt')
  const allow = recorder()
  const { service } = setup(allow, { workdir: root })

  const result = await service.invoke('fs.write', { path: file, text: 'approved external text' }, { subject: 'tester', tainted: true })
  assert.equal(result.ok, true)
  assert.deepEqual(allow.calls, ['act:invoke:fs.write', 'act:invoke:fs.write:tainted'])
  assert.equal(readFileSync(file, 'utf8'), 'approved external text')
})

test('a taintToken raises the gate; a forged token cannot authorize or downgrade it', async t => {
  const root = workdir(t)
  const file = join(root, 'forged.txt')
  const allow = recorder(new Set(['act:invoke:fs.write']))
  const { service } = setup(allow, { workdir: root })

  const forged = await service.invoke('fs.write', { path: file, text: 'x' }, { subject: 'tester', taintToken: 'forged' })
  assert.equal(forged.code, 'grant_required')
  assert.equal(forged.capability, 'act:invoke:fs.write:tainted')
  assert.equal(forged.tainted, true)
  assert.equal(existsSync(file), false)

  // An empty token is treated as "no taint evidence", not as a token.
  const empty = await service.invoke('fs.write', { path: file, text: 'plain' }, { subject: 'tester', taintToken: '' })
  assert.equal(empty.ok, true)
  assert.deepEqual(allow.calls, [
    'act:invoke:fs.write', 'act:invoke:fs.write:tainted', 'act:invoke:fs.write',
  ])
})

test('act_invoke forwards tainted/taintToken and requires the extra Grant', async t => {
  const root = workdir(t)
  const file = join(root, 'tool.txt')
  const allow = recorder(new Set(['act:invoke:fs.write']))
  const { ctx } = setup(allow, { workdir: root })
  const exec = { agent: { session: { id: 's1' } } }
  const tool = ctx._tools.get('act_invoke')

  const denied = await tool.execute({ id: 'fs.write', args: { path: file, text: 'via tool' }, tainted: true }, exec)
  assert.equal(denied.code, 'grant_required')
  assert.equal(denied.capability, 'act:invoke:fs.write:tainted')
  assert.equal(existsSync(file), false)

  const tokenDenied = await tool.execute({ id: 'fs.write', args: { path: file, text: 'via token' }, taintToken: 'x' }, exec)
  assert.equal(tokenDenied.capability, 'act:invoke:fs.write:tainted')

  const full = recorder()
  const { ctx: ctx2 } = setup(full, { workdir: root })
  const written = await ctx2._tools.get('act_invoke').execute(
    { id: 'fs.write', args: { path: file, text: 'via both' }, tainted: true },
    exec,
  )
  assert.equal(written.ok, true)
  assert.deepEqual(full.calls, ['act:invoke:fs.write', 'act:invoke:fs.write:tainted'])
  assert.equal(readFileSync(file, 'utf8'), 'via both')
})

test('only write/danger actions get the taint gate; preview and reads stay open', async t => {
  const root = workdir(t)
  const file = join(root, 'preview.txt')
  const allow = recorder()
  const { service } = setup(allow, { workdir: root })

  const preview = await service.invoke('fs.write', { path: file, text: 'draft' }, { preview: true, tainted: true })
  assert.equal(preview.ok, true)
  assert.equal(existsSync(file), false)
  assert.deepEqual(allow.calls, [])

  const read = await service.invoke('echo', { text: 'data' }, { tainted: true })
  assert.equal(read.ok, true)
  assert.deepEqual(allow.calls, [])
})
