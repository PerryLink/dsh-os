/**
 * dsh-trace — auditable long-term memory governance for DeepSeek Harness.
 *
 * 0.1.0 MVP: Host service `ctx.trace` with remember / search / forget / list /
 * export, provenance, TTL expiry, confidence-aware supersede chains and secret
 * redaction. Four plain-object agent tools. Plain ESM, Node.js 22+, no runtime
 * dependencies and no network access.
 * @module dsh-trace
 */
import { randomUUID } from 'node:crypto'

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

const SCOPES = ['user', 'workspace', 'preset', 'team']
const SENSITIVITIES = ['normal', 'public', 'internal', 'private', 'secret']
const REMEMBER_FIELDS = new Set([
  'key', 'text', 'source', 'scope', 'confidence', 'ttlMs', 'sensitivity', 'force',
])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

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
  if (typeof source !== 'string' || source.trim() === '' || source.length > 256) {
    fail('invalid_source', 'source must be a non-empty string of at most 256 characters')
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

/** Build one active record. Secret text never reaches the record. */
function makeRecord(draft, now, previous) {
  const record = {
    id: randomUUID(),
    key: draft.key,
    text: draft.sensitivity === 'secret' ? REDACTED : draft.text,
    scope: draft.scope,
    confidence: draft.confidence,
    sensitivity: draft.sensitivity,
    status: 'active',
    supersedes: previous === undefined ? [] : [previous.id],
    provenance: { source: draft.source, createdAt: now, updatedAt: now },
  }
  if (draft.sensitivity === 'secret') record.redacted = true
  if (draft.ttlMs !== null) record.expiresAt = now + draft.ttlMs
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

  /**
   * Store one claim under a normalized key. A newer claim supersedes the
   * previous one unless the previous record has higher confidence and `force`
   * is not set, in which case a `trace_confidence_too_low` error is thrown.
   * Secret text is replaced with `[redacted]` before storage.
   */
  remember(input) {
    const draft = normalizeDraft(input)
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
    const record = makeRecord(draft, now, previous)
    if (previous !== undefined) this.#retire(previous, 'superseded', now, record.id)
    this.#records.set(record.key, record)
    return clone(record)
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

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const argsSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
})

function tool(name, description, parameters, execute) {
  return { name, description, parameters, output: OUTPUT, execute }
}

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    tool(
      'trace_remember',
      'Remember one auditable claim under a key. A newer claim supersedes the old one; '
        + 'lower confidence is refused unless force is true. sensitivity "secret" stores only [redacted].',
      argsSchema({
        key: { type: 'string', description: 'Normalized subject key, e.g. "repo:dsh/pkg".' },
        text: { type: 'string', description: 'One self-contained claim.' },
        source: { type: 'string', description: 'Provenance label; defaults to "user".' },
        scope: { type: 'string', enum: SCOPES, description: 'Defaults to "workspace".' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Defaults to 0.5.' },
        ttlMs: { type: 'number', exclusiveMinimum: 0, description: 'Optional lifetime in milliseconds.' },
        sensitivity: { type: 'string', enum: SENSITIVITIES, description: 'Defaults to "normal".' },
        force: { type: 'boolean', description: 'Replace even a higher-confidence record.' },
      }, ['key', 'text']),
      async args => {
        try {
          return { record: service.remember(args) }
        } catch (error) {
          if (error?.code !== 'trace_confidence_too_low') throw error
          return { ok: false, code: error.code, message: error.message, current: error.current }
        }
      },
    ),
    tool(
      'trace_search',
      'Search active Trace records by case-insensitive substring over key and text.',
      argsSchema({
        query: { type: 'string', description: 'Substring; empty returns all active records.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Defaults to 20.' },
      }, ['query']),
      async args => ({ results: service.search(args?.query, { limit: args?.limit }) }),
    ),
    tool(
      'trace_forget',
      'Forget every version of a Trace key and leave a text-free audit tombstone.',
      argsSchema({ key: { type: 'string' } }, ['key']),
      async args => ({ forgotten: service.forget(args?.key) }),
    ),
    tool(
      'trace_list',
      'List active Trace records, most recently updated first.',
      argsSchema({
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Defaults to 20.' },
      }),
      async args => ({ records: service.list({ limit: args?.limit }) }),
    ),
  ]
}

/**
 * Mount dsh-trace: provide `ctx.trace` and register the four agent tools.
 * @param {object} ctx - Cordis context.
 * @param {object} [_config] - Reserved; the 0.1.0 ledger is in-memory only.
 */
export function apply(ctx, _config = {}) {
  const service = new TraceService()
  ctx.provide('trace', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
