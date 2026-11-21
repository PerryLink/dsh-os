import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply as mountAllow } from '../../allow/index.js'
import { apply } from '../index.js'
import { TAINT_TTL_MS, TaintRegistry, sha256 } from '../lib/taint.js'

const CLIP = 'text copied from the clipboard'
const EVIDENCE = 'text returned by seek_resolve'
const TOKEN = 'a'.repeat(64)
const FORGED = 'b'.repeat(64)
const GRANT = { id: 'grant_base', status: 'active' }

const snipCap = (text = CLIP, token = TOKEN) => ({
  id: 'snip.get', title: 'Read a clipping', summary: 'Read one clipping with its text.',
  inputSchema: { type: 'object', additionalProperties: true },
  risk: 'read',
  handler: async () => ({ id: 'clip_1', text, taintToken: token }),
})

const seekCap = () => ({
  id: 'seek.resolve', title: 'Resolve evidence', summary: 'Resolve one evidence ref.',
  inputSchema: { type: 'object', additionalProperties: true },
  risk: 'read',
  handler: async () => ({ ref: 'dsh://trace/1', found: true, status: 'fresh', text: EVIDENCE }),
})

const writeCap = (writes, id = 'act.fs.write') => ({
  id, title: 'Write a file', summary: 'Write one file.',
  inputSchema: { type: 'object', additionalProperties: true },
  risk: 'write',
  handler: async args => { writes.push(args); return { written: true } },
})

function allowStub(allowed = []) {
  const calls = []
  const requests = []
  return {
    calls, requests,
    async check({ capability }) {
      calls.push(capability)
      return { allowed: allowed.includes(capability) }
    },
    async request(input) {
      requests.push(input)
      return { requestId: `req_${requests.length}`, status: 'pending' }
    },
  }
}

function mount(capabilities, options = {}) {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    ...(options.allow ? { allow: options.allow } : {}),
  }
  const kernel = apply(ctx, {
    capabilities,
    ...(options.legacyTools ? { legacyTools: options.legacyTools } : {}),
    ...(options.taint ? { taint: options.taint } : {}),
  })
  return {
    kernel,
    tool: name => tools.get(name),
    read: (input = {}, exec = {}) => tools.get('os_do').execute({ id: 'snip.get', args: {}, ...input }, exec),
    write: (input, exec = {}) => tools.get('os_do').execute(input, exec),
  }
}

const denied = (result, capability = 'cap:act.fs.write:tainted') => {
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_DENIED')
  assert.equal(result.error.subcode, 'grant_required')
  assert.equal(result.error.details.permission, capability)
  assert.equal(result.error.nextTools[0].tool, 'os_request')
  return result
}

test('the registry hashes text, binds one token and never stores plaintext', () => {
  let now = 1_000
  const registry = new TaintRegistry({ now: () => now, ttlMs: TAINT_TTL_MS })
  assert.equal(TAINT_TTL_MS, 5 * 60 * 1000)
  registry.record(CLIP, { source: 'snip.get', token: TOKEN })
  assert.equal(registry.matches(CLIP), true)
  assert.equal(registry.matches(`${CLIP}!`), false)
  const [record] = registry.snapshot()
  assert.equal(record.hash, sha256(CLIP))
  assert.equal(record.source, 'snip.get')
  assert.equal(JSON.stringify(record).includes(CLIP), false)
  assert.equal(registry.consume(sha256(CLIP), TOKEN), true)
  assert.equal(registry.consume(sha256(CLIP), TOKEN), false, 'tokens are single-use')
  assert.equal(registry.matches(CLIP), true, 'the digest outlives its token')
  registry.record(CLIP, { token: TOKEN })
  now += TAINT_TTL_MS + 1
  assert.equal(registry.consume(sha256(CLIP), TOKEN), false, 'tokens expire after five minutes')
})

test('content read through snip.get cannot be written without the tainted Grant', async () => {
  const writes = []
  const allow = allowStub()
  const h = mount([snipCap(), writeCap(writes)], { allow })
  assert.equal((await h.read()).ok, true)

  const result = denied(await h.write({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP }, grant: GRANT,
  }))
  assert.equal(result.error.details.tainted, true)
  assert.equal(result.error.details.taintSource, 'snip.get')
  assert.equal(result.error.nextTools[0].args.tainted, true)
  assert.equal(writes.length, 0)
})

test('the base and tainted Grants together let a tainted write through', async () => {
  const writes = []
  const allow = allowStub(['cap:act.fs.write', 'cap:act.fs.write:tainted'])
  const h = mount([snipCap(), writeCap(writes)], { allow })
  await h.read()

  const result = await h.write({ id: 'act.fs.write', args: { path: 'a.txt', text: CLIP } }, { subject: 'agent-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(allow.calls, ['cap:act.fs.write', 'cap:act.fs.write:tainted'])
  assert.equal(writes.length, 1)
})

test('a fresh taintToken authorizes exactly one matching write and is stripped', async () => {
  const writes = []
  const h = mount([snipCap(), writeCap(writes)])
  const token = (await h.read()).data.taintToken
  assert.equal(typeof token, 'string')

  const first = await h.write({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP, taintToken: token }, grant: GRANT,
  })
  assert.equal(first.ok, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].taintToken, undefined, 'taint evidence is not forwarded')
  assert.equal(writes[0].text, CLIP)

  denied(await h.write({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP, taintToken: token }, grant: GRANT,
  }))
  assert.equal(writes.length, 1, 'a replayed token cannot write again')
})

