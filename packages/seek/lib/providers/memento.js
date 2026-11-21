/**
 * `memento` provider: read approved memory through dsh-memento's `ctx.memory`.
 * Only the `user-global` scope is queried, with the caller's `agentKey` passed
 * into the query so visibility is filtered before entries are returned.
 * @module dsh-seek/providers/memento
 */

import { fail, firstLine, rankScore, serviceOf, throwIfAborted } from './util.js'

/** Keep in sync with `MAX_REF_LENGTH` in index.js. */
const MAX_REF_LENGTH = 512

/** Locate `ctx.memory` (or an adapter exposing the same `query` shape). */
export function probeMemento(ctx) {
  const memory = serviceOf(ctx, 'memory')
  if (memory !== undefined && typeof memory.query === 'function') return { ok: true, memory }
  const adapters = serviceOf(ctx, 'memoryAdapters')
  if (adapters !== undefined && typeof adapters.query === 'function') return { ok: true, memory: adapters }
  return { ok: false, reason: 'memory service is not available (install/enable dsh-memento)' }
}

function refId(value) {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..') return undefined
  const id = encodeURIComponent(value)
  if (id === '' || id === '.' || id === '..') return undefined
  return id
}

function toHit(raw, index, agentKey) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.scope !== 'user-global') return undefined
  if (typeof raw.agentKey === 'string' && raw.agentKey !== '' && raw.agentKey !== agentKey) return undefined
  const id = refId(raw.id)
  if (id === undefined) return undefined
  const ref = `dsh://memento/${id}`
  if (ref.length > MAX_REF_LENGTH) return undefined
  const body = typeof raw.text === 'string' ? raw.text : ''
  const snippet = body.length > 2000 ? `${body.slice(0, 1997)}...` : body
  return {
    ref,
    source: 'memento',
    title: firstLine(raw.title ?? body, 300) || `Memory ${id}`,
    snippet,
    score: Number.isFinite(raw.score) ? raw.score : rankScore(index),
    // Memory entries have no verifiable snapshot, so freshness is explicitly unknown.
    freshness: { state: 'unknown' },
  }
}

/** Extract the ref id, preferring the id the Seek service already parsed. */
function idOf(ref, options) {
  if (typeof options.id === 'string') return options.id
  const prefix = 'dsh://memento/'
  if (typeof ref === 'string' && ref.startsWith(prefix)) return ref.slice(prefix.length)
  return undefined
}

/** First-party memento adapter. */
export function createMementoProvider(ctx) {
  return {
    name: 'memento',
    async search(query, options = {}) {
      const probe = probeMemento(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      if (typeof options.agentKey !== 'string' && options.agent === undefined) {
        throw fail('E_UNAUTHORIZED', 'seek: memento requires a caller agent (agentKey)')
      }
      throwIfAborted(options.signal)
      const agentKey = typeof options.agentKey === 'string' ? options.agentKey : ''
      const result = await probe.memory.query({
        text: query,
        limit: options.limit,
        scope: 'user-global',
      }, { agentKey })
      if (!Array.isArray(result?.entries)) throw fail('E_STATE', 'seek: memory.query returned no entries array')
      return result.entries.map((entry, index) => toHit(entry, index, agentKey)).filter(Boolean)
    },

    /**
     * Look one entry up by id. dsh-memento has no get-by-id API, so the query is
     * narrowed before returning (user-global + caller agentKey) and only then
     * matched by id; it never falls back to a workspace or all-agent query.
     * Found entries have no verifiable snapshot, so status stays `unknown`.
     */
    async resolve(ref, options = {}) {
      const probe = probeMemento(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      if (typeof options.agentKey !== 'string' && options.agent === undefined) {
        throw fail('E_UNAUTHORIZED', 'seek: memento resolve requires a caller agent (agentKey)')
      }
      const id = idOf(ref, options)
      if (typeof id !== 'string' || id === '') {
        throw fail('E_INVALID_ARGUMENT', 'seek: memento resolve requires a ref id')
      }
      let rawId
      try {
        rawId = decodeURIComponent(id)
      } catch {
        throw fail('E_INVALID_ARGUMENT', 'seek: memento ref id is not valid percent-encoding')
      }
      throwIfAborted(options.signal)
      const agentKey = typeof options.agentKey === 'string' ? options.agentKey : ''
      const result = await probe.memory.query({ scope: 'user-global', limit: 1000 }, { agentKey })
      if (!Array.isArray(result?.entries)) throw fail('E_STATE', 'seek: memory.query returned no entries array')
      const entry = result.entries.find(raw => raw !== null && typeof raw === 'object'
        && raw.id === rawId
        && raw.scope === 'user-global'
        && (typeof raw.agentKey !== 'string' || raw.agentKey === '' || raw.agentKey === agentKey))
      if (entry === undefined) return { found: false, status: 'missing', checkedAt: Date.now() }
      return {
        found: true,
        status: 'unknown',
        title: firstLine(entry.title ?? entry.text, 300) || `Memory ${rawId}`,
        freshness: { state: 'unknown' },
        checkedAt: Date.now(),
      }
    },
  }
}
