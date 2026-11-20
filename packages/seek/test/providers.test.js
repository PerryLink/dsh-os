import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, parseRef, registerDefaultProviders } from '../index.js'
import { createLocatorProvider } from '../lib/providers/locator.js'
import { createMementoProvider } from '../lib/providers/memento.js'

/** Fake Cordis context with a tool registry and optional host services. */
function fakeContext({ tools = [], memory } = {}) {
  const registry = new Map(tools.map(tool => [tool.name, tool]))
  const services = new Map()
  const toolService = {
    get: name => registry.get(name),
    register: definition => (registry.set(definition.name, definition), () => registry.delete(definition.name)),
  }
  services.set('tools', toolService)
  if (memory !== undefined) services.set('memory', memory)
  return {
    tools: toolService,
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _registry: registry,
    _services: services,
  }
}

function setup(options) {
  const ctx = fakeContext(options)
  return { ctx, service: apply(ctx) }
}

function fakeLocator(hits, calls = []) {
  return {
    name: 'locator_find',
    async execute(args, exec) {
      calls.push({ args, exec })
      return typeof hits === 'function' ? await hits(args, exec) : { ok: true, hits }
    },
  }
}

function fakeMemory(entries, calls = []) {
  return {
    query(filter, opts) {
      calls.push({ filter, opts })
      return { entries: typeof entries === 'function' ? entries(filter, opts) : entries, total: 0, truncated: false }
    },
  }
}

test('apply auto-registers locator and memento when their host services exist', () => {
  const { ctx, service } = setup({ tools: [fakeLocator([])], memory: fakeMemory([]) })
  assert.deepEqual(service.providers(), ['locator', 'memento'])
  assert.deepEqual(service.sources(), [
    { name: 'locator', status: 'ready' },
    { name: 'memento', status: 'ready' },
  ])
  assert.deepEqual(
    [...ctx._registry.keys()].filter(name => name.startsWith('seek_')),
    ['seek_search', 'seek_providers', 'seek_register_defaults'],
  )
})

test('missing optional plugins are reported as unavailable, not thrown', async () => {
  const { ctx, service } = setup()
  assert.deepEqual(service.providers(), [])
  const report = await ctx._registry.get('seek_providers').execute()
  assert.deepEqual(report.providers, [])
  assert.deepEqual(report.sources.map(source => source.status), ['unavailable', 'unavailable'])
  assert.match(report.sources[0].reason, /locator_find/)
  assert.match(report.sources[1].reason, /memory/)
})

test('locator hits map to dsh://locator/<path> with caller cwd and freshness', async () => {
  const calls = []
  const locator = fakeLocator([
    {
      kind: 'file',
      path: '/work/src/a.ts',
      title: 'A',
      snippet: 'retry once',
      score: 0.9,
      freshness: { state: 'fresh', observedAt: 7 },
      permissions: { read: 'allowed' },
    },
    { kind: 'file', path: '/work/docs/b c.md', refStatus: 'stale' },
    { kind: 'file', path: '/work/../secret', title: 'traversal' },
    { kind: 'file', path: '/work/secret.txt', title: 'denied', permissions: { read: 'denied' } },
  ], calls)
  const { service } = setup({ tools: [locator] })

  const result = await service.search('retry', {
    cwd: '/work',
    limit: 5,
    agent: { session: { id: 's1' } },
  })

  assert.deepEqual(result.hits.map(hit => hit.ref), [
    'dsh://locator/src/a.ts',
    'dsh://locator/docs/b%20c.md',
  ])
  assert.equal(result.hits[0].source, 'locator')
  assert.equal(result.hits[0].title, 'A')
  assert.equal(result.hits[0].snippet, 'retry once')
  assert.equal(result.hits[0].score, 0.9)
  assert.deepEqual(result.hits[0].freshness, { state: 'fresh', observedAt: 7 })
  assert.deepEqual(result.hits[1].freshness, { state: 'stale' })
  assert.equal(result.hits[1].score, 1 / 61)
  assert.deepEqual(result.errors, [])
  for (const hit of result.hits) assert.ok(parseRef(hit.ref) !== undefined, hit.ref)

  assert.equal(calls[0].args.mode, 'content')
  assert.equal(calls[0].args.scope, 'workspace')
  assert.equal(calls[0].args.pathPrefix, '/work')
  assert.equal(calls[0].args.limit, 5)
  assert.equal(calls[0].exec.agent.session.id, 's1')
})

