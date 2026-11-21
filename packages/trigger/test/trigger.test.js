import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, makeTools, summarize, TriggerService } from '../index.js'

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

/** Deterministic clock for cooldown and duration assertions. */
function fakeClock(start = 1000) {
  let value = start
  return { now: () => value, advance: ms => (value += ms) }
}

function setup() {
  const clock = fakeClock()
  const ctx = fakeContext()
  const service = apply(ctx, { now: clock.now })
  return { ctx, service, clock }
}

test('apply provides ctx.triggers, four plain tools, and works without a tool registry', async () => {
  const { ctx, service } = setup()
  assert.ok(service instanceof TriggerService)
  assert.equal(ctx.get('triggers'), service)
  assert.deepEqual([...ctx._tools.keys()], [
    'trigger_register', 'trigger_list', 'trigger_fire', 'trigger_runs',
    'trigger_sources', 'trigger_source_start', 'trigger_source_stop',
  ])
  for (const definition of makeTools(service)) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }

  const services = new Map()
  const bare = apply({ provide: (name, value) => services.set(name, value) })
  assert.equal(services.get('triggers'), bare)
  assert.deepEqual((await bare.fire('nobody/listens')).runs, [])
})

test('fire matches the exact event, runs actions and records one run each', async () => {
  const { service, clock } = setup()
  const calls = []
  service.register({
    id: 'tg_first',
    event: 'demo/ping',
    action: (payload, context) => {
      calls.push(['first', payload, context.event])
      return { pong: true }
    },
  })
  service.register({
    id: 'tg_second',
    event: 'demo/ping',
    action: async payload => calls.push(['second', payload]),
  })
  service.register({ id: 'tg_other', event: 'demo/other', action: () => calls.push(['other']) })

  clock.advance(10)
  const fired = await service.fire('demo/ping', { n: 1 })

  assert.deepEqual(calls.map(call => call[0]), ['first', 'second'])
  assert.equal(fired.event, 'demo/ping')
  assert.deepEqual(fired.skipped, [])
  assert.equal(fired.runs.length, 2)
  assert.deepEqual(fired.results.find(entry => entry.triggerId === 'tg_first').result, { pong: true })
  for (const run of fired.runs) {
    assert.deepEqual(Object.keys(run).sort(), [
      'durationMs', 'error', 'event', 'id', 'ok', 'path', 'payload', 'startedAt', 'triggerId',
    ])
    assert.match(run.id, /^run_/)
    assert.equal(run.event, 'demo/ping')
    assert.equal(run.ok, true)
    assert.equal(run.error, null)
    assert.equal(run.startedAt, 1010)
    assert.equal(run.durationMs, 0)
    assert.deepEqual(run.payload, { n: 1 })
    assert.equal(run.path, null)
  }
  assert.deepEqual(service.runs().map(run => run.triggerId), ['tg_second', 'tg_first'])
  assert.equal(service.list().length, 3)
  assert.equal(summarize(service.list()[0]).action, 'function')
})

