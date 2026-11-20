import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, NotifyService } from '../index.js'

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

function setup(config = {}) {
  let now = 1000
  const ctx = fakeContext()
  const service = apply(ctx, { ...config, now: () => now })
  return { ctx, service, advance: ms => { now += ms } }
}

test('apply provides ctx.notify and registers three plain tool definitions', () => {
  const { ctx } = setup()
  assert.ok(ctx.get('notify') instanceof NotifyService)
  assert.deepEqual([...ctx._tools.keys()], ['notify_send', 'notify_channels', 'notify_history'])
  for (const tool of ctx._tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
})

test('registerChannel registers once and channels() lists names in order', () => {
  const { service } = setup()
  assert.deepEqual(service.channels(), [])
  assert.deepEqual(service.registerChannel({ name: 'im', send: async () => {} }), { name: 'im' })
  service.registerChannel({ name: 'desktop', send: async () => {} })
  assert.deepEqual(service.channels(), ['im', 'desktop'])
  assert.throws(
    () => service.registerChannel({ name: 'im', send: async () => {} }),
    error => error.code === 'E_CONFLICT',
  )
  assert.throws(
    () => service.registerChannel({ name: 'bad', send: 'not-a-function' }),
    error => error.code === 'E_INVALID_ARGUMENT',
  )
})

test('send routes title/body/priority to the channel and records the delivery', async () => {
  const { service } = setup()
  const calls = []
  service.registerChannel({ name: 'desktop', send: async payload => calls.push(payload) })
  const result = await service.send({
    channel: 'desktop',
    title: 'Build failed',
    body: 'job 42',
    priority: 'high',
  })
  assert.equal(result.deduped, false)
  const { delivery } = result
  assert.deepEqual(delivery, {
    id: delivery.id,
    channel: 'desktop',
    ok: true,
    error: null,
    at: 1000,
  })
  assert.deepEqual(calls, [{
    id: delivery.id,
    channel: 'desktop',
    title: 'Build failed',
    body: 'job 42',
    priority: 'high',
  }])
  assert.deepEqual(service.history(), [delivery])
})

test('send rejects E_UNAVAILABLE for an unregistered channel and records nothing', async () => {
  const { service } = setup()
  await assert.rejects(
    service.send({ channel: 'nope', title: 'hello' }),
    error => error.code === 'E_UNAVAILABLE',
  )
  await assert.rejects(
    service.send({ channel: 'nope', title: 'hello', priority: 'loud' }),
    error => error.code === 'E_UNAVAILABLE',
  )
  assert.deepEqual(service.history(), [])
})

test('dedupeKey suppresses repeats inside the window and allows them after it', async () => {
  const { service, advance } = setup({ dedupeWindowMs: 1000 })
  let calls = 0
  service.registerChannel({ name: 'im', send: async () => { calls += 1 } })
  const first = await service.send({ channel: 'im', title: 'Hi', dedupeKey: 'ring:t2' })
  const second = await service.send({ channel: 'im', title: 'Hi', dedupeKey: 'ring:t2' })
  assert.equal(calls, 1)
  assert.equal(second.deduped, true)
  assert.equal(second.delivery.id, first.delivery.id)
  assert.equal(service.history().length, 1)

  advance(1000)
  const third = await service.send({ channel: 'im', title: 'Hi', dedupeKey: 'ring:t2' })
  assert.equal(calls, 2)
  assert.equal(third.deduped, false)
  assert.notEqual(third.delivery.id, first.delivery.id)
  assert.equal(service.history().length, 2)
})

test('concurrent sends sharing one dedupeKey deliver exactly once', async () => {
  const { service } = setup()
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  service.registerChannel({ name: 'slow', send: async () => { calls += 1; await gate } })
  const first = service.send({ channel: 'slow', title: 'once', dedupeKey: 'k' })
  const second = service.send({ channel: 'slow', title: 'once', dedupeKey: 'k' })
  assert.equal(calls, 1)
  release()
  const [delivered, duplicate] = await Promise.all([first, second])
  assert.equal(delivered.deduped, false)
  assert.equal(duplicate.deduped, true)
  assert.equal(duplicate.delivery.id, delivered.delivery.id)
  assert.equal(service.history().length, 1)
})

test('a channel failure is recorded as ok:false instead of being thrown', async () => {
  const { service } = setup()
  service.registerChannel({ name: 'im', send: async () => { throw new Error('webhook down') } })
  const result = await service.send({ channel: 'im', title: 'Oops' })
  assert.equal(result.delivery.ok, false)
  assert.equal(result.delivery.error, 'webhook down')
  assert.equal(service.history()[0].ok, false)
})

test('history returns newest first, honors a limit and validates it', async () => {
  const { service, advance } = setup()
  for (const channel of ['a', 'b', 'c']) {
    service.registerChannel({ name: channel, send: async () => {} })
    await service.send({ channel, title: channel })
    advance(1)
  }
  assert.deepEqual(service.history(2).map(entry => entry.channel), ['c', 'b'])
  assert.equal(service.history().length, 3)
  assert.throws(() => service.history(0), error => error.code === 'E_INVALID_ARGUMENT')
  assert.throws(() => service.history(1001), error => error.code === 'E_INVALID_ARGUMENT')
})

test('clear empties the ledger and dedupe memory but keeps channels registered', async () => {
  const { service } = setup()
  let calls = 0
  service.registerChannel({ name: 'im', send: async () => { calls += 1 } })
  await service.send({ channel: 'im', title: 'one', dedupeKey: 'k' })
  assert.deepEqual(service.clear(), { cleared: 1 })
  assert.deepEqual(service.history(), [])
  assert.deepEqual(service.channels(), ['im'])

  const again = await service.send({ channel: 'im', title: 'one', dedupeKey: 'k' })
  assert.equal(again.deduped, false)
  assert.equal(calls, 2)
})

test('notify tools execute against the mounted service', async () => {
  const { ctx } = setup()
  ctx.get('notify').registerChannel({ name: 'desktop', send: async () => {} })
  const sent = await ctx._tools.get('notify_send').execute({ channel: 'desktop', title: 'Hi' })
  assert.equal(sent.delivery.ok, true)
  assert.deepEqual(await ctx._tools.get('notify_channels').execute({}), { channels: ['desktop'] })
  assert.equal((await ctx._tools.get('notify_history').execute({})).history.length, 1)
})
