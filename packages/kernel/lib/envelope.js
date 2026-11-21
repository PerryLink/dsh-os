/**
 * Local `ok()` / `err()` envelopes for the OsResult and OsError protocols.
 *
 * Mirrors dsh-os-contract's result/error helpers on purpose: the
 * kernel stays zero-dependency and keeps its published `os.result/v1` schema.
 * Unknown or legacy error codes are aliased to the nine classes, with the
 * original kept in `details.legacyCode`.
 */
import { fingerprint } from './registry.js'

export const RESULT_SCHEMA = 'os.result/v1'
export const VERSION = '0.4.0'
export const ERROR_CLASSES = Object.freeze([
  'E_INVALID_ARGUMENT', 'E_DENIED', 'E_NOT_FOUND', 'E_CONFLICT', 'E_UNAVAILABLE',
  'E_LIMIT', 'E_STATE', 'E_TIMEOUT', 'E_INTERNAL',
])

const CLASSES = new Set(ERROR_CLASSES)
const RETRYABLE = Object.freeze({ E_UNAVAILABLE: true, E_LIMIT: true, E_TIMEOUT: true })
const ALIASES = Object.freeze({
  E_INPUT: ['E_INVALID_ARGUMENT', 'invalid_argument'],
  E_STATE_INVALID: ['E_STATE', 'version_mismatch'],
  state_invalid: ['E_STATE', 'version_mismatch'],
  grant_required: ['E_DENIED', 'grant_required'],
  E_UNAUTHORIZED: ['E_DENIED', 'unauthenticated'],
  E_RATE_LIMITED: ['E_LIMIT', 'rate_limited'],
  E_RATE_LIMIT: ['E_LIMIT', 'rate_limited'],
  E_QUOTA_EXCEEDED: ['E_LIMIT', 'quota_exceeded'],
  E_REQUEST_EXPIRED: ['E_TIMEOUT', 'approval_expired'],
  aborted: ['E_TIMEOUT', 'cancelled'],
  ABORT_ERR: ['E_TIMEOUT', 'cancelled'],
  action_failed: ['E_INTERNAL', 'tool_failed'],
})
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const slim = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const uid = kind => `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Map any code to `{ code, subcode, legacyCode }`; never throws. */
export function resolveCode(code, subcode) {
  if (CLASSES.has(code)) return { code, subcode: subcode ?? null, legacyCode: null }
  if (typeof code !== 'string' || code === '') return { code: 'E_INTERNAL', subcode: subcode ?? 'tool_failed', legacyCode: null }
  if (ALIASES[code]) return { code: ALIASES[code][0], subcode: subcode ?? ALIASES[code][1], legacyCode: code }
  if (code.startsWith('invalid_')) return { code: 'E_INVALID_ARGUMENT', subcode: subcode ?? code, legacyCode: code }
  if (code.startsWith('E_')) return { code: 'E_INVALID_ARGUMENT', subcode: subcode ?? 'invalid_argument', legacyCode: code }
  if (code.endsWith('_not_found')) return { code: 'E_NOT_FOUND', subcode: subcode ?? code, legacyCode: code }
  if (code.endsWith('_exists')) return { code: 'E_CONFLICT', subcode: subcode ?? 'already_exists', legacyCode: code }
  if (code.endsWith('_timeout') || code === 'timeout') return { code: 'E_TIMEOUT', subcode: subcode ?? 'timeout', legacyCode: code }
  if (code.endsWith('_failed')) return { code: 'E_INTERNAL', subcode: subcode ?? 'tool_failed', legacyCode: code }
  return { code: 'E_INTERNAL', subcode: subcode ?? 'tool_failed', legacyCode: code }
}

/** Build the canonical failure envelope `{ ok: false, error }`. */
export function err(code, message, options = {}) {
  const resolved = resolveCode(code, options.subcode)
  const legacyCode = options.legacyCode ?? resolved.legacyCode
  const details = { ...(isObject(options.details) ? options.details : {}) }
  if (legacyCode !== null && details.legacyCode === undefined) details.legacyCode = legacyCode
  const retryable = options.retryable ?? RETRYABLE[resolved.code] === true
  const text = typeof message === 'string' && message.trim() !== '' ? message : `${resolved.code}: the call failed.`
  return {
    ok: false,
    error: {
      code: resolved.code,
      subcode: resolved.subcode,
      message: slim(text, 240),
      retryable,
      retryAfterMs: retryable ? (options.retryAfterMs ?? 0) : null,
      remediation: options.remediation ?? 'Report the requestId to the maintainer.',
      nextTools: (Array.isArray(options.nextTools) ? options.nextTools : [])
        .filter(item => isObject(item) && typeof item.tool === 'string' && item.tool !== '').slice(0, 3),
      requestId: options.requestId ?? uid('req'),
      auditId: options.auditId ?? null,
      details,
      cause: null,
    },
  }
}

/** Build a bounded `os.result/v1` success envelope. */
export function ok(tool, value, options = {}) {
  const items = Array.isArray(value) ? value.slice(0, 20) : Array.isArray(value?.items) ? value.items.slice(0, 20) : []
  const total = Array.isArray(value) ? value.length : Number.isInteger(value?.total) ? value.total : items.length
  const data = value === undefined || Array.isArray(value) ? undefined : value
  const summary = slim(options.summary ?? (typeof value?.summary === 'string' ? value.summary
    : Array.isArray(value) ? `Returned ${items.length} item(s) from ${tool}.` : `${tool} completed.`), 200)
  const page = {
    limit: items.length || 0, returned: items.length, total, totalKnown: true,
    hasMore: total > items.length, nextCursor: null, sort: 'none',
  }
  const payload = { items, page, data }
  const result = {
    schema: RESULT_SCHEMA,
    ok: true,
    tool,
    requestId: options.requestId ?? uid('req'),
    auditId: null,
    summary,
    items,
    page,
    handles: Array.isArray(value?.handles) ? value.handles.slice(0, 5) : [],
    truncated: false,
    warnings: Array.isArray(value?.warnings) ? value.warnings.slice(0, 20) : [],
    cost: {
      tokens: Math.ceil(JSON.stringify(payload).length / 4),
      tokensEstimated: true,
      latencyMs: options.latencyMs ?? 0,
      money: { usd: 0, estimated: false },
    },
    next: Array.isArray(options.next) ? options.next.slice(0, 3) : Array.isArray(value?.next) ? value.next.slice(0, 3) : [],
    provenance: {
      source: 'kernel', sourceVersion: VERSION, observedAt: Date.now(), freshness: 'live',
      hash: `fnv1a:${fingerprint(payload)}`, hashScope: 'items+page+data',
    },
  }
  if (data !== undefined) result.data = data
  if (isObject(value?.job)) result.job = value.job
  return result
}

/**
 * Read a legacy tool outcome. Returns `null` for a plain value, otherwise
 * `{ ok: true, value }` with the `ok` flag stripped, or `{ ok: false, error }`.
 * @param {unknown} value
 * @returns {{ok: true, value: any}|{ok: false, error: any}|null}
 */
export function legacyOutcome(value) {
  if (!isObject(value) || typeof value.ok !== 'boolean') return null
  if (value.ok === false) {
    const error = isObject(value.error) ? value.error
      : typeof value.error === 'string' ? { message: value.error }
      : value
    return { ok: false, error }
  }
  const { ok: _ok, ...rest } = value
  const keys = Object.keys(rest)
  return { ok: true, value: keys.length === 1 && keys[0] === 'data' ? rest.data : rest }
}

export default { ok, err, legacyOutcome, resolveCode, RESULT_SCHEMA, VERSION, ERROR_CLASSES }
