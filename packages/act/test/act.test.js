import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, ActService } from '../index.js'

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

function setup(allow) {
  const ctx = fakeContext()
  if (allow !== undefined) ctx._services.set('allow', allow)
  const service = apply(ctx)
  return { ctx, service }
}

test('apply provides ctx.act and registers both tools', () => {
  const { ctx } = setup()
  assert.ok(ctx.get('act') instanceof ActService)
  assert.deepEqual([...ctx._tools.keys()], ['act_list', 'act_invoke'])
})

test('built-ins list, echo and now', async () => {
  const { service } = setup()
  assert.deepEqual(service.list().map(action => action.id), ['echo', 'now', 'list'])
  assert.deepEqual(service.list('echo').map(action => action.id), ['echo'])
  assert.deepEqual(service.list({ riskMax: 'read' }).length, 3)

  assert.deepEqual(await service.invoke('echo', { text: 'hello' }), {
    ok: true,
    actionId: 'echo',
    result: { text: 'hello' },
  })
  const now = await service.invoke('now')
  assert.equal(now.ok, true)
  assert.match(now.result.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const listed = await service.invoke('list')
  assert.equal(listed.result.actions.length, 3)
  assert.equal(listed.result.actions[0].execute, undefined)
})

test('register validates id, risk and execute; duplicates throw', () => {
  const { service } = setup()
  assert.throws(() => service.register({ id: 'Echo', title: 'x', risk: 'read', execute() {} }), /invalid action id/)
  assert.throws(() => service.register({ id: 'a', title: 'x', risk: 'read', execute() {} }), /invalid action id/)
  assert.throws(() => service.register({ id: 'ok.id', title: 'x', risk: 'exec', execute() {} }), /risk/)
  assert.throws(() => service.register({ id: 'ok.id', title: 'x', risk: 'read' }), /execute/)
  assert.throws(
    () => service.register({ id: 'echo', title: 'Dup', risk: 'read', execute() {} }),
    /already registered/,
  )
})

test('write without an Allow service is denied without executing', async () => {
  const { service } = setup()
  let calls = 0
  service.register({
    id: 'write.action',
    title: 'Write',
    risk: 'write',
    execute() { calls += 1 },
  })
  assert.deepEqual(await service.invoke('write.action'), {
    ok: false,
    code: 'grant_required',
    actionId: 'write.action',
    capability: 'act:invoke:write.action',
  })
  assert.equal(calls, 0)
})

test('an authorized write runs and the grant request carries subject and scope', async () => {
  const checks = []
  const allow = {
    async check(request) {
      checks.push(request)
      return { granted: true }
    },
  }
  const { service } = setup(allow)
  service.register({
    id: 'danger.action',
    title: 'Danger',
    risk: 'danger',
    execute(args, meta) {
      return { args, subject: meta?.subject }
    },
  })
  const result = await service.invoke('danger.action', { n: 1 }, { subject: 'tester', scope: { path: '/tmp' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { args: { n: 1 }, subject: 'tester' })
  assert.deepEqual(checks, [{
    subject: 'tester',
    capability: 'act:invoke:danger.action',
  }])
})

test('denied and throwing checks fail closed; sessionId is the subject fallback', async () => {
  const seen = []
  const allow = {
    async check(request) {
      seen.push(request.subject)
      return { granted: false }
    },
  }
  const { service } = setup(allow)
  service.register({ id: 'write.one', title: 'One', risk: 'write', execute: () => 'ran' })
  assert.equal((await service.invoke('write.one', {}, { sessionId: 'session-1' })).code, 'grant_required')
  // Missing subject fails closed: no shared 'anonymous' identity is created.
  assert.equal((await service.invoke('write.one')).code, 'grant_required')
  assert.deepEqual(seen, ['session-1'])
  assert.equal((await service.invoke('echo', { text: 'read still runs' })).ok, true)

  const broken = setup({ check: async () => { throw new Error('ledger unavailable') } })
  broken.service.register({ id: 'write.two', title: 'Two', risk: 'write', execute: () => 'ran' })
  assert.equal((await broken.service.invoke('write.two')).code, 'grant_required')
})

test('execute failures and unknown ids return structured results', async () => {
  const { service } = setup()
  service.register({
    id: 'explode',
    title: 'Explode',
    risk: 'read',
    execute() { throw new Error('boom') },
  })
  assert.deepEqual(await service.invoke('explode'), {
    ok: false,
    code: 'action_failed',
    message: 'boom',
  })
  assert.deepEqual(await service.invoke('missing'), {
    ok: false,
    code: 'action_not_found',
    actionId: 'missing',
  })
})

test('unregister and get reflect the registry', () => {
  const { service } = setup()
  const dispose = service.register({ id: 'temp.action', title: 'Temp', risk: 'read', execute: () => 1 })
  assert.equal(service.get('temp.action').title, 'Temp')
  assert.equal(dispose(), true)
  assert.equal(service.get('temp.action'), undefined)
})

test('agent tools list and invoke through the service', async () => {
  const { ctx, service } = setup()
  const listed = await ctx._tools.get('act_list').execute({ query: 'echo' })
  assert.deepEqual(listed.actions.map(action => action.id), ['echo'])

  const invoked = await ctx._tools.get('act_invoke').execute({ id: 'echo', args: { text: 'via tool' } })
  assert.deepEqual(invoked, { ok: true, actionId: 'echo', result: { text: 'via tool' } })
  await assert.rejects(ctx._tools.get('act_invoke').execute({}), /non-empty string id/)

  service.register({ id: 'write.tool', title: 'Write', risk: 'write', execute: () => 'ran' })
  assert.deepEqual(await ctx._tools.get('act_invoke').execute({ id: 'write.tool' }), {
    ok: false,
    code: 'grant_required',
    actionId: 'write.tool',
    capability: 'act:invoke:write.tool',
  })
})
