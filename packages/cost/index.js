/**
 * dsh-price — a budget/admission adapter for DeepSeek Harness.
 * Cost is not a meter: it reads `ctx.costMeter` (dsh-cost-meter) or any
 * `ctx.cost` provider exposing summary()/status()/usage(), and keeps a local
 * budget ledger used as a pre-flight USD gate. Install `dsh-cost-meter` first;
 * without a meter summary() returns { available: false, reason }.
 * @module dsh-price
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-cost'

/** The budget ledger works without tools; the three agent tools need the registry. */
export const inject = ['tools']

export const PERIODS = Object.freeze(['session', 'day', 'month', 'total'])
export const METER_SEAMS = Object.freeze(['costMeter', 'cost'])
const METER_METHODS = Object.freeze(['summary', 'status', 'usage', 'getState', 'getLocalState'])
const STATE_VERSION = 1
const SCOPE_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9*:._/-]{0,127}$/
const EPSILON = 1e-9

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function scopeOf(value) {
  if (value === undefined) return 'global'
  if (typeof value !== 'string') fail('E_INVALID_ARGUMENT', 'scope must be a string')
  const scope = value.trim()
  if (!SCOPE_PATTERN.test(scope)) fail('E_INVALID_ARGUMENT', `invalid scope: ${String(value)}`)
  return scope
}

function periodOf(value) {
  if (value === undefined) return 'session'
  if (!PERIODS.includes(value)) fail('E_INVALID_ARGUMENT', `period must be one of ${PERIODS.join(', ')}`)
  return value
}

/** Validate a USD amount: finite, and non-negative (or strictly positive). */
function money(value, field, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('E_INVALID_ARGUMENT', `${field} must be a finite number`)
  }
  if (positive ? value <= 0 : value < 0) {
    fail('E_INVALID_ARGUMENT', `${field} must be ${positive ? 'greater than 0' : 'at least 0'}`)
  }
  return value
}

/** JSON clone of a meter value; never lets an exotic value escape. */
function json(value) {
  if (value === undefined) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

/** dsh-cost-meter's getState() is a whole client snapshot; keep only totals. */
function project(method, raw) {
  if (!method.startsWith('get') || !isPlainObject(raw)) return json(raw)
  const picked = {}
  for (const key of ['today', 'month', 'total', 'budgetUsed']) if (raw[key] !== undefined) picked[key] = raw[key]
  return json(picked)
}

/**
 * One budget per `(scope, period)`. In memory by default; with
 * `config.stateFile` it is loaded from and atomically written to JSON.
 * A malformed state file fails closed with `E_STATE`.
 */
export class BudgetLedger {
  constructor(config = {}) {
    this.clock = typeof config.now === 'function' ? config.now : () => Date.now()
    this.stateFile = null
    if (config.stateFile !== undefined && config.stateFile !== null) {
      if (typeof config.stateFile !== 'string' || !config.stateFile.trim()) {
        fail('E_STATE', 'stateFile must be a non-empty path string')
      }
      this.stateFile = resolve(config.stateFile)
    }
    this.budgets = new Map()
    if (this.stateFile) this.load()
  }

  key(scope, period) { return `${scope}\u0000${period}` }

  load() {
    let raw
    try {
      raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      fail('E_STATE', `cannot read budget state ${this.stateFile}: ${error.message}`)
    }
    if (!isPlainObject(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.budgets)) {
      fail('E_STATE', `invalid budget state ${this.stateFile}`)
    }
    for (const entry of raw.budgets) {
      const valid = isPlainObject(entry) && typeof entry.scope === 'string'
        && SCOPE_PATTERN.test(entry.scope) && PERIODS.includes(entry.period)
        && Number.isFinite(entry.limitUsd) && entry.limitUsd > 0
      if (!valid) fail('E_STATE', `invalid budget record in ${this.stateFile}`)
      this.budgets.set(this.key(entry.scope, entry.period), {
        id: `budget:${entry.scope}:${entry.period}`, scope: entry.scope, period: entry.period, limitUsd: entry.limitUsd,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      })
    }
  }

  save() {
    if (!this.stateFile) return
    const body = `${JSON.stringify({ version: STATE_VERSION, budgets: this.list() }, null, 2)}\n`
    const temp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    let fd
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      fd = openSync(temp, 'wx', 0o600)
      writeSync(fd, body)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, this.stateFile)
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      try { unlinkSync(temp) } catch {}
      fail('E_STATE', `cannot write budget state ${this.stateFile}: ${error.message}`)
    }
  }

  /** Create or replace the budget for this scope + period and return it. */
  set(input = {}) {
    if (!isPlainObject(input)) fail('E_INVALID_ARGUMENT', 'setBudget expects an object')
    const scope = scopeOf(input.scope)
    const period = periodOf(input.period)
    const limitUsd = money(input.limitUsd, 'limitUsd', { positive: true })
    const key = this.key(scope, period)
    const now = this.clock()
    const budget = {
      id: `budget:${scope}:${period}`, scope, period, limitUsd,
      createdAt: this.budgets.get(key)?.createdAt ?? now, updatedAt: now,
    }
    this.budgets.set(key, budget)
    this.save()
    return { ...budget }
  }

  /** Budgets that apply to `scope`: an exact match, or the global wildcards. */
  matching(scope, period) {
    return this.list().filter(budget => (period === undefined || budget.period === period)
      && (budget.scope === scope || budget.scope === 'global' || budget.scope === '*'))
  }

  list() {
    return [...this.budgets.values()]
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.period.localeCompare(b.period))
      .map(budget => ({ ...budget }))
  }
}

