import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, RingService } from '../index.js'

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

const T0 = 0
const T1 = 3 * 60 * 1000
const T2 = 10 * 60 * 1000
const T3 = 30 * 60 * 1000
const TTL = 60 * 60 * 1000

function setup(config = {}) {
  const ctx = fakeContext()
  const service = apply(ctx, { now: () => 0, ...config })
  return { ctx, service }
}

function state(service, id) {
  return service.get(id)
}

test('apply provides ctx.ring and registers five plain tool definitions', () => {
  const { ctx } = setup()
  assert.ok(ctx.get('ring') instanceof RingService)
  assert.deepEqual([...ctx._tools.keys()], ['ring_raise', 'ring_ack', 'ring_escalate', 'ring_list', 'ring_receipts'])
  for (const tool of ctx._tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
})

test('raise -> tick(t0) -> notified -> ack -> resolve, with receipts', () => {
  const { service } = setup()
  const raised = service.raise({ source: 'approval' })
  assert.equal(raised.state, 'pending')
  assert.equal(raised.risk, 'write')
  assert.equal(raised.level, 0)
  assert.equal(raised.createdAt, T0)
  assert.equal(raised.expiresAt, T0 + TTL)
  assert.equal(raised.escalationChain.length, 4)

  const notified = service.tick(T0)
  assert.equal(notified.receipts.length, 1)
  assert.equal(notified.receipts[0].kind, 'delivery')
  assert.equal(state(service, raised.id).state, 'notified')

  const acked = service.ack(raised.id, { by: 'alice' })
  assert.equal(acked.state, 'acked')
  assert.equal(acked.ackedBy, 'alice')
  assert.equal(acked.ackedAt, T0)

  // Ack stops escalation even after t1.
  assert.equal(service.tick(T1).receipts.length, 0)
  assert.equal(state(service, raised.id).state, 'acked')

  const resolved = service.resolve(raised.id, { decision: 'allowed-once' })
  assert.equal(resolved.state, 'resolved')
  assert.equal(resolved.decision, 'allowed-once')
  assert.equal(resolved.resolvedAt, T0)

  const receipts = service.receipts(raised.id)
  assert.deepEqual(receipts.map(receipt => receipt.kind), ['delivery', 'ack', 'decision'])
  assert.deepEqual(receipts[0], { id: receipts[0].id, caseId: raised.id, kind: 'delivery', at: T0, channel: 'local', to: 't0' })
  assert.deepEqual(receipts[1], { id: receipts[1].id, caseId: raised.id, kind: 'ack', at: T0, by: 'alice' })
  for (const receipt of receipts) {
    assert.equal(typeof receipt.id, 'string')
    assert.equal(receipt.caseId, raised.id)
    assert.equal(Number.isFinite(receipt.at), true)
  }
})

test('illegal transitions throw E_STATE and do not mutate the case', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'manual' })
  service.tick(T0)
  service.ack(kase.id, { by: 'alice' })
  service.resolve(kase.id, { decision: 'rejected' })

  assert.throws(() => service.ack(kase.id, { by: 'bob' }), { code: 'E_STATE' })
  assert.throws(() => service.escalate(kase.id, { to: 1 }), { code: 'E_STATE' })
  assert.throws(() => service.resolve(kase.id, { decision: 'rejected' }), { code: 'E_STATE' })
  assert.equal(state(service, kase.id).state, 'resolved')

  const acked = service.raise({ source: 'hook' })
  service.ack(acked.id, { by: 'alice' })
  assert.throws(() => service.escalate(acked.id, { to: 1 }), { code: 'E_STATE' })

  const expired = service.raise({ source: 'job', ttlMs: T1 })
  service.tick(T1)
  assert.equal(state(service, expired.id).state, 'expired')
  assert.throws(() => service.ack(expired.id, { by: 'alice' }), { code: 'E_STATE' })
  assert.throws(() => service.escalate(expired.id), { code: 'E_STATE' })
  // Expired is terminal for direct decisions: ack and resolve must not put the
  // case back into an active state. Only an explicit late page may revive it.
  assert.throws(() => service.resolve(expired.id, { decision: 'unavailable' }), { code: 'E_STATE' })
  assert.equal(state(service, expired.id).state, 'expired')
  assert.equal(service.escalate(expired.id, { to: 1 }).state, 'escalated')
  const late = service.resolve(expired.id, { decision: 'unavailable' })
  assert.equal(late.state, 'resolved')
  assert.equal(late.late, true)
  assert.deepEqual(service.receipts(expired.id).map(receipt => receipt.kind), [
    'expiry', 'escalation', 'decision',
  ])
  assert.equal(state(service, expired.id).state, 'resolved')
})

