import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, DEFAULT_TIMEOUT_MS, MAX_REF_LENGTH, parseRef, SeekService } from '../index.js'

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

test('apply provides ctx.evidence and registers all four tools', () => {
  const { ctx, service } = setup()
  assert.ok(service instanceof SeekService)
  assert.equal(ctx.get('evidence'), service)
  assert.deepEqual([...ctx._tools.keys()], ['seek_search', 'seek_resolve', 'seek_providers', 'seek_register_defaults'])
  assert.deepEqual(service.sources(), [
    { name: 'locator', status: 'unavailable', reason: 'locator_find is not registered (install/enable dsh-locator)' },
    { name: 'memento', status: 'unavailable', reason: 'memory service is not available (install/enable dsh-memento)' },
    { name: 'trace', status: 'unavailable', reason: 'trace service is not available (install/enable dsh-trace)' },
  ])
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
  for (const call of calls) {
    assert.equal(call.options.limit, 5)
    assert.equal(call.options.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.ok(call.options.signal instanceof AbortSignal)
    assert.equal(call.options.signal.aborted, false)
  }
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

test('a hanging provider is bounded by timeoutMs and reported as an error', async () => {
  const { service } = setup()
  let seen
  service.registerProvider({
    name: 'slow',
    search: (_query, options) => {
      seen = options
      return new Promise(() => {})
    },
  })
  service.registerProvider(provider('alpha', [hit('dsh://alpha/a', 0.4)]))

  const started = Date.now()
  const result = await service.search('x', { timeoutMs: 25 })
  assert.ok(Date.now() - started < 2000)
  assert.equal(result.total, 1)
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/a'])
  assert.deepEqual(result.errors, [{
    source: 'slow',
    code: 'provider_timeout',
    message: 'seek: provider "slow" timed out after 25 ms',
  }])
  assert.equal(seen.timeoutMs, 25)
  assert.ok(seen.signal instanceof AbortSignal)
  assert.equal(seen.signal.aborted, true)
})

test('a slow provider that rejects on abort does not affect the other providers', async () => {
  const { service } = setup()
  service.registerProvider({
    name: 'slow',
    search: (_query, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }),
  })
  service.registerProvider(provider('alpha', [hit('dsh://alpha/a', 0.4)]))
  const result = await service.search('x', { timeoutMs: 20 })
  assert.deepEqual(result.hits.map(item => item.ref), ['dsh://alpha/a'])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'provider_timeout')
})

test('caller abort is forwarded to providers and stops the query', async () => {
  const { service } = setup()
  const controller = new AbortController()
  let seen
  service.registerProvider({
    name: 'hang',
    search: (_query, options) => {
      seen = options
      return new Promise(() => {})
    },
  })

  const pending = service.search('x', { signal: controller.signal, timeoutMs: 5000 })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'aborted')
  assert.equal(seen.signal.aborted, true)

  const already = new AbortController()
  already.abort()
  await assert.rejects(
    service.search('x', { signal: already.signal }),
    error => error.code === 'aborted',
  )
})

test('overlong and dot-segment refs are rejected as invalid hits', async () => {
  const { service } = setup()
  const longestRef = `dsh://alpha/${'a'.repeat(MAX_REF_LENGTH - 'dsh://alpha/'.length)}`
  service.registerProvider(provider('alpha', [
    { ref: `dsh://alpha/${'a'.repeat(MAX_REF_LENGTH)}`, source: 'alpha', title: 'too long', snippet: 's' },
    { ref: 'dsh://alpha/../secret', source: 'alpha', title: 'traversal', snippet: 's' },
    { ref: longestRef, source: 'alpha', title: 'max', snippet: 's' },
  ]))
  const result = await service.search('x')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].title, 'max')
  assert.equal(result.hits[0].ref.length, MAX_REF_LENGTH)
  assert.equal(result.errors[0].code, 'invalid_hit')
  assert.match(result.errors[0].message, /2 hit\(s\) omitted/)
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
    message: '2 hit(s) omitted: refs must use dsh://<source>/<id> (at most 512 characters) and match hit.source',
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
      tainted: true,
      taintSource: 'alpha',
      resolvable: false,
    },
    {
      ref: 'dsh://alpha/bare',
      source: 'alpha',
      title: '',
      snippet: '',
      tainted: true,
      taintSource: 'alpha',
      resolvable: false,
    },
  ])
})

