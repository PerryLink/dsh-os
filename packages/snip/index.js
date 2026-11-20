/**
 * dsh-snip — local-first clipboard ledger for DeepSeek Harness.
 *
 * 0.1.0 records explicit `add` calls only: no clipboard polling, no network,
 * no encryption yet. Secret-looking text is not stored unless the caller
 * explicitly disables `excludeSecrets`.
 * @module dsh-snip
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-snip'
export const inject = ['tools']

const DAY_MS = 86_400_000
const PREVIEW_CHARS = 140
const HANDLE_PREFIX = 'clipboard://'
const KINDS = new Set(['text', 'html', 'link', 'color'])
const SENSITIVITIES = new Set(['normal', 'sensitive', 'secret'])

/** Ordered: first match wins. Reasons are stable for `[redacted:<reason>]`. */
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{6,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{8,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{10,}\b/],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/],
  ['password', /\b(?:password|passwd|pwd)"?\s*[:=]\s*(?:"[^"]{3,}"|'[^']{3,}'|[^\s'"]{3,})/i],
  ['api-key', /\b(?:api[_-]?key|apikey)"?\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s'"]{8,})/i],
  ['credential', /\b(?:secret|token|access[_-]?key)"?\s*[:=]\s*(?:"[^"]{6,}"|'[^']{6,}'|[^\s'"]{6,})/i],
]

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

function requestedLimit(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.min(Math.floor(number), fallback) : fallback
}