test('tick escalates t1 -> t2 -> t3, then expires at the TTL', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'approval', risk: 'danger', ttlMs: TTL })
  service.tick(T0)

  const t1 = service.tick(T1)
  assert.equal(t1.receipts.length, 1)
  assert.equal(t1.receipts[0].kind, 'escalation')
  assert.equal(t1.receipts[0].to, 't1')
  assert.equal(t1.receipts[0].channel, 'local')
  assert.equal(state(service, kase.id).state, 'escalated')
  assert.equal(state(service, kase.id).level, 1)

  const t2 = service.tick(T2)
  assert.equal(t2.receipts[0].to, 't2')
  assert.equal(t2.receipts[0].channel, 'webhook')
  assert.equal(state(service, kase.id).level, 2)

  const t3 = service.tick(T3)
  assert.equal(t3.receipts[0].to, 't3')
  assert.equal(t3.receipts[0].channel, 'voice')
  assert.equal(state(service, kase.id).level, 3)

  const expired = service.tick(TTL)
  assert.equal(expired.receipts.length, 1)
  assert.equal(expired.receipts[0].kind, 'expiry')
  assert.equal(state(service, kase.id).state, 'expired')

  // Expiry stops automatic escalation, and ticks are idempotent once closed.
  assert.equal(service.tick(TTL + T3).receipts.length, 0)
  assert.deepEqual(service.receipts(kase.id).map(receipt => receipt.kind), [
    'delivery', 'escalation', 'escalation', 'escalation', 'expiry',
  ])
})

test('tick never re-escalates a resolved case and receipts stay immutable', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'approval', ttlMs: TTL })
  service.tick(T0)
  service.tick(T1)
  const handled = service.resolve(kase.id, { decision: 'allowed' })
  assert.equal(handled.state, 'resolved')
  const ledger = service.receipts(kase.id)
  assert.deepEqual(ledger.map(receipt => receipt.kind), ['delivery', 'escalation', 'decision'])

  // A resolved case is closed for tick and for every manual transition.
  const later = service.tick(T2)
  assert.deepEqual(later.receipts, [])
  assert.deepEqual(later.cases, [])
  const after = service.tick(TTL + T3)
  assert.deepEqual(after.receipts, [])
  assert.equal(state(service, kase.id).state, 'resolved')
  assert.equal(state(service, kase.id).level, 1)
  assert.deepEqual(service.receipts(kase.id), ledger)
  assert.throws(() => service.escalate(kase.id, { to: 2 }), { code: 'E_STATE' })
  assert.throws(() => service.ack(kase.id, { by: 'alice' }), { code: 'E_STATE' })
  assert.throws(() => service.resolve(kase.id, { decision: 'again' }), { code: 'E_STATE' })

  // Receipts are defensive copies: mutating a returned entry cannot rewrite the
  // append-only ledger, and each read yields fresh objects.
  ledger[0].kind = 'mutated'
  const again = service.receipts(kase.id)
  assert.equal(again[0].kind, 'delivery')
  assert.notEqual(again[0], service.receipts(kase.id)[0])
  again[2].at = -1
  assert.notEqual(service.receipts(kase.id)[2].at, -1)
  assert.deepEqual(service.receipts(kase.id).map(receipt => receipt.kind), ['delivery', 'escalation', 'decision'])

  const blocked = service.raise({ source: 'manual', ttlMs: T1 })
  service.tick(T1)
  const expiredReceipts = service.receipts(blocked.id)
  assert.deepEqual(expiredReceipts.map(receipt => receipt.kind), ['expiry'])
  expiredReceipts[0].kind = 'mutated'
  assert.deepEqual(service.receipts(blocked.id).map(receipt => receipt.kind), ['expiry'])
})

test('a large tick jump emits t0 plus one catch-up escalation at the highest due level', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'approval' })
  const result = service.tick(T3)
  assert.deepEqual(result.receipts.map(receipt => receipt.kind), ['delivery', 'escalation'])
  assert.equal(result.receipts[1].to, 't3')
  assert.equal(state(service, kase.id).state, 'escalated')
  assert.equal(state(service, kase.id).level, 3)
  assert.equal(result.cases.length, 1)
})

test('manual escalate advances one level, accepts targets, and validates input', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'act' })

  const first = service.escalate(kase.id)
  assert.equal(first.state, 'escalated')
  assert.equal(first.level, 1)
  assert.equal(service.receipts(kase.id).at(-1).to, 't1')

  const third = service.escalate(kase.id, { to: 't3' })
  assert.equal(third.level, 3)
  assert.equal(service.receipts(kase.id).at(-1).to, 't3')
  assert.throws(() => service.escalate(kase.id), { code: 'E_STATE' })
  assert.throws(() => service.escalate(kase.id, { to: 2 }), { code: 'E_INPUT' })
  assert.throws(() => service.escalate(kase.id, { to: 0 }), { code: 'E_INPUT' })

  const labelled = service.raise({ source: 'manual' })
  const named = service.escalate(labelled.id, { to: 'on-call' })
  assert.equal(named.state, 'escalated')
  assert.equal(named.level, 1)
  assert.equal(service.receipts(labelled.id).at(-1).to, 'on-call')
})