test('locator ref ids are workspace-relative and percent-encoded', async () => {
  const locator = fakeLocator([
    { kind: 'file', path: '/work/a b#c?.ts' },
    { kind: 'file', path: '/work/x/./y' },
    { kind: 'file', path: '/work/a/../b' },
    { kind: 'file', path: '/other/keep.txt' },
  ])
  const { service } = setup({ tools: [locator] })
  const result = await service.search('x', { cwd: '/work' })
  assert.deepEqual(result.hits.map(hit => hit.ref), [
    'dsh://locator/a%20b%23c%3F.ts',
    'dsh://locator/x/y',
    'dsh://locator/other/keep.txt',
  ])
  assert.equal(decodeURIComponent(parseRef(result.hits[0].ref).id), 'a b#c?.ts')
})

test('locator refs normalize Windows separators and drive cwd', async () => {
  const locator = fakeLocator([
    { kind: 'file', path: 'C:\\work\\src\\a.ts' },
    { kind: 'file', path: 'C:\\work\\a\\..\\b.ts' },
  ])
  const { service } = setup({ tools: [locator] })
  const result = await service.search('x', { cwd: 'C:\\work' })
  assert.deepEqual(result.hits.map(hit => hit.ref), ['dsh://locator/src/a.ts'])
})

test('empty locator results stay an empty, successful query', async () => {
  const { service } = setup({ tools: [fakeLocator([])] })
  assert.deepEqual(await service.search('nothing', { cwd: '/work' }), {
    query: 'nothing',
    hits: [],
    total: 0,
    errors: [],
  })
})

test('locator provider fails closed without its tool or caller cwd', async () => {
  await assert.rejects(
    createLocatorProvider(fakeContext()).search('x', { cwd: '/work' }),
    error => error.code === 'E_UNAVAILABLE',
  )
  await assert.rejects(
    createLocatorProvider(fakeContext({ tools: [fakeLocator([])] })).search('x'),
    error => error.code === 'E_UNAUTHORIZED',
  )
})

test('locator ACL denials surface as E_UNAUTHORIZED errors', async () => {
  const locator = fakeLocator(() => ({ ok: false, error: 'content-path-denied: cwd is outside roots' }))
  const { service } = setup({ tools: [locator] })
  const result = await service.search('x', { cwd: '/outside' })
  assert.deepEqual(result.hits, [])
  assert.equal(result.errors[0].source, 'locator')
  assert.equal(result.errors[0].code, 'E_UNAUTHORIZED')
})

test('a hanging locator_find is bounded by the per-provider timeout', async () => {
  const hang = { name: 'locator_find', execute: () => new Promise(() => {}) }
  const { service } = setup({ tools: [hang] })
  const started = Date.now()
  const result = await service.search('x', { cwd: '/work', timeoutMs: 25 })
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.errors, [{
    source: 'locator',
    code: 'provider_timeout',
    message: 'seek: provider "locator" timed out after 25 ms',
  }])
})

