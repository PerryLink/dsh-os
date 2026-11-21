/**
 * dsh-check — paired-environment regression canary for DeepSeek Harness.
 *
 * 0.4.0 adds a bounded `os.result/v1` envelope to `check_compare`
 * (`summaryText` ≤200 chars, `page`, `truncated`, `next`, `error`) while keeping
 * the legacy `summary` counts object, `verdict`, `tasks` and `allowFlaky`.
 * 0.3.0 adds safety defaults to the real headless runner: `check_run` needs a
 * Grant, a rolling-hour budget, an allowlisted env and a prompt-free audit.
 * @module dsh-check
 */
import { isDeepStrictEqual } from 'node:util'
import { compareEnvelope, compareFailure } from './lib/compare-envelope.js'
import {
  CAP_ACT_CHECK_RUN, CAP_CHECK_RUN, RunBudget, granted, meterFrom, refusal,
} from './lib/guard.js'
import { CheckRunner } from './lib/runner.js'
export {
  CheckRunner, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES, parseOutput, sanitizeEnv, summarizeEvents,
} from './lib/runner.js'
/** Cordis plugin name. */
export const name = 'dsh-check'
/** The diff service works without tools; the agent tool needs the registry. */
export const inject = ['tools']

const EPSILON = 1e-9
const MAX_AUDIT_ENTRIES = 200
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
  /** @param {object} [options] `{ctx, runner, dshBin, maxRunsPerHour, maxCostUsd, costMeter, allowedDshBins}`. */
  constructor(options = {}) {
    this.options = isObject(options) ? options : {}
    this.ctx = this.options.ctx ?? null
    this.runner = this.options.runner ?? null
    this.dshBin = this.options.dshBin
    this.budget = new RunBudget({
      ...this.options,
      costMeter: this.options.costMeter ?? meterFrom(this.ctx),
    })
    this.auditLog = []
    this.auditSeq = 0
  }

  /** Resolve the optional Allow service through `ctx.get('allow')` or `ctx.allow`. */
  allow() {
    if (typeof this.options.allow?.check === 'function') return this.options.allow
    const ctx = this.ctx
    if (ctx === null || ctx === undefined) return null
    if (typeof ctx.get === 'function') {
      try {
        const service = ctx.get('allow')
        if (service !== undefined && service !== null) return service
      } catch {
        // A throwing service is not a Grant.
      }
    }
    return ctx.allow ?? null
  }

  /** Resolve `check:run` or `act:invoke:check.run`; `null` fails closed. */
  async authorize(subject) {
    const allow = this.allow()
    if (typeof subject !== 'string' || subject === '' || typeof allow?.check !== 'function') return null
    for (const capability of [CAP_CHECK_RUN, CAP_ACT_CHECK_RUN]) {
      try {
        if (granted(await allow.check({ subject, capability }))) return capability
      } catch {
        // Fail closed: a broken Allow service never authorizes a run.
      }
    }
    return null
  }

  /** `E_DENIED` value for the agent tool, with an `allow_request` hint. */
  denied(subject) {
    const nextTools = [{
      tool: 'allow_request',
      args: {
        ...(typeof subject === 'string' && subject !== '' ? { subject } : {}),
        capability: CAP_CHECK_RUN,
        reason: 'Run one headless DSH check task (spawns a model-backed child process).',
      },
      why: `request a Grant for ${CAP_CHECK_RUN}, then retry check_run`,
    }]
    return refusal('E_DENIED', `check_run requires a Grant for capability "${CAP_CHECK_RUN}".`, {
      subcode: 'grant_required',
      nextTools,
      details: { capability: CAP_CHECK_RUN, ...(typeof subject === 'string' && subject ? { subject } : {}) },
    })
  }

  /** In-memory audit trail (prompts are never recorded). */
  audit() {
    return this.auditLog.map(entry => ({ ...entry }))
  }

  /** Append one `{runId,taskId,profile,exitCode,durationMs,costUsd?}` entry. */
  recordAudit(record, profile, started, runId) {
    const usd = record?.cost?.usd
    const rawDuration = record?.raw?.durationMs
    const entry = {
      runId,
      taskId: typeof record?.taskId === 'string' ? record.taskId : null,
      profile,
      exitCode: Number.isInteger(record?.exitCode) ? record.exitCode : null,
      durationMs: typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
        ? rawDuration
        : Date.now() - started,
    }
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) entry.costUsd = usd
    this.auditLog.push(entry)
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) this.auditLog.shift()
  }

  /** @see compareRuns */
  compare(oldRun, newRun, options = {}) {
    return compareRuns(oldRun, newRun, options)
  }

  /** Run one task through the configured/injected runner; no runner -> no_runner. */
  async run(task, options = {}) {
    const { runner, ...runOptions } = isObject(options) ? options : {}
    const active = runner ?? this.runner ?? this.lazyRunner()
    if (!active) return NO_RUNNER(task)
    const admitted = await this.budget.admit()
    if (!admitted.ok) {
      return refusal('E_LIMIT', `check_run budget exhausted: ${admitted.reason}.`, {
        subcode: 'quota_exceeded',
        retryAfterMs: admitted.retryAfterMs,
        details: {
          reason: admitted.reason,
          maxRunsPerHour: this.budget.maxRunsPerHour,
          maxCostUsd: this.budget.maxCostUsd,
          costMeter: this.budget.costMeter !== null,
        },
      })
    }
    const started = Date.now()
    const record = await active.run(task, runOptions)
    const runId = `run_${started.toString(36)}_${(this.auditSeq += 1).toString(36)}`
    if (isObject(record)) record.runId = runId
    this.recordAudit(record, active.profile ?? this.options.profile ?? 'headless', started, runId)
    return record
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
      allowedDshBins: this.options.allowedDshBins,
      killGraceMs: this.options.killGraceMs,
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
      try {
        return compareEnvelope(check.compare(args.old, args.new, { allowFlaky: args.allowFlaky }))
      } catch (error) {
        return compareFailure(error)
      }
    },
  }
}

function runTool(check) {
  return {
    name: 'check_run',
    description: 'Run one task through the real DSH headless CLI (configured dshBin) and '
      + 'return its four-dimension record. Requires a Grant for capability "check:run", '
      + 'a DSH checkout and a model key; budget-limited and audited.',
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
    async execute(args, exec) {
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
      const subject = exec?.agent?.session?.id ?? exec?.agent?.id ?? exec?.subject
      if ((await check.authorize(subject)) === null) return check.denied(subject)
      return check.run(
        { id: args.id ?? 'task', prompt: args.prompt },
        { timeoutMs: args.timeoutMs, signal: exec?.signal },
      )
    },
  }
}

/**
 * Mount dsh-check: provide `ctx.check` and register `check_compare`; register
 * the optional `check_run` tool only when the host supplies `dshBin`/`runner`.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - `{runner, dshBin, profile, cwd, timeoutMs, env,
 * spawn, maxRunsPerHour, maxCostUsd, costMeter, allowedDshBins}`.
 */
export function apply(ctx, config = {}) {
  const options = isObject(config) ? config : {}
  const check = new CheckService({
    ctx,
    runner: options.runner,
    dshBin: options.dshBin ?? process.env.DSH_BIN,
    profile: options.profile,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: options.env,
    spawn: options.spawn,
    maxRunsPerHour: options.maxRunsPerHour,
    maxCostUsd: options.maxCostUsd,
    costMeter: options.costMeter,
    allowedDshBins: options.allowedDshBins,
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
