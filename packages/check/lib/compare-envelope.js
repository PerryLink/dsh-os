/**
 * `check_compare` result envelopes: keep the `dsh.check.diff/v1` report fields
 * intact and add the bounded `os.result/v1` summary/paging metadata.
 * @module dsh-check/compare-envelope
 */
import { failEnvelope, okEnvelope, pageOf, step } from './result.js'

const MAX_FINDINGS = 20
const EMPTY_COUNTS = Object.freeze({
  tasks: 0, compared: 0, regressions: 0, warnings: 0, ignored: 0, added: 0,
})

/** Flatten one severity from the per-task diff lists, preserving the evidence. */
function findings(tasks, severity) {
  return tasks.flatMap(task => (Array.isArray(task.diffs) ? task.diffs : [])
    .filter(diff => diff.severity === severity)
    .map(diff => ({
      taskId: task.id,
      dimension: diff.dimension,
      ...(diff.metric === undefined ? {} : { metric: diff.metric }),
      message: diff.message,
    })))
}

/** One-line, ≤200-character verdict summary for the agent. */
function summaryText(report) {
  const { tasks, compared, regressions, warnings, ignored, added } = report.summary
  const parts = [
    `${report.verdict}: ${regressions} regression(s), ${warnings} warning(s)`,
    `${compared}/${tasks} tasks compared`,
  ]
  if (ignored > 0) parts.push(`${ignored} ignored`)
  if (added > 0) parts.push(`${added} added`)
  return parts.join('; ')
}

/** Actionable follow-ups; never claims a regression is already diagnosed. */
function nextFor(report) {
  if (report.verdict === 'regression') {
    const regressed = report.tasks.find(task => task.verdict === 'regression')
    const id = regressed?.id ?? 'the regressed task'
    return [
      step('check_run', {
        ...(regressed?.id === undefined ? {} : { id: regressed.id }),
        prompt: `Re-run check task ${id} against the candidate environment.`,
      }, 'Reproduce the regression with a fresh run.'),
      step('seek_search', { query: `check regression ${id}` }, 'Look for related evidence before changing code.'),
    ]
  }
  if (report.verdict === 'warning') {
    const flaky = report.tasks.filter(task => task.verdict === 'warning').map(task => task.id)
    return [step('check_compare', { allowFlaky: flaky }, 'If these warnings are known-flaky, re-call with the same runs plus allowFlaky.')]
  }
  return []
}

/** Build the success envelope without changing `summary`, `verdict`, `tasks` or `allowFlaky`. */
export function compareEnvelope(report) {
  const regressions = findings(report.tasks, 'regression')
  const warnings = findings(report.tasks, 'warning')
  const shownRegressions = regressions.slice(0, MAX_FINDINGS)
  const shownWarnings = warnings.slice(0, MAX_FINDINGS)
  const total = regressions.length + warnings.length
  const returned = shownRegressions.length + shownWarnings.length
  const page = pageOf({ limit: MAX_FINDINGS * 2, offset: 0, returned, total })
  const text = summaryText(report)
  return okEnvelope('check_compare', {
    summary: report.summary,
    summaryText: text,
    page,
    truncated: page.hasMore || text.length > 200,
    next: nextFor(report),
    legacy: {
      verdict: report.verdict,
      regressions: shownRegressions,
      warnings: shownWarnings,
      allowFlaky: report.allowFlaky,
      tasks: report.tasks,
    },
  })
}

/** Failure envelope; `code` stays the original validation code. */
export function compareFailure(error) {
  return failEnvelope('check_compare', error, {
    summary: { ...EMPTY_COUNTS },
    remediation: 'Pass two valid run objects; task ids must be unique and metrics non-negative.',
    nextTools: [step('check_run', { prompt: 'Produce a run object, then retry check_compare.' }, 'Generate a valid run before comparing.')],
    legacy: { verdict: null, regressions: [], warnings: [], allowFlaky: [], tasks: [] },
  })
}
