/**
 * OsError v1: nine classes, recovery hints, cause projection and legacy aliases.
 * @module @perrylink/dsh-os-contract/lib/error
 */
import { newId } from './ids.js'

/** The nine closed error classes (`error.code`). */
export const ERROR_CLASSES = Object.freeze([
  'E_INVALID_ARGUMENT', 'E_DENIED', 'E_NOT_FOUND', 'E_CONFLICT', 'E_UNAVAILABLE',
  'E_LIMIT', 'E_STATE', 'E_TIMEOUT', 'E_INTERNAL',
])

const CLASS_SET = new Set(ERROR_CLASSES)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

const CLASS_DEFAULTS = Object.freeze(Object.fromEntries([
  ['E_INVALID_ARGUMENT', 'invalid_argument', false, 'Pass arguments that match the tool schema, then retry once.'],
  ['E_DENIED', 'denied', false, 'Request the missing grant or scope, then retry once it is active.'],
  ['E_NOT_FOUND', 'not_found', false, 'Use an existing id or create the object first.'],
  ['E_CONFLICT', 'conflict', false, 'Re-read the current state, then retry with a fresh version or idempotency key.'],
  ['E_UNAVAILABLE', 'unavailable', true, 'Retry after the dependency recovers; if it persists, check that it is installed and configured.'],
  ['E_LIMIT', 'limit_exceeded', true, 'Wait for the limit to reset, then retry with fewer items or a narrower scope.'],
  ['E_STATE', 'state_error', false, 'Stop retrying; preserve the state and run the repair or migration path.'],
  ['E_TIMEOUT', 'timeout', true, 'Retry with a larger deadline or fewer items; do not retry a write whose outcome is unknown.'],
  ['E_INTERNAL', 'tool_failed', false, 'Do not retry; report the requestId and auditId to the maintainer.'],
].map(([code, subcode, retryable, remediation]) => [code, { subcode, retryable, remediation }])))

/** Per-subcode retry defaults; missing entries fall back to the class default. */
const SUBCODE_RETRY = Object.freeze({
  rate_limited: true, quota_exceeded: false, result_budget: false, result_capped: false, deadline: true, timeout: true,
  cancelled: false, outcome_unknown: false, idempotency_in_flight: true, grant_required: false, cursor_expired: true,
  cursor_stale: true, handle_expired: false, transient: true, already_exists: false, idempotency_reuse: false,
})

/** Legacy code → `[class, subcode]`; details.legacyCode keeps the original. */
const ALIASES = Object.freeze({
  E_INPUT: ['E_INVALID_ARGUMENT', 'invalid_argument'], E_VERSION: ['E_STATE', 'version_mismatch'],
  E_STATE_INVALID: ['E_STATE', 'version_mismatch'], state_invalid: ['E_STATE', 'version_mismatch'],
  E_MEMENTO_PAYLOAD: ['E_STATE', 'corrupt'], grant_required: ['E_DENIED', 'grant_required'],
  'scope-mismatch': ['E_DENIED', 'scope_mismatch'], E_SUBJECT_MISMATCH: ['E_DENIED', 'subject_mismatch'],
  E_UNAUTHORIZED: ['E_DENIED', 'unauthenticated'], layer_forbidden: ['E_DENIED', 'layer_forbidden'],
  SNIP_CLIPBOARD_EXCLUDED: ['E_DENIED', 'clipboard_excluded'], stale_topology: ['E_CONFLICT', 'stale_topology'],
  trace_confidence_too_low: ['E_CONFLICT', 'trace_confidence_too_low'], inherit_cycle: ['E_CONFLICT', 'inherit_cycle'],
  action_exists: ['E_CONFLICT', 'already_exists'],
  trigger_exists: ['E_CONFLICT', 'already_exists'], provider_exists: ['E_CONFLICT', 'already_exists'],
  source_exists: ['E_CONFLICT', 'already_exists'], duplicate_task: ['E_CONFLICT', 'already_exists'],
  E_RATE_LIMITED: ['E_LIMIT', 'rate_limited'], E_RATE_LIMIT: ['E_LIMIT', 'rate_limited'],
  E_QUOTA_EXCEEDED: ['E_LIMIT', 'quota_exceeded'], E_EXHAUSTED: ['E_DENIED', 'grant_exhausted'],
  E_MISMATCH: ['E_CONFLICT', 'digest_mismatch'], E_REQUEST_EXPIRED: ['E_TIMEOUT', 'approval_expired'],
  provider_timeout: ['E_TIMEOUT', 'timeout'], timeout: ['E_TIMEOUT', 'timeout'],
  aborted: ['E_TIMEOUT', 'cancelled'], ABORT_ERR: ['E_TIMEOUT', 'cancelled'],
  action_failed: ['E_INTERNAL', 'tool_failed'], SNIP_BAD_TEXT: ['E_INVALID_ARGUMENT', 'invalid_argument'],
  SNIP_NOT_FOUND: ['E_NOT_FOUND', 'snip_not_found'], SNIP_CLIPBOARD_TIMEOUT: ['E_TIMEOUT', 'timeout'],
  SNIP_CLIPBOARD_UNSUPPORTED: ['E_UNAVAILABLE', 'clipboard_unsupported'],
  SNIP_CLIPBOARD_UNAVAILABLE: ['E_UNAVAILABLE', 'clipboard_unsupported'],
  no_runner: ['E_UNAVAILABLE', 'not_configured'], no_topology: ['E_NOT_FOUND', 'no_topology'],
  nothing_to_undo: ['E_NOT_FOUND', 'nothing_to_undo'],
})

