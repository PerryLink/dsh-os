/**
 * dsh-check — paired-environment regression canary for DeepSeek Harness.
 *
 * 0.2.0 adds a real headless runner on top of the dependency-free
 * four-dimension diff engine (result, trajectory, cost, approvals): the
 * `ctx.check.run()` seam and the optional `check_run` agent tool. The runner
 * needs a DSH checkout/bin and a model key; the diff engine does not.
 * @module dsh-check
 */
import { isDeepStrictEqual } from 'node:util'
import { CheckRunner } from './lib/runner.js'

export { CheckRunner, DEFAULT_TIMEOUT_MS, parseOutput, summarizeEvents } from './lib/runner.js'

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

const NO_RUNNER = task => ({
  ok: false,
  code: 'no_runner',
  taskId: typeof task?.id === 'string' && task.id ? task.id : null,
  result: { text: '' },
  trajectory: { steps: 0, toolCalls: 0, errors: 0 },
  cost: { tokens: 0, usd: 0 },
  approvals: { asked: 0, rejected: 0 },
  exitCode: null,
  raw: { ok: false, hint: 'configure the plugin with dshBin or runner to enable check_run' },
})

/** Host seam exposed as `ctx.check`. */
export class CheckService {
  /**
   * @param {object} [options]
   * @param {object} [options.runner] Injected runner exposing `run(task, opts)`.
   * @param {string} [options.dshBin] DSH CLI entry; lazily builds a CheckRunner.
   */
  constructor(options = {}) {
    this.options = isObject(options) ? options : {}
    this.runner = this.options.runner ?? null
    this.dshBin = this.options.dshBin
  }

  /** @see compareRuns */
  compare(oldRun, newRun, options = {}) {
    return compareRuns(oldRun, newRun, options)
  }

  /**
   * Run one task through a real DSH headless process. A runner can be injected
   * per call (`{ runner }`) or configured on the service; without either this
   * resolves to `{ ok: false, code: 'no_runner' }` instead of throwing.
   */
  async run(task, options = {}) {
    const { runner, ...runOptions } = isObject(options) ? options : {}
    const active = runner ?? this.runner ?? this.lazyRunner()
    if (!active) return NO_RUNNER(task)
    return active.run(task, runOptions)
  }

  lazyRunner() {
    if (this.runner || typeof this.dshBin !== 'string' || this.dshBin.trim() === '') {
      return this.runner
    }
    this.runner = new CheckRunner({
      dshBin: this.dshBin,
      profile: this.options.profile,
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs,
      env: this.options.env,
      spawn: this.options.spawn,
    })
    return this.runner
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

function runTool(check) {
  return {
    name: 'check_run',
    description: 'Run one task through the real DSH headless CLI (configured dshBin) and '
      + 'return its four-dimension record. Requires a DSH checkout and a model key.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Task prompt passed to `dsh --json`.' },
        id: { type: 'string', description: 'Optional task id for the returned record.' },
        timeoutMs: { type: 'number', description: 'Optional per-task timeout in milliseconds.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (!isObject(args) || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw fail('invalid_arguments', 'check_run requires a non-empty prompt')
      }
      if (args.id !== undefined && (typeof args.id !== 'string' || args.id.trim() === '')) {
        throw fail('invalid_arguments', 'check_run id must be a non-empty string when provided')
      }
      if (args.timeoutMs !== undefined
        && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw fail('invalid_arguments', 'check_run timeoutMs must be a positive finite number')
      }
      return check.run({ id: args.id ?? 'task', prompt: args.prompt }, { timeoutMs: args.timeoutMs })
    },
  }
}

/**
 * Mount dsh-check: provide `ctx.check` and register `check_compare`; register
 * the optional `check_run` tool only when the host supplies `dshBin`/`runner`.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - `{runner, dshBin, profile, cwd, timeoutMs, env, spawn}`.
 */
export function apply(ctx, config = {}) {
  const options = isObject(config) ? config : {}
  const check = new CheckService({
    runner: options.runner,
    dshBin: options.dshBin ?? process.env.DSH_BIN,
    profile: options.profile,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: options.env,
    spawn: options.spawn,
  })
  ctx.provide('check', check)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register(compareTool(check))
    if (check.runner || (typeof check.dshBin === 'string' && check.dshBin.trim() !== '')) {
      ctx.tools.register(runTool(check))
    }
  }
  return check
}