test('memento maps user-global entries and filters by agentKey', async () => {
  const calls = []
  const memory = fakeMemory([
    {
      id: '11111111-1111-4111-8111-111111111111',
      scope: 'user-global',
      agentKey: '',
      text: 'Retry policy: 3 attempts\nDetails',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'user-global',
      agentKey: 'reviewer',
      text: 'Reviewer note',
    },
    { id: '33333333-3333-4333-8333-333333333333', scope: 'workspace', agentKey: '', text: 'workspace secret' },
    { id: '44444444-4444-4444-8444-444444444444', scope: 'user-global', agentKey: 'other', text: 'other agent' },
  ], calls)
  const { service } = setup({ memory })

  const result = await service.search('retry', { limit: 5, agentKey: 'reviewer', agent: {} })
  assert.deepEqual(result.hits.map(hit => hit.ref), [
    'dsh://memento/11111111-1111-4111-8111-111111111111',
    'dsh://memento/22222222-2222-4222-8222-222222222222',
  ])
  assert.deepEqual(calls[0].filter, { text: 'retry', limit: 5, scope: 'user-global' })
  assert.deepEqual(calls[0].opts, { agentKey: 'reviewer' })
  assert.equal(result.hits[0].source, 'memento')
  assert.equal(result.hits[0].title, 'Retry policy: 3 attempts')
  assert.equal(result.hits[0].snippet, 'Retry policy: 3 attempts\nDetails')
  assert.equal(result.hits[0].score, 1 / 60)
  assert.deepEqual(result.hits[0].freshness, { state: 'unknown' })
  assert.deepEqual(result.errors, [])
})

test('memento provider fails closed without its service or a caller', async () => {
  await assert.rejects(
    createMementoProvider(fakeContext()).search('x', { agentKey: 'reviewer' }),
    error => error.code === 'E_UNAVAILABLE',
  )
  await assert.rejects(
    createMementoProvider(fakeContext({ memory: fakeMemory([]) })).search('x'),
    error => error.code === 'E_UNAUTHORIZED',
  )
})

test('seek_register_defaults retries after optional plugins mount', async () => {
  const { ctx } = setup()
  const register = ctx._registry.get('seek_register_defaults')

  let report = await register.execute()
  assert.deepEqual(report.providers, [])
  assert.equal(report.sources.filter(source => source.status === 'unavailable').length, 2)

  ctx._registry.set('locator_find', fakeLocator([{ kind: 'file', path: '/work/a.ts' }]))
  ctx._services.set('memory', fakeMemory([
    { id: 'id-1', scope: 'user-global', agentKey: '', text: 'm' },
  ]))

  report = await register.execute()
  assert.deepEqual(report.providers, ['locator', 'memento'])
  assert.deepEqual(report.sources, [
    { name: 'locator', status: 'ready' },
    { name: 'memento', status: 'ready' },
  ])

  report = await register.execute()
  assert.deepEqual(report.providers, ['locator', 'memento'])
})

test('registerDefaultProviders is idempotent and returns statuses', () => {
  const { ctx, service } = setup({ tools: [fakeLocator([])] })
  assert.deepEqual(registerDefaultProviders(ctx, service), [
    { name: 'locator', status: 'ready' },
    { name: 'memento', status: 'unavailable', reason: 'memory service is not available (install/enable dsh-memento)' },
  ])
  assert.deepEqual(service.providers(), ['locator'])
  assert.deepEqual(registerDefaultProviders(ctx, service).map(status => status.status), ['ready', 'unavailable'])
})

test('seek_search without a caller fails first-party providers closed', async () => {
  const memoryCalls = []
  const { ctx } = setup({ tools: [fakeLocator([])], memory: fakeMemory([], memoryCalls) })
  const result = await ctx._registry.get('seek_search').execute({ query: 'x' })
  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.errors.map(error => error.code).sort(), ['E_UNAUTHORIZED', 'E_UNAUTHORIZED'])
  assert.equal(memoryCalls.length, 0)
})

test('seek_search forwards exec.agent cwd and agentKey to providers', async () => {
  const locatorCalls = []
  const memoryCalls = []
  const { ctx } = setup({
    tools: [fakeLocator([], locatorCalls)],
    memory: fakeMemory([], memoryCalls),
  })
  const exec = {
    agent: { session: { id: 's1', header: { cwd: '/work', agentPreset: 'reviewer' } } },
    signal: new AbortController().signal,
  }
  const result = await ctx._registry.get('seek_search').execute({ query: 'x' }, exec)
  assert.deepEqual(result.hits, [])
  assert.equal(locatorCalls[0].args.pathPrefix, '/work')
  assert.equal(locatorCalls[0].exec.agent.session.id, 's1')
  assert.deepEqual(memoryCalls[0].opts, { agentKey: 'reviewer' })
})
