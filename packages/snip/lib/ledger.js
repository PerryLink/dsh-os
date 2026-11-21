/**
 * Ledger, secret screening and clipboard-capture orchestration for dsh-snip.
 * The plugin entry re-exports these symbols, so `import { SnipService } from
 * 'dsh-snip'` keeps working.
 * @module dsh-snip/ledger
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_INTERVAL_MS,
  createClipboardAdapter,
  hashText,
} from './capture.js'

const DAY_MS = 86_400_000
const PREVIEW_CHARS = 140
const HANDLE_PREFIX = 'clipboard://'
const MAX_SOURCE_APP = 80
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
export const KINDS = new Set(['text', 'html', 'link', 'color'])
export const SENSITIVITIES = new Set(['normal', 'sensitive', 'secret'])

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

export function fail(code, message) {
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

/**
 * Validate the source application label. Labels are metadata, never a secret
 * store: anything secret-looking is rejected instead of silently stored.
 */
function normalizeSourceApp(value) {
  if (value === undefined || value === null) return 'unknown'
  if (typeof value !== 'string') throw fail('SNIP_BAD_SOURCE_APP', 'snip: sourceApp must be a string')
  const label = value.trim()
  if (label === '') return 'unknown'
  if (label.length > MAX_SOURCE_APP) {
    throw fail('SNIP_BAD_SOURCE_APP', `snip: sourceApp must be at most ${MAX_SOURCE_APP} characters`)
  }
  if (CONTROL_CHARS.test(label)) {
    throw fail('SNIP_BAD_SOURCE_APP', 'snip: sourceApp must not contain control characters')
  }
  if (detectSecret(label)) {
    throw fail('SNIP_BAD_SOURCE_APP', 'snip: sourceApp must not contain secret-looking text')
  }
  return label
}