function resolveCode(code) {
  if (CLASS_SET.has(code)) return { code, subcode: null, legacyCode: null }
  const legacy = typeof code === 'string' ? code : null
  if (legacy !== null && Object.hasOwn(ALIASES, legacy)) {
    return { code: ALIASES[legacy][0], subcode: ALIASES[legacy][1], legacyCode: legacy }
  }
  if (legacy !== null) {
    if (legacy.startsWith('invalid_')) return { code: 'E_INVALID_ARGUMENT', subcode: legacy, legacyCode: legacy }
    if (legacy.startsWith('E_')) return { code: 'E_INVALID_ARGUMENT', subcode: 'invalid_argument', legacyCode: legacy }
    if (legacy.endsWith('_not_found')) return { code: 'E_NOT_FOUND', subcode: legacy, legacyCode: legacy }
    if (legacy.endsWith('_exists')) return { code: 'E_CONFLICT', subcode: 'already_exists', legacyCode: legacy }
    if (legacy.endsWith('_timeout')) return { code: 'E_TIMEOUT', subcode: 'timeout', legacyCode: legacy }
    if (legacy.endsWith('_failed')) return { code: 'E_INTERNAL', subcode: 'tool_failed', legacyCode: legacy }
  }
  return { code: 'E_INTERNAL', subcode: 'tool_failed', legacyCode: legacy }
}

function clampRetry(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), 600000)
}

function normalizeDetails(value, legacyCode) {
  const details = isObject(value) ? { ...value } : {}
  if (legacyCode !== null && details.legacyCode === undefined) details.legacyCode = legacyCode
  return details
}

function normalizeNext(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => isObject(item) && typeof item.tool === 'string' && item.tool !== '').slice(0, 3)
}

function normalizeCause(cause) {
  if (cause === undefined || cause === null) return null
  if (typeof cause === 'string') return { name: 'Error', code: null, message: clip(cause, 240) }
  if (!isObject(cause)) return null
  const message = typeof cause.message === 'string' ? cause.message : ''
  return {
    name: typeof cause.name === 'string' && cause.name !== '' ? cause.name : 'Error',
    code: typeof cause.code === 'string' ? cause.code : null,
    message: clip(message, 240),
  }
}

