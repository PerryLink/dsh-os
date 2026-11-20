import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyAllow } from '../packages/allow/index.js'
import { apply as applyAct } from '../packages/act/index.js'

function fakeContext() {
  const services = new Map()
  const tools = new Map()
  return {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
    _services: services,
    _tools: tools,
  }
}

test('Act write actions require an Allow grant, and revocation takes effect immediately', async () => {
  const ctx = fakeContext()
  const allow = applyAllow(ctx)
  const act = applyAct(ctx)

  act.register({
    id: 'write.demo',
    title: 'Demo write',
    risk: 'write',
    execute: async args => ({ written: args.value }),
  })

  const denied = await act.invoke('write.demo', { value: 1 }, { subject: 'session-1' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'grant_required')
  assert.equal(denied.capability, 'act:invoke:write.demo')

  const grant = allow.issue({
    subject: 'session-1',
    capability: 'act:invoke:write.demo',
    scope: '*',
  })
  const allowed = await act.invoke('write.demo', { value: 2 }, { subject: 'session-1' })
  assert.deepEqual(allowed, { ok: true, actionId: 'write.demo', result: { written: 2 } })

  allow.revoke(grant.id)
  const afterRevoke = await act.invoke('write.demo', { value: 3 }, { subject: 'session-1' })
  assert.equal(afterRevoke.ok, false)
  assert.equal(afterRevoke.code, 'grant_required')
})

test('read actions run without a grant', async () => {
  const ctx = fakeContext()
  applyAllow(ctx)
  const act = applyAct(ctx)
  const echoed = await act.invoke('echo', { text: 'hello' }, { subject: 'session-2' })
  assert.deepEqual(echoed, { ok: true, actionId: 'echo', result: { text: 'hello' } })
})
