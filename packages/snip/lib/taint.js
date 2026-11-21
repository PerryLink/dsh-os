/**
 * In-process taint tokens for dsh-snip 0.4.0.
 *
 * A token is a random 256-bit id mapped to the SHA-256 of the text it was
 * minted for. Tokens are never persisted, never leave this process and expire
 * after 15 minutes by default, so they are evidence that *this process* saw
 * the content, not a signed capability.
 *
 * This is a deliberately minimal gate: it cannot prove that the content is
 * safe, and a caller can bypass it by not forwarding the token. See the
 * package README for the limits.
 * @module dsh-snip/taint
 */
import { randomBytes } from 'node:crypto'

export const DEFAULT_TAINT_TTL_MS = 15 * 60 * 1000
export const MAX_TAINT_TOKENS = 512
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export class TaintTokens {
  #records = new Map()
  #now
  #ttlMs
  #max

  constructor(options = {}) {
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    this.#ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_TAINT_TTL_MS
    this.#max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : MAX_TAINT_TOKENS
  }

  /** Mint a token bound to one entry id and content hash. */
  issue(entryId, hash) {
    this.#sweep()
    while (this.#records.size >= this.#max) this.#records.delete(this.#records.keys().next().value)
    const token = randomBytes(32).toString('hex')
    this.#records.set(token, Object.freeze({ entryId, hash, expiresAt: this.#now() + this.#ttlMs }))
    return token
  }

  /** Return the record for a live token, or undefined for forged/expired ones. */
  verify(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return undefined
    const record = this.#records.get(token)
    if (record === undefined) return undefined
    if (record.expiresAt <= this.#now()) {
      this.#records.delete(token)
      return undefined
    }
    return record
  }

  /** Invalidate every token minted for one entry. */
  dropEntry(entryId) {
    for (const [token, record] of this.#records) {
      if (record.entryId === entryId) this.#records.delete(token)
    }
  }

  #sweep() {
    const now = this.#now()
    for (const [token, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(token)
    }
  }
}