test('custom escalation chains, list filters, clones and unknown ids', () => {
  const { service } = setup()
  const kase = service.raise({
    source: 'hook',
    escalationChain: [{ afterMs: 0 }, { afterMs: 1000, channel: 'local' }, { afterMs: 2000, channel: 'webhook' }],
  })
  service.tick(0)
  const jumped = service.tick(2000)
  assert.equal(jumped.receipts.length, 1)
  assert.equal(jumped.receipts[0].to, 't2')
  assert.equal(state(service, kase.id).level, 2)

  const pending = service.raise({ source: 'manual' })
  assert.deepEqual(service.list({ status: 'pending' }).map(item => item.id), [pending.id])
  assert.deepEqual(service.list({ status: ['notified', 'escalated'] }).map(item => item.id), [kase.id])
  assert.equal(service.list().length, 2)
  assert.throws(() => service.list({ status: 'bogus' }), { code: 'E_INPUT' })

  const copy = service.get(kase.id)
  copy.state = 'resolved'
  copy.escalationChain[0].channel = 'mutated'
  assert.equal(state(service, kase.id).state, 'escalated')
  const receipts = service.receipts(kase.id)
  receipts[0].kind = 'mutated'
  assert.equal(service.receipts(kase.id)[0].kind, 'delivery')

  assert.equal(service.get('missing'), undefined)
  assert.throws(() => service.receipts('missing'), { code: 'E_NOT_FOUND' })
  assert.throws(() => service.ack('missing', { by: 'alice' }), { code: 'E_NOT_FOUND' })
  assert.throws(() => service.raise({ source: '' }), { code: 'E_INPUT' })
  assert.throws(() => service.raise({ source: 'manual', risk: 'root' }), { code: 'E_INPUT' })
  assert.throws(() => service.raise({ source: 'manual', ttlMs: 0 }), { code: 'E_TTL' })
  assert.throws(() => service.raise({ source: 'manual', escalationChain: [] }), { code: 'E_CHAIN' })
})

test('agent tools create, escalate, acknowledge, list and read receipts', async () => {
  const { ctx } = setup()
  const tools = ctx._tools
  const raised = await tools.get('ring_raise').execute({ source: 'manual', risk: 'exec' })
  assert.equal(raised.case.state, 'pending')
  const escalated = await tools.get('ring_escalate').execute({ id: raised.case.id, to: 2 })
  assert.equal(escalated.case.state, 'escalated')
  assert.equal(escalated.case.level, 2)
  assert.deepEqual((await tools.get('ring_receipts').execute({ id: raised.case.id })).receipts.map(receipt => receipt.kind), ['escalation'])
  assert.deepEqual((await tools.get('ring_list').execute({ status: 'escalated' })).cases.map(item => item.id), [raised.case.id])
  assert.equal((await tools.get('ring_ack').execute({ id: raised.case.id, by: 'alice' })).case.state, 'acked')
  assert.equal(tools.has('ring_resolve'), false)

  const expired = ctx.get('ring').raise({ source: 'job', ttlMs: 1 })
  ctx.get('ring').tick(1)
  await assert.rejects(
    tools.get('ring_ack').execute({ id: expired.id, by: 'alice' }),
    { code: 'E_STATE' },
  )
  await assert.rejects(
    tools.get('ring_escalate').execute({ id: expired.id }),
    { code: 'E_STATE' },
  )
  assert.equal((await tools.get('ring_escalate').execute({ id: expired.id, to: 1 })).case.state, 'escalated')
})

test('an explicitly targeted escalation can record a late page on an expired case', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'manual', ttlMs: 1000 })
  service.tick(1000)
  assert.equal(state(service, kase.id).state, 'expired')
  // Expired cannot be acked or resolved directly; only a late page reopens it.
  assert.throws(() => service.ack(kase.id, { by: 'alice' }), { code: 'E_STATE' })
  assert.throws(() => service.resolve(kase.id, { decision: 'cancelled' }), { code: 'E_STATE' })
  const revived = service.escalate(kase.id, { to: 1 })
  assert.equal(revived.state, 'escalated')
  assert.equal(service.receipts(kase.id).at(-1).to, 't1')
  assert.equal(service.tick(2000).receipts.length, 0)
  const decided = service.resolve(kase.id, { decision: 'cancelled' })
  assert.equal(decided.state, 'resolved')
  assert.equal(decided.late, true)
})

test('a late page can target any level on a case that expired at t3', () => {
  const { service } = setup()
  const kase = service.raise({ source: 'approval' })
  service.tick(T0)
  service.tick(T3)
  service.tick(TTL)
  assert.equal(state(service, kase.id).state, 'expired')
  assert.equal(state(service, kase.id).level, 3)
  const late = service.escalate(kase.id, { to: 1 })
  assert.equal(late.state, 'escalated')
  assert.equal(late.level, 3)
  assert.equal(service.receipts(kase.id).at(-1).to, 't1')
})