/** Loading a snapshot tolerates bad metadata: drop it instead of failing mount. */
function safeSourceApp(value) {
  try {
    return normalizeSourceApp(value)
  } catch {
    return 'unknown'
  }
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
  #captureEnabled
  #captureOptions
  #adapter
  #watching = false
  #watchIntervalMs
  #lastWatchError = null
  #lastHash = null
  #lastEntryId = null

  constructor(ctxOrConfig = {}, maybeConfig) {
    const config = isContext(ctxOrConfig) ? (maybeConfig ?? {}) : (ctxOrConfig ?? {})
    this.#ttlMs = positiveInt(config.ttlMs ?? config.ttl, DAY_MS)
    this.#maxEntries = positiveInt(config.maxEntries, 200)
    this.#maxBytes = positiveInt(config.maxBytes, 64 * 1024)
    this.#excludeSecrets = config.excludeSecrets !== false
    this.#now = typeof config.now === 'function' ? config.now : () => Date.now()
    this.#stateFile = typeof config.stateFile === 'string' && config.stateFile.length > 0 ? config.stateFile : null
    const rawCapture = config.capture
    const capture = rawCapture === true
      ? { enabled: true }
      : rawCapture && typeof rawCapture === 'object' ? rawCapture : {}
    this.#captureEnabled = capture.enabled === true
    this.#watchIntervalMs = positiveInt(capture.intervalMs, DEFAULT_INTERVAL_MS)
    this.#captureOptions = {
      platform: capture.platform,
      backend: capture.backend,
      runner: capture.runner,
      available: capture.available,
      timeoutMs: capture.timeoutMs,
      maxChars: capture.maxChars,
      intervalMs: this.#watchIntervalMs,
    }
    this.#adapter = capture.adapter ?? null
    if (this.#stateFile) this.#load()
    const next = new Map(this.#entries)
    const swept = this.#sweep(next)
    if (this.#stateFile) this.#commit(next)
    else if (swept > 0) this.#entries = next
  }

  /** Whether clipboard capture is enabled; off unless configured. */
  get captureEnabled() {
    return this.#captureEnabled
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
    const sourceApp = normalizeSourceApp(args.sourceApp)

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

    const next = new Map(this.#entries)
    this.#sweep(next)
    next.set(entry.id, entry)
    this.#enforceMax(next)
    this.#commit(next)
    return summaryOf(entry)
  }

  /**
   * Read the OS clipboard once and store it. Disabled unless
   * `capture.enabled` is true. The result never contains the text itself.
   */
  capture(options = {}) {
    this.#requireCapture()
    const adapter = this.#getAdapter()
    const probe = adapter.available()
    if (!probe.available) {
      throw fail('SNIP_CLIPBOARD_UNAVAILABLE', `snip: clipboard unavailable (${probe.reason ?? 'unsupported'})`)
    }
    let snapshot
    try {
      snapshot = adapter.read()
    } catch (error) {
      if (typeof error?.code === 'string') throw error
      throw fail('SNIP_CLIPBOARD_FAILED', 'snip: clipboard read failed')
    }
    return this.#ingest(snapshot, options?.sourceApp)
  }

  /**
   * Start explicit clipboard polling. Requires `capture.enabled`; there is no
   * implicit watcher on mount. Idempotent while already watching.
   */
  watch(options = {}) {
    this.#requireCapture()
    const adapter = this.#getAdapter()
    const probe = adapter.available()
    if (!probe.available) {
      throw fail('SNIP_CLIPBOARD_UNAVAILABLE', `snip: clipboard unavailable (${probe.reason ?? 'unsupported'})`)
    }
    if (this.#watching) {
      return { ok: true, watching: true, intervalMs: this.#watchIntervalMs }
    }
    const intervalMs = positiveInt(options?.intervalMs, this.#watchIntervalMs)
    this.#lastWatchError = null
    adapter.watch(snapshot => {
      try {
        this.#ingest(snapshot)
        this.#lastWatchError = null
      } catch (error) {
        this.#lastWatchError = typeof error?.code === 'string' ? error.code : 'SNIP_CLIPBOARD_FAILED'
      }
    }, { intervalMs })
    this.#watching = true
    this.#watchIntervalMs = intervalMs
    return { ok: true, watching: true, intervalMs }
  }

  /** Stop polling; safe to call when no watcher is running. */
  stopWatch() {
    const wasWatching = this.#watching
    if (wasWatching) this.#getAdapter().stop()
    this.#watching = false
    return { ok: true, watching: false, stopped: wasWatching, lastError: this.#lastWatchError }
  }

  #requireCapture() {
    if (!this.#captureEnabled) {
      throw fail('SNIP_CAPTURE_DISABLED', 'snip: clipboard capture is disabled; set capture.enabled=true')
    }
  }

  #getAdapter() {
    if (this.#adapter === null) this.#adapter = createClipboardAdapter(this.#captureOptions)
    return this.#adapter
  }

  /** Turn one adapter snapshot into a ledger entry, redacting and deduping. */
  #ingest(snapshot, sourceApp) {
    if (!snapshot || snapshot.ok !== true) {
      const code = typeof snapshot?.code === 'string' ? snapshot.code : 'SNIP_CLIPBOARD_FAILED'
      throw fail(code, 'snip: clipboard read failed')
    }
    if (snapshot.kind !== 'text') {
      return { ok: true, kind: snapshot.kind ?? 'empty', captured: false }
    }
    const text = snapshot.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: true, kind: 'empty', captured: false }
    }
    const hash = hashText(text)
    const last = this.#lastEntryId === null ? null : this.#entries.get(this.#lastEntryId)
    if (hash === this.#lastHash && last && Date.parse(last.expiresAt) > this.#now()) {
      return {
        ok: true,
        kind: 'text',
        captured: false,
        duplicate: true,
        handle: handleOf(this.#lastEntryId),
        redacted: last.redacted,
      }
    }
    const summary = this.add({ text, kind: 'text', sourceApp })
    this.#lastHash = hash
    this.#lastEntryId = summary.id
    return {
      ok: true,
      kind: 'text',
      captured: true,
      duplicate: false,
      id: summary.id,
      handle: summary.handle,
      redacted: summary.redacted,
      bytes: Buffer.byteLength(text, 'utf8'),
      ...(snapshot.truncated === true ? { truncated: true } : {}),
      expiresAt: summary.expiresAt,
    }
  }

  /** Newest-first summaries, optionally filtered by kind. */
  list(options = {}) {
    const args = options ?? {}
    this.#sweepAndCommit()
    const kind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : null
    return [...this.#entries.values()]
      .reverse()
      .filter(entry => kind === null || entry.kind === kind)
      .slice(0, requestedLimit(args.limit, this.#maxEntries))
      .map(summaryOf)
  }

  /** Case-insensitive substring search over stored text (redacted text included). */
  search(query, options = {}) {
    return this.searchPage(query, options).entries
  }

  /**
   * Paged search: returns the requested window plus the full match count so a
   * tool envelope can report `page.total`/`hasMore` without re-scanning.
   */
  searchPage(query, options = {}) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (!needle) throw fail('SNIP_BAD_QUERY', 'snip: query must be a non-empty string')
    this.#sweepAndCommit()
    const matches = [...this.#entries.values()]
      .reverse()
      .filter(entry => entry.text.toLowerCase().includes(needle))
    const limit = requestedLimit(options?.limit, this.#maxEntries)
    const offset = Number.isInteger(options?.offset) && options.offset >= 1 ? options.offset : 0
    return { total: matches.length, limit, offset, entries: matches.slice(offset, offset + limit).map(summaryOf) }
  }

  /** Full entry (including text) by id or `clipboard://` handle; null if absent. */
  get(idOrHandle) {
    const id = resolveId(idOrHandle)
    this.#sweepAndCommit()
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
    const next = new Map(this.#entries)
    const swept = this.#sweep(next)
    const removed = next.delete(id)
    if (removed || swept > 0) this.#commit(next)
    return removed
  }

  /** Delete every entry; return the number removed. */
  clear() {
    const removed = this.#entries.size
    if (removed > 0) this.#commit(new Map())
    return removed
  }

  /** Sweep expired/overflowing entries; commit only when something changed. */
  #sweepAndCommit() {
    const next = new Map(this.#entries)
    if (this.#sweep(next) === 0) return
    this.#commit(next)
  }

  #sweep(entries = this.#entries) {
    const now = this.#now()
    let removed = 0
    for (const [id, entry] of entries) {
      if (Date.parse(entry.expiresAt) <= now) {
        entries.delete(id)
        removed += 1
      }
    }
    return removed + this.#enforceMax(entries)
  }

  #enforceMax(entries = this.#entries) {
    let removed = 0
    while (entries.size > this.#maxEntries) {
      entries.delete(entries.keys().next().value)
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
        sourceApp: safeSourceApp(raw.sourceApp),
        sensitivity,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(this.#now()).toISOString(),
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : new Date(this.#now() + this.#ttlMs).toISOString(),
        redacted: raw.redacted === true || reason !== null,
      })
    }
  }

  /** Write `next` first; only replace live state after the snapshot lands. */
  #commit(next) {
    this.#persist(next)
    this.#entries = next
  }

  #persist(entries = this.#entries) {
    if (!this.#stateFile) return
    const payload = `${JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2)}\n`
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