/** Host seam `ctx.cost`: meter summary + a local budget gate. */
export class CostService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.ledger = new BudgetLedger(config)
  }

  /**
   * First non-self service on a meter seam. The self check matters:
   * `ctx.get('cost')` is this very service, so calling back would recurse.
   */
  meter() {
    for (const seam of METER_SEAMS) {
      let provider
      try { provider = typeof this.ctx?.get === 'function' ? this.ctx.get(seam) : undefined } catch { provider = undefined }
      if (provider && provider !== this) return { seam, provider }
    }
    return null
  }

  /**
   * Read the installed meter; never meters anything itself. Returns
   * `{ available: false, reason }` when no meter is installed or its read fails.
   */
  async summary() {
    const meter = this.meter()
    if (meter === null) {
      return {
        available: false,
        reason: 'no cost meter installed; add dsh-cost-meter (ctx.costMeter) '
          + 'or provide ctx.cost with summary()/status()/usage()',
      }
    }
    try {
      const method = METER_METHODS.find(candidate => typeof meter.provider[candidate] === 'function')
      if (method === undefined) return { available: false, reason: `cost meter "${meter.seam}" exposes no summary()/status()/usage()` }
      return { available: true, source: meter.seam, method, summary: project(method, await meter.provider[method]()) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { available: false, reason: `cost meter ${meter.seam} read failed: ${message}` }
    }
  }

  setBudget(input) { return this.ledger.set(input) }
  listBudgets() { return this.ledger.list() }

  /**
   * Check an estimated spend against every budget that applies to `scope`.
   * `spentUsd` is the amount already spent in the period (the meter owns that
   * number; defaults to 0). A denied check stays structured, never throws.
   */
  check(input = {}) {
    if (!isPlainObject(input)) fail('E_INVALID_ARGUMENT', 'check expects an object')
    const scope = scopeOf(input.scope)
    const estimatedUsd = money(input.estimatedUsd, 'estimatedUsd')
    const spentUsd = money(input.spentUsd ?? 0, 'spentUsd')
    const period = input.period === undefined ? undefined : periodOf(input.period)
    const checked = this.ledger.matching(scope, period).map(budget => ({
      id: budget.id, scope: budget.scope, period: budget.period, limitUsd: budget.limitUsd,
      remainingUsd: Math.max(0, budget.limitUsd - spentUsd),
      allowed: spentUsd + estimatedUsd <= budget.limitUsd + EPSILON,
    }))
    const denied = checked.filter(entry => !entry.allowed)
    const remainingUsd = checked.length === 0
      ? null : Math.max(0, Math.min(...checked.map(entry => entry.remainingUsd - estimatedUsd)))
    if (denied.length === 0) {
      return { allowed: true, scope, estimatedUsd, spentUsd, remainingUsd, checked }
    }
    const limiting = denied.reduce((left, right) => (right.remainingUsd < left.remainingUsd ? right : left))
    return {
      allowed: false, code: 'E_LIMIT', scope, estimatedUsd, spentUsd,
      limitUsd: limiting.limitUsd, period: limiting.period, remainingUsd: limiting.remainingUsd,
      reason: `${limiting.id} does not allow $${estimatedUsd} (limit $${limiting.limitUsd}, spent $${spentUsd})`,
      checked,
    }
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const defineTool = (name, description, properties, required, execute) => ({
  name, description, parameters: { type: 'object', additionalProperties: false, properties, required }, output: OUTPUT, execute,
})

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    defineTool(
      'cost_summary',
      'Read cost and usage from the installed cost meter (dsh-cost-meter); '
        + 'returns { available: false, reason } when none is installed.',
      {}, [], async () => service.summary(),
    ),
    defineTool(
      'cost_budget_set',
      'Create or replace the local USD budget for a scope and period. '
        + 'Cost is a budget gate, not a meter; the meter still owns spend.',
      {
        scope: { type: 'string', description: 'Exact scope, or "global"/"*" for every scope (default "global").' },
        limitUsd: { type: 'number', minimum: 0, description: 'Maximum spend in USD (must be > 0).' },
        period: { type: 'string', enum: PERIODS, description: 'Budget window label (default "session").' },
      },
      ['limitUsd'], async args => service.setBudget(args),
    ),
    defineTool(
      'cost_budget_check',
      'Check an estimated USD spend against every local budget matching the scope; '
        + 'a denied check returns { allowed: false, code: "E_LIMIT" }.',
      {
        scope: { type: 'string', description: 'Scope to check (default "global").' },
        estimatedUsd: { type: 'number', minimum: 0, description: 'Estimated spend in USD.' },
        spentUsd: { type: 'number', minimum: 0, description: 'Already spent in the period (default 0).' },
        period: { type: 'string', enum: PERIODS, description: 'Only check budgets for this period (default all).' },
      },
      ['estimatedUsd'], async args => service.check(args),
    ),
  ]
}

/**
 * Mount dsh-cost: provide `ctx.cost` and register the three agent tools.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - `{ stateFile?, now? }`; no state file keeps the ledger in memory.
 */
export function apply(ctx, config = {}) {
  const service = new CostService(ctx, config)
  ctx.provide('cost', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
