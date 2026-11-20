import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, parseRef, SeekService } from '../index.js'

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

/** A valid hit; `source` is derived from the ref. */
function hit(ref, score, extra = {}) {
  return {
    ref,
    source: ref.slice('dsh://'.length).split('/')[0],
    title: `title:${ref}`,
    snippet: `snippet:${ref}`,
    ...(score === undefined ? {} : { score }),
    ...extra,
  }
}

function provider(name, hits, calls = []) {
  return {
    name,
    async search(query, options) {
      calls.push({ query, options })
      return typeof hits === 'function' ? hits() : hits
    },
  }
}

test('apply provides ctx.evidence and registers both tools', () => {
  const { ctx, service } = setup()
  assert.ok(service instanceof SeekService)
  assert.equal(ctx.get('evidence'), service)
  assert.deepEqual([...ctx._tools.keys()], ['seek_search', 'seek_providers'])
})

test('search fans out in parallel, dedupes by ref and sorts by score then source', async () => {
  const { service } = setup()
  const calls = []
  service.registerProvider(provider('alpha', [
    hit('dsh://alpha/a', 0.4),
    hit('dsh://notes/shared', 0.5),
  ], calls))
  service.registerProvider(provider('beta', [
    hit('dsh://beta/b', 0.9),
    hit('dsh://notes/shared', 0.7),
  ], calls))

  const result = await service.search('  retry  ', { limit: 5 })
  assert.equal(result.query, 'retry')
  assert.deepEqual(result.hits.map(item => item.ref), [
    'dsh://beta/b',
    'dsh://notes/shared',
    'dsh://alpha/a',
  ])
  assert.equal(result.hits[1].source, 'notes')
  assert.equal(result.hits[1].score, 0.7)
  assert.equal(result.hits[1].title, 'title:dsh://notes/shared')
  assert.equal(result.total, 3)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(calls.map(call => call.query), ['retry', 'retry'])
  assert.deepEqual(calls.map(call => call.options), [{ limit: 5 }, { limit: 5 }])
})

test('equal scores are ordered by source', async () => {
  const { service } = setup()
  service.registerProvider(provider('beta', [hit('dsh://beta/tie', 0.5)]))
  service.registerProvider(provider('alpha', [hit('dsh://alpha/tie', 0.5)]))

  const result = await service.search('tie')
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/tie', 'dsh://beta/tie'])
})

test('source filter is applied before fan-out and limit after merging', async () => {
  const { service } = setup()
  const alphaCalls = []
  const betaCalls = []
  service.registerProvider(provider('alpha', [hit('dsh://alpha/a', 0.3), hit('dsh://alpha/b', 0.2)], alphaCalls))
  service.registerProvider(provider('beta', [hit('dsh://beta/c', 0.9)], betaCalls))

  const filtered = await service.search('x', { sources: ['alpha'], limit: 1 })
  assert.deepEqual(filtered.hits.map(item => item.ref), ['dsh://alpha/a'])
  assert.equal(filtered.total, 1)
  assert.deepEqual(filtered.errors, [])
  assert.equal(alphaCalls.length, 1)
  assert.equal(betaCalls.length, 0)

  const empty = await service.search('x', { sources: [] })
  assert.deepEqual(empty, { query: 'x', hits: [], total: 0, errors: [] })
  assert.equal(betaCalls.length, 0)
})

test('one provider failure does not fail the query', async () => {
  const { service } = setup()
  service.registerProvider(provider('alpha', [hit('dsh://alpha/a', 0.2)]))
  service.registerProvider({
    name: 'broken',
    async search() { throw new Error('boom') },
  })
  service.registerProvider({ name: 'not-array', search: () => ({ hits: [] }) })

  const result = await service.search('x')
  assert.equal(result.total, 1)
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/a'])
  assert.deepEqual(result.errors, [
    { source: 'broken', code: 'provider_failed', message: 'boom' },
    { source: 'not-array', code: 'provider_failed', message: 'provider must return an array of hits' },
  ])
})

test('invalid and mismatched refs are omitted and reported once per provider', async () => {
  const { service } = setup()
  service.registerProvider(provider('alpha', [
    { ref: 'dsh://alpha/ok', source: 'alpha', title: 'ok', snippet: 's' },
    { ref: 'https://example.com/x', source: 'alpha', title: 'bad', snippet: 's' },
    { ref: 'dsh://other/x', source: 'alpha', title: 'mismatch', snippet: 's' },
  ]))

  const result = await service.search('x')
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/ok'])
  assert.deepEqual(result.errors, [{
    source: 'alpha',
    code: 'invalid_hit',
    message: '2 hit(s) omitted: refs must use dsh://<source>/<id> and match hit.source',
  }])
})

