import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply, DEFAULT_TTL_MS, MAX_AUDIT_ENTRIES, MAX_CHECK_AUDIT_ENTRIES, MAX_TTL_MS,
} from '../index.js'

const HOUR = 60 * 60 * 1000

function fakeContext(config = {}) {
  const clock = { t: 1_700_000_000_000 }
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
  const service = apply(ctx, { ...config, now: () => clock.t })
  return { ctx, clock, service }
}

test('issue then check allows a matching grant and records usedAt', () => {
  const { service, clock } = fakeContext()
  const grant = service.issue({ subject: 'agent:planner', capability: 'fs.write', scope: 'repo:src' })

  assert.equal(grant.status, 'active')
  assert.equal(grant.subject, 'agent:planner')
  assert.equal(grant.capability, 'fs.write')
  assert.equal(grant.scope, 'repo:src')
  assert.equal(grant.approver, 'user')
  assert.equal(grant.createdAt, clock.t)
  assert.equal(grant.expiresAt, clock.t + DEFAULT_TTL_MS)

  const result = service.check({ subject: 'agent:planner', capability: 'fs.write', scope: 'repo:src' })
  assert.equal(result.allowed, true)
  assert.equal(result.reason, 'allowed')
  assert.equal(result.grant.id, grant.id)
  assert.equal(result.grant.usedAt, clock.t)
})

test('scope patterns: *, prefix:* and arrays', () => {
  const { service } = fakeContext()
  const any = service.issue({ subject: 's', capability: 'c', scope: '*' })
  assert.equal(service.check({ subject: 's', capability: 'c', scope: 'anything' }).allowed, true)

  const prefix = service.issue({ subject: 's', capability: 'repo.read', scope: 'repo:*' })
  assert.equal(service.check({ subject: 's', capability: 'repo.read', scope: 'repo:src/a.js' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'repo.read', scope: 'repo:src' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'repo.read', scope: 'repositories' }).allowed, false)
  assert.equal(prefix.scope, 'repo:*')

  const exact = service.issue({ subject: 's', capability: 'exact', scope: 'a:b' })
  assert.equal(service.check({ subject: 's', capability: 'exact', scope: 'a:b' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'exact', scope: 'a:b:c' }).allowed, false)
  assert.equal(exact.scope, 'a:b')

  service.issue({ subject: 's', capability: 'array', scope: ['one', 'two:*'] })
  assert.equal(service.check({ subject: 's', capability: 'array', scope: 'one' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'array', scope: 'two:deep' }).allowed, true)
  assert.equal(service.check({ subject: 's', capability: 'array', scope: 'three' }).allowed, false)
  assert.equal(any.scope, '*')
})

test('check denies unknown subjects, capabilities and scope mismatches', () => {
  const { service } = fakeContext()
  assert.deepEqual(
    service.check({ subject: 'nobody', capability: 'fs.write', scope: 'x' }),
    { allowed: false, reason: 'no-grant', remainingUses: null },
  )

  service.issue({ subject: 's', capability: 'fs.write', scope: 'repo:src' })
  const wrongCapability = service.check({ subject: 's', capability: 'fs.delete', scope: 'repo:src' })
  assert.equal(wrongCapability.allowed, false)
  assert.equal(wrongCapability.reason, 'no-grant')

  const wrongScope = service.check({ subject: 's', capability: 'fs.write', scope: 'repo:other' })
  assert.equal(wrongScope.allowed, false)
  assert.equal(wrongScope.reason, 'scope-mismatch')
  assert.equal(wrongScope.grant.status, 'active')
})

test('expiry is evaluated with the clock and materialized in status/list/audit', () => {
  const { service, clock } = fakeContext()
  const grant = service.issue({ subject: 's', capability: 'c', scope: '*', ttlMs: 1000 })

  clock.t += 999
  assert.equal(service.check({ subject: 's', capability: 'c', scope: 'x' }).allowed, true)
  clock.t += 1

  const result = service.check({ subject: 's', capability: 'c', scope: 'x' })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'expired')
  assert.equal(result.grant.id, grant.id)
  assert.equal(result.grant.status, 'expired')
  assert.equal(service.list({ status: 'active' }).length, 0)
  assert.equal(service.list({ status: 'expired' }).length, 1)
  assert.equal(service.audit().filter(entry => entry.event === 'expired').length, 1)
})

