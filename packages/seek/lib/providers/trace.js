/**
 * `trace` provider: read dsh-trace's governed memory ledger through `ctx.trace`.
 *
 * Memory is user/external input, so every hit is marked `tainted: true`; a hit
 * is `resolvable: true` because this provider implements `resolve`. Records are
 * mapped to `dsh://trace/<record-id>` and looked up by id through `trace.list`
 * (falling back to `trace.search`). Trace has no verifiable snapshot, so a found
 * record is `status: "unknown"`, never `fresh`.
 * @module dsh-seek/providers/trace
 */

import { fail, firstLine, rankScore, serviceOf, text, throwIfAborted } from './util.js'

/** Keep in sync with `MAX_REF_LENGTH` in index.js and `MAX_LIMIT` in dsh-trace. */
const MAX_REF_LENGTH = 512
const LOOKUP_LIMIT = 100

/** Locate `ctx.trace` without requiring dsh-trace. */
export function probeTrace(ctx) {
  const trace = serviceOf(ctx, 'trace')
  if (trace === undefined) {
    return { ok: false, reason: 'trace service is not available (install/enable dsh-trace)' }
  }
  if (typeof trace.search !== 'function') {
    return { ok: false, reason: 'trace service has no search function (install/enable dsh-trace >= 0.3)' }
  }
  return { ok: true, trace }
}

function refId(value) {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..') return undefined
  const id = encodeURIComponent(value)
  if (id === '' || id === '.' || id === '..') return undefined
  return id
}

function toHit(record, index) {
  if (record === null || typeof record !== 'object') return undefined
  const id = refId(record.id)
  if (id === undefined) return undefined
  const ref = `dsh://trace/${id}`
  if (ref.length > MAX_REF_LENGTH) return undefined
  const body = typeof record.text === 'string' ? record.text : ''
  return {
    ref,
    source: 'trace',
    title: firstLine(typeof record.key === 'string' ? record.key : body, 300) || `Trace ${id}`,
    snippet: text(body, 2000),
    score: rankScore(index),
    freshness: { state: 'unknown' },
    // Memory is user/external input; downstream gates must treat it as tainted.
    tainted: true,
  }
}

/** Extract the ref id, preferring the id the Seek service already parsed. */
function idOf(ref, options) {
  if (typeof options.id === 'string') return options.id
  const prefix = 'dsh://trace/'
  if (typeof ref === 'string' && ref.startsWith(prefix)) return ref.slice(prefix.length)
  return undefined
}

/** Read one page of active records; a malformed service answer is an E_STATE. */
function recordsOf(value) {
  if (!Array.isArray(value)) throw fail('E_STATE', 'seek: trace service returned no records array')
  return value
}

/**
 * Find one active record by id. `trace.list` is the direct lookup; `trace.search`
 * is the documented fallback for services that only expose search.
 */
function findById(trace, id) {
  if (typeof trace.list === 'function') {
    const found = recordsOf(trace.list({ limit: LOOKUP_LIMIT }))
      .find(record => record !== null && typeof record === 'object' && record.id === id)
    if (found !== undefined) return found
  }
  if (typeof trace.search === 'function') {
    return recordsOf(trace.search(id, { limit: LOOKUP_LIMIT }))
      .find(record => record !== null && typeof record === 'object' && record.id === id)
  }
  return undefined
}

/** First-party trace adapter. */
export function createTraceProvider(ctx) {
  return {
    name: 'trace',
    async search(query, options = {}) {
      const probe = probeTrace(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      throwIfAborted(options.signal)
      return recordsOf(probe.trace.search(query, { limit: options.limit }))
        .map((record, index) => toHit(record, index))
        .filter(Boolean)
    },

    /**
     * Resolve one `dsh://trace/<record-id>` ref. The raw answer carries the
     * record's provenance `source` and `text`; Seek's normalizer keeps the
     * provider name as `source` and forwards `text` for the evidence chain.
     */
    async resolve(ref, options = {}) {
      const probe = probeTrace(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      const id = idOf(ref, options)
      if (typeof id !== 'string' || id === '') {
        throw fail('E_INVALID_ARGUMENT', 'seek: trace resolve requires a ref id')
      }
      let rawId
      try {
        rawId = decodeURIComponent(id)
      } catch {
        throw fail('E_INVALID_ARGUMENT', 'seek: trace ref id is not valid percent-encoding')
      }
      throwIfAborted(options.signal)
      const record = findById(probe.trace, rawId)
      if (record === undefined) return { found: false, status: 'missing' }
      return {
        found: true,
        status: 'unknown',
        source: typeof record.provenance?.source === 'string' ? record.provenance.source : 'trace',
        title: firstLine(typeof record.key === 'string' ? record.key : record.text, 300) || `Trace ${rawId}`,
        ...(typeof record.text === 'string' && record.text !== ''
          ? { text: text(record.text, 4000) }
          : {}),
      }
    },
  }
}
