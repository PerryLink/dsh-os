/**
 * dsh-trace — auditable long-term memory governance for DeepSeek Harness.
 *
 * 0.3.0: Host service `ctx.trace` with remember / search / forget / list /
 * export, provenance, TTL expiry, confidence-aware supersede chains and secret
 * redaction, plus the `dsh-memory-protocol/v1` bridge to `dsh-memento`
 * (read-only import, data-only export, adapter availability). `trace_remember`
 * optionally verifies a `dsh://` source through `ctx.evidence.resolve`
 * (`verifyRefs`, default true). Seven plain-object agent tools. Plain ESM,
 * Node.js 22+, no runtime dependencies, no network.
 * @module dsh-trace
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_SOURCE_LENGTH, SCOPES, SENSITIVITIES } from './lib/constants.js'
import { createMementoBridge } from './lib/memento.js'
import { createTools } from './lib/tools.js'
import { createRefVerifier } from './lib/verify.js'

/** Cordis plugin name. */
export const name = 'dsh-trace'

/** The service is standalone; the agent tools need the host tool registry. */
export const inject = ['tools']

/** Wire identifiers of the 0.1.0 governance profile. */
export const PROTOCOL = 'dsh-memory-protocol/v1'
export const PROFILE = 'trace/1'
export const EXPORT_FORMAT = 'trace-export-v1'

/** Text stored for records whose sensitivity is `secret`. */
export const REDACTED = '[redacted]'

const REMEMBER_FIELDS = new Set([
  'key', 'text', 'source', 'scope', 'confidence', 'ttlMs', 'sensitivity', 'force',
])
const RESTORE_FIELDS = new Set([
  'key', 'text', 'source', 'scope', 'confidence', 'sensitivity', 'createdAt', 'expiresAt',
])
const clone = value => structuredClone(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const byUpdatedDesc = (a, b) => b.provenance.updatedAt - a.provenance.updatedAt

function fail(code, message, extra) {
  throw Object.assign(new Error(message), { code }, extra)
}

function checkKey(key) {
  const normalized = typeof key === 'string' ? key.trim() : ''
  if (normalized === '' || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    fail('invalid_key', 'key must be a non-empty single-line string of at most 256 characters')
  }
  return normalized
}

function normalizeLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1) fail('invalid_limit', 'limit must be a positive integer')
  return Math.min(value, MAX_LIMIT)
}

/** Validate and normalize one `remember` draft. Unknown fields are rejected. */
function normalizeDraft(input) {
  if (!plain(input)) fail('invalid_arguments', 'remember input must be an object')
  for (const field of Object.keys(input)) {
    if (!REMEMBER_FIELDS.has(field)) fail('invalid_arguments', `unknown remember field "${field}"`)
  }
  const key = checkKey(input.key)
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    fail('invalid_text', 'text must be a non-empty string')
  }
  const source = input.source ?? 'user'
  if (typeof source !== 'string' || source.trim() === '' || source.length > MAX_SOURCE_LENGTH) {
    fail('invalid_source', `source must be a non-empty string of at most ${MAX_SOURCE_LENGTH} characters`)
  }
  const scope = input.scope ?? 'workspace'
  if (!SCOPES.includes(scope)) fail('invalid_scope', `scope must be one of ${SCOPES.join(', ')}`)
  const confidence = input.confidence ?? 0.5
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1) {
    fail('invalid_confidence', 'confidence must be a number between 0 and 1')
  }
  const ttlMs = input.ttlMs ?? null
  if (ttlMs !== null && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) {
    fail('invalid_ttl', 'ttlMs must be a positive number of milliseconds')
  }
  const sensitivity = input.sensitivity ?? 'normal'
  if (!SENSITIVITIES.includes(sensitivity)) {
    fail('invalid_sensitivity', `sensitivity must be one of ${SENSITIVITIES.join(', ')}`)
  }
  const force = input.force ?? false
  if (typeof force !== 'boolean') fail('invalid_force', 'force must be a boolean')
  return {
    key,
    text: input.text,
    source: source.trim(),
    scope,
    confidence,
    ttlMs,
    sensitivity,
    force,
  }
}

