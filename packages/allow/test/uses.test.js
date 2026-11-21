import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, DEFAULT_MAX_USES, MAX_USES } from '../index.js'

const NOW = 1_700_000_000_000

function harness(config = {}) {
  const clock = { t: NOW }
  const ctx = {
    tools: { register: () => {} },
    provide: () => {},
  }
  const service = apply(ctx, { ...config, now: () => clock.t })
  return { clock, service }
}

const ask = (service, overrides = {}) => service.request({
  subject: 'agent:model', capability: 'act:invoke:fs.write', scope: 'repo:src',
  reason: 'edit one file', ...overrides,
})

const use = (service, subject = 'agent:model', capability = 'act:invoke:fs.write') =>
  service.check({ subject, capability })

test('approve defaults to one use; one approval permits exactly one act_invoke', () => {
  const { service } = harness()
  const request = ask(service)
  assert.equal(request.maxUses, DEFAULT_MAX_USES)

  const { grant } = service.approve({ id: request.id, by: 'alice' })
  assert.equal(grant.maxUses, 1)
  assert.equal(grant.uses, 0)
  assert.equal(grant.lastUsedAt, null)

  // The Act gate calls allow.check with the capability it is about to execute.
  let writes = 0
  const actInvoke = () => {
    const decision = use(service)
    if (!decision.allowed) {
      return { ok: false, code: 'grant_required', reason: decision.reason, remainingUses: decision.remainingUses }
    }
    writes += 1
    return { ok: true }
  }

  assert.deepEqual(actInvoke(), { ok: true })
  const replay = actInvoke()
  assert.deepEqual(replay, {
    ok: false, code: 'grant_required', reason: 'grant_exhausted', remainingUses: 0,
  })
  assert.equal(writes, 1)

  const stored = service.list()[0]
  assert.equal(stored.status, 'used')
  assert.equal(stored.uses, 1)
  assert.equal(stored.lastUsedAt, NOW)
  assert.equal(service.audit().filter(entry => entry.event === 'allowed').length, 1)
  assert.equal(service.audit().filter(entry => entry.event === 'exhausted').length, 1)

  // A repeat approval is idempotent and cannot resurrect the exhausted Grant.
  const again = service.approve({ id: request.id, by: 'alice' })
  assert.equal(again.grant.id, grant.id)
  assert.equal(again.grant.status, 'used')
  assert.equal(service.list().length, 1)
  assert.equal(service.audit().filter(entry => entry.event === 'request-approved').length, 1)
  assert.equal(use(service).allowed, false)
})

test('request maxUses is bounded; approve may only lower it and defaults to one', () => {
  const { service } = harness()
  for (const maxUses of [0, 1.5, MAX_USES + 1, Infinity, '2', null]) {
    assert.throws(() => ask(service, { maxUses }), { code: 'E_MAX_USES' }, String(maxUses))
  }

  const request = ask(service, { maxUses: 3 })
  assert.equal(request.maxUses, 3)
  assert.throws(() => service.approve({ id: request.id, by: 'alice', maxUses: 4 }), { code: 'E_MAX_USES' })
  assert.throws(() => service.approve({ id: request.id, by: 'alice', maxUses: 0 }), { code: 'E_MAX_USES' })
  assert.equal(service.list().length, 0, 'a rejected approval creates no Grant')
  assert.equal(service.requests()[0].status, 'pending')

  assert.throws(() => service.approve({ id: request.id, by: 'alice', subject: 'agent:other' }), { code: 'E_INPUT' })
  assert.throws(() => service.approve({ id: request.id, by: 'alice', approver: 'agent:model' }), { code: 'E_INPUT' })

  const { grant } = service.approve({ id: request.id, by: 'alice', maxUses: 3 })
  assert.equal(grant.maxUses, 3)
  const remaining = [1, 2, 3].map(() => {
    const decision = use(service)
    assert.equal(decision.allowed, true)
    return decision.remainingUses
  })
  assert.deepEqual(remaining, [2, 1, 0])
  assert.equal(use(service).reason, 'grant_exhausted')

  // Omitting maxUses on a wider request still approves one use only.
  const second = ask(service, { subject: 'agent:model-2', maxUses: 3 })
  assert.equal(service.approve({ id: second.id, by: 'alice' }).grant.maxUses, 1)
})

