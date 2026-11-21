import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CapabilityRegistry } from '../lib/registry.js'
import { validateDescriptor, normalizeDescriptor } from '../lib/descriptor.js'

const descriptor = (overrides = {}) => ({
  id: 'snip.search',
  title: 'Search clippings',
  summary: 'Find a previously copied item.',
  whenToUse: ['The user refers to something copied earlier.'],
  whenNotToUse: ['The user wants the current clipboard.'],
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
  },
  risk: 'read',
  permissions: ['clipboard.read'],
  cost: { tokens: 80, latencyMs: 5, moneyUsd: 0 },
  examples: [{ input: { query: 'invoice' }, expect: 'ok' }],
  tags: ['clipboard', 'search'],
  handler: async ({ query }) => ({ query, items: [{ id: 'c1', preview: query }] }),
  ...overrides,
})

test('validateDescriptor accepts a full descriptor and rejects bad shapes', () => {
  const value = descriptor()
  assert.equal(validateDescriptor(value), value)
  assert.throws(() => validateDescriptor({ ...value, id: 'noDot' }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => validateDescriptor({ ...value, risk: 'danger' }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => validateDescriptor({ ...value, surprise: true }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => validateDescriptor({ ...value, title: 'x'.repeat(41) }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => validateDescriptor({ ...value, handler: null }), { code: 'E_INVALID_ARGUMENT' })
})

test('normalizeDescriptor fills defaults, splits risk and strips handler from JSON', () => {
  const normalized = normalizeDescriptor(descriptor({ risk: ['read', 'network'], tags: undefined, version: undefined }))
  assert.deepEqual(normalized.risk, ['read', 'network'])
  assert.deepEqual(normalized.tags, [])
  assert.equal(normalized.version, '1.0.0')
  assert.equal(normalized.idempotency, 'pure')
  assert.equal(normalized.audience.length, 3)
  assert.equal(normalized.cost.moneyUsd, 0)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.cost))
  assert.equal('handler' in JSON.parse(JSON.stringify(normalized)), false)
})

test('registry lists, filters by capability/risk/tag, searches and resolves aliases', () => {
  const registry = new CapabilityRegistry()
  registry.register(descriptor({ aliases: ['snip_search'] }))
  registry.register(descriptor({
    id: 'snip.add', title: 'Add clipping', summary: 'Store a new clipping.',
    risk: 'write', tags: ['clipboard', 'write'], aliases: [],
    handler: async ({ text }) => ({ id: 'c2', text }),
  }))
  registry.register(descriptor({
    id: 'check.run', title: 'Run checks', summary: 'Run the regression suite.',
    whenToUse: ['The user asks whether the build regressed.'], tags: ['regression'], risk: 'execute',
    handler: async () => ({ run: 'r1' }),
  }))

  assert.deepEqual(registry.names(), ['check.run', 'snip.add', 'snip.search'])
  assert.deepEqual(registry.list({ capability: 'snip' }).map(item => item.id), ['snip.add', 'snip.search'])
  assert.deepEqual(registry.list({ risk: 'write' }).map(item => item.id), ['snip.add'])
  assert.deepEqual(registry.list({ tag: ['clipboard', 'write'] }).map(item => item.id), ['snip.add'])
  assert.equal(registry.list()[0].handler, undefined)
  assert.deepEqual(registry.search('clipboard').map(item => item.id).sort(), ['snip.add', 'snip.search'])
  assert.equal(registry.search('previously copied')[0].id, 'snip.search')
  assert.equal(registry.search('regression')[0].id, 'check.run')
  assert.equal(registry.resolve('snip_search').title, 'Search clippings')
  assert.equal(registry.resolve('missing.cap'), null)
})

test('registry invokes handlers, validates input and normalizes errors', async () => {
  const registry = new CapabilityRegistry()
  registry.register(descriptor())
  assert.deepEqual(await registry.invoke('snip.search', { query: 'invoice' }), {
    ok: true, value: { query: 'invoice', items: [{ id: 'c1', preview: 'invoice' }] },
  })
  assert.equal((await registry.invoke('snip.search', {})).code, 'E_INVALID_ARGUMENT')
  assert.equal((await registry.invoke('snip.search', { query: 'invoice', extra: true })).code, 'E_INVALID_ARGUMENT')
  assert.equal((await registry.invoke('missing.cap', {})).code, 'E_NOT_FOUND')
  registry.register(descriptor({ id: 'fail.now', handler: async () => { throw Object.assign(new Error('boom'), { code: 'WEIRD' }) } }))
  assert.equal((await registry.invoke('fail.now', { query: 'x' })).code, 'E_UNAVAILABLE')
})

test('registry rejects conflicts and unregisters only the owner', () => {
  const registry = new CapabilityRegistry()
  const undo = registry.register(descriptor({ aliases: ['snip_search'] }))
  assert.throws(() => registry.register(descriptor({ handler: async () => ({ other: true }) })), { code: 'E_CONFLICT' })
  assert.throws(() => registry.register(descriptor({ id: 'snip.add', aliases: ['snip_search'] })), { code: 'E_CONFLICT' })
  assert.equal(undo(), true)
  assert.deepEqual(registry.names(), [])
  const other = new CapabilityRegistry()
  other.register(descriptor(), { owner: 'a' })
  assert.equal(other.unregister('snip.search', 'b'), false)
  assert.equal(other.unregister('snip.search', 'a'), true)
})

test('registry lazy entries load once and must match their metadata', async () => {
  const registry = new CapabilityRegistry()
  let loads = 0
  registry.register({
    id: 'lazy.echo',
    meta: {
      id: 'lazy.echo', title: 'Lazy echo', summary: 'Echo after loading.', whenToUse: [], whenNotToUse: [],
      risk: 'read', tags: ['clipboard', 'search'], cost: { tokens: 80, latencyMs: 5, moneyUsd: 0 },
    },
    load: async () => {
      loads += 1
      return descriptor({ id: 'lazy.echo', title: 'Lazy echo', summary: 'Echo after loading.', whenToUse: [], whenNotToUse: [], aliases: [] })
    },
  })
  const first = await registry.resolve('lazy.echo')
  const second = await registry.resolve('lazy.echo')
  assert.equal(first, second)
  assert.equal(loads, 1)
  assert.deepEqual((await registry.invoke('lazy.echo', { query: 'x' })).value, { query: 'x', items: [{ id: 'c1', preview: 'x' }] })

  registry.register({
    id: 'lazy.bad',
    meta: { id: 'lazy.bad', title: 'Stub title', summary: 'Stub.', whenToUse: [], risk: 'read', tags: [], cost: {} },
    load: async () => descriptor({ id: 'lazy.bad', title: 'Different title', aliases: [] }),
  })
  await assert.rejects(() => registry.resolve('lazy.bad'), { code: 'E_CONFLICT' })
})