test('runs keep a redacted, bounded payload and an event display path', async () => {
  const { ctx, service } = setup()
  service.register({ id: 'tg_fs', event: 'fs.change', action: 'record' })
  const payload = {
    type: 'fs.change',
    path: '/work/reports/app.txt',
    kind: 'change',
    access_token: 'ghp_abcdefghijklmnopqrstuvwxyz012345',
    nested: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', note: 'AKIAABCDEFGHIJKLMNOP' },
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----',
    blob: 'x'.repeat(20_000),
  }
  await service.fire('fs.change', payload)

  const [run] = service.runs(1)
  assert.equal(run.path, 'app.txt')
  assert.equal(run.payload.path, '/work/reports/app.txt')
  assert.equal(run.payload.kind, 'change')
  assert.equal(run.payload.access_token, '[REDACTED]')
  assert.equal(run.payload.nested.apiKey, '[REDACTED]')
  assert.equal(run.payload.pem, '[REDACTED_PRIVATE_KEY]')
  assert.match(run.payload.nested.note, /\[REDACTED_AWS_KEY\]/)
  assert.ok(run.payload.blob.endsWith('…[truncated]'))

  const stored = JSON.stringify(run.payload)
  for (const raw of ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'sk-abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'MIIEsecret']) {
    assert.equal(stored.includes(raw), false, `payload leaks ${raw.slice(0, 8)}`)
  }
  assert.ok(Buffer.byteLength(stored) <= 2048)
  assert.ok(Object.isFrozen(run.payload))
  assert.ok(Object.isFrozen(run.payload.nested))

  // The projection is what trigger_runs exposes, and it never mutates the
  // live payload that conditions and actions receive.
  const viaTool = await ctx._tools.get('trigger_runs').execute({ limit: 1 })
  assert.equal(viaTool.runs[0].path, 'app.txt')
  assert.deepEqual(viaTool.runs[0].payload.nested, { apiKey: '[REDACTED]', note: '[REDACTED_AWS_KEY]' })
  assert.equal(payload.nested.apiKey, 'sk-abcdefghijklmnopqrstuvwxyz')
  assert.equal(payload.blob.length, 20_000)

  // A path inside the working directory stays relative, with no leading `./`.
  const inside = `${process.cwd()}/test/fixture.txt`
  await service.fire('fs.change', { path: inside, kind: 'add' })
  assert.equal(service.runs(1)[0].path, 'test/fixture.txt')

  // The display path is a redaction surface too: a token in a directory name
  // must not reach the ledger just because it is not inside the payload.
  const secretPath = `${process.cwd()}/sk-abcdefghijklmnopqrstuvwxyz/fixture.txt`
  await service.fire('fs.change', { path: secretPath })
  const secretRun = service.runs(1)[0]
  assert.equal(secretRun.path.includes('sk-abcdefghijklmnopqrstuvwxyz'), false)
  assert.match(secretRun.path, /REDACTED_API_KEY/)
})

test('oversized nested payloads degrade to a bounded redacted preview', async () => {
  const { service } = setup()
  service.register({ id: 'tg_big', event: 'big', action: () => {} })
  const noisy = `${String.fromCharCode(1)}${'"'.repeat(300)}`
  const item = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, noisy]))
  const payload = {
    items: Array.from({ length: 32 }, () => item),
    note: 'ghp_abcdefghijklmnopqrstuvwxyz012345',
    path: '/work/deep.txt',
  }
  await service.fire('big', payload)

  const run = service.runs(1)[0]
  assert.equal(run.path, 'deep.txt')
  assert.equal(run.payload.truncated, true)
  assert.equal(typeof run.payload.preview, 'string')
  const stored = JSON.stringify(run.payload)
  assert.ok(Buffer.byteLength(stored) <= 2048)
  assert.equal(stored.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), false)
})

