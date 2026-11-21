import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const task = (id, patch = {}) => ({
  id,
  result: { text: `${id}: ok` },
  trajectory: { steps: 4, toolCalls: 2, errors: 0 },
  cost: { usd: 0.1, tokens: 1000 },
  approvals: { asked: 0, rejected: 0 },
  ...patch,
})
const run = (...tasks) => ({ schema: 'dsh.check.run/v1', tasks })

function setup() {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  apply(ctx)
  return tools.get('check_compare')
}

test('check_compare adds the envelope without changing summary/verdict/tasks', async () => {
  const tool = setup()
  const oldRun = run(task('a'), task('b'))
  const newRun = run(task('a'), task('b'))
  const result = await tool.execute({ old: oldRun, new: newRun })
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'check_compare')
  assert.equal(result.verdict, 'pass')
  assert.deepEqual(result.summary, {
    tasks: 2, compared: 2, regressions: 0, warnings: 0, ignored: 0, added: 0,
  })
  assert.equal(typeof result.summaryText, 'string')
  assert.equal(result.summaryText.length <= 200, true)
  assert.match(result.summaryText, /^pass:/)
  assert.deepEqual(result.regressions, [])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.page, { limit: 40, offset: 0, returned: 0, total: 0, hasMore: false })
  assert.equal(result.truncated, false)
  assert.deepEqual(result.next, [])
  assert.equal(result.error, null)
  assert.deepEqual(result.tasks.map(item => [item.id, item.verdict]), [['a', 'pass'], ['b', 'pass']])
  assert.deepEqual(result.allowFlaky, [])
})

test('check_compare exposes regressions and warnings with next steps', async () => {
  const tool = setup()
  const regressed = await tool.execute({
    old: run(task('a')),
    new: run(task('a', { result: { text: 'different' } })),
  })
  assert.equal(regressed.verdict, 'regression')
  assert.equal(regressed.summary.regressions, 1)
  assert.equal(regressed.regressions.length, 1)
  assert.equal(regressed.regressions[0].taskId, 'a')
  assert.equal(regressed.regressions[0].dimension, 'result')
  assert.match(regressed.summaryText, /^regression:/)
  assert.equal(regressed.next[0].tool, 'check_run')
  assert.equal(regressed.next[0].args.id, 'a')

  const warned = await tool.execute({
    old: run(task('a')),
    new: run(task('a', { cost: { usd: 0.2, tokens: 1000 } })),
  })
  assert.equal(warned.verdict, 'warning')
  assert.equal(warned.summary.warnings, 1)
  assert.equal(warned.warnings.length, 1)
  assert.equal(warned.warnings[0].taskId, 'a')
  assert.equal(warned.warnings[0].dimension, 'cost')
  assert.equal(warned.next[0].tool, 'check_compare')
  assert.deepEqual(warned.next[0].args.allowFlaky, ['a'])
})

test('check_compare keeps throwing for missing arguments and envelopes invalid runs', async () => {
  const tool = setup()
  await assert.rejects(tool.execute({ old: run(task('a')) }), /old and new/)

  const result = await tool.execute({
    old: run({ nope: true }),
    new: run({ nope: true }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_run')
  assert.equal(result.error.code, 'invalid_run')
  assert.equal(result.verdict, null)
  assert.deepEqual(result.summary, {
    tasks: 0, compared: 0, regressions: 0, warnings: 0, ignored: 0, added: 0,
  })
  assert.equal(typeof result.summaryText, 'string')
  assert.deepEqual(result.regressions, [])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.tasks, [])
  assert.equal(result.next[0].tool, 'check_run')
})

test('check_compare bounds findings and marks truncation', async () => {
  const tool = setup()
  const oldTasks = Array.from({ length: 25 }, (_, index) => task(`t${index}`))
  const newTasks = oldTasks.map(item => task(item.id, { result: { text: 'changed' } }))
  const result = await tool.execute({ old: run(...oldTasks), new: run(...newTasks) })
  assert.equal(result.verdict, 'regression')
  assert.equal(result.summary.regressions, 25)
  assert.equal(result.regressions.length, 20)
  assert.equal(result.page.total, 25)
  assert.equal(result.page.returned, 20)
  assert.equal(result.page.hasMore, true)
  assert.equal(result.truncated, true)
  assert.equal(result.summaryText.length <= 200, true)
})