test('revoke is immediate and idempotent', () => {
  const { service } = fakeContext()
  const grant = service.issue({ subject: 's', capability: 'c', scope: '*' })

  const revoked = service.revoke(grant.id)
  assert.equal(revoked.status, 'revoked')
  const again = service.revoke(grant.id)
  assert.equal(again.status, 'revoked')

  const result = service.check({ subject: 's', capability: 'c', scope: 'x' })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'revoked')
  assert.equal(result.grant.id, grant.id)
})

test('list filters and audit ordering/limits', () => {
  const { service } = fakeContext()
  const first = service.issue({ subject: 'a', capability: 'c1', scope: '*', approver: 'cli' })
  const second = service.issue({ subject: 'b', capability: 'c2', scope: '*', approver: 'user' })
  service.check({ subject: 'a', capability: 'c1', scope: 'x' })
  service.revoke(second.id)

  assert.equal(service.list().length, 2)
  assert.deepEqual(service.list({ subject: 'a' }).map(grant => grant.id), [first.id])
  assert.deepEqual(service.list({ capability: 'c2' }).map(grant => grant.id), [second.id])
  assert.deepEqual(service.list({ approver: 'cli' }).map(grant => grant.id), [first.id])
  assert.deepEqual(service.list({ status: 'revoked' }).map(grant => grant.id), [second.id])

  const audit = service.audit()
  assert.deepEqual(audit.slice(0, 4).map(entry => entry.event), ['revoked', 'allowed', 'issued', 'issued'])
  assert.equal(service.audit(2).length, 2)
  assert.equal(service.audit(2)[0].event, 'revoked')
  assert.throws(() => service.audit(0), { code: 'E_LIMIT' })
})

test('validates subject, capability, scope, approver and ttl', () => {
  const { service } = fakeContext()
  assert.throws(() => service.issue({ capability: 'c' }), { code: 'E_SUBJECT' })
  assert.throws(() => service.issue({ subject: '   ', capability: 'c' }), { code: 'E_SUBJECT' })
  assert.throws(() => service.issue({ subject: 's', capability: ' ' }), { code: 'E_CAPABILITY' })
  assert.throws(() => service.issue({ subject: 's'.repeat(257), capability: 'c' }), { code: 'E_SUBJECT' })
  assert.throws(() => service.issue({ subject: 's', capability: 'c', scope: [] }), { code: 'E_SCOPE' })
  assert.throws(() => service.issue({ subject: 's', capability: 'c', scope: ['ok', 1] }), { code: 'E_SCOPE' })
  assert.throws(() => service.issue({ subject: 's', capability: 'c', ttlMs: 0 }), { code: 'E_TTL' })
  assert.throws(() => service.issue({ subject: 's', capability: 'c', ttlMs: MAX_TTL_MS + 1 }), { code: 'E_TTL' })
  assert.throws(() => service.issue({ subject: 's', capability: 'c', approver: '' }), { code: 'E_APPROVER' })
  assert.throws(() => service.revoke('grant_missing'), { code: 'E_GRANT_NOT_FOUND' })
})

test('evidence is cloned, not aliased', () => {
  const { service } = fakeContext()
  const evidence = { sessionId: 'session-1', callId: 'call-1' }
  const grant = service.issue({ subject: 's', capability: 'c', evidence })
  evidence.sessionId = 'mutated'
  assert.equal(grant.evidence.sessionId, 'session-1')
  assert.equal(service.list()[0].evidence.sessionId, 'session-1')
})

test('default apply exposes only request/wait/list/check tools (no self-grant)', async () => {
  const { ctx, service } = fakeContext()
  assert.equal(ctx.get('allow'), service)
  assert.deepEqual([...ctx._tools.keys()], ['allow_check', 'allow_request', 'allow_wait', 'allow_requests'])
  assert.equal(ctx._tools.get('allow_issue'), undefined)
  assert.equal(ctx._tools.get('allow_revoke'), undefined)
  assert.equal(ctx._tools.get('allow_list'), undefined)
  assert.equal(ctx._tools.get('allow_approve'), undefined)
  assert.equal(ctx._tools.get('allow_deny'), undefined)
})