test('conditions filter with a function and the field/op/value DSL', async () => {
  const { service } = setup()
  const hits = []
  service.register({
    id: 'tg_fn',
    event: 'turn/end',
    condition: payload => payload.reason === 'error',
    action: () => hits.push('fn'),
  })
  service.register({
    id: 'tg_starts',
    event: 'file/changed',
    condition: { field: 'payload.name', op: 'startsWith', value: 'report' },
    action: () => hits.push('starts'),
  })
  service.register({
    id: 'tg_size',
    event: 'file/changed',
    condition: { field: 'meta.size', op: 'gt', value: 10 },
    action: () => hits.push('size'),
  })
  service.register({
    id: 'tg_kind',
    event: 'file/changed',
    condition: { field: 'kind', op: 'in', value: ['a', 'b'] },
    action: () => hits.push('kind'),
  })

  const hit = await service.fire('turn/end', { reason: 'error' })
  assert.equal(hit.runs.length, 1)
  const miss = await service.fire('turn/end', { reason: 'completed' })
  assert.equal(miss.runs.length, 0)
  assert.deepEqual(miss.skipped, [{ triggerId: 'tg_fn', reason: 'condition' }])

  const files = await service.fire('file/changed', {
    name: 'report.pdf', meta: { size: 11 }, kind: 'b',
  })
  assert.equal(files.runs.length, 3)
  assert.deepEqual(hits, ['fn', 'starts', 'size', 'kind'])

  const missing = await service.fire('file/changed', { name: 'notes.txt', meta: { size: 1 } })
  assert.equal(missing.runs.length, 0)
  assert.deepEqual(missing.skipped.map(item => item.reason), ['condition', 'condition', 'condition'])

  service.register({ id: 'tg_exists', event: 'x', condition: { field: 'a.b', op: 'exists' }, action: () => {} })
  assert.equal((await service.fire('x', { a: { b: false } })).runs.length, 1)
  assert.equal((await service.fire('x', { a: {} })).runs.length, 0)

  assert.throws(
    () => service.register({ id: 'bad_op', event: 'x', condition: { field: 'a', op: 'nope' }, action: () => {} }),
    { code: 'invalid_condition' },
  )
  assert.throws(
    () => service.register({ id: 'bad_in', event: 'x', condition: { field: 'a', op: 'in', value: 'a' }, action: () => {} }),
    { code: 'invalid_condition' },
  )
  assert.throws(
    () => service.register({ id: 'bad_cond', event: 'x', condition: 'nope', action: () => {} }),
    { code: 'invalid_condition' },
  )
  assert.throws(
    () => service.register({ id: 'bad_field', event: 'x', condition: { field: 'a..b', op: 'eq', value: 1 }, action: () => {} }),
    { code: 'invalid_condition' },
  )
})

test('cooldown skips inside the window and fires again at the boundary', async () => {
  const { service, clock } = setup()
  let calls = 0
  const trigger = service.register({
    id: 'tg_cool',
    event: 'tick',
    cooldownMs: 1000,
    action: () => {
      calls += 1
    },
  })
  assert.equal(trigger.cooldownMs, 1000)

  assert.equal((await service.fire('tick')).runs.length, 1)
  clock.advance(500)
  const skipped = await service.fire('tick')
  assert.equal(skipped.runs.length, 0)
  assert.deepEqual(skipped.skipped, [{ triggerId: 'tg_cool', reason: 'cooldown' }])
  assert.equal(calls, 1)

  clock.advance(500)
  assert.equal((await service.fire('tick')).runs.length, 1)
  assert.equal(calls, 2)

  assert.equal(service.unregister('tg_cool'), true)
  assert.equal(service.unregister('tg_cool'), false)
  clock.advance(1)
  assert.equal((await service.fire('tick')).runs.length, 0)
})

test('action failures are recorded, do not reject fire, and do not block later triggers', async () => {
  const { service } = setup()
  service.register({
    id: 'tg_boom',
    event: 'e',
    action: () => {
      throw new Error('kaboom')
    },
  })
  service.register({ id: 'tg_after', event: 'e', action: payload => payload })

  const fired = await service.fire('e', { x: 1 })
  assert.equal(fired.runs.length, 2)
  const failed = fired.runs.find(run => run.triggerId === 'tg_boom')
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'kaboom')
  assert.equal(failed.durationMs, 0)
  assert.equal(fired.runs.find(run => run.triggerId === 'tg_after').ok, true)
  assert.deepEqual(fired.results.map(entry => entry.triggerId), ['tg_after'])
  assert.equal(service.runs(1)[0].triggerId, 'tg_after')

  service.register({
    id: 'tg_async',
    event: 'async',
    action: async () => {
      throw new Error('later')
    },
  })
  const settled = await service.fire('async')
  assert.equal(settled.runs[0].ok, false)
  assert.equal(settled.runs[0].error, 'later')
})

