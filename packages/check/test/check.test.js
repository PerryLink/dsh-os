import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, compareRuns } from '../index.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-check.js')

const task = (id, patch = {}) => ({
  id,
  result: { text: `${id}: ok` },
  trajectory: { steps: 4, toolCalls: 2, errors: 0 },
  cost: { usd: 0.1, tokens: 1000 },
  approvals: { asked: 0, rejected: 0 },
  ...patch,
})
const run = (...tasks) => ({ schema: 'dsh.check.run/v1', tasks })
const cli = args => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
const fakeContext = () => {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
  }
}
function paired(oldRun, newRun) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-'))
  const oldFile = join(dir, 'old.json')
  const newFile = join(dir, 'new.json')
  writeFileSync(oldFile, JSON.stringify(oldRun))
  writeFileSync(newFile, JSON.stringify(newRun))
  return { oldFile, newFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('no regression: pass, exit 0, and check_compare is wired', async () => {
  const oldRun = run(task('a'), task('b'))
  const newRun = run(task('a'), task('b'))
  const report = compareRuns(oldRun, newRun)
  assert.equal(report.verdict, 'pass')
  assert.deepEqual(report.summary, {
    tasks: 2, compared: 2, regressions: 0, warnings: 0, ignored: 0, added: 0,
  })
  const files = paired(oldRun, newRun)
  try {
    const result = cli(['diff', '--old', files.oldFile, '--new', files.newFile])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PASS/)
  } finally {
    files.cleanup()
  }

  const ctx = fakeContext()
  const check = apply(ctx)
  assert.equal(ctx.get('check'), check)
  const tool = ctx._tools.get('check_compare')
  assert.equal((await tool.execute({ old: oldRun, new: newRun })).verdict, 'pass')
  await assert.rejects(tool.execute({ old: oldRun }), /old and new/)
})

test('result regression: exit 1 and a machine-readable --json report', () => {
  const oldRun = run(task('a'))
  const newRun = run(task('a', { result: { text: 'different' } }))
  const report = compareRuns(oldRun, newRun)
  assert.equal(report.verdict, 'regression')
  assert.equal(report.tasks[0].diffs[0].dimension, 'result')
  const files = paired(oldRun, newRun)
  try {
    assert.equal(cli(['diff', '--old', files.oldFile, '--new', files.newFile]).status, 1)
    const result = cli(['diff', '--old', files.oldFile, '--new', files.newFile, '--json'])
    assert.equal(result.status, 1, result.stderr)
    const json = JSON.parse(result.stdout)
    assert.equal(json.schema, 'dsh.check.diff/v1')
    assert.equal(json.verdict, 'regression')
    assert.equal(json.summary.regressions, 1)
    assert.equal(json.tasks[0].diffs[0].severity, 'regression')
  } finally {
    files.cleanup()
  }
})

test('cost above 25% warns but exits 0; exactly 25% passes', () => {
  const warn = compareRuns(run(task('a')), run(task('a', { cost: { usd: 0.13, tokens: 1000 } })))
  assert.equal(warn.verdict, 'warning')
  assert.deepEqual(warn.tasks[0].diffs.map(diff => [diff.dimension, diff.severity]), [['cost', 'warning']])
  const edge = run(task('b', { cost: { usd: 0.125, tokens: 1000 } }))
  assert.equal(compareRuns(run(task('b')), edge).verdict, 'pass')
  const files = paired(run(task('a')), run(task('a', { cost: { usd: 0.13 } })))
  try {
    assert.equal(cli(['diff', '--old', files.oldFile, '--new', files.newFile]).status, 0)
    const json = JSON.parse(cli(['diff', '--old', files.oldFile, '--new', files.newFile, '--json']).stdout)
    assert.equal(json.verdict, 'warning')
  } finally {
    files.cleanup()
  }
})

test('trajectory, tool error and approval rules', () => {
  const warning = compareRuns(run(task('a')), run(task('a', {
    trajectory: { steps: 5, toolCalls: 3, errors: 0 },
    approvals: { asked: 1, rejected: 1 },
  })))
  assert.equal(warning.verdict, 'warning')
  assert.deepEqual(
    warning.tasks[0].diffs.map(diff => diff.dimension),
    ['trajectory', 'trajectory', 'approvals', 'approvals'],
  )
  const regression = compareRuns(
    run(task('a')),
    run(task('a', { trajectory: { steps: 4, toolCalls: 2, errors: 1 } })),
  )
  assert.equal(regression.verdict, 'regression')
  assert.equal(regression.tasks[0].diffs[0].metric, 'errors')
})

