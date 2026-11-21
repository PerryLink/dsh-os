import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromTool, inferRisk } from '../lib/from-tool.js'
import { createTools as helpTools } from '../../help/index.js'
import { createTools as costTools } from '../../cost/index.js'

// Two real dsh-os tools: a read-only doctor and a write budget setter.
const helpDoctor = helpTools({
  doctor: async () => ({ healthy: true, modules: ['help'] }),
  firstRun: async () => ({}),
  installPlan: async () => ({}),
}).find(tool => tool.name === 'help_doctor')
const costBudgetSet = costTools({
  summary: async () => ({}),
  setBudget: async args => ({ ok: true, budget: args }),
  check: async () => ({ allowed: true }),
}).find(tool => tool.name === 'cost_budget_set')

test('fromTool adapts a real read tool', async () => {
  const descriptor = fromTool(helpDoctor)
  assert.equal(descriptor.id, 'legacy.help_doctor')
  assert.deepEqual(descriptor.risk, ['read'])
  assert.equal(descriptor.legacy, true)
  assert.deepEqual(descriptor.aliases, ['help_doctor'])
  assert.deepEqual(await descriptor.handler({}), { healthy: true, modules: ['help'] })
  assert.equal('handler' in JSON.parse(JSON.stringify(descriptor)), false)
})

test('fromTool infers write risk and forwards args to tool.execute', async () => {
  const descriptor = fromTool(costBudgetSet)
  assert.equal(descriptor.id, 'legacy.cost_budget_set')
  assert.deepEqual(descriptor.risk, ['write'])
  assert.equal(descriptor.idempotency, 'non-idempotent')
  assert.deepEqual(await descriptor.handler({ limitUsd: 5, scope: 'global' }, null, {}), {
    ok: true, budget: { limitUsd: 5, scope: 'global' },
  })
})

test('fromTool infers read/write/execute from names and descriptions', () => {
  assert.equal(inferRisk({ name: 'snip_search', description: 'Search clippings.' }), 'read')
  assert.equal(inferRisk({ name: 'snip_add', description: 'Store a clipping.' }), 'write')
  assert.equal(inferRisk({ name: 'shell_exec', description: 'Run a command.' }), 'execute')
  assert.equal(inferRisk({ name: 'stage_move', description: 'Move a window.' }), 'execute')
  assert.throws(() => fromTool({ name: 'bad' }), { code: 'E_INVALID_ARGUMENT' })
})
