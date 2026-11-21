import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply as mountAllow } from '../../allow/index.js'
import { apply as mountKernel, capabilityName } from '../index.js'

const cap = handler => ({
  id: 'act.fs.write', title: 'Write a workspace file',
  summary: 'Write one file inside the workspace.',
  inputSchema: { type: 'object', additionalProperties: true },
  risk: 'write', permissions: ['fs.write'],
  handler: handler ?? (async args => ({ written: true, path: args.path })),
})

function mount(handler) {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  const allow = mountAllow(ctx, {})
  mountKernel(ctx, { capabilities: [cap(handler)] })
  return { allow, tool: name => tools.get(name) }
}

const exec = { subject: 'session-1' }
const args = { path: 'src/a.ts' }

test('os_request and allowedByHost share cap:<id>; observe consumes the approved grant once', async () => {
  let writes = 0
  const h = mount(async () => { writes += 1; return { written: true } })
  const run = h.tool('os_do')

  const denied = await run.execute({ id: 'act.fs.write', args }, exec)
  assert.equal(denied.error.code, 'E_DENIED')
  assert.equal(denied.error.details.permission, capabilityName('act.fs.write'))
  assert.equal(denied.error.nextTools[0].tool, 'os_request')

  const requested = await h.tool('os_request').execute({ id: 'act.fs.write', args, reason: 'edit one file' }, exec)
  assert.equal(requested.capability, 'cap:act.fs.write')
  assert.equal(h.allow.requests({ subject: 'session-1' })[0].capability, 'cap:act.fs.write')
  const pending = await h.tool('os_observe').execute({ requestId: requested.requestId }, exec)
  assert.deepEqual([pending.state, pending.grantAvailable], ['pending', false])

  h.allow.approve({ id: requested.requestId, by: 'alice', scope: 'repo:src' })
  const approved = await h.tool('os_observe').execute({ requestId: requested.requestId }, exec)
  assert.deepEqual([approved.state, approved.grantAvailable, approved.capability],
    ['approved', true, 'cap:act.fs.write'])
  assert.equal(approved.request.args, undefined, 'the request cache never stores raw args')
  assert.equal(typeof approved.request.argsHash, 'string')

  const first = await run.execute({ id: 'act.fs.write', args }, exec)
  assert.equal(first.ok, true)
  assert.equal(first.requestId, requested.requestId)
  assert.equal(writes, 1)
  assert.equal((await run.execute({ id: 'act.fs.write', args }, exec)).error.code, 'E_DENIED')
  assert.equal(writes, 1)
  assert.equal(h.allow.list({ subject: 'session-1' })[0].status, 'used')
})

test('the cached grant is bound to the exact args; a different ask stays denied', async () => {
  let writes = 0
  const h = mount(async () => { writes += 1; return { written: true } })
  const requested = await h.tool('os_request').execute({ id: 'act.fs.write', args, reason: 'edit one file' }, exec)
  h.allow.approve({ id: requested.requestId, by: 'alice' })
  assert.equal((await h.tool('os_observe').execute({ requestId: requested.requestId }, exec)).grantAvailable, true)

  assert.equal((await h.tool('os_do').execute({ id: 'act.fs.write', args: { path: 'src/b.ts' } }, exec)).error.code, 'E_DENIED')
  assert.equal(writes, 0)
  assert.equal((await h.tool('os_do').execute({ id: 'act.fs.write', args }, exec)).ok, true)
  assert.equal(writes, 1)
})

test('observe reports a denied request and caches no grant', async () => {
  const h = mount()
  const requested = await h.tool('os_request').execute({ id: 'act.fs.write', args, reason: 'edit one file' }, exec)
  h.allow.deny({ id: requested.requestId, by: 'alice', reason: 'not now' })
  const observed = await h.tool('os_observe').execute({ requestId: requested.requestId }, exec)
  assert.deepEqual([observed.state, observed.grantAvailable], ['denied', false])
  assert.equal((await h.tool('os_do').execute({ id: 'act.fs.write', args }, exec)).error.code, 'E_DENIED')
})