/**
 * Validate one migration draft. Unlike `remember`, callers may pin the
 * original `createdAt` and an absolute `expiresAt`, and may not force a
 * higher-confidence record away: imports must obey the normal supersede rule.
 */
function normalizeRestore(input) {
  if (!plain(input)) fail('invalid_arguments', 'restore input must be an object')
  for (const field of Object.keys(input)) {
    if (!RESTORE_FIELDS.has(field)) fail('invalid_arguments', `unknown restore field "${field}"`)
  }
  const draft = normalizeDraft({
    key: input.key,
    text: input.text,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  })
  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    fail('invalid_created_at', 'createdAt must be a non-negative integer')
  }
  const expiresAt = input.expiresAt ?? null
  if (expiresAt !== null
    && (!Number.isInteger(expiresAt) || expiresAt <= createdAt)) {
    fail('invalid_expires_at', 'expiresAt must be an integer after createdAt')
  }
  return { draft, createdAt, expiresAt }
}

/** Build one active record. Secret text never reaches the record. */
function makeRecord(draft, now, previous, times = {}) {
  const createdAt = times.createdAt ?? now
  const record = {
    id: randomUUID(),
    key: draft.key,
    text: draft.sensitivity === 'secret' ? REDACTED : draft.text,
    scope: draft.scope,
    confidence: draft.confidence,
    sensitivity: draft.sensitivity,
    status: 'active',
    supersedes: previous === undefined ? [] : [previous.id],
    provenance: { source: draft.source, createdAt, updatedAt: times.updatedAt ?? createdAt },
  }
  if (draft.sensitivity === 'secret') record.redacted = true
  if (times.expiresAt !== undefined) record.expiresAt = times.expiresAt
  else if (draft.ttlMs !== null) record.expiresAt = now + draft.ttlMs
  return record
}

/**
 * Host seam `ctx.trace`: an in-memory, auditable memory ledger.
 *
 * The current record for a key is active; every replaced or expired version is
 * retained in an internal archive so `export()` can prove the supersede chain.
 * Expired records disappear from `search()`/`list()` but stay visible in the
 * export with `status: 'expired'`. `forget()` removes every version of the key
 * and leaves only a text-free tombstone.
 */
export class TraceService {
  protocol = PROTOCOL
  profile = PROFILE
  #records = new Map()
  #archive = new Map()
  #tombstones = []

