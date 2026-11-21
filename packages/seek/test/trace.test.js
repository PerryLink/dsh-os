import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { apply as applyTrace } from '../../trace/index.js'

/** Fake Cordis context with the two host seams Seek and Trace consume. */
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

test('trace provider auto-registers and maps memory hits as tainted and resolvable', async () => {
  const ctx = fakeContext()
  const trace = applyTrace(ctx)
  const service = apply(ctx)

  assert.deepEqual(service.providers(), ['trace'])
  assert.deepEqual(service.sources(), [
    { name: 'trace', status: 'ready' },
    { name: 'locator', status: 'unavailable', reason: 'locator_find is not registered (install/enable dsh-locator)' },
    { name: 'memento', status: 'unavailable', reason: 'memory service is not available (install/enable dsh-memento)' },
  ])

  const first = trace.remember({
    key: 'user-trust-profile',
    text: 'User-trust profiles are hidden from agent-layer resolution.',
    source: 'note:user-trust',
  })
  const second = trace.remember({
    key: 'user-trust-env',
    text: 'Root never materializes process.env.',
    source: 'note:user-trust',
  })

  const result = await service.search('user-trust', { limit: 10 })
  assert.deepEqual(result.errors, [])
  assert.equal(result.hits.length, 2)
  assert.deepEqual(
    result.hits.map(hit => hit.ref).sort(),
    [`dsh://trace/${first.id}`, `dsh://trace/${second.id}`].sort(),
  )
  for (const hit of result.hits) {
    assert.equal(hit.source, 'trace')
    assert.equal(hit.resolvable, true)
    assert.equal(hit.tainted, true)
    assert.deepEqual(hit.freshness, { state: 'unknown' })
  }

  const found = await service.resolve(`dsh://trace/${first.id}`)
  assert.equal(found.found, true)
  assert.equal(found.status, 'unknown')
  assert.equal(found.source, 'trace')
  assert.equal(found.title, 'user-trust-profile')
  assert.equal(found.text, 'User-trust profiles are hidden from agent-layer resolution.')
  assert.equal(typeof found.checkedAt, 'number')

  const missing = await service.resolve('dsh://trace/00000000-0000-4000-8000-000000000000')
  assert.equal(missing.found, false)
  assert.equal(missing.status, 'missing')
})

test('a trace service mounted after Seek is picked up by seek_providers/seek_search/seek_resolve', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  assert.deepEqual(service.providers(), [])

  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    key: 'user-trust-profile',
    text: 'User-trust profiles are hidden from agent-layer resolution.',
    provenance: { source: 'note:user-trust', createdAt: 1, updatedAt: 1 },
  }
  ctx.provide('trace', { search: () => [record], list: () => [record] })

  const providers = await ctx._tools.get('seek_providers').execute()
  assert.deepEqual(providers.providers, ['trace'])
  assert.deepEqual(providers.sources, [
    { name: 'trace', status: 'ready' },
    { name: 'locator', status: 'unavailable', reason: 'locator_find is not registered (install/enable dsh-locator)' },
    { name: 'memento', status: 'unavailable', reason: 'memory service is not available (install/enable dsh-memento)' },
  ])

  const found = await ctx._tools.get('seek_search').execute({ query: 'user-trust' })
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].tainted, true)
  assert.equal(found.hits[0].resolvable, true)

  const resolved = await ctx._tools.get('seek_resolve').execute({ ref: found.hits[0].ref })
  assert.equal(resolved.found, true)
  assert.equal(resolved.text, record.text)
})

test('a manual provider may replace an auto-registered built-in provider', async () => {
  const ctx = fakeContext()
  applyTrace(ctx)
  const service = apply(ctx)
  assert.deepEqual(service.providers(), ['trace'])

  service.registerProvider({ name: 'trace', search: () => [] })
  assert.deepEqual(await service.search('anything'), {
    query: 'anything',
    hits: [],
    total: 0,
    errors: [],
  })
  assert.throws(
    () => service.registerProvider({ name: 'trace', search: () => [] }),
    error => error.code === 'provider_exists',
  )
})