test('parseRef validates the dsh ref format', () => {
  assert.deepEqual(parseRef('dsh://locator/src/index.js'), { source: 'locator', id: 'src/index.js' })
  assert.deepEqual(parseRef('dsh://notes/a-b_c.d~e'), { source: 'notes', id: 'a-b_c.d~e' })
  const longestId = 'a'.repeat(MAX_REF_LENGTH - 'dsh://locator/'.length)
  assert.deepEqual(parseRef(`dsh://locator/${longestId}`), { source: 'locator', id: longestId })
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
    'dsh://locator/../secret',
    'dsh://locator/a/./b',
    'dsh://locator/..',
    `dsh://locator/${longestId}a`,
    `dsh://locator/${'x'.repeat(MAX_REF_LENGTH)}`,
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
  for (const timeoutMs of [0, -1, 1.5, '10', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(service.search('x', { timeoutMs }), error => error.code === 'invalid_timeout')
  }
  await assert.rejects(service.search('x', { signal: {} }), error => error.code === 'invalid_signal')
  await assert.rejects(service.search('x', { signal: null }), error => error.code === 'invalid_signal')
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

  const providers = await ctx._tools.get('seek_providers').execute()
  assert.deepEqual(providers.providers, ['alpha'])
  assert.deepEqual(providers.sources.map(source => [source.name, source.status]), [
    ['alpha', 'ready'],
    ['locator', 'unavailable'],
    ['memento', 'unavailable'],
    ['trace', 'unavailable'],
  ])
  await assert.rejects(
    ctx._tools.get('seek_search').execute({}),
    error => error.code === 'invalid_query',
  )
})

test('seek_search forwards exec.signal to providers', async () => {
  const { ctx, service } = setup()
  service.registerProvider({ name: 'hang', search: () => new Promise(() => {}) })
  const controller = new AbortController()
  const pending = ctx._tools.get('seek_search').execute(
    { query: 'x', sources: ['hang'] },
    { signal: controller.signal },
  )
  controller.abort()
  await assert.rejects(pending, error => error.code === 'aborted')
  await assert.rejects(
    ctx._tools.get('seek_search').execute({ query: 'x' }, { signal: { aborted: false } }),
    error => error.code === 'invalid_signal',
  )
})

test('resolve routes by source and normalizes the provider answer', async () => {
  const { service } = setup()
  const calls = []
  service.registerProvider({
    name: 'alpha',
    search: () => [],
    async resolve(ref, options) {
      calls.push({ ref, options })
      return {
        status: 'stale',
        title: 'A',
        freshness: { state: 'stale', observedAt: 9 },
        checkedAt: 1234,
      }
    },
  })

  const result = await service.resolve('dsh://alpha/a', {
    cwd: '/work',
    agentKey: 'reviewer',
    agent: { session: { id: 's1' } },
  })
  assert.deepEqual(result, {
    ref: 'dsh://alpha/a',
    found: true,
    status: 'stale',
    source: 'alpha',
    checkedAt: 1234,
    title: 'A',
    freshness: { state: 'stale', observedAt: 9 },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ref, 'dsh://alpha/a')
  assert.equal(calls[0].options.source, 'alpha')
  assert.equal(calls[0].options.id, 'a')
  assert.equal(calls[0].options.cwd, '/work')
  assert.equal(calls[0].options.agentKey, 'reviewer')
  assert.equal(calls[0].options.agent.session.id, 's1')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.equal(calls[0].options.signal.aborted, false)
})

test('resolve reports missing and tombstoned refs as not found', async () => {
  const { service } = setup()
  service.registerProvider({
    name: 'alpha',
    search: () => [],
    resolve: () => ({ status: 'missing', checkedAt: 7 }),
  })
  const missing = await service.resolve('dsh://alpha/gone')
  assert.deepEqual(missing, {
    ref: 'dsh://alpha/gone',
    found: false,
    status: 'missing',
    source: 'alpha',
    checkedAt: 7,
  })

  service.unregisterProvider('alpha')
  service.registerProvider({
    name: 'alpha',
    search: () => [],
    resolve: () => ({ found: false, status: 'tombstoned' }),
  })
  const tombstoned = await service.resolve('dsh://alpha/old')
  assert.equal(tombstoned.found, false)
  assert.equal(tombstoned.status, 'tombstoned')
  assert.equal(typeof tombstoned.checkedAt, 'number')
})

test('resolve rejects malformed refs and options with E_INVALID_ARGUMENT', async () => {
  const { service } = setup()
  for (const bad of [
    undefined,
    null,
    '',
    'ref://locator/x',
    'dsh:///x',
    'dsh://Locator/x',
    'dsh://locator/',
    'dsh://locator/a b',
    'dsh://locator/../secret',
  ]) {
    await assert.rejects(
      service.resolve(bad),
      error => error.code === 'E_INVALID_ARGUMENT',
      `expected invalid ref: ${String(bad)}`,
    )
  }
  await assert.rejects(
    service.resolve('dsh://ghost/x', null),
    error => error.code === 'E_INVALID_ARGUMENT',
  )
  await assert.rejects(
    service.resolve('dsh://ghost/x', { timeoutMs: 0 }),
    error => error.code === 'invalid_timeout',
  )
  await assert.rejects(
    service.resolve('dsh://ghost/x', { signal: {} }),
    error => error.code === 'invalid_signal',
  )
})

test('resolve returns unsupported without a provider or a resolve function', async () => {
  const { service } = setup()
  const ghost = await service.resolve('dsh://ghost/x')
  assert.equal(ghost.found, false)
  assert.equal(ghost.status, 'unsupported')
  assert.equal(ghost.source, 'ghost')
  assert.equal(typeof ghost.checkedAt, 'number')

  service.registerProvider({ name: 'plain', search: () => [] })
  const plain = await service.resolve('dsh://plain/x')
  assert.equal(plain.found, false)
  assert.equal(plain.status, 'unsupported')
  assert.equal(plain.source, 'plain')
})

test('resolve isolates provider timeout, failure and malformed answers', async () => {
  const { service } = setup()
  service.registerProvider({
    name: 'slow',
    search: () => [],
    resolve: () => new Promise(() => {}),
  })
  const started = Date.now()
  const timedOut = await service.resolve('dsh://slow/x', { timeoutMs: 25 })
  assert.ok(Date.now() - started < 1000)
  assert.equal(timedOut.found, false)
  assert.equal(timedOut.status, 'timeout')
  assert.equal(timedOut.source, 'slow')
  assert.equal(timedOut.error.code, 'provider_timeout')

  service.registerProvider({
    name: 'broken',
    search: () => [],
    resolve: () => {
      throw Object.assign(new Error('boom'), { code: 'E_UNAVAILABLE' })
    },
  })
  const failed = await service.resolve('dsh://broken/x')
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.error, { code: 'E_UNAVAILABLE', message: 'boom' })

  service.registerProvider({ name: 'weird', search: () => [], resolve: () => ({ status: 'fresh-ish' }) })
  const malformed = await service.resolve('dsh://weird/x')
  assert.equal(malformed.status, 'error')
  assert.equal(malformed.error.code, 'E_STATE')
})

test('resolve forwards caller cancellation', async () => {
  const { service } = setup()
  service.registerProvider({
    name: 'slow',
    search: () => [],
    resolve: (_ref, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }),
  })
  const controller = new AbortController()
  const pending = service.resolve('dsh://slow/x', { signal: controller.signal, timeoutMs: 5000 })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'aborted')
})

