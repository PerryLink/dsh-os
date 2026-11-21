/**
 * dsh-check guard — Grant resolution, budget and structured refusals.
 * @module dsh-canary/guard
 */
export const HOUR_MS = 3_600_000
export const DEFAULT_MAX_RUNS_PER_HOUR = 10
export const DEFAULT_MAX_COST_USD = 5
export const CAP_CHECK_RUN = 'check:run'
export const CAP_ACT_CHECK_RUN = 'act:invoke:check.run'
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => Object.assign(new Error(message), { code })
/** Recipient-side view of an Allow decision. Fail closed. */
export function granted(decision) {
  if (decision === true || decision === 'allow') return true
  return isObject(decision) && ([decision.granted, decision.allowed, decision.allow, decision.permitted].includes(true)
    || decision.decision === 'allow' || decision.status === 'allow')
}
/** First `ctx.costMeter`/`ctx.cost` provider, read as USD spent this hour. */
export function meterFrom(ctx) {
  const provider = ['costMeter', 'cost'].map(seam => { try { return ctx?.get?.(seam) } catch { return null } }).find(Boolean)
  if (!provider) return null
  return async () => {
    const method = typeof provider.spentUsd === 'function' ? 'spentUsd'
      : ['summary', 'status', 'usage', 'getState', 'getLocalState'].find(name => typeof provider[name] === 'function')
    if (!method) return null
    const value = await provider[method]()
    const summary = value?.summary ?? value
    return summary?.spentUsd ?? summary?.todayUsd ?? summary?.totalUsd ?? summary?.usd ?? summary?.total?.usd ?? null
  }
}
/** Structured refusal: never spawns, never throws, always carries nextTools. */
export function refusal(code, message, options = {}) {
  const denied = code === 'E_DENIED'
  const retryAfterMs = code === 'E_LIMIT' ? (options.retryAfterMs ?? HOUR_MS) : null
  const nextTools = (options.nextTools ?? []).slice(0, 3)
  return {
    ok: false,
    code,
    message,
    nextTools,
    error: {
      code,
      subcode: options.subcode ?? null,
      message,
      retryable: code === 'E_LIMIT',
      retryAfterMs,
      remediation: denied
        ? `Call allow_request for capability "${CAP_CHECK_RUN}", wait for a human decision, then retry.`
        : 'Wait for the rolling-hour budget to reset, then retry.',
      nextTools,
      details: options.details ?? {},
    },
  }
}
/** Rolling-hour admission; USD applies only when a meter is configured. */
export class RunBudget {
  constructor(options = {}) {
    this.maxRunsPerHour = options.maxRunsPerHour ?? DEFAULT_MAX_RUNS_PER_HOUR
    if (!Number.isInteger(this.maxRunsPerHour) || this.maxRunsPerHour < 0) throw fail('invalid_options', 'maxRunsPerHour must be a non-negative integer')
    this.maxCostUsd = options.maxCostUsd ?? DEFAULT_MAX_COST_USD
    if (typeof this.maxCostUsd !== 'number' || !Number.isFinite(this.maxCostUsd) || this.maxCostUsd < 0) throw fail('invalid_options', 'maxCostUsd must be a non-negative finite number')
    if (options.costMeter !== undefined && options.costMeter !== null && typeof options.costMeter !== 'function') throw fail('invalid_options', 'costMeter must be a function that returns USD spent')
    this.costMeter = options.costMeter ?? null
    this.clock = typeof options.now === 'function' ? options.now : () => Date.now()
    this.starts = []
  }

  /** Reserve one slot; returns `{ok, reason, retryAfterMs}`. */
  async admit() {
    let spent = null
    if (this.costMeter !== null) {
      try { spent = await this.costMeter() } catch {
        return { ok: false, reason: 'costMeterError', retryAfterMs: HOUR_MS }
      }
    }
    const now = this.clock()
    this.starts = this.starts.filter(start => now - start < HOUR_MS)
    if (this.starts.length >= this.maxRunsPerHour) {
      return { ok: false, reason: 'maxRunsPerHour', retryAfterMs: Math.max(1, (this.starts[0] ?? now) + HOUR_MS - now) }
    }
    if (typeof spent === 'number' && Number.isFinite(spent) && spent >= this.maxCostUsd) {
      return { ok: false, reason: 'maxCostUsd', retryAfterMs: HOUR_MS }
    }
    this.starts.push(now)
    return { ok: true, reason: null, retryAfterMs: 0 }
  }
}
