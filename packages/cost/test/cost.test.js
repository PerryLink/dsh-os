import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, CostService, createTools } from '../index.js'

/** Fake Cordis context: one service registry and one tool registry. */
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

function setup(config) {
  const ctx = fakeContext()
  const service = apply(ctx, config)
  return { ctx, service }
}

const hasCode = code => error => error.code === code

test('apply provides ctx.cost and registers three plain tool objects', () => {
  const { ctx, service } = setup()
  assert.ok(ctx.get('cost') instanceof CostService)
  assert.deepEqual([...ctx._tools.keys()], ['cost_summary', 'cost_budget_set', 'cost_budget_check'])
  for (const tool of ctx._tools.values()) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.output.schema, { type: 'object', additionalProperties: true })
  }
  assert.equal(createTools(service).length, 3)
})

test('summary is unavailable without a meter and does not recurse into ctx.cost', async () => {
  const { service } = setup()
  const result = await service.summary()
  assert.deepEqual(Object.keys(result).sort(), ['available', 'reason'])
  assert.equal(result.available, false)
  assert.match(result.reason, /dsh-cost-meter/)
})

test('summary adapts costMeter, the cost seam, getState and failures', async () => {
  const { ctx, service } = setup()

  ctx._services.set('costMeter', { async summary() { return { todayUsd: 1.25, currency: 'USD' } } })
  assert.deepEqual(await service.summary(), {
    available: true,
    source: 'costMeter',
    method: 'summary',
    summary: { todayUsd: 1.25, currency: 'USD' },
  })

  ctx._services.delete('costMeter')
  ctx._services.set('cost', { status: () => ({ ok: true, spentUsd: 2 }) })
  const viaStatus = await service.summary()
  assert.equal(viaStatus.available, true)
  assert.equal(viaStatus.source, 'cost')
  assert.equal(viaStatus.method, 'status')
  assert.deepEqual(viaStatus.summary, { ok: true, spentUsd: 2 })

  ctx._services.set('cost', { async usage() { return { tokens: 10 } } })
  assert.equal((await service.summary()).method, 'usage')

  // dsh-cost-meter's getState() is a whole snapshot; only the totals survive.
  ctx._services.set('cost', {
    async getState() { return { today: { cost: 1 }, total: { cost: 9 }, config: { secret: 'nope' } } },
  })
  const viaState = await service.summary()
  assert.equal(viaState.method, 'getState')
  assert.deepEqual(viaState.summary, { today: { cost: 1 }, total: { cost: 9 } })

  ctx._services.set('cost', { other() {} })
  assert.equal((await service.summary()).available, false)

  ctx._services.set('cost', { summary() { throw new Error('ledger offline') } })
  const failed = await service.summary()
  assert.equal(failed.available, false)
  assert.match(failed.reason, /ledger offline/)
})

test('budgets allow, deny with E_LIMIT, and list', () => {
  const { service } = setup()
  const budget = service.setBudget({ scope: 'session:42', limitUsd: 2, period: 'session' })
  assert.equal(budget.scope, 'session:42')
  assert.equal(budget.id, 'budget:session:42:session')
  assert.equal(service.listBudgets().length, 1)

  const allowed = service.check({ scope: 'session:42', estimatedUsd: 1.5 })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.remainingUsd, 0.5)

  const denied = service.check({ scope: 'session:42', estimatedUsd: 2.5 })
  assert.equal(denied.allowed, false)
  assert.equal(denied.code, 'E_LIMIT')
  assert.equal(denied.limitUsd, 2)

  // spend already recorded for the period reduces the headroom.
  assert.equal(service.check({ scope: 'session:42', estimatedUsd: 1, spentUsd: 1.5 }).allowed, false)

  // no matching budget means no local limit.
  assert.equal(service.check({ scope: 'session:other', estimatedUsd: 99 }).allowed, true)

  // a global budget gates every scope; period filters the budgets checked.
  service.setBudget({ limitUsd: 1, period: 'day' })
  assert.equal(service.check({ scope: 'session:other', estimatedUsd: 1.5 }).code, 'E_LIMIT')
  assert.equal(service.check({ scope: 'session:other', estimatedUsd: 1.5, period: 'session' }).allowed, true)

  // setting the same scope + period replaces instead of duplicating.
  service.setBudget({ scope: 'session:42', limitUsd: 5 })
  assert.equal(service.listBudgets().filter(entry => entry.scope === 'session:42').length, 1)
  assert.equal(service.listBudgets().find(entry => entry.scope === 'session:42').limitUsd, 5)
})

test('invalid amounts, scopes and periods fail with E_INVALID_ARGUMENT', () => {
  const { service } = setup()
  for (const limitUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
    assert.throws(() => service.setBudget({ limitUsd }), hasCode('E_INVALID_ARGUMENT'))
  }
  for (const estimatedUsd of [-0.01, Number.NaN, Number.NEGATIVE_INFINITY, '1', undefined]) {
    assert.throws(() => service.check({ estimatedUsd }), hasCode('E_INVALID_ARGUMENT'))
  }
  assert.throws(() => service.setBudget({ limitUsd: 1, period: 'week' }), hasCode('E_INVALID_ARGUMENT'))
  assert.throws(() => service.setBudget({ limitUsd: 1, scope: 'bad scope' }), hasCode('E_INVALID_ARGUMENT'))
  assert.throws(() => service.check(null), hasCode('E_INVALID_ARGUMENT'))
})

test('stateFile persists budgets and malformed state fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cost-test-'))
  assert.ok(dir.startsWith(tmpdir()))
  try {
    const stateFile = join(dir, 'budgets.json')
    setup({ stateFile }).service.setBudget({ scope: 'agent:planner', limitUsd: 7 })
    const reloaded = setup({ stateFile }).service.listBudgets()
    assert.deepEqual(reloaded.map(entry => [entry.scope, entry.limitUsd]), [['agent:planner', 7]])
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).version, 1)

    writeFileSync(stateFile, '{not json')
    assert.throws(() => new CostService(fakeContext(), { stateFile }), hasCode('E_STATE'))

    writeFileSync(stateFile, JSON.stringify({ version: 1, budgets: [{ scope: 'x', period: 'session', limitUsd: -1 }] }))
    assert.throws(() => new CostService(fakeContext(), { stateFile }), hasCode('E_STATE'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent tools execute through the service', async () => {
  const { ctx } = setup()
  assert.equal((await ctx._tools.get('cost_summary').execute({})).available, false)
  const budget = await ctx._tools.get('cost_budget_set').execute({ scope: 'tool', limitUsd: 1 })
  assert.equal(budget.limitUsd, 1)
  const denied = await ctx._tools.get('cost_budget_check').execute({ scope: 'tool', estimatedUsd: 2 })
  assert.equal(denied.code, 'E_LIMIT')
  await assert.rejects(ctx._tools.get('cost_budget_set').execute({ limitUsd: 0 }), hasCode('E_INVALID_ARGUMENT'))
})