test('a forged token cannot authorize a tainted or an untainted write', async () => {
  const writes = []
  const h = mount([snipCap(), writeCap(writes)])
  await h.read()

  const tainted = denied(await h.write({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP, taintToken: FORGED }, grant: GRANT,
  }))
  assert.equal(tainted.error.details.reason, 'invalid_taint_token')

  denied(await h.write({
    id: 'act.fs.write', args: { path: 'b.txt', text: 'model wrote this itself', taintToken: FORGED }, grant: GRANT,
  }))
  assert.equal(writes.length, 0)
})

test('an expired token cannot authorize; the digest still needs the tainted Grant', async () => {
  let now = 10_000
  const writes = []
  const allow = allowStub()
  const h = mount([snipCap(), writeCap(writes)], { allow, taint: { now: () => now } })
  const token = (await h.read()).data.taintToken
  now += TAINT_TTL_MS + 1

  denied(await h.write({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP, taintToken: token }, grant: GRANT,
  }))
  assert.equal(writes.length, 0)
})

test('ordinary content is unaffected, and seek.resolve text is gated without a token', async () => {
  const writes = []
  const allow = allowStub()
  const h = mount([seekCap(), writeCap(writes)], { allow })

  assert.equal((await h.write({
    id: 'act.fs.write', args: { path: 'plain.txt', text: 'ordinary text' }, grant: GRANT,
  })).ok, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(allow.calls, [])

  assert.equal((await h.write({ id: 'seek.resolve', args: { ref: 'dsh://trace/1' } })).ok, true)
  denied(await h.write({
    id: 'act.fs.write', args: { path: 'evidence.txt', text: EVIDENCE }, grant: GRANT,
  }))
  assert.equal(writes.length, 1)
})

test('legacy.act_invoke maps to cap:act.fs.write:tainted and strips nested taint args', async () => {
  const writes = []
  const allow = allowStub()
  const h = mount([snipCap(), writeCap(writes, 'legacy.act_invoke')], { allow })
  const token = (await h.read()).data.taintToken

  const passed = await h.write({
    id: 'legacy.act_invoke',
    args: { id: 'fs.write', args: { path: 'a.txt', text: CLIP, taintToken: token }, tainted: true, taintToken: token },
    grant: GRANT,
  })
  assert.equal(passed.ok, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].args.taintToken, undefined)
  assert.equal(writes[0].tainted, undefined)

  const blocked = denied(await h.write({
    id: 'legacy.act_invoke', args: { id: 'fs.write', args: { path: 'b.txt', text: CLIP }, tainted: true }, grant: GRANT,
  }))
  assert.equal(blocked.error.details.taintSource, 'snip.get')
})

test('os_request tainted:true asks Allow for the mapped tainted capability', async () => {
  const allow = allowStub()
  const h = mount([writeCap([], 'legacy.act_invoke')], { allow })
  const requested = await h.tool('os_request').execute({
    id: 'legacy.act_invoke', args: { id: 'fs.write', args: { path: 'a.txt', text: CLIP } },
    reason: 'write approved evidence', tainted: true,
  }, { subject: 'agent-1' })
  assert.equal(requested.ok, true)
  assert.equal(requested.capability, 'cap:act.fs.write:tainted')
  assert.equal(allow.requests[0].capability, 'cap:act.fs.write:tainted')
})

test('the tainted-Grant recovery loop works through os_request/os_observe', async () => {
  const writes = []
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  const allow = mountAllow(ctx, {})
  apply(ctx, { capabilities: [snipCap(), writeCap(writes)] })
  const exec = { subject: 'agent-1' }
  const args = { path: 'a.txt', text: CLIP }
  const run = input => tools.get('os_do').execute(input, exec)

  assert.equal((await run({ id: 'snip.get', args: {} })).ok, true)

  const base = await tools.get('os_request').execute({ id: 'act.fs.write', args, reason: 'write it' }, exec)
  allow.approve({ id: base.requestId, by: 'alice' })
  await tools.get('os_observe').execute({ requestId: base.requestId }, exec)
  denied(await run({ id: 'act.fs.write', args }), 'cap:act.fs.write:tainted')
  assert.equal(writes.length, 0)

  const tainted = await tools.get('os_request').execute({
    id: 'act.fs.write', args, reason: 'write tainted content', tainted: true,
  }, exec)
  assert.equal(tainted.capability, 'cap:act.fs.write:tainted')
  allow.approve({ id: tainted.requestId, by: 'alice' })
  const observed = await tools.get('os_observe').execute({ requestId: tainted.requestId }, exec)
  assert.equal(observed.grantAvailable, true)
  assert.equal(observed.capability, 'cap:act.fs.write:tainted')

  assert.equal((await run({ id: 'act.fs.write', args })).ok, true)
  assert.equal(writes.length, 1)
})

test('a legacy snip_get result seeds the registry through the legacy bridge', async () => {
  const writes = []
  const legacy = {
    name: 'snip_get', description: 'Read one clipping with its text.',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: true } },
    execute: async () => ({ id: 'clip_1', text: CLIP, taintToken: TOKEN }),
  }
  const h = mount([writeCap(writes)], { legacyTools: [legacy] })
  const read = await h.tool('os_do').execute({ id: 'legacy.snip_get', args: { id: 'clip_1' } })
  assert.equal(read.ok, true)
  denied(await h.tool('os_do').execute({
    id: 'act.fs.write', args: { path: 'a.txt', text: CLIP }, grant: GRANT,
  }))
  assert.equal(writes.length, 0)
})
