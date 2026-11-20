import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, TraceService } from '../index.js'

/** Fake Cordis context from docs/implementation-contract.md. */
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

function setup() {
  const ctx = fakeContext()
  const service = apply(ctx)
  return { ctx, service }
}

const coded = code => error => error?.code === code
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('apply provides ctx.trace and registers four plain-object tools', async () => {
  const { ctx, service } = setup()
  assert.ok(ctx.get('trace') instanceof TraceService)
  assert.equal(service.protocol, 'dsh-memory-protocol/v1')
  assert.equal(service.profile, 'trace/1')
  assert.deepEqual(
    [...ctx._tools.keys()],
    ['trace_remember', 'trace_search', 'trace_forget', 'trace_list'],
  )
  for (const tool of ctx._tools.values()) {
    assert.equal(Object.getPrototypeOf(tool), Object.prototype)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  const remembered = await ctx._tools.get('trace_remember').execute({ key: 'tool:pnpm', text: 'Use pnpm.' })
  assert.equal(remembered.record.key, 'tool:pnpm')
  const listed = await ctx._tools.get('trace_list').execute({})
  assert.equal(listed.records.length, 1)
})

test('remember stores provenance and search finds key and text', () => {
  const { service } = setup()
  const record = service.remember({ key: ' repo:dsh ', text: 'Use pnpm workspaces.' })
  assert.equal(record.key, 'repo:dsh')
  assert.equal(record.text, 'Use pnpm workspaces.')
  assert.equal(record.scope, 'workspace')
  assert.equal(record.confidence, 0.5)
  assert.equal(record.sensitivity, 'normal')
  assert.equal(record.status, 'active')
  assert.deepEqual(record.supersedes, [])
  assert.deepEqual(record.provenance.source, 'user')
  assert.equal(typeof record.provenance.createdAt, 'number')
  assert.equal(record.provenance.createdAt, record.provenance.updatedAt)

  assert.deepEqual(service.search('pnpm').map(item => item.id), [record.id])
  assert.deepEqual(service.search('REPO:DSH').map(item => item.id), [record.id])
  assert.deepEqual(service.search('missing'), [])
  assert.deepEqual(service.list({ limit: 1 }).map(item => item.id), [record.id])

  record.text = 'mutated by caller'
  assert.equal(service.search('pnpm')[0].text, 'Use pnpm workspaces.')
})

test('same key supersedes the old record and keeps the chain', () => {
  const { service } = setup()
  const first = service.remember({ key: 'tool:pnpm', text: 'Use pnpm.', confidence: 0.8 })
  const second = service.remember({ key: 'tool:pnpm', text: 'Use npm.', confidence: 0.9 })
  assert.notEqual(second.id, first.id)
  assert.deepEqual(second.supersedes, [first.id])
  assert.deepEqual(service.list().map(item => item.id), [second.id])
  assert.deepEqual(service.search('Use pnpm.'), [])

  assert.throws(
    () => service.remember({ key: 'tool:pnpm', text: 'Use yarn.', confidence: 0.2 }),
    error => coded('trace_confidence_too_low')(error) && error.current.id === second.id,
  )
  assert.deepEqual(service.list().map(item => item.id), [second.id])

  const forced = service.remember({ key: 'tool:pnpm', text: 'Use yarn.', confidence: 0.2, force: true })
  assert.deepEqual(forced.supersedes, [second.id])

  const dump = service.export()
  assert.equal(dump.records.length, 3)
  const byId = new Map(dump.records.map(item => [item.id, item]))
  assert.equal(byId.get(first.id).status, 'superseded')
  assert.equal(byId.get(first.id).supersededBy, second.id)
  assert.equal(byId.get(second.id).status, 'superseded')
  assert.equal(byId.get(second.id).supersededBy, forced.id)
  assert.deepEqual(byId.get(second.id).supersedes, [first.id])
  assert.equal(byId.get(forced.id).status, 'active')
})

test('ttl expiry removes records from search and list but keeps an audit entry', async () => {
  const { service } = setup()
  const record = service.remember({ key: 'fact:ephemeral', text: 'Short lived fact.', ttlMs: 5 })
  assert.equal(record.expiresAt, record.provenance.createdAt + 5)
  assert.deepEqual(service.search('short lived').map(item => item.id), [record.id])

  await sleep(20)
  assert.deepEqual(service.search('short lived'), [])
  assert.deepEqual(service.list(), [])

  const dump = service.export()
  assert.equal(dump.records.find(item => item.id === record.id).status, 'expired')
})

test('secret sensitivity stores only [redacted] and never exports the original', () => {
  const { service } = setup()
  const secret = service.remember({
    key: 'credential:api',
    text: 'sk-live-123456',
    sensitivity: 'secret',
    confidence: 0.9,
  })
  assert.equal(secret.text, '[redacted]')
  assert.equal(secret.redacted, true)
  assert.equal(secret.sensitivity, 'secret')
  assert.deepEqual(service.search('sk-live'), [])
  assert.deepEqual(service.search('credential:api').map(item => item.id), [secret.id])

  const dump = service.export()
  assert.equal(dump.records[0].text, '[redacted]')
  assert.equal(JSON.stringify(dump).includes('sk-live-123456'), false)
})

test('forget removes every version of a key and exports only a tombstone', () => {
  const { service } = setup()
  const keep = service.remember({ key: 'keep', text: 'Keep this claim.' })
  service.remember({ key: 'gone', text: 'Forget this claim.', confidence: 0.9 })
  service.remember({ key: 'gone', text: 'Forget this claim too.', confidence: 0.95 })

  assert.equal(service.forget('gone'), true)
  assert.equal(service.forget('gone'), false)
  assert.deepEqual(service.search('Forget').map(item => item.id), [])
  assert.deepEqual(service.list().map(item => item.id), [keep.id])

  const dump = service.export()
  assert.equal(dump.format, 'trace-export-v1')
  assert.deepEqual(dump.records.map(item => item.id), [keep.id])
  assert.equal(dump.tombstones.length, 1)
  assert.equal(dump.tombstones[0].key, 'gone')
  assert.equal(dump.tombstones[0].versions, 2)
  assert.equal(JSON.stringify(dump).includes('Forget this claim'), false)
})

test('invalid drafts and limits fail with stable codes', () => {
  const { service } = setup()
  assert.throws(() => service.remember({ key: '', text: 'x' }), coded('invalid_key'))
  assert.throws(() => service.remember({ key: 'k', text: '  ' }), coded('invalid_text'))
  assert.throws(() => service.remember({ key: 'k', text: 'x', confidence: 1.1 }), coded('invalid_confidence'))
  assert.throws(() => service.remember({ key: 'k', text: 'x', ttlMs: 0 }), coded('invalid_ttl'))
  assert.throws(() => service.remember({ key: 'k', text: 'x', scope: 'global' }), coded('invalid_scope'))
  assert.throws(() => service.remember({ key: 'k', text: 'x', bogus: true }), coded('invalid_arguments'))
  assert.throws(() => service.search(42), coded('invalid_query'))
  assert.throws(() => service.search('x', { limit: 0 }), coded('invalid_limit'))
  assert.throws(() => service.list({ limit: 1.5 }), coded('invalid_limit'))
  assert.equal(service.forget('not-there'), false)
})
