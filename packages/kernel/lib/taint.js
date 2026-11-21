/**
 * Content-hash taint registry for dsh-os-kernel 0.4.0.
 *
 * The gateway records the SHA-256 of text returned by taint sources
 * (`snip_get`, `seek_resolve`, `trigger_runs`) and of any result carrying a
 * `taintToken`. A later write of the same text can then require the extra
 * `:tainted` Grant or a one-time, hash-bound token instead of trusting the
 * model to self-report `tainted: true`.
 *
 * Only digests, source ids, tokens and timestamps are stored — never the
 * original text. Tokens expire after five minutes and are cleared on first
 * successful use; the digest stays registered (bounded) so the content keeps
 * requiring the tainted Grant after its token is gone.
 *
 * This is an exact-text gate, not taint tracking: a model that edits the
 * content before writing produces a different digest and passes the gate. See
 * the package README for the limits.
 * @module dsh-os-kernel/taint
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export const TAINT_TTL_MS = 5 * 60 * 1000
export const MAX_TAINT_RECORDS = 256
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/
export const TAINT_SOURCES = Object.freeze([
  'snip.get', 'legacy.snip_get', 'snip_get',
  'seek.resolve', 'legacy.seek_resolve', 'seek_resolve',
  'trigger.runs', 'legacy.trigger_runs', 'trigger_runs',
])

const SOURCE_IDS = new Set(TAINT_SOURCES)
const TEXT_KEYS = new Set(['text', 'content', 'body', 'markdown', 'snippet'])
const MAX_DEPTH = 8

const isObject = value => value !== null && typeof value === 'object'
const isToken = value => typeof value === 'string' && TOKEN_PATTERN.test(value)
const sameToken = (left, right) => isToken(left) && isToken(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right))

/** True when a capability id is one whose text starts a taint flow. */
export const isTaintSource = id => SOURCE_IDS.has(id)

/** SHA-256 hex digest of one text value. */
export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** Collect `{ hash -> token }` for every text/content field in a result value. */
function collectTexts(value, token, found, depth = 0) {
  if (!isObject(value) || depth > MAX_DEPTH) return
  const local = typeof value.taintToken === 'string' && value.taintToken !== '' ? value.taintToken : token
  for (const [key, child] of Object.entries(value)) {
    if (TEXT_KEYS.has(key) && typeof child === 'string' && child !== '') {
      const hash = sha256(child)
      if (local !== null || !found.has(hash)) found.set(hash, local)
      continue
    }
    if (isObject(child)) collectTexts(child, local, found, depth + 1)
  }
}

export class TaintRegistry {
  #records = new Map()
  #now
  #ttlMs
  #max

  constructor(options = {}) {
    this.#now = typeof options?.now === 'function' ? options.now : Date.now
    this.#ttlMs = Number.isSafeInteger(options?.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TAINT_TTL_MS
    this.#max = Number.isSafeInteger(options?.max) && options.max > 0 ? options.max : MAX_TAINT_RECORDS
  }

  /** Register one text digest. The text itself is hashed and discarded. */
  record(text, options = {}) {
    if (typeof text !== 'string' || text === '') return null
    return this.#store(sha256(text), options)
  }

  /**
   * Observe one capability result. Text from a taint source is always
   * registered; other results are registered only when they carry a token.
   */
  observe(capabilityId, value) {
    const found = new Map()
    collectTexts(value, null, found)
    const source = isTaintSource(capabilityId)
    if (!source && ![...found.values()].some(token => typeof token === 'string' && token !== '')) return 0
    for (const [hash, token] of found) this.#store(hash, { source: capabilityId, token })
    return found.size
  }

  #store(hash, { source = 'unknown', token = null } = {}) {
    const previous = this.#records.get(hash)
    const incoming = typeof token === 'string' && token !== '' ? token : null
    const nextToken = incoming ?? previous?.token ?? null
    const at = this.#now()
    const record = {
      hash, source, token: nextToken, at,
      tokenExpiresAt: incoming !== null ? at + this.#ttlMs
        : nextToken === null ? null : previous?.tokenExpiresAt ?? at + this.#ttlMs,
      usedAt: previous?.usedAt ?? null,
    }
    if (!this.#records.has(hash)) {
      while (this.#records.size >= this.#max) this.#records.delete(this.#records.keys().next().value)
    }
    this.#records.set(hash, record)
    return { ...record }
  }

  /** Look up a digest without consuming its token. */
  lookup(hash) {
    return typeof hash === 'string' ? this.#records.get(hash) : undefined
  }

  /** True when this exact text was registered (token already used or not). */
  matches(text) {
    return typeof text === 'string' && text !== '' && this.#records.has(sha256(text))
  }

  /** Check a token for a digest and burn it on success. */
  consume(hash, token) {
    const record = this.lookup(hash)
    if (record === undefined || !isToken(token) || !sameToken(record.token, token)) return false
    if (!(record.tokenExpiresAt > this.#now())) return false
    record.token = null
    record.usedAt = this.#now()
    return true
  }

  /** Copy of the registry metadata; never contains plaintext. */
  snapshot() {
    return [...this.#records.values()].map(record => ({ ...record }))
  }

  get size() {
    return this.#records.size
  }
}

export default TaintRegistry
