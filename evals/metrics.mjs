/** Metric summaries and report comparison for dsh-os evals. */

/** `rate` rows are formatted as percentages in reports and `compare`. */
export const METRICS = [
  ['successRate', '成功率', true],
  ['strictSuccessRate', '严格成功率', true],
  ['deferredChecks', '延后判据', false],
  ['firstStepAccuracy', '首步选择准确率', true],
  ['recoveryRate', '恢复率', true],
  ['invalidCallRate', '无效调用率', true],
  ['avgSteps', '平均步数', false],
  ['avgTokens', '平均 tokens 估算', false],
  ['interventions', '人类介入次数', false],
]

/**
 * Aggregate runs. A run that hit a failed call counts as recovered only when
 * all external checks still pass. Invalid calls are unknown tools, schema
 * errors, off-route tools and same-argument retries with no new information.
 */
export function summarize(runs) {
  const total = runs.length || 1
  const calls = runs.reduce((sum, run) => sum + run.toolCalls, 0)
  const invalid = runs.reduce((sum, run) => sum + run.invalidCalls, 0)
  const failures = runs.filter(run => run.steps.some(step => !step.ok))
  const recovered = failures.filter(run => run.success)
  const wins = runs.filter(run => run.success)
  const strictWins = wins.filter(run => (run.deferredChecks ?? 0) === 0)
  const tokens = runs.reduce((sum, run) => sum + run.tokensEstimate, 0)
  return {
    scenarios: runs.length, successes: wins.length, successRate: wins.length / total,
    strictSuccesses: strictWins.length, strictSuccessRate: strictWins.length / total,
    deferredChecks: runs.reduce((sum, run) => sum + (run.deferredChecks ?? 0), 0),
    deferredScenarios: runs.filter(run => (run.deferredChecks ?? 0) > 0).length,
    firstStepAccuracy: runs.filter(run => run.firstStepCorrect).length / total,
    recoveryRate: failures.length === 0 ? 0 : recovered.length / failures.length,
    recoveredScenarios: recovered.length, scenariosWithFailures: failures.length,
    toolCalls: calls, invalidCalls: invalid, invalidCallRate: calls === 0 ? 0 : invalid / calls,
    avgSteps: calls / total, tokensEstimate: tokens, avgTokens: tokens / total,
    interventions: runs.reduce((sum, run) => sum + run.interventions.length, 0),
    assistedSuccesses: wins.filter(run => run.interventions.length > 0).length,
    autonomousSuccesses: wins.filter(run => run.interventions.length === 0).length,
  }
}

/** Compare two report objects; returns metric rows plus per-scenario deltas. */
export function compareReports(base, head) {
  const before = base.metrics ?? {}, after = head.metrics ?? {}
  // Pre-0.4 reports had no strict/deferred concept; a 0-deferred baseline is
  // strict by definition, so derive it instead of printing a misleading 0%.
  const baseValue = key => (key === 'strictSuccessRate' && before[key] === undefined
    ? before.successRate ?? 0
    : before[key] ?? 0)
  const rows = METRICS.map(([key, label, rate]) => ({
    key, label, rate, base: baseValue(key), head: after[key] ?? 0,
    delta: (after[key] ?? 0) - baseValue(key),
  }))
  const old = new Map((base.scenarios ?? []).map(run => [run.id, run.success]))
  return {
    rows,
    scenarios: (head.scenarios ?? []).map(run => ({
      id: run.id, baseline: old.has(run.id) ? old.get(run.id) : null, latest: run.success === true,
    })),
  }
}

/** Human-readable metric value; `rate` rows are percentages. */
export function formatMetric(rate, value) {
  return rate ? `${(value * 100).toFixed(1)}%` : Number.isInteger(value) ? String(value) : value.toFixed(1)
}