function previewOf(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

function handleOf(id) {
  return `${HANDLE_PREFIX}${id}`
}

function resolveId(value) {
  if (typeof value !== 'string') throw fail('SNIP_BAD_ID', 'snip: id must be a string')
  const id = value.startsWith(HANDLE_PREFIX) ? value.slice(HANDLE_PREFIX.length) : value
  if (!id) throw fail('SNIP_BAD_ID', 'snip: id must not be empty')
  return id
}

function summaryOf(entry) {
  return {
    id: entry.id,
    handle: handleOf(entry.id),
    kind: entry.kind,
    preview: entry.preview,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    redacted: entry.redacted,
  }
}

function isContext(value) {
  return Boolean(value && typeof value === 'object' && ('provide' in value || 'get' in value || 'tools' in value))
}

/** Return the first secret pattern reason found in `text`, or null. */
export function detectSecret(text) {
  if (typeof text !== 'string') return null
  for (const [reason, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return reason
  }
  return null
}

/** In-memory ledger with optional atomic JSON snapshot. */
export class SnipService {
  #entries = new Map()
  #stateFile
  #ttlMs
  #maxEntries
  #maxBytes
  #excludeSecrets
  #now

  constructor(ctxOrConfig = {}, maybeConfig) {
    const config = isContext(ctxOrConfig) ? (maybeConfig ?? {}) : (ctxOrConfig ?? {})
    this.#ttlMs = positiveInt(config.ttlMs ?? config.ttl, DAY_MS)
    this.#maxEntries = positiveInt(config.maxEntries, 200)
    this.#maxBytes = positiveInt(config.maxBytes, 64 * 1024)
    this.#excludeSecrets = config.excludeSecrets !== false
    this.#now = typeof config.now === 'function' ? config.now : () => Date.now()
    this.#stateFile = typeof config.stateFile === 'string' && config.stateFile.length > 0 ? config.stateFile : null
    if (this.#stateFile) this.#load()
    if (this.#sweep() || this.#stateFile) this.#persist()
  }

  /** Store one clipping; return its stable handle and metadata. */
  add(input = {}) {
    const args = input ?? {}
    const text = args.text
    if (typeof text !== 'string') throw fail('SNIP_BAD_TEXT', 'snip: text must be a string')
    if (text.trim().length === 0) throw fail('SNIP_EMPTY_TEXT', 'snip: text must not be empty')
    if (Buffer.byteLength(text, 'utf8') > this.#maxBytes) {
      throw fail('SNIP_TOO_LARGE', `snip: text exceeds maxBytes (${this.#maxBytes})`)
    }

    const kind = args.kind ?? 'text'
    if (typeof kind !== 'string' || !KINDS.has(kind)) {
      throw fail('SNIP_BAD_KIND', 'snip: unsupported kind')
    }
    const sensitivity = args.sensitivity ?? 'normal'
    if (typeof sensitivity !== 'string' || !SENSITIVITIES.has(sensitivity)) {
      throw fail('SNIP_BAD_SENSITIVITY', 'snip: unsupported sensitivity')
    }
    const rawSource = typeof args.sourceApp === 'string' ? args.sourceApp.trim() : ''
    const sourceApp = (rawSource || 'unknown').slice(0, 80)

    const reason = sensitivity === 'secret'
      ? 'sensitivity'
      : this.#excludeSecrets ? detectSecret(text) : null
    const storedText = reason ? `[redacted:${reason}]` : text
    const timestamp = this.#now()
    const entry = {
      id: randomUUID(),
      kind,
      text: storedText,
      preview: previewOf(storedText),
      sourceApp,
      sensitivity,
      createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + this.#ttlMs).toISOString(),
      redacted: reason !== null,
    }

    this.#sweep()
    this.#entries.set(entry.id, entry)
    this.#enforceMax()
    this.#persist()
    return summaryOf(entry)
  }

  /** Newest-first summaries, optionally filtered by kind. */
  list(options = {}) {
    const args = options ?? {}
    if (this.#sweep()) this.#persist()
    const kind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : null
    return [...this.#entries.values()]
      .reverse()
      .filter(entry => kind === null || entry.kind === kind)
      .slice(0, requestedLimit(args.limit, this.#maxEntries))
      .map(summaryOf)
  }

  /** Case-insensitive substring search over stored text (redacted text included). */
  search(query, options = {}) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (!needle) throw fail('SNIP_BAD_QUERY', 'snip: query must be a non-empty string')
    if (this.#sweep()) this.#persist()
    return [...this.#entries.values()]
      .reverse()
      .filter(entry => entry.text.toLowerCase().includes(needle))
      .slice(0, requestedLimit(options?.limit, this.#maxEntries))
      .map(summaryOf)
  }

  /** Full entry (including text) by id or `clipboard://` handle; null if absent. */
  get(idOrHandle) {
    const id = resolveId(idOrHandle)
    if (this.#sweep()) this.#persist()
    const entry = this.#entries.get(id)
    if (!entry) return null
    return {
      ...summaryOf(entry),
      text: entry.text,
      sourceApp: entry.sourceApp,
      sensitivity: entry.sensitivity,
    }
  }

  /** Delete one entry by id or handle; true when it existed. */
  forget(idOrHandle) {
    const id = resolveId(idOrHandle)
    const swept = this.#sweep()
    const removed = this.#entries.delete(id)
    if (removed || swept) this.#persist()
    return removed
  }

  /** Delete every entry; return the number removed. */
  clear() {
    const removed = this.#entries.size
    this.#entries.clear()
    if (removed) this.#persist()
    return removed
  }

  #sweep() {
    const now = this.#now()
    let removed = 0
    for (const [id, entry] of this.#entries) {
      if (Date.parse(entry.expiresAt) <= now) {
        this.#entries.delete(id)
        removed += 1
      }
    }
    return removed + this.#enforceMax()
  }

  #enforceMax() {
    let removed = 0
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value)
      removed += 1
    }
    return removed
  }

  #load() {
    if (!existsSync(this.#stateFile)) return
    let parsed
    try {
      const raw = readFileSync(this.#stateFile, 'utf8').trim()
      if (!raw) return
      parsed = JSON.parse(raw)
    } catch (error) {
      throw fail('SNIP_STATE_INVALID', `snip: cannot read state file: ${error.message}`)
    }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    for (const raw of entries) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
      const sensitivity = SENSITIVITIES.has(raw.sensitivity) ? raw.sensitivity : 'normal'
      // Re-scan on load so a snapshot written with detection disabled is safe.
      const reason = sensitivity === 'secret'
        ? 'sensitivity'
        : this.#excludeSecrets ? detectSecret(raw.text) : null
      const text = reason ? `[redacted:${reason}]` : raw.text
      this.#entries.set(raw.id, {
        id: raw.id,
        kind: KINDS.has(raw.kind) ? raw.kind : 'text',
        text,
        preview: previewOf(text),
        sourceApp: typeof raw.sourceApp === 'string' ? raw.sourceApp : 'unknown',
        sensitivity,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(this.#now()).toISOString(),
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : new Date(this.#now() + this.#ttlMs).toISOString(),
        redacted: raw.redacted === true || reason !== null,
      })
    }
  }

  #persist() {
    if (!this.#stateFile) return
    const payload = `${JSON.stringify({ version: 1, entries: [...this.#entries.values()] }, null, 2)}\n`
    const temp = `${this.#stateFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.#stateFile), { recursive: true, mode: 0o700 })
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, this.#stateFile)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch {}
      throw fail('SNIP_STATE_WRITE_FAILED', `snip: cannot write state file: ${error.message}`)
    }
  }
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args) {
      return run(args ?? {})
    },
  }
}

/** Plain-object ToolDefinition list; deliberately no @deepseek-ai/dsh-tools import. */
export function makeTools(service) {
  return [
    tool(
      'snip_add',
      'Add a text clipping to the local Snip ledger and return a clipboard:// handle. Secret-looking text is redacted and not stored by default.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text to record.' },
          kind: { type: 'string', enum: [...KINDS] },
          sourceApp: { type: 'string', description: 'Optional source application label.' },
          sensitivity: { type: 'string', enum: [...SENSITIVITIES] },
        },
      },
      args => service.add(args),
    ),
    tool(
      'snip_search',
      'Search the local Snip ledger (case-insensitive substring) and return matching handles and previews.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Text to look for.' },
          limit: { type: 'integer', minimum: 1 },
        },
      },
      args => ({ query: args.query, entries: service.search(args.query, { limit: args.limit }) }),
    ),
    tool(
      'snip_get',
      'Read one clipping by id or clipboard:// handle. Returned text becomes part of this conversation session log.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Clipping id or clipboard:// handle.' } },
      },
      args => {
        const entry = service.get(args.id)
        if (!entry) throw fail('SNIP_NOT_FOUND', 'snip: clipping not found')
        return entry
      },
    ),
    tool(
      'snip_list',
      'List recent clippings newest first, optionally filtered by kind.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: [...KINDS] },
          limit: { type: 'integer', minimum: 1 },
        },
      },
      args => ({ entries: service.list(args) }),
    ),
    tool(
      'snip_forget',
      'Delete one clipping by id or clipboard:// handle.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Clipping id or clipboard:// handle.' } },
      },
      args => {
        const removed = service.forget(args.id)
        return { ok: removed, removed }
      },
    ),
    tool(
      'snip_clear',
      'Delete every clipping in the local Snip ledger.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => ({ removed: service.clear() }),
    ),
  ]
}

/** Mount `ctx.snip` and the snip_* agent tools. */
export function apply(ctx, config = {}) {
  const service = new SnipService(config)
  ctx.provide('snip', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const definition of makeTools(service)) ctx.tools.register(definition)
  }
  return service
}