  /** Retire an internal record into the export archive. */
  #retire(record, status, now, supersededBy) {
    record.status = status
    record.provenance.updatedAt = now
    if (supersededBy !== undefined) record.supersededBy = supersededBy
    this.#archive.set(record.id, record)
  }

  /** Move every expired active record into the archive. */
  #sweep(now) {
    for (const [key, record] of this.#records) {
      if (record.expiresAt === undefined || record.expiresAt > now) continue
      this.#retire(record, 'expired', now)
      this.#records.delete(key)
    }
  }

  /** Shared write path for remember and restore. */
  #commit(draft, times = {}) {
    const now = Date.now()
    this.#sweep(now)
    const previous = this.#records.get(draft.key)
    if (previous !== undefined && previous.confidence > draft.confidence && !draft.force) {
      fail(
        'trace_confidence_too_low',
        `refusing to replace "${draft.key}" (confidence ${previous.confidence}) with confidence ${draft.confidence}; pass force:true to override`,
        { current: clone(previous) },
      )
    }
    const record = makeRecord(draft, now, previous, times)
    if (previous !== undefined) this.#retire(previous, 'superseded', now, record.id)
    this.#records.set(record.key, record)
    return clone(record)
  }

  /**
   * Store one claim under a normalized key. A newer claim supersedes the
   * previous one unless the previous record has higher confidence and `force`
   * is not set, in which case a `trace_confidence_too_low` error is thrown.
   * Secret text is replaced with `[redacted]` before storage.
   */
  remember(input) {
    return this.#commit(normalizeDraft(input))
  }

  /**
   * Migration/import path: like `remember`, but preserves the original
   * `createdAt` and an absolute `expiresAt`. `force` is deliberately not
   * accepted, so an import can never overwrite a higher-confidence record.
   * Stored text is still redacted when `sensitivity` is `secret`.
   */
  restore(input) {
    const { draft, createdAt, expiresAt } = normalizeRestore(input)
    return this.#commit(draft, {
      createdAt,
      ...(expiresAt === null ? {} : { expiresAt }),
    })
  }

  /** Read one active record by key; expired records are swept first. */
  get(key) {
    const normalized = checkKey(key)
    this.#sweep(Date.now())
    const record = this.#records.get(normalized)
    return record === undefined ? null : clone(record)
  }

  /**
   * Case-insensitive substring search over active keys and text. Key matches
   * rank above text matches, then confidence and recency break ties.
   */
  search(query, options = {}) {
    if (typeof query !== 'string') fail('invalid_query', 'query must be a string')
    if (!plain(options)) fail('invalid_arguments', 'search options must be an object')
    const limit = normalizeLimit(options.limit)
    this.#sweep(Date.now())
    const active = [...this.#records.values()]
    const needle = query.trim().toLowerCase()
    if (needle === '') return active.sort(byUpdatedDesc).slice(0, limit).map(clone)
    const scored = []
    for (const record of active) {
      const inKey = record.key.toLowerCase().includes(needle)
      const inText = record.text.toLowerCase().includes(needle)
      if (!inKey && !inText) continue
      scored.push({ record, score: (inKey ? 2 : 0) + (inText ? 1 : 0) + record.confidence })
    }
    scored.sort((a, b) => b.score - a.score || byUpdatedDesc(a.record, b.record))
    return scored.slice(0, limit).map(entry => clone(entry.record))
  }

  /**
   * Forget every version of one key: the active record and its archived
   * versions are removed, and a text-free tombstone is retained for audit.
   * Returns whether the key existed.
   */
  forget(key) {
    const normalized = checkKey(key)
    const now = Date.now()
    this.#sweep(now)
    const current = this.#records.get(normalized)
    const archived = [...this.#archive.values()].filter(record => record.key === normalized)
    if (current === undefined && archived.length === 0) return false
    if (current !== undefined) this.#records.delete(normalized)
    for (const record of archived) this.#archive.delete(record.id)
    this.#tombstones.push({
      key: normalized,
      forgottenAt: now,
      versions: archived.length + (current === undefined ? 0 : 1),
    })
    return true
  }

  /** List active records, most recently updated first. */
  list(options = {}) {
    if (!plain(options)) fail('invalid_arguments', 'list options must be an object')
    const limit = normalizeLimit(options.limit)
    this.#sweep(Date.now())
    return [...this.#records.values()].sort(byUpdatedDesc).slice(0, limit).map(clone)
  }

  /**
   * Export active, superseded and expired records plus text-free forget
   * tombstones. The format is stable for 0.1.0 (`trace-export-v1`).
   */
  export() {
    const now = Date.now()
    this.#sweep(now)
    const records = [...this.#archive.values(), ...this.#records.values()]
      .sort((a, b) => a.provenance.createdAt - b.provenance.createdAt)
      .map(clone)
    return {
      format: EXPORT_FORMAT,
      protocol: PROTOCOL,
      profile: PROFILE,
      exportedAt: now,
      records,
      tombstones: clone(this.#tombstones),
    }
  }
}

/**
 * Mount dsh-trace: provide `ctx.trace`, probe memento without requiring it,
 * and register the seven agent tools. `config.verifyRefs` (default true) lets
 * `trace_remember` verify `dsh://` source labels through `ctx.evidence.resolve`
 * before storing them; `refVerifyMode: "warn"` records the claim with a warning
 * instead of rejecting it, and `verifyTimeoutMs` bounds the resolve call.
 * @param {object} ctx - Cordis context.
 * @param {{ verifyRefs?: boolean, refVerifyMode?: 'enforce'|'warn',
 *   verifyTimeoutMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const service = new TraceService()
  ctx.provide('trace', service)
  const memento = createMementoBridge(ctx, service)
  service.memento = memento
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const verifier = createRefVerifier(ctx, config)
    for (const tool of createTools(service, memento, verifier)) ctx.tools.register(tool)
  }
  return service
}

export { createTools }