test('hits are normalized to the documented shape', async () => {
  const { service } = setup()
  service.registerProvider(provider('alpha', [
    { ref: 'dsh://alpha/bare' },
    {
      ref: 'dsh://alpha/full',
      title: 'Full',
      snippet: 'snip',
      score: 1.5,
      freshness: 'fresh',
      ignored: true,
    },
  ]))

  const result = await service.search('x')
  assert.deepEqual(result.hits, [
    {
      ref: 'dsh://alpha/full',
      source: 'alpha',
      title: 'Full',
      snippet: 'snip',
      score: 1.5,
      freshness: 'fresh',
    },
    { ref: 'dsh://alpha/bare', source: 'alpha', title: '', snippet: '' },
  ])
})

test('parseRef validates the dsh ref format', () => {
  assert.deepEqual(parseRef('dsh://locator/src/index.js'), { source: 'locator', id: 'src/index.js' })
  assert.deepEqual(parseRef('dsh://notes/a-b_c.d~e'), { source: 'notes', id: 'a-b_c.d~e' })
  for (const bad of [
    undefined,
    null,
    '',
    'ref://locator/x',
    'dsh:///x',
    'dsh://Locator/x',
    'dsh://locator/',
    'dsh://locator/a//b',
    'dsh://locator/a b',
    'dsh://locator/a?q=1',
  ]) {
    assert.equal(parseRef(bad), undefined, `expected invalid: ${String(bad)}`)
  }
})

test('provider registration validates names, search and duplicates', () => {
  const { service } = setup()
  const dispose = service.registerProvider({ name: 'alpha', search: () => [] })
  assert.deepEqual(service.providers(), ['alpha'])
  assert.throws(
    () => service.registerProvider({ name: 'alpha', search: () => [] }),
    error => error.code === 'provider_exists',
  )
  assert.throws(
    () => service.registerProvider({ name: 'Alpha', search: () => [] }),
    error => error.code === 'invalid_provider',
  )
  assert.throws(
    () => service.registerProvider({ name: 'beta' }),
    error => error.code === 'invalid_provider',
  )
  assert.throws(
    () => service.registerProvider(null),
    error => error.code === 'invalid_provider',
  )

  assert.equal(dispose(), true)
  assert.equal(dispose(), false)
  assert.deepEqual(service.providers(), [])
  service.registerProvider({ name: 'beta', search: () => [] })
  assert.equal(service.unregisterProvider('missing'), false)
  assert.equal(service.unregisterProvider('beta'), true)
  assert.deepEqual(service.providers(), [])
})

test('search rejects invalid queries, limits and sources', async () => {
  const { service } = setup()
  await assert.rejects(service.search('   '), error => error.code === 'invalid_query')
  await assert.rejects(service.search(undefined), error => error.code === 'invalid_query')
  await assert.rejects(service.search('x', { limit: 0 }), error => error.code === 'invalid_limit')
  await assert.rejects(service.search('x', { limit: 1.5 }), error => error.code === 'invalid_limit')
  await assert.rejects(service.search('x', { sources: 'alpha' }), error => error.code === 'invalid_sources')
  await assert.rejects(service.search('x', { sources: [1] }), error => error.code === 'invalid_sources')
  await assert.rejects(service.search('x', null), error => error.code === 'invalid_options')
})

test('providers are queried in parallel', async () => {
  const { service } = setup()
  const started = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  for (const name of ['alpha', 'beta']) {
    service.registerProvider({
      name,
      async search() {
        started.push(name)
        await gate
        return []
      },
    })
  }

  const pending = service.search('parallel')
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, ['alpha', 'beta'])
  } finally {
    release()
  }
  assert.equal((await pending).total, 0)
})

test('agent tools call the service', async () => {
  const { ctx, service } = setup()
  service.registerProvider(provider('alpha', [hit('dsh://alpha/a', 0.3)]))

  const result = await ctx._tools.get('seek_search').execute({ query: 'x', sources: ['alpha'], limit: 3 })
  assert.equal(result.query, 'x')
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/a'])

  assert.deepEqual(await ctx._tools.get('seek_providers').execute(), { providers: ['alpha'] })
  await assert.rejects(
    ctx._tools.get('seek_search').execute({}),
    error => error.code === 'invalid_query',
  )
})