test('human-facing clients can opt into the admin tools', async () => {
  const { ctx, service } = fakeContext({ exposeAdminTools: true })
  assert.equal(ctx.get('allow'), service)
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    'allow_approve', 'allow_check', 'allow_deny', 'allow_issue', 'allow_list',
    'allow_request', 'allow_requests', 'allow_revoke', 'allow_wait',
  ])

  const issueTool = ctx._tools.get('allow_issue')
  assert.equal(issueTool.parameters.type, 'object')
  assert.equal(issueTool.parameters.required[0], 'subject')
  assert.deepEqual(issueTool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])

  const grant = await issueTool.execute({ subject: 'agent:tool', capability: 'fs.write', scope: 'repo:*' })
  const checked = await ctx._tools.get('allow_check').execute({
    subject: 'agent:tool',
    capability: 'fs.write',
    scope: 'repo:file.js',
  })
  assert.equal(checked.allowed, true)

  const listed = await ctx._tools.get('allow_list').execute({ subject: 'agent:tool' })
  assert.equal(listed.grants.length, 1)
  assert.equal(listed.grants[0].id, grant.id)

  const revoked = await ctx._tools.get('allow_revoke').execute({ id: grant.id, subject: 'agent:tool' })
  assert.equal(revoked.status, 'revoked')
})

test('admin tools are subject-scoped: no fleet-wide listing or cross-subject revoke', async () => {
  const { ctx } = fakeContext({ exposeAdminTools: true })
  const issue = ctx._tools.get('allow_issue')
  const list = ctx._tools.get('allow_list')
  const revoke = ctx._tools.get('allow_revoke')
  const alice = await issue.execute({ subject: 'human:alice', capability: 'fs.write', scope: '*' })
  await issue.execute({ subject: 'agent:bob', capability: 'fs.write', scope: '*' })

  assert.deepEqual(list.parameters.required, ['subject'])
  await assert.rejects(list.execute({}), { code: 'E_SUBJECT' })
  assert.deepEqual((await list.execute({ subject: 'agent:bob' })).grants.map(grant => grant.subject), ['agent:bob'])

  assert.deepEqual(revoke.parameters.required, ['id', 'subject'])
  await assert.rejects(revoke.execute({ id: alice.id, subject: 'agent:bob' }), { code: 'E_SUBJECT_MISMATCH' })
  assert.equal((await list.execute({ subject: 'human:alice' })).grants[0].status, 'active')

  const revoked = await revoke.execute({ id: alice.id, subject: 'human:alice' })
  assert.equal(revoked.status, 'revoked')
  assert.throws(() => ctx.get('allow').revoke(alice.id, { subject: 'agent:bob' }), { code: 'E_SUBJECT_MISMATCH' })
})

