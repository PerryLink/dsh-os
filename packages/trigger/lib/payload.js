/**
 * Bounded, redacted projection of an event payload for the run ledger.
 *
 * Runs keep a *copy*, never the live payload: secrets are replaced before the
 * copy is stored, the JSON form is capped at 2 KiB, and the result is deeply
 * frozen so neither a later action nor a reader can rewrite the ledger.
 * The original payload still goes to conditions and actions unchanged.
 */
import { basename, isAbsolute, relative, sep } from 'node:path'

/** Stored payload cap, in UTF-8 bytes of its JSON form. */
export const MAX_PAYLOAD_BYTES = 2048

const TRUNCATED = '…[truncated]'
const MAX_TEXT_BYTES = 512
const SENSITIVE_KEY = /(?:apikey|secret|token|password|passwd|authorization|auth|cookie|privatekey|credentials?|signature|hmac)$/i

/** Key names whose value is never persisted, regardless of its shape. */
const sensitive = key => SENSITIVE_KEY.test(String(key).replace(/[-_]/g, ''))

const REDACTIONS = [
  [/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '[REDACTED_GH_TOKEN]'],
  [/\bAKIA[0-9A-Z]{12,24}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
]

/** Replace known credential shapes in one string. */
export function redactText(text) {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/** Cut a UTF-8 string at a byte budget without splitting a code point. */
export function truncateText(text, maxBytes = MAX_TEXT_BYTES) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  const suffix = Buffer.byteLength(TRUNCATED)
  let end = Math.max(0, maxBytes - suffix)
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return `${buffer.subarray(0, end).toString('utf8')}${TRUNCATED}`
}

const byteLength = value => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
const isPlain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && !(value instanceof Date)
  && !ArrayBuffer.isView(value)

/** One depth/key/item/text budget; the largest that fits under the cap wins. */
const LIMITS = Object.freeze([
  { depth: 8, keys: 64, items: 32, text: 512 },
  { depth: 6, keys: 32, items: 16, text: 256 },
  { depth: 4, keys: 16, items: 8, text: 128 },
  { depth: 3, keys: 8, items: 4, text: 64 },
])

function copy(value, depth, seen, limits) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return truncateText(redactText(value), limits.text)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value !== 'object') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (ArrayBuffer.isView(value)) return { type: 'binary', bytes: value.byteLength }
  if (depth >= limits.depth) return '[MaxDepth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.slice(0, limits.items)
      .map(item => copy(item, depth + 1, seen, limits))
      .filter(item => item !== undefined)
  } else {
    out = {}
    for (const key of Object.keys(value).slice(0, limits.keys)) {
      if (sensitive(key)) {
        out[key] = '[REDACTED]'
        continue
      }
      const child = copy(value[key], depth + 1, seen, limits)
      if (child !== undefined) out[key] = child
    }
  }
  seen.delete(value)
  return out
}

function freeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

/**
 * Return a JSON-safe, redacted, deeply frozen copy of `payload` whose JSON form
 * is at most `MAX_PAYLOAD_BYTES`. Oversized payloads degrade to a `preview`
 * string that is already redacted; the original is never mutated.
 */
export function sanitizePayload(payload) {
  let safe
  for (const limits of LIMITS) {
    safe = copy(payload, 0, new WeakSet(), limits) ?? null
    if (byteLength(safe) <= MAX_PAYLOAD_BYTES) return freeze(safe)
  }
  const compact = copy(payload, 0, new WeakSet(), LIMITS.at(-1)) ?? null
  const json = JSON.stringify(compact)
  const bytes = Buffer.byteLength(json, 'utf8')
  // JSON escaping (quotes, control characters) can grow the preview, so shrink
  // the raw slice until the *encoded* fallback fits the cap.
  for (let limit = 900; ; limit = Math.floor(limit / 2)) {
    const out = { truncated: true, bytes, preview: truncateText(json, limit) }
    if (byteLength(out) <= MAX_PAYLOAD_BYTES || limit === 0) return freeze(out)
  }
}

/**
 * A short display path for the run row. Paths inside `process.cwd()` stay
 * relative; anything else is reduced to its final segment. The full value, if
 * any, remains in `payload.path`.
 */
export function displayPath(payload) {
  if (!isPlain(payload) || payload === null || typeof payload.path !== 'string' || payload.path === '') return null
  const rel = relative(process.cwd(), payload.path)
  const display = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : basename(payload.path)
  return display === '' ? null : truncateText(redactText(display), MAX_TEXT_BYTES)
}

/** The ledger projection of one fired event. */
export function runFields(payload) {
  return { payload: sanitizePayload(payload), path: displayPath(payload) }
}
