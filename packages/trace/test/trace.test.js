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

function setup(config) {
  const ctx = fakeContext()
  const service = apply(ctx, config)
  return { ctx, service }
}

const coded = code => error => error?.code === code
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('apply provides ctx.trace and registers seven plain-object tools', async () => {
  const { ctx, service } = setup()
  assert.ok(ctx.get('trace') instanceof TraceService)
  assert.equal(service.protocol, 'dsh-memory-protocol/v1')
  assert.equal(service.profile, 'trace/1')
  assert.deepEqual(
    [...ctx._tools.keys()],
    [
      'trace_remember',
      'trace_search',
      'trace_forget',
      'trace_list',
      'trace_import_memento',
      'trace_export_memento',
      'trace_adapter_status',
    ],
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

test('restore preserves createdAt/expiresAt and never forces a higher-confidence record', () => {
  const { service } = setup()
  const high = service.remember({ key: 'tool:pnpm', text: 'Use pnpm.', confidence: 0.9 })
  assert.throws(
    () => service.restore({
      key: 'tool:pnpm',
      text: 'Use npm.',
      confidence: 0.2,
      createdAt: 1_700_000_000_000,
    }),
    coded('trace_confidence_too_low'),
  )
  assert.equal(service.get('tool:pnpm').id, high.id)

  const restored = service.restore({
    key: 'imported:decision',
    text: 'Adopt pnpm workspaces.',
    source: 'memento',
    scope: 'user',
    confidence: 0.7,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
  })
  assert.equal(restored.provenance.createdAt, 1_700_000_000_000)
  assert.equal(restored.provenance.updatedAt, 1_700_000_000_000)
  assert.equal(restored.expiresAt, 1_800_000_000_000)
  assert.equal(service.get('imported:decision').id, restored.id)

  assert.throws(() => service.restore({ key: 'x', text: 'x', force: true }), coded('invalid_arguments'))
  assert.throws(() => service.restore({ key: 'x', text: 'x', createdAt: 1.5 }), coded('invalid_created_at'))
  assert.throws(
    () => service.restore({ key: 'x', text: 'x', createdAt: 10, expiresAt: 10 }),
    coded('invalid_expires_at'),
  )
})

test('trace_remember verifies a dsh:// source through ctx.evidence before storing', async () => {
  const { ctx } = setup()
  const calls = []
  const signal = new AbortController().signal
  ctx._services.set('evidence', {
    async resolve(ref, options) {
      calls.push({ ref, options })
      return { found: true, status: 'fresh', checkedAt: 11 }
    },
  })
  const exec = {
    agent: { session: { id: 's1', header: { cwd: '/work', agentPreset: 'reviewer' } } },
    signal,
  }
  const result = await ctx._tools.get('trace_remember').execute(
    { key: 'repo:dsh', text: 'Verified claim.', source: 'dsh://locator/src/a.ts' },
    exec,
  )
  assert.equal(result.record.provenance.source, 'dsh://locator/src/a.ts')
  assert.deepEqual(result.verification, {
    ok: true,
    status: 'fresh',
    ref: 'dsh://locator/src/a.ts',
    checkedAt: 11,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ref, 'dsh://locator/src/a.ts')
  assert.equal(calls[0].options.signal, signal)
  assert.equal(calls[0].options.cwd, '/work')
  assert.equal(calls[0].options.agentKey, 'reviewer')
  assert.equal(calls[0].options.timeoutMs, 10_000)
})

test('trace_remember rejects a not-found dsh:// ref by default', async () => {
  const { ctx, service } = setup()
  ctx._services.set('evidence', {
    async resolve() {
      return { found: false, status: 'missing', checkedAt: 5 }
    },
  })
  const result = await ctx._tools.get('trace_remember').execute({
    key: 'repo:fake',
    text: 'Forged source.',
    source: 'dsh://locator/docs/missing.md',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_REF_NOT_FOUND')
  assert.equal(result.status, 'missing')
  assert.equal(result.ref, 'dsh://locator/docs/missing.md')
  assert.equal(result.checkedAt, 5)
  assert.deepEqual(service.list(), [])
})

test('trace_remember rejects timeout and resolve errors as E_REF_NOT_FOUND', async () => {
  const timeout = setup()
  timeout.ctx._services.set('evidence', {
    async resolve() {
      return { found: false, status: 'timeout', error: { code: 'provider_timeout', message: 'slow' } }
    },
  })
  const timedOut = await timeout.ctx._tools.get('trace_remember').execute({
    key: 'k',
    text: 't',
    source: 'dsh://locator/slow.ts',
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'E_REF_NOT_FOUND')
  assert.equal(timedOut.status, 'timeout')
  assert.equal(timedOut.error.code, 'provider_timeout')

  const broken = setup()
  broken.ctx._services.set('evidence', {
    async resolve() {
      throw Object.assign(new Error('bad ref'), { code: 'E_INVALID_ARGUMENT' })
    },
  })
  const invalid = await broken.ctx._tools.get('trace_remember').execute({
    key: 'k',
    text: 't',
    source: 'dsh://',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'E_REF_NOT_FOUND')
  assert.equal(invalid.status, 'error')
  assert.equal(invalid.error.code, 'E_INVALID_ARGUMENT')
})

test('trace_remember stores a not-found ref with a warning in warn mode', async () => {
  const { ctx, service } = setup({ refVerifyMode: 'warn' })
  ctx._services.set('evidence', {
    async resolve() {
      return { found: false, status: 'missing' }
    },
  })
  const result = await ctx._tools.get('trace_remember').execute({
    key: 'repo:warned',
    text: 'Stored with a warning.',
    source: 'dsh://locator/gone.md',
  })
  assert.equal(result.record.key, 'repo:warned')
  assert.equal(result.warning.code, 'E_REF_NOT_FOUND')
  assert.equal(result.warning.status, 'missing')
  assert.equal(service.list().length, 1)
})

test('verifyRefs:false skips resolution and keeps the 0.2 free-text behaviour', async () => {
  const { ctx, service } = setup({ verifyRefs: false })
  let calls = 0
  ctx._services.set('evidence', { async resolve() { calls += 1; return { found: false, status: 'missing' } } })
  const result = await ctx._tools.get('trace_remember').execute({
    key: 'repo:unchecked',
    text: 'Not verified.',
    source: 'dsh://locator/missing.md',
  })
  assert.equal(result.record.key, 'repo:unchecked')
  assert.equal(result.verification, undefined)
  assert.equal(result.warning, undefined)
  assert.equal(calls, 0)
  assert.equal(service.list().length, 1)
})

test('non-dsh sources and a missing evidence service are not verified', async () => {
  const { ctx, service } = setup()
  let calls = 0
  ctx._services.set('evidence', { async resolve() { calls += 1; return { found: false, status: 'missing' } } })
  const freeText = await ctx._tools.get('trace_remember').execute({
    key: 'repo:check',
    text: 'from a check',
    source: 'check_compare',
  })
  assert.equal(freeText.record.key, 'repo:check')
  assert.equal(freeText.verification, undefined)
  assert.equal(calls, 0)

  const standalone = setup()
  const stored = await standalone.ctx._tools.get('trace_remember').execute({
    key: 'repo:standalone',
    text: 'no seek installed',
    source: 'dsh://locator/src/a.ts',
  })
  assert.equal(stored.record.key, 'repo:standalone')
  assert.equal(stored.verification, undefined)
  assert.equal(service.list().length, 1)
})

test('verifyTimeoutMs bounds the evidence resolve call', async () => {
  const { ctx } = setup({ verifyTimeoutMs: 25 })
  let seen
  ctx._services.set('evidence', {
    async resolve(_ref, options) {
      seen = options
      return { found: true, status: 'fresh' }
    },
  })
  await ctx._tools.get('trace_remember').execute({
    key: 'k',
    text: 't',
    source: 'dsh://locator/src/a.ts',
  })
  assert.equal(seen.timeoutMs, 25)
})
