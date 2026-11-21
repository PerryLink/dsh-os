import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  const listeners = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    _tools: tools,
    _emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
  }
}

test('agent-source runs carry taint on the run and its stored payload', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  service.register({ id: 'tg_agent', event: 'session/turn-end', action: 'record' })
  const source = await service.startSource('agent')

  ctx._emit('session/event', { id: 'ses_1' }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()

  const [run] = service.runs(1)
  assert.equal(run.tainted, true)
  assert.equal(run.taintSource, 'agent')
  assert.equal(run.payload.tainted, true)
  assert.equal(run.payload.taintSource, 'agent')
  assert.equal(run.payload.type, 'session/turn-end')
  assert.equal(await service.stopSource(source.id), true)
})

test('host fire options set taint; trigger_fire and plain fire stay untainted', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  let livePayload
  service.register({ id: 'tg_x', event: 'e', action: payload => { livePayload = payload } })

  const tainted = await service.fire('e', { x: 1 }, { tainted: true, taintSource: 'webhook' })
  assert.equal(tainted.runs[0].tainted, true)
  assert.equal(tainted.runs[0].taintSource, 'webhook')
  assert.equal(tainted.runs[0].payload.tainted, true)
  assert.equal(tainted.runs[0].payload.taintSource, 'webhook')
  assert.deepEqual(livePayload, { x: 1 }, 'actions still receive the live, unmodified payload')

  const plain = await service.fire('e', { x: 2 })
  assert.deepEqual(Object.keys(plain.runs[0]).sort(), [
    'durationMs', 'error', 'event', 'id', 'ok', 'path', 'payload', 'startedAt', 'triggerId',
  ])
  assert.equal('tainted' in plain.runs[0].payload, false)

  const viaTool = await ctx._tools.get('trigger_fire').execute({ event: 'e', payload: { x: 3 } })
  assert.equal('tainted' in viaTool.runs[0], false, 'model-authored trigger_fire payload is not source taint')
  assert.equal('tainted' in viaTool.runs[0].payload, false)
})
