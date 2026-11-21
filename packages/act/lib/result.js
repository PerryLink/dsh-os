/**
 * Zero-dependency `os.result/v1` envelope helpers for the agent tools.
 * Legacy fields stay exactly as they were; the envelope adds bounded metadata.
 * @module dsh-act/result
 */

export const RESULT_SCHEMA = 'os.result/v1'
export const MAX_SUMMARY = 200
export const MAX_NEXT = 3

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Trim and cap a summary at `max` characters, marking the cut with an ellipsis. */
export function clip(text, max = MAX_SUMMARY) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** One page descriptor; `hasMore` tells the caller whether another page exists. */
export function pageOf({ limit = 0, offset = 0, returned = 0, total = 0 } = {}) {
  return { limit, offset, returned, total, hasMore: offset + returned < total }
}

/** One suggested next tool call. */
export function step(tool, args = {}, why = '') {
  return { tool, args: isObject(args) ? args : {}, ...(typeof why === 'string' && why !== '' ? { why } : {}) }
}

function nextList(value) {
  return (Array.isArray(value) ? value : [])
    .filter(item => isObject(item) && typeof item.tool === 'string' && item.tool !== '')
    .slice(0, MAX_NEXT)
}

/** Keep `summary` as a string, or as a legacy object plus `summaryText`. */
function summaryFields(fields, fallback) {
  if (isObject(fields.summary)) {
    return { summary: fields.summary, summaryText: clip(fields.summaryText ?? fallback) }
  }
  return { summary: clip(fields.summary ?? fallback) }
}

/** Build a successful envelope, merging unchanged legacy fields. */
export function okEnvelope(tool, fields = {}) {
  const items = Array.isArray(fields.items) ? fields.items : []
  const page = fields.page ?? pageOf({ limit: items.length, returned: items.length, total: items.length })
  return {
    schema: RESULT_SCHEMA,
    ok: true,
    tool,
    ...(isObject(fields.legacy) ? fields.legacy : {}),
    ...summaryFields(fields, `${items.length} item(s)`),
    items,
    page,
    truncated: fields.truncated === true,
    next: nextList(fields.next),
    error: null,
  }
}

/** Build a failure envelope; the original `code` is preserved at both levels. */
export function failEnvelope(tool, error, fields = {}) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'E_INTERNAL'
  const message = clip(error instanceof Error ? error.message : String(error), 240)
  const next = nextList(fields.nextTools)
  return {
    schema: RESULT_SCHEMA,
    ok: false,
    tool,
    ...(isObject(fields.legacy) ? fields.legacy : {}),
    code,
    ...summaryFields(fields, `${tool} failed: ${message}`),
    items: [],
    page: fields.page ?? pageOf({}),
    truncated: false,
    next,
    error: {
      code,
      message,
      retryable: fields.retryable === true,
      remediation: clip(fields.remediation ?? 'Fix the request, then retry once.'),
      nextTools: next,
    },
  }
}

export default { RESULT_SCHEMA, MAX_SUMMARY, MAX_NEXT, clip, pageOf, step, okEnvelope, failEnvelope }