/** The single error object: `{code, subcode, message, retryable, …, details, cause}`. */
export class OsError extends Error {
  constructor(code, options = {}) {
    const input = isObject(options) ? options : {}
    const resolved = resolveCode(code)
    const defaults = CLASS_DEFAULTS[resolved.code]
    const subcode = input.subcode === undefined
      ? (resolved.subcode ?? defaults.subcode)
      : (typeof input.subcode === 'string' && input.subcode !== '' ? input.subcode : null)
    let retryable = input.retryable ?? SUBCODE_RETRY[subcode] ?? defaults.retryable
    if (input.retryable === undefined && subcode === 'grant_required' && input.details?.approvalRequestId) retryable = true
    const message = typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message
      : `${resolved.code}${subcode === null ? '' : `/${subcode}`}: the call failed.`
    super(clip(message, 240))
    this.name = 'OsError'
    this.code = resolved.code
    this.subcode = subcode
    this.retryable = retryable === true
    this.retryAfterMs = this.retryable
      ? clampRetry(input.retryAfterMs ?? (subcode === 'grant_required' ? 2000 : 0))
      : null
    this.remediation = clip(typeof input.remediation === 'string' && input.remediation.trim() !== ''
      ? input.remediation
      : defaults.remediation, 200)
    this.nextTools = normalizeNext(input.nextTools)
    this.requestId = typeof input.requestId === 'string' && input.requestId !== '' ? input.requestId : newId('req_')
    this.auditId = typeof input.auditId === 'string' && input.auditId !== '' ? input.auditId : null
    this.details = normalizeDetails(input.details, resolved.legacyCode)
    this.cause = resolved.code === 'E_INTERNAL' || resolved.code === 'E_STATE' ? normalizeCause(input.cause) : null
  }

  /** Wire projection; `cause` is limited to `{name, code, message}`. */
  toJSON() {
    return {
      code: this.code, subcode: this.subcode, message: this.message,
      retryable: this.retryable, retryAfterMs: this.retryAfterMs,
      remediation: this.remediation, nextTools: this.nextTools,
      requestId: this.requestId, auditId: this.auditId,
      details: this.details, cause: this.cause,
    }
  }
}

/**
 * Build an `OsError`; unknown or legacy `code` strings are resolved to a class.
 * @param {string} code
 * @param {object} [options]
 * @returns {OsError}
 */
export function err(code, options = {}) {
  return new OsError(code, options)
}

/**
 * Whether the same call may be retried as-is. Accepts a code, a subcode as the
 * second argument, or an error-like object carrying `retryable`.
 * @param {string|object} code
 * @param {string} [subcode]
 * @returns {boolean}
 */
export function isRetryable(code, subcode) {
  if (code instanceof OsError) return code.retryable
  if (isObject(code) && typeof code.retryable === 'boolean') return code.retryable
  if (isObject(code)) {
    subcode = code.subcode ?? subcode
    code = code.code
  }
  const resolved = resolveCode(code)
  const value = subcode === undefined ? resolved.subcode : subcode
  if (typeof value === 'string' && Object.hasOwn(SUBCODE_RETRY, value)) return SUBCODE_RETRY[value]
  return CLASS_DEFAULTS[resolved.code].retryable
}

/**
 * Normalize anything thrown or returned into the failure envelope
 * `{ ok: false, error }`. Legacy `error.code` values are aliased and kept in
 * `error.details.legacyCode`; this function never throws.
 * @param {unknown} error
 * @returns {{ok:false,error:object}}
 */
export function toToolError(error) {
  if (error instanceof OsError) return { ok: false, error: error.toJSON() }
  const envelope = isObject(error) && error.ok === false && error.error !== undefined ? error : null
  const source = envelope ? error.error : error
  if (source instanceof OsError) return { ok: false, error: source.toJSON() }
  if (typeof source === 'string') {
    const options = { message: source, requestId: envelope?.requestId, auditId: envelope?.auditId }
    return { ok: false, error: new OsError('E_INTERNAL', options).toJSON() }
  }
  if (isObject(source)) {
    let code = source.code
    let subcode = source.subcode
    if ((code === undefined || code === null || code === '')
      && (source.name === 'AbortError' || source.name === 'TimeoutError')) {
      code = 'E_TIMEOUT'
      subcode = source.name === 'AbortError' ? 'cancelled' : 'timeout'
    }
    const options = {
      subcode,
      message: source.message ?? source.reason,
      retryable: source.retryable,
      retryAfterMs: source.retryAfterMs,
      remediation: source.remediation,
      nextTools: source.nextTools,
      requestId: source.requestId ?? envelope?.requestId,
      auditId: source.auditId ?? envelope?.auditId,
      details: source.details,
      cause: source.cause ?? (source instanceof Error ? source : undefined),
    }
    return { ok: false, error: new OsError(code ?? 'E_INTERNAL', options).toJSON() }
  }
  const options = { requestId: envelope?.requestId, auditId: envelope?.auditId }
  return { ok: false, error: new OsError('E_INTERNAL', { ...options, message: 'Unknown error' }).toJSON() }
}