test('seek_search marks hits resolvable only when the source has resolve', async () => {
  const { service } = setup()
  service.registerProvider({
    name: 'alpha',
    search: () => [hit('dsh://alpha/a', 0.4)],
    resolve: () => ({ status: 'fresh' }),
  })
  service.registerProvider(provider('beta', [hit('dsh://beta/b', 0.5)]))

  const result = await service.search('x')
  assert.deepEqual(result.hits.map(item => [item.ref, item.resolvable]), [
    ['dsh://beta/b', false],
    ['dsh://alpha/a', true],
  ])
})

test('registerProvider rejects a non-function resolve', () => {
  const { service } = setup()
  assert.throws(
    () => service.registerProvider({ name: 'alpha', search: () => [], resolve: true }),
    error => error.code === 'invalid_provider',
  )
})

test('seek_resolve tool calls the service and forwards the caller context', async () => {
  const { ctx, service } = setup()
  let seen
  service.registerProvider({
    name: 'alpha',
    search: () => [],
    async resolve(ref, options) {
      seen = options
      return { status: 'fresh', title: 'A', checkedAt: 5 }
    },
  })
  const exec = {
    agent: { session: { id: 's1', header: { cwd: '/work', agentPreset: 'reviewer' } } },
    signal: new AbortController().signal,
  }
  const result = await ctx._tools.get('seek_resolve').execute({ ref: 'dsh://alpha/a' }, exec)
  assert.deepEqual(result, {
    ref: 'dsh://alpha/a',
    found: true,
    status: 'fresh',
    source: 'alpha',
    checkedAt: 5,
    title: 'A',
  })
  assert.equal(seen.cwd, '/work')
  assert.equal(seen.agentKey, 'reviewer')
  assert.equal(seen.agent.session.id, 's1')
  assert.ok(seen.signal instanceof AbortSignal)
  assert.equal(seen.signal.aborted, false)

  await assert.rejects(
    ctx._tools.get('seek_resolve').execute({}),
    error => error.code === 'E_INVALID_ARGUMENT',
  )
})