test('--allow-flaky keeps the diff visible but clears the gate', () => {
  const report = compareRuns(
    run(task('a')),
    run(task('a', { result: 'changed' })),
    { allowFlaky: ['a'] },
  )
  assert.equal(report.verdict, 'pass')
  assert.deepEqual([report.summary.ignored, report.summary.regressions], [1, 0])
  assert.equal(report.tasks[0].verdict, 'ignored')
  assert.equal(report.tasks[0].diffs[0].dimension, 'result')
  const files = paired(run(task('a')), run(task('a', { result: 'changed' })))
  try {
    const result = cli(['diff', '--old', files.oldFile, '--new', files.newFile, '--allow-flaky', 'a'])
    assert.equal(result.status, 0, result.stderr)
  } finally {
    files.cleanup()
  }
})

test('init writes three tasks, list reads them, and bad runs exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-suite-'))
  try {
    const init = cli(['init', dir])
    assert.equal(init.status, 0, init.stderr)
    const file = join(dir, 'check.tasks.json')
    const suite = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(suite.tasks.length, 3)
    assert.equal(cli(['init', dir]).status, 2)
    const listed = cli(['list', '--file', file])
    assert.equal(listed.status, 0, listed.stderr)
    for (const item of suite.tasks) assert.match(listed.stdout, new RegExp(item.id))
    assert.equal(JSON.parse(cli(['list', '--file', file, '--json']).stdout).tasks.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const report = compareRuns(run(task('a')), run(task('b')))
  assert.equal(report.verdict, 'regression')
  assert.deepEqual(report.tasks.map(item => [item.id, item.verdict]), [['a', 'regression'], ['b', 'added']])
  const files = paired({ schema: 'dsh.check.run/v1', tasks: [{ nope: true }] }, run())
  try {
    assert.equal(cli(['diff', '--old', files.oldFile, '--new', files.newFile]).status, 2)
  } finally {
    files.cleanup()
  }
})

test('ctx.check.run injects a runner and check_run only appears when runnable', async () => {
  const calls = []
  const runner = {
    async run(task, options) {
      calls.push({ task, options })
      return {
        ok: true,
        code: null,
        taskId: task.id,
        result: { text: 'ran' },
        trajectory: { steps: 1, toolCalls: 0, errors: 0 },
        cost: { tokens: 3, usd: 0 },
        approvals: { asked: 0, rejected: 0 },
        exitCode: 0,
        raw: { ok: true },
      }
    },
  }
  const ctx = fakeContext()
  ctx.provide('allow', { check: async () => ({ allowed: true }) })
  const check = apply(ctx, { runner })
  assert.equal(ctx._tools.has('check_run'), true)
  const record = await check.run({ id: 'x', prompt: 'hi' }, { timeoutMs: 1234 })
  assert.equal(record.result.text, 'ran')
  assert.equal(calls[0].task.id, 'x')
  assert.equal(calls[0].options.timeoutMs, 1234)
  const ran = await ctx._tools.get('check_run').execute(
    { prompt: 'hi', id: 'tool' },
    { agent: { session: { id: 'agent:test' } } },
  )
  assert.equal(ran.taskId, 'tool')
  await assert.rejects(ctx._tools.get('check_run').execute({ prompt: '' }), /non-empty prompt/)
  const perCall = await check.run({ id: 'z', prompt: 'hi' }, {
    runner: { run: async () => ({ ok: true, code: null, taskId: 'z' }) },
  })
  assert.equal(perCall.ok, true)
  const configured = fakeContext()
  apply(configured, { dshBin: '/opt/dsh.js' })
  assert.equal(configured._tools.has('check_run'), true)

  const previous = process.env.DSH_BIN
  delete process.env.DSH_BIN
  try {
    const plain = apply(fakeContext())
    assert.equal((await plain.run({ id: 'y', prompt: 'hi' })).code, 'no_runner')
  } finally {
    if (previous === undefined) delete process.env.DSH_BIN
    else process.env.DSH_BIN = previous
  }
})
