import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AllowService } from '../../allow/index.js'

const BIN = fileURLToPath(new URL('../bin/dsh-os.js', import.meta.url))

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-os-approvals-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, stateFile: join(dir, 'allow.json') }
}

function run(args, { cwd, env = process.env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' })
}

function service(stateFile) {
  return new AllowService({}, { stateFile })
}

function request(stateFile, overrides = {}) {
  return service(stateFile).request({
    subject: 'agent:model', capability: 'fs.write', scope: 'repo:src', reason: 'edit one file', ...overrides,
  })
}

test('CLI list, approve and deny round-trip through the Allow state file', t => {
  const { dir, stateFile } = fixture(t)
  const approved = request(stateFile)
  const denied = request(stateFile, { subject: 'agent:other', capability: 'fs.delete' })
  const env = { ...process.env, PATH: '' }

  const listed = run(['approvals', 'list', '--state', stateFile, '--json'], { cwd: dir, env })
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout).map(item => item.id), [approved.id, denied.id])

  const approval = run(['approvals', 'approve', approved.id, '--by', 'alice', '--state', stateFile], { cwd: dir, env })
  assert.equal(approval.status, 0, approval.stderr)
  const result = JSON.parse(approval.stdout)
  assert.equal(result.request.status, 'approved')
  assert.equal(result.grant.approver, 'alice')
  assert.equal(result.grant.requestHash, approved.requestHash)

  const fresh = service(stateFile)
  assert.equal(fresh.check({ subject: 'agent:model', capability: 'fs.write', scope: 'repo:src' }).allowed, true)
  assert.equal(fresh.requests({ status: 'approved' })[0].grantId, result.grant.id)

  const denial = run(['approvals', 'deny', denied.id, '--reason', 'not now', '--state', stateFile], { cwd: dir, env })
  assert.equal(denial.status, 0, denial.stderr)
  assert.equal(JSON.parse(denial.stdout).request.status, 'denied')
  assert.equal(JSON.parse(denial.stdout).request.denyReason, 'not now')
  assert.equal(service(stateFile).list().length, 1)

  const pending = run(['approvals', 'list', '--state', stateFile, '--status', 'pending', '--json'], { cwd: dir, env })
  assert.deepEqual(JSON.parse(pending.stdout), [])
  const text = run(['approvals', 'list', '--state', stateFile], { cwd: dir, env })
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /^ID\s+STATUS\s+SUBJECT\s+CAPABILITY\s+SCOPE\s+EXPIRES/m)
  assert.deepEqual(readdirSync(dir), ['allow.json'])
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).version, 2)
})

test('repeat approval is idempotent and denial is terminal', t => {
  const { dir, stateFile } = fixture(t)
  const created = request(stateFile)

  const first = run(['approvals', 'approve', created.id, '--by', 'alice', '--state', stateFile], { cwd: dir })
  const second = run(['approvals', 'approve', created.id, '--by', 'alice', '--state', stateFile], { cwd: dir })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(JSON.parse(first.stdout).grant.id, JSON.parse(second.stdout).grant.id)
  assert.equal(service(stateFile).list().length, 1)
  assert.equal(service(stateFile).audit().filter(entry => entry.event === 'request-approved').length, 1)

  const denied = request(stateFile, { capability: 'fs.delete' })
  assert.equal(run(['approvals', 'deny', denied.id, '--reason', 'no', '--state', stateFile], { cwd: dir }).status, 0)
  const again = run(['approvals', 'deny', denied.id, '--reason', 'still no', '--state', stateFile], { cwd: dir })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).request.denyReason, 'no')

  const afterDeny = run(['approvals', 'approve', denied.id, '--by', 'alice', '--state', stateFile], { cwd: dir })
  assert.equal(afterDeny.status, 1)
  assert.match(afterDeny.stderr, /denied/)
  const afterApprove = run(['approvals', 'deny', created.id, '--reason', 'late', '--state', stateFile], { cwd: dir })
  assert.equal(afterApprove.status, 1)
  assert.match(afterApprove.stderr, /already approved/)
})

test('expired requests cannot be approved; hash mismatch and bad input fail closed', async t => {
  const { dir, stateFile } = fixture(t)
  const expired = request(stateFile, { capability: 'fs.delete', ttlMs: 1 })
  const tampered = request(stateFile, { capability: 'fs.write', subject: 'agent:tampered' })
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  raw.requests.find(item => item.id === tampered.id).scope = 'repo:/etc'
  writeFileSync(stateFile, JSON.stringify(raw))

  await new Promise(resolve => setTimeout(resolve, 15))
  const expiredRun = run(['approvals', 'approve', expired.id, '--by', 'alice', '--state', stateFile], { cwd: dir })
  assert.equal(expiredRun.status, 1)
  assert.match(expiredRun.stderr, /expired/)
  assert.equal(service(stateFile).requests({ status: 'expired' }).length, 1)

  const tamperedRun = run(['approvals', 'approve', tampered.id, '--by', 'alice', '--state', stateFile], { cwd: dir })
  assert.equal(tamperedRun.status, 1)
  assert.match(tamperedRun.stderr, /requestHash/)

  assert.equal(run(['approvals', 'approve', 'req_missing', '--by', 'alice', '--state', stateFile], { cwd: dir }).status, 1)
  const noBy = run(['approvals', 'approve', tampered.id, '--state', stateFile], { cwd: dir })
  assert.equal(noBy.status, 1)
  assert.match(noBy.stderr, /--by/)
  assert.equal(run(['approvals', 'list'], { cwd: dir }).status, 1)
  assert.equal(run(['approvals', 'deny', tampered.id, '--reason', 'x', '--state', '/missing/dir/none.json'], { cwd: dir }).status, 1)
})

test('approver names are data, never shell input; filters and defaults work', t => {
  const { dir, stateFile } = fixture(t)
  const created = request(stateFile, { subject: 'agent:model' })
  request(stateFile, { subject: 'agent:other', capability: 'fs.delete' })
  const by = 'x; echo pwned `id` $HOME'
  const approved = run(['approvals', 'approve', created.id, '--by', by, '--state', stateFile], { cwd: dir, env: { ...process.env, PATH: '' } })
  assert.equal(approved.status, 0, approved.stderr)
  assert.equal(JSON.parse(approved.stdout).grant.approver, by)

  const filtered = run(['approvals', 'list', '--state', stateFile, '--subject', 'agent:other', '--json'], { cwd: dir })
  assert.deepEqual(JSON.parse(filtered.stdout).map(item => item.subject), ['agent:other'])
  assert.equal(run(['approvals', 'list', '--state', stateFile, '--status', 'nope'], { cwd: dir }).status, 1)

  const help = run(['approvals', '--help'], { cwd: dir })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /approvals approve <request-id> --by <name>/)
  assert.equal(run(['approvals', 'bogus'], { cwd: dir }).status, 1)
})
