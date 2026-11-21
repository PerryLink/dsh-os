import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AllowService, apply, createTools, DEFAULT_TTL_MS, MAX_REQUEST_TTL_MS, REQUEST_TTL_MS,
} from '../index.js'

function harness(config = {}) {
  const clock = { t: 1_700_000_000_000 }
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    provide: () => {},
  }
  const service = apply(ctx, { ...config, now: () => clock.t })
  const admin = new Map(createTools(service, { exposeAdminTools: true }).map(tool => [tool.name, tool]))
  return { clock, service, tools, admin }
}

const ask = (service, overrides = {}) => service.request({
  subject: 'agent:model', capability: 'fs.write', scope: 'repo:src', reason: 'edit one file', ...overrides,
})

test('request → approve creates a usable Grant in one transaction and is idempotent', () => {
  const { service, clock } = harness()
  assert.equal(service.requests().length, 0)

  const request = ask(service)
  assert.match(request.id, /^req_/)
  assert.equal(request.status, 'pending')
  assert.equal(request.subject, 'agent:model')
  assert.equal(request.capability, 'fs.write')
  assert.equal(request.scope, 'repo:src')
  assert.equal(request.ttlMs, REQUEST_TTL_MS)
  assert.equal(request.reason, 'edit one file')
  assert.equal(request.createdAt, clock.t)
  assert.equal(request.expiresAt, clock.t + REQUEST_TTL_MS)
  assert.match(request.requestHash, /^[0-9a-f]{64}$/)

  const { request: approved, grant } = service.approve({ id: request.id, by: 'alice' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.grantId, grant.id)
  assert.equal(approved.decidedBy, 'alice')
  assert.equal(approved.requestHash, request.requestHash)
  assert.equal(grant.status, 'active')
  assert.equal(grant.approver, 'alice')
  assert.equal(grant.requestHash, request.requestHash)
  assert.equal(grant.createdAt, clock.t)
  assert.equal(grant.expiresAt, clock.t + DEFAULT_TTL_MS)
  assert.equal(service.check({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:src' }).allowed, true)
  assert.equal(service.check({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:other' }).allowed, false)

  const again = service.approve({ id: request.id, by: 'alice' })
  assert.equal(again.grant.id, grant.id)
  assert.equal(service.list().length, 1)
  assert.equal(service.audit().filter(entry => entry.event === 'request-approved').length, 1)
  assert.equal(service.audit().filter(entry => entry.event === 'requested').length, 1)
})

test('deny is terminal, creates no Grant and is idempotent', () => {
  const { service } = harness()
  const request = ask(service)
  const denied = service.deny({ id: request.id, by: 'alice', reason: 'not now' }).request
  assert.equal(denied.status, 'denied')
  assert.equal(denied.denyReason, 'not now')
  assert.equal(denied.requestHash, request.requestHash)
  assert.equal(service.list().length, 0)
  assert.equal(service.deny({ id: request.id, by: 'alice', reason: 'changed my mind' }).request.denyReason, 'not now')
  assert.throws(() => service.approve({ id: request.id, by: 'alice' }), { code: 'E_REQUEST_DENIED' })
  assert.throws(() => service.approve({ id: 'req_missing', by: 'alice' }), { code: 'E_REQUEST_NOT_FOUND' })
})

test('pending requests expire, cannot be approved and wait returns the current state', async () => {
  const { service, clock } = harness()
  const request = ask(service, { ttlMs: 1000 })
  assert.equal((await service.wait(request.id, { timeoutMs: 0 })).status, 'pending')
  clock.t += 999
  assert.equal((await service.wait(request.id, { timeoutMs: 0 })).status, 'pending')
  clock.t += 1
  assert.equal(service.requests({ status: 'pending' }).length, 0)
  assert.equal(service.requests({ status: 'expired' })[0].id, request.id)
  assert.equal((await service.wait(request.id, { timeoutMs: 0 })).status, 'expired')
  assert.throws(() => service.approve({ id: request.id, by: 'alice' }), { code: 'E_REQUEST_EXPIRED' })
  assert.equal(service.list().length, 0)

  await assert.rejects(service.wait('req_missing', { timeoutMs: 0 }), { code: 'E_REQUEST_NOT_FOUND' })
  await assert.rejects(service.wait(request.id, { timeoutMs: 0, subject: 'agent:other' }), { code: 'E_REQUEST_NOT_FOUND' })

  const pending = ask(service, { capability: 'fs.delete' })
  assert.equal((await service.wait(pending.id, { timeoutMs: 25 })).status, 'pending')
  setTimeout(() => service.approve({ id: pending.id, by: 'alice' }), 20)
  assert.equal((await service.wait(pending.id, { timeoutMs: 1000 })).status, 'approved')
})

test('the model cannot pass privileged fields or approve/deny through default tools', async () => {
  const { service, tools, admin } = harness()
  for (const field of ['approver', 'by', 'status', 'id', 'requestHash', 'expiresAt', 'createdAt', 'grantId']) {
    assert.throws(() => ask(service, { [field]: 'forged' }), { code: 'E_PRIVILEGED' }, field)
  }
  assert.equal(service.requests().length, 0)
  assert.deepEqual([...tools.keys()], ['allow_check', 'allow_request', 'allow_wait', 'allow_requests'])
  assert.equal(tools.get('allow_approve'), undefined)
  assert.equal(tools.get('allow_deny'), undefined)
  assert.equal(tools.get('allow_issue'), undefined)

  const created = await tools.get('allow_request').execute({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:src', reason: 'x' })
  assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'hint', 'reason', 'requestId', 'status'])
  assert.match(created.hint, new RegExp(created.requestId))
  await assert.rejects(tools.get('allow_request').execute({ subject: 'agent:model', capability: 'fs.write', approver: 'alice' }), { code: 'E_PRIVILEGED' })

  const listed = await tools.get('allow_requests').execute({ subject: 'agent:model' })
  assert.deepEqual(listed.requests.map(request => request.id), [created.requestId])
  assert.equal((await tools.get('allow_requests').execute({ subject: 'agent:other' })).requests.length, 0)
  await assert.rejects(tools.get('allow_wait').execute({ requestId: created.requestId, subject: 'agent:other', timeoutMs: 0 }), { code: 'E_REQUEST_NOT_FOUND' })

  assert.ok(admin.has('allow_approve'))
  assert.ok(admin.has('allow_deny'))
  assert.ok(admin.has('allow_issue'))
  assert.equal((await admin.get('allow_approve').execute({ id: created.requestId, by: 'alice' })).grant.approver, 'alice')
})

test('approval scope may only narrow the requested scope', () => {
  const { service } = harness()
  const request = ask(service, { subject: 'agent:a', scope: 'repo:*' })
  const { grant } = service.approve({ id: request.id, by: 'alice', scope: 'repo:src' })
  assert.equal(grant.scope, 'repo:src')
  assert.equal(service.check({ subject: 'agent:a', capability: 'fs.write', scope: 'repo:src' }).allowed, true)
  assert.equal(service.check({ subject: 'agent:a', capability: 'fs.write', scope: 'repo:src/b' }).allowed, false)

  const widen = ask(service, { subject: 'agent:b', scope: 'repo:src' })
  assert.throws(() => service.approve({ id: widen.id, by: 'alice', scope: 'repo:*' }), { code: 'E_SCOPE_NARROW' })
  assert.throws(() => service.approve({ id: widen.id, by: 'alice', scope: '*' }), { code: 'E_SCOPE_NARROW' })

  const list = ask(service, { subject: 'agent:c', scope: 'repo:*' })
  const narrowed = service.approve({ id: list.id, by: 'alice', scope: ['repo:src', 'repo:test'] }).grant
  assert.deepEqual(narrowed.scope, ['repo:src', 'repo:test'])
  assert.equal(service.check({ subject: 'agent:c', capability: 'fs.write', scope: 'repo:test' }).allowed, true)
})

test('a request whose content no longer matches requestHash is refused', () => {
  const { service } = harness()
  const request = ask(service)
  service.store.requests.get(request.id).scope = 'repo:/etc'
  assert.throws(() => service.approve({ id: request.id, by: 'alice' }), { code: 'E_REQUEST_HASH' })
  assert.throws(() => service.deny({ id: request.id, by: 'alice', reason: 'no' }), { code: 'E_REQUEST_HASH' })
  assert.equal(service.list().length, 0)
})

test('requests and approved Grants survive a stateFile restart; tampered asks are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-requests-'))
  const stateFile = join(dir, 'state.json')
  try {
    const first = harness({ stateFile })
    const approved = ask(first.service, { capability: 'fs.write' })
    first.service.approve({ id: approved.id, by: 'alice' })
    const pending = ask(first.service, { capability: 'fs.delete' })

    const second = harness({ stateFile })
    assert.equal(second.service.requests().length, 2)
    assert.equal(second.service.requests({ status: 'approved' })[0].grantId !== undefined, true)
    assert.equal(second.service.check({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:src' }).allowed, true)
    assert.equal(second.service.requests({ subject: 'agent:model', status: 'pending' })[0].id, pending.id)

    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    raw.requests.find(item => item.status === 'pending').reason = 'tampered'
    writeFileSync(stateFile, JSON.stringify(raw))
    const third = harness({ stateFile })
    assert.deepEqual(third.service.requests().map(item => item.id), [approved.id])

    writeFileSync(stateFile, JSON.stringify({ version: 1, grants: [], audit: [] }))
    assert.equal(harness({ stateFile }).service.requests().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('request ttl and wait timeout are bounded', () => {
  const { service } = harness()
  assert.throws(() => ask(service, { ttlMs: MAX_REQUEST_TTL_MS + 1 }), { code: 'E_TTL' })
  assert.throws(() => ask(service, { ttlMs: -1 }), { code: 'E_TTL' })
  const request = ask(service)
  return Promise.all([
    assert.rejects(service.wait(request.id, { timeoutMs: -1 }), { code: 'E_WAIT' }),
    service.wait(request.id, { timeoutMs: 30 }).then(result => assert.equal(result.status, 'pending')),
  ])
})

test('wait observes an approval written by the CLI-style writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-allow-shared-'))
  const stateFile = join(dir, 'state.json')
  try {
    const service = new AllowService({}, { stateFile })
    const request = ask(service)
    setTimeout(() => new AllowService({}, { stateFile }).approve({ id: request.id, by: 'alice' }), 20)
    const result = await service.wait(request.id, { timeoutMs: 1000 })
    assert.equal(result.status, 'approved')
    assert.equal(service.check({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:src' }).allowed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