test('runs returns newest first, honours limit and validates it', async () => {
  const { service } = setup()
  service.register({ id: 'tg_run', event: 'e', action: () => {} })
  for (let index = 0; index < 4; index += 1) await service.fire('e', { index })

  const all = service.runs()
  assert.equal(all.length, 4)
  assert.equal(new Set(all.map(run => run.id)).size, 4)
  const ids = all.map(run => run.id)
  assert.deepEqual(service.runs(2).map(run => run.id), ids.slice(0, 2))
  assert.deepEqual(service.runs(0), [])
  assert.deepEqual(service.runs(99), all)
  assert.throws(() => service.runs(-1), { code: 'invalid_limit' })
  assert.throws(() => service.runs(1.5), { code: 'invalid_limit' })
})

test('registration validates ids, events, actions, cooldowns and duplicates', () => {
  const { service } = setup()
  service.register({ id: 'tg_ok', event: 'e', action: () => {} })
  assert.throws(() => service.register({ id: 'tg_ok', event: 'e', action: () => {} }), { code: 'trigger_exists' })
  assert.throws(() => service.register({ id: '', event: 'e', action: () => {} }), { code: 'invalid_trigger' })
  assert.throws(() => service.register({ id: 'tg_x', event: '', action: () => {} }), { code: 'invalid_trigger' })
  assert.throws(() => service.register({ id: 'tg_x', event: 'e', action: 'nope' }), { code: 'unknown_action' })
  assert.throws(() => service.register({ id: 'tg_x', event: 'e', action: 'not-fn' }), { code: 'unknown_action' })
  assert.throws(() => service.register({ id: 'tg_x', event: 'e', action: () => {}, cooldownMs: -1 }), { code: 'invalid_trigger' })
  assert.throws(() => service.register({ id: 'tg_x', event: 'e', action: () => {}, cooldownMs: 'soon' }), { code: 'invalid_trigger' })
  assert.throws(() => service.register({ id: 'tg_x', event: 'e' }), { code: 'invalid_trigger' })
  assert.throws(() => service.register(null), { code: 'invalid_trigger' })
  assert.equal(service.list().length, 1)
})

test('tools drive the built-in record and echo actions end to end', async () => {
  const { ctx } = setup()
  const register = args => ctx._tools.get('trigger_register').execute(args)
  const fire = args => ctx._tools.get('trigger_fire').execute(args)
  const list = () => ctx._tools.get('trigger_list').execute({})
  const runs = args => ctx._tools.get('trigger_runs').execute(args)

  const echo = await register({ id: 'tg_echo', event: 'demo/ping', actionId: 'echo' })
  assert.deepEqual(echo.trigger, {
    id: 'tg_echo', event: 'demo/ping', cooldownMs: 0, action: 'echo', condition: null,
  })

  const payload = { text: 'hi' }
  const echoed = await fire({ event: 'demo/ping', payload })
  assert.equal(echoed.runs.length, 1)
  assert.equal(echoed.runs[0].ok, true)
  assert.deepEqual(echoed.results[0].result, payload)
  assert.equal(echoed.skipped.length, 0)

  await register({ id: 'tg_record', event: 'demo/ping', actionId: 'record' })
  const recorded = await fire({ event: 'demo/ping', payload })
  assert.equal(recorded.runs.length, 2)
  const recordEntry = recorded.results.find(entry => entry.triggerId === 'tg_record')
  assert.equal(recordEntry.result.recorded, true)
  assert.equal(recordEntry.result.runId, recorded.runs.find(run => run.triggerId === 'tg_record').id)

  assert.deepEqual((await list()).triggers.map(trigger => trigger.id), ['tg_echo', 'tg_record'])
  const recent = await runs({ limit: 1 })
  assert.equal(recent.runs.length, 1)
  assert.equal(recent.runs[0].triggerId, 'tg_record')

  await assert.rejects(register({ id: 'tg_bad', event: 'e', actionId: 'nope' }), /unknown built-in action/)
  await assert.rejects(register({ id: '', event: 'e', actionId: 'echo' }), { code: 'invalid_arguments' })
  await assert.rejects(fire({}), { code: 'invalid_arguments' })
})
