/** Protocol enums and SLA defaults shared by the service and tool schemas. */

/** States; `resolved` and `expired` close a case for tick purposes. */
export const STATES = Object.freeze(['pending', 'notified', 'escalated', 'acked', 'resolved', 'expired'])
export const RISKS = Object.freeze(['read', 'write', 'exec', 'danger'])
export const DEFAULT_TTL_MS = 60 * 60 * 1000

/** Default SLA: t0 0s, t1 3m, t2 10m, t3 30m; case TTL is 60m. */
export const DEFAULT_ESCALATION_CHAIN = Object.freeze([
  { level: 0, afterMs: 0, channel: 'local' },
  { level: 1, afterMs: 3 * 60 * 1000, channel: 'local' },
  { level: 2, afterMs: 10 * 60 * 1000, channel: 'webhook' },
  { level: 3, afterMs: 30 * 60 * 1000, channel: 'voice' },
])
