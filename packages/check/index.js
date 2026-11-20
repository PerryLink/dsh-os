/**
 * dsh-check — paired-environment regression canary for DeepSeek Harness.
 *
 * 0.1.0 MVP: a dependency-free four-dimension diff engine (result,
 * trajectory, cost, approvals), the `ctx.check` service and the
 * `check_compare` agent tool. Running DSH headless is planned for 0.2.0.
 * @module dsh-check
 */
import { isDeepStrictEqual } from 'node:util'

/** Cordis plugin name. */
export const name = 'dsh-check'

/** The diff service works without tools; the agent tool needs the registry. */
export const inject = ['tools']

const EPSILON = 1e-9
const fail = (code, message) => Object.assign(new Error(message), { code })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function tasksOf(run, label) {
  if (!isObject(run)) throw fail('invalid_run', `${label} run must be an object`)
  if (!Array.isArray(run.tasks)) throw fail('invalid_run', `${label} run must have a tasks array`)
  const ids = new Set()
  for (const task of run.tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || task.id.trim() === '') {
      throw fail('invalid_run', `${label} run has a task without a non-empty string id`)
    }
    if (ids.has(task.id)) throw fail('duplicate_task', `${label} run repeats task id "${task.id}"`)
    ids.add(task.id)
  }
  return run.tasks
}

function metrics(task, label) {
  for (const key of ['trajectory', 'cost', 'approvals']) {
    if (task[key] !== undefined && !isObject(task[key])) {
      throw fail('invalid_metric', `${label}.${key} must be an object`)
    }
  }
  const { trajectory = {}, cost = {}, approvals = {} } = task
  const read = (section, key) => {
    const value = section[key]
    if (value === undefined) return 0
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw fail('invalid_metric', `${label}.${key} must be a non-negative number`)
    }
    return value
  }
  return {
    steps: read(trajectory, 'steps'), toolCalls: read(trajectory, 'toolCalls'),
    errors: read(trajectory, 'errors'), usd: read(cost, 'usd'),
    asked: read(approvals, 'asked'), rejected: read(approvals, 'rejected'),
  }
}

const grew = (before, after, ratio) =>
  after > before && (before === 0 || (after - before) / before > ratio + EPSILON)

const growth = (before, after) =>
  before === 0
    ? `from 0 to ${after}`
    : `+${Math.round(((after - before) / before) * 100)}% (${before} -> ${after})`

function diffTask(oldTask, newTask) {
  const diffs = []
  if (!isDeepStrictEqual(oldTask.result, newTask.result)) {
    diffs.push({
      dimension: 'result',
      severity: 'regression',
      message: 'result changed',
      old: oldTask.result,
      new: newTask.result,
    })
  }
  const before = metrics(oldTask, `old task "${oldTask.id}"`)
  const after = metrics(newTask, `new task "${newTask.id}"`)
  for (const [key, label] of [['steps', 'steps'], ['toolCalls', 'tool calls']]) {
    if (grew(before[key], after[key], 0.2)) {
      diffs.push({
        dimension: 'trajectory',
        severity: 'warning',
        metric: key,
        message: `${label} increased ${growth(before[key], after[key])} (>20%)`,
        old: before[key],
        new: after[key],
      })
    }
  }
  if (after.errors > before.errors) {
    diffs.push({
      dimension: 'trajectory',
      severity: 'regression',
      metric: 'errors',
      message: `tool errors increased (${before.errors} -> ${after.errors})`,
      old: before.errors,
      new: after.errors,
    })
  }
  if (grew(before.usd, after.usd, 0.25)) {
    diffs.push({
      dimension: 'cost',
      severity: 'warning',
      metric: 'usd',
      message: `cost increased ${growth(before.usd, after.usd)} (>25%)`,
      old: before.usd,
      new: after.usd,
    })
  }
  for (const key of ['asked', 'rejected']) {
    if (after[key] > before[key]) {
      diffs.push({
        dimension: 'approvals',
        severity: 'warning',
        metric: key,
        message: `approvals ${key} increased (${before[key]} -> ${after[key]})`,
        old: before[key],
        new: after[key],
      })
    }
  }
  return diffs
}

function flakySet(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  return new Set(
    list.flatMap(item => String(item).split(','))
      .map(item => item.trim())
      .filter(Boolean),
  )
}

/**
 * Compare two run objects. Returns a `dsh.check.diff/v1` report:
 * `verdict` is `pass`, `warning` or `regression`; warnings never fail a gate.
 * Tasks listed in `options.allowFlaky` are reported but do not affect it.
 */
export function compareRuns(oldRun, newRun, options = {}) {
  const oldTasks = tasksOf(oldRun, 'old')
  const newTasks = tasksOf(newRun, 'new')
  const flaky = flakySet(options?.allowFlaky)
  const newById = new Map(newTasks.map(task => [task.id, task]))
  const oldIds = new Set(oldTasks.map(task => task.id))
  const summary = { tasks: 0, compared: 0, regressions: 0, warnings: 0, ignored: 0, added: 0 }
  const tasks = []

  for (const oldTask of oldTasks) {
    const ignored = flaky.has(oldTask.id)
    const newTask = newById.get(oldTask.id)
    const diffs = newTask
      ? diffTask(oldTask, newTask)
      : [{ dimension: 'result', severity: 'regression', message: 'task missing from new run' }]
    const regression = diffs.some(diff => diff.severity === 'regression')
    const warning = diffs.some(diff => diff.severity === 'warning')
    if (newTask !== undefined) summary.compared += 1
    if (ignored) summary.ignored += 1
    else {
      if (regression) summary.regressions += 1
      if (warning) summary.warnings += 1
    }
    tasks.push({
      id: oldTask.id,
      verdict: ignored ? 'ignored' : regression ? 'regression' : warning ? 'warning' : 'pass',
      ignored,
      diffs,
    })
  }
  for (const newTask of newTasks) {
    if (oldIds.has(newTask.id)) continue
    summary.added += 1
    tasks.push({ id: newTask.id, verdict: 'added', ignored: false, diffs: [] })
  }
  summary.tasks = tasks.length

  return {
    schema: 'dsh.check.diff/v1',
    verdict: summary.regressions > 0 ? 'regression' : summary.warnings > 0 ? 'warning' : 'pass',
    summary,
    allowFlaky: [...flaky],
    tasks,
  }
}

/** Host seam exposed as `ctx.check`. */
export class CheckService {
  /** @see compareRuns */
  compare(oldRun, newRun, options = {}) {
    return compareRuns(oldRun, newRun, options)
  }
}

function compareTool(check) {
  return {
    name: 'check_compare',
    description: 'Compare baseline (old) and candidate (new) dsh-check run objects across '
      + 'result, trajectory, cost and approvals. Warnings do not fail a gate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        old: { type: 'object', additionalProperties: true, description: 'Baseline run object.' },
        new: { type: 'object', additionalProperties: true, description: 'Candidate run object.' },
        allowFlaky: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids whose diffs are reported but ignored by the verdict.',
        },
      },
      required: ['old', 'new'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (!isObject(args) || args.old === undefined || args.new === undefined) {
        throw fail('invalid_arguments', 'check_compare requires old and new run objects')
      }
      return check.compare(args.old, args.new, { allowFlaky: args.allowFlaky })
    },
  }
}

/**
 * Mount dsh-check: provide `ctx.check` and register the `check_compare` tool.
 * @param {object} ctx - Cordis context.
 */
export function apply(ctx) {
  const check = new CheckService()
  ctx.provide('check', check)
  if (ctx.tools && typeof ctx.tools.register === 'function') ctx.tools.register(compareTool(check))
  return check
}
