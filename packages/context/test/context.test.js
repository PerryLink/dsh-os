import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextService, apply } from '../index.js'

const T0 = 1_700_000_000_000
const provider = (name, get) => ({ name, get })
const service = () => new ContextService({ now: () => T0 })

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
  }
}

test('register, list and unregister providers', () => {
  const context = service()
  assert.deepEqual(context.providers(), [])
  assert.deepEqual(
    context.registerProvider(provider('editor', () => ({ app: { id: 'editor' } }))),
    { name: 'editor' },
  )
  context.registerProvider(provider('shell', () => ({ window: { id: 'shell' } })))
  assert.deepEqual(context.providers(), [{ name: 'editor' }, { name: 'shell' }])
  assert.equal(context.unregisterProvider('editor'), true)
  assert.equal(context.unregisterProvider('editor'), false)
  assert.deepEqual(context.providers(), [{ name: 'shell' }])
})

test('snapshot calls providers in parallel and merges by provider name', async () => {
  const context = service()
  let started = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = label => provider(label, async () => {
    started += 1
    if (started === 2) release()
    await gate
    return { app: { id: label } }
  })
  context.registerProvider(slow('one'))
  context.registerProvider(slow('two'))
  const pending = context.snapshot()
  assert.equal(started, 2, 'both providers start before either resolves')
  release()
  const snapshot = await pending
  assert.equal(snapshot.schema, 'dsh.context.snapshot/v1')
  assert.equal(snapshot.at, T0)
  assert.deepEqual(snapshot.providers, ['one', 'two'])
  assert.deepEqual(snapshot.context, {
    one: { app: { id: 'one' } },
    two: { app: { id: 'two' } },
  })
  assert.deepEqual(snapshot.errors, [])
})

test('one failing provider is isolated in errors', async () => {
  const context = service()
  context.registerProvider(provider('ok', () => ({ selection: { chars: 3 } })))
  context.registerProvider(provider('sync', () => {
    throw Object.assign(new Error('no window'), { code: 'E_DENIED' })
  }))
  context.registerProvider(provider('async', async () => {
    throw new Error('provider offline')
  }))
  context.registerProvider(provider('bad-shape', () => ['not', 'an', 'object']))
  const snapshot = await context.snapshot()
  assert.deepEqual(snapshot.context, { ok: { selection: { chars: 3 } } })
  assert.equal(snapshot.errors.length, 3)
  const errors = Object.fromEntries(snapshot.errors.map(entry => [entry.provider, entry]))
  assert.equal(errors.sync.code, 'E_DENIED')
  assert.equal(errors.sync.message, 'no window')
  assert.equal(errors.async.code, 'E_UNAVAILABLE')
  assert.equal(errors['bad-shape'].code, 'E_STATE')
})

test('invalid providers and duplicate names are rejected', () => {
  const context = service()
  assert.throws(() => context.registerProvider(null), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => context.registerProvider({ name: 'x' }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => context.registerProvider({ name: 'x', get: 'nope' }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => context.registerProvider({ name: 'Bad Name', get() {} }), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => context.unregisterProvider('Bad Name'), { code: 'E_INVALID_ARGUMENT' })
  context.registerProvider(provider('x', () => ({})))
  assert.throws(() => context.registerProvider(provider('x', () => ({}))), { code: 'E_CONFLICT' })
  assert.equal(context.providers().length, 1)
})

test('snapshot filters, validates names and clones payloads', async () => {
  const context = service()
  const shared = { app: { id: 'shared' }, clipboard: { kind: 'metadata' } }
  let calls = 0
  context.registerProvider(provider('editor', () => (calls += 1, shared)))
  context.registerProvider(provider('other', () => (calls += 1, { files: [] })))
  const first = await context.snapshot({ providers: ['editor', 'editor'] })
  assert.deepEqual(first.providers, ['editor'])
  assert.equal(calls, 1)
  assert.equal(first.context.editor.clipboard.kind, 'metadata')
  first.context.editor.app.id = 'mutated'
  assert.equal(shared.app.id, 'shared')
  const second = await context.snapshot({ providers: ['editor'] })
  assert.equal(second.context.editor.app.id, 'shared')
  assert.deepEqual((await context.snapshot({ providers: [] })).context, {})
  await assert.rejects(context.snapshot({ providers: 'editor' }), { code: 'E_INVALID_ARGUMENT' })
  await assert.rejects(context.snapshot({ providers: ['missing'] }), { code: 'E_NOT_FOUND' })
})

test('unknown provider fields fail only that provider', async () => {
  const context = service()
  context.registerProvider(provider('good', () => ({ files: ['a.txt'] })))
  context.registerProvider(provider('bad', () => ({ mouse: { x: 1 } })))
  const snapshot = await context.snapshot()
  assert.deepEqual(snapshot.context, { good: { files: ['a.txt'] } })
  assert.equal(snapshot.errors.length, 1)
  assert.equal(snapshot.errors[0].provider, 'bad')
  assert.equal(snapshot.errors[0].code, 'E_INVALID_ARGUMENT')
})

test('apply wires ctx.context and the three tools', async () => {
  const ctx = fakeContext()
  const context = apply(ctx)
  assert.ok(context instanceof ContextService)
  assert.equal(ctx.get('context'), context)
  assert.deepEqual([...ctx._tools.keys()], [
    'context_snapshot', 'context_providers', 'context_register_demo',
  ])

  const list = ctx._tools.get('context_providers')
  assert.deepEqual(await list.execute({}), { providers: [] })
  const register = ctx._tools.get('context_register_demo')
  assert.equal((await register.execute({})).registered, true)
  assert.equal((await register.execute({})).registered, false)
  assert.deepEqual(await list.execute({}), { providers: [{ name: 'demo', demo: true }] })

  const snapshotTool = ctx._tools.get('context_snapshot')
  const snapshot = await snapshotTool.execute({})
  assert.equal(snapshot.schema, 'dsh.context.snapshot/v1')
  assert.equal(snapshot.context.demo.app.demo, true)
  assert.equal(snapshot.context.demo.app.id, 'demo.app')
  assert.equal(snapshot.context.demo.clipboard, undefined)
  await assert.rejects(snapshotTool.execute('nope'), { code: 'E_INVALID_ARGUMENT' })
})

test('apply works without a tool registry', () => {
  const ctx = { provide(name, value) { this.provided = { name, value } } }
  const context = apply(ctx)
  assert.equal(ctx.provided.name, 'context')
  assert.equal(ctx.provided.value, context)
})