test('stateFile round-trips grants and audit through atomic JSON writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-test-'))
  try {
    const stateFile = join(dir, 'state.json')
    const first = fakeContext({ stateFile })
    const grant = first.service.issue({ subject: 's', capability: 'c', scope: 'repo:*' })

    const raw = readFileSync(stateFile, 'utf8')
    assert.match(raw, new RegExp(grant.id))
    assert.deepEqual(readdirSync(dir), ['state.json'])

    const second = fakeContext({ stateFile })
    assert.equal(second.service.list().length, 1)
    assert.equal(second.service.auditStats().totals.security, 1)
    const result = second.service.check({ subject: 's', capability: 'c', scope: 'repo:a' })
    assert.equal(result.allowed, true)
    assert.equal(second.service.audit().some(entry => entry.event === 'allowed'), true)

    writeFileSync(stateFile, '{not json')
    assert.throws(() => fakeContext({ stateFile }), { code: 'E_STATE' })
    rmSync(stateFile)
    const empty = fakeContext({ stateFile })
    assert.equal(empty.service.list().length, 0)
  } finally {
    assert.ok(dir.startsWith(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a persisted grant with a non-numeric expiresAt is dropped (fail closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-corrupt-'))
  const stateFile = join(dir, 'state.json')
  try {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      grants: [{
        id: 'g1', subject: 's', capability: 'c', scope: '*', status: 'active',
        createdAt: 1, expiresAt: 'never', approver: 'user',
      }],
      audit: [],
    }))
    const { service } = fakeContext({ stateFile })
    assert.deepEqual(service.check({ subject: 's', capability: 'c' }), { allowed: false, reason: 'no-grant', remainingUses: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2100 checks cannot evict issued/revoked audit events', () => {
  const { service } = fakeContext()
  const grant = service.issue({ subject: 's', capability: 'c', scope: '*' })
  for (let index = 0; index < 2100; index += 1) {
    assert.equal(service.check({ subject: 's', capability: 'c', scope: 'x' }).allowed, true)
  }

  let events = service.audit(MAX_AUDIT_ENTRIES)
  assert.equal(events.filter(entry => entry.event === 'issued').length, 1)
  assert.equal(events.filter(entry => entry.event === 'allowed').length, MAX_CHECK_AUDIT_ENTRIES)

  service.revoke(grant.id)
  events = service.audit(MAX_AUDIT_ENTRIES)
  assert.equal(events.filter(entry => entry.event === 'issued').length, 1)
  assert.equal(events.filter(entry => entry.event === 'revoked').length, 1)

  const stats = service.auditStats()
  assert.deepEqual(stats.totals, { allowed: 2100, denied: 0, security: 2 })
  assert.equal(stats.retained.allowed, MAX_CHECK_AUDIT_ENTRIES)
  assert.equal(stats.retained.security, 2)
})

test('a malicious flood of security events is capped at MAX_AUDIT_ENTRIES', () => {
  const { service } = fakeContext()
  for (let index = 0; index < MAX_AUDIT_ENTRIES + 100; index += 1) {
    service.issue({ subject: `s${index}`, capability: 'c' })
  }
  const events = service.audit(MAX_AUDIT_ENTRIES)
  assert.equal(events.length, MAX_AUDIT_ENTRIES)
  assert.equal(service.auditStats().totals.security, MAX_AUDIT_ENTRIES + 100)
  assert.equal(events[0].event, 'issued')
  assert.equal(events.at(-1).seq, 101)
})

test('checks answer from memory without rewriting the state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-nowrite-'))
  const stateFile = join(dir, 'state.json')
  try {
    const { service } = fakeContext({ stateFile })
    service.issue({ subject: 's', capability: 'c', scope: '*' })
    const before = readFileSync(stateFile, 'utf8')
    for (let index = 0; index < 50; index += 1) service.check({ subject: 's', capability: 'c', scope: 'x' })
    assert.equal(readFileSync(stateFile, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistence failure rolls back issue and revoke in memory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-readonly-'))
  const stateFile = join(dir, 'state.json')
  try {
    const { service } = fakeContext({ stateFile })
    const grant = service.issue({ subject: 's', capability: 'c', scope: '*' })
    chmodSync(dir, 0o500)
    try {
      let writable = true
      try { writeFileSync(join(dir, 'probe'), '') } catch { writable = false }
      if (writable) {
        t.skip('directory permissions are not enforced on this platform')
        return
      }
      assert.throws(() => service.issue({ subject: 's', capability: 'other', scope: '*' }), { code: 'E_STATE' })
      assert.deepEqual(service.list({ capability: 'other' }), [])
      assert.throws(() => service.revoke(grant.id), { code: 'E_STATE' })
      assert.equal(service.list().find(item => item.id === grant.id).status, 'active')
      assert.deepEqual(readdirSync(dir), ['state.json'])
    } finally {
      chmodSync(dir, 0o700)
    }
    // The disk still says active, so a restart cannot resurrect a revoked grant.
    const replay = fakeContext({ stateFile }).service
    assert.equal(replay.list().find(item => item.id === grant.id).status, 'active')
    assert.equal(replay.check({ subject: 's', capability: 'c', scope: 'x' }).allowed, true)
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('save() removes its temp file when the atomic rename fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-rename-'))
  const stateFile = join(dir, 'state.json')
  try {
    const { service } = fakeContext({ stateFile })
    const grant = service.issue({ subject: 's', capability: 'c', scope: '*' })
    rmSync(stateFile)
    mkdirSync(stateFile)

    assert.throws(() => service.revoke(grant.id), { code: 'E_STATE' })
    assert.equal(service.list().find(item => item.id === grant.id).status, 'active')
    assert.throws(() => service.issue({ subject: 's2', capability: 'c', scope: '*' }), { code: 'E_STATE' })
    assert.deepEqual(service.list({ subject: 's2' }), [])
    assert.deepEqual(readdirSync(dir), ['state.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