test('legacy allow_issue grants are unlimited and old state loads uses/maxUses defaults', t => {
  const { service } = harness()
  const grant = service.issue({ subject: 's', capability: 'c' })
  assert.equal(grant.maxUses, Infinity)
  assert.equal(grant.uses, 0)
  for (let index = 0; index < 5; index += 1) {
    const decision = service.check({ subject: 's', capability: 'c' })
    assert.equal(decision.allowed, true)
    assert.equal(decision.remainingUses, null)
  }
  assert.equal(service.list()[0].uses, 5)
  const oneShot = service.issue({ subject: 's', capability: 'one-shot', maxUses: 1 })
  assert.equal(oneShot.maxUses, 1)
  assert.equal(service.check({ subject: 's', capability: 'one-shot' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'one-shot' }).reason, 'grant_exhausted')
  assert.equal(service.issue({ subject: 's', capability: 'unlimited', maxUses: Infinity }).maxUses, Infinity)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  for (const version of [1, 2]) {
    writeFileSync(stateFile, JSON.stringify({
      version,
      grants: [{
        id: `grant_legacy_${version}`, subject: 's', capability: 'c', scope: '*', status: 'active',
        createdAt: 1, expiresAt: 9_999_999_999_999, approver: 'user',
      }],
      audit: [],
    }))
    const loaded = harness({ stateFile }).service
    const [old] = loaded.list()
    assert.equal(old.maxUses, Infinity)
    assert.equal(old.uses, 0)
    assert.equal(old.lastUsedAt, null)
    for (let index = 0; index < 3; index += 1) {
      assert.equal(loaded.check({ subject: 's', capability: 'c' }).allowed, true)
    }
  }
})

test('uses survive restart; a one-shot approval cannot be replayed after reload', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-uses-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')

  const first = harness({ stateFile })
  const request = ask(first.service, { maxUses: 2 })
  first.service.approve({ id: request.id, by: 'alice', maxUses: 2 })
  assert.equal(first.service.check({ subject: 'agent:model', capability: 'act:invoke:fs.write' }).remainingUses, 1)

  const second = harness({ stateFile }).service
  const used = second.check({ subject: 'agent:model', capability: 'act:invoke:fs.write' })
  assert.equal(used.allowed, true)
  assert.equal(used.remainingUses, 0)
  assert.equal(used.grant.status, 'used')

  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(raw.version, 2, 'the on-disk version the 0.2 approvals CLI reads is unchanged')
  assert.equal(raw.grants[0].maxUses, 2)
  assert.equal(raw.grants[0].uses, 2)

  const third = harness({ stateFile }).service
  const replay = third.check({ subject: 'agent:model', capability: 'act:invoke:fs.write' })
  assert.equal(replay.allowed, false)
  assert.equal(replay.reason, 'grant_exhausted')
  assert.equal(replay.remainingUses, 0)
  assert.equal(third.list()[0].uses, 2)
})

test('a CLI-written Grant without maxUses adopts its request budget on load', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  const first = harness({ stateFile })
  const request = ask(first.service)
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  const pending = raw.requests.find(item => item.id === request.id)
  // `dsh-os approvals approve` copies scope/hash but predates maxUses.
  raw.grants.push({
    id: 'grant_cli', subject: pending.subject, capability: pending.capability, scope: pending.scope,
    status: 'active', createdAt: NOW, expiresAt: NOW + 86_400_000, approver: 'alice',
    requestId: pending.id, requestHash: pending.requestHash,
  })
  Object.assign(pending, { status: 'approved', grantId: 'grant_cli', decidedBy: 'alice', decidedAt: NOW })
  writeFileSync(stateFile, JSON.stringify(raw))

  const loaded = harness({ stateFile }).service
  assert.equal(loaded.list()[0].maxUses, 1)
  assert.equal(loaded.check({ subject: 'agent:model', capability: 'act:invoke:fs.write' }).allowed, true)
  assert.equal(loaded.check({ subject: 'agent:model', capability: 'act:invoke:fs.write' }).reason, 'grant_exhausted')
})

test('interleaved checks cannot overdraw a single-use Grant', async () => {
  const { service } = harness()
  const request = ask(service, { capability: 'c' })
  service.approve({ id: request.id, by: 'alice' })
  const decisions = await Promise.all(Array.from({ length: 10 }, () =>
    Promise.resolve().then(() => service.check({ subject: 'agent:model', capability: 'c' }))))
  assert.equal(decisions.filter(decision => decision.allowed).length, 1)
  assert.equal(decisions.filter(decision => decision.reason === 'grant_exhausted').length, 9)
  assert.equal(service.list()[0].uses, 1)
})
