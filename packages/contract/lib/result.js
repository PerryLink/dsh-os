/**
 * OsResult v1 helpers: bounded envelopes, signed cursors and `dsh://` handles.
 * @module dsh-os-contract/lib/result
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { newId } from './ids.js'

export const RESULT_SCHEMA = 'dsh.os.result/v1'
export const MAX_SUMMARY = 200
export const MAX_ITEMS = 20
export const MAX_HANDLES = 5
export const DEFAULT_PAGE_LIMIT = 20
export const HANDLE_KINDS = Object.freeze(['backup', 'backup-entries', 'trace', 'check-run', 'job', 'job-events', 'blob', 'snip'])

const MAX_NEXT = 3, MAX_WARNINGS = 20, MAX_PAGE_LIMIT = 100
const HANDLE_KIND_SET = new Set(HANDLE_KINDS), REF_ID = /^[^\s/?#\u0000-\u001f]+$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => Object.assign(new Error(message), { code: 'E_INVALID_ARGUMENT' })
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** Deterministic JSON with sorted object keys, used for the provenance hash. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

let processKey = null
const asKey = key => {
  if (key instanceof Uint8Array) return Buffer.from(key)
  if (typeof key === 'string' && key !== '') return Buffer.from(key, 'utf8')
  throw invalid('cursor key must be a non-empty string, Buffer or Uint8Array')
}
const getKey = key => (key === undefined || key === null ? (processKey ??= randomBytes(32)) : asKey(key))
const sign = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url')

/** Set the process-wide cursor key; `null` restores a random per-process key. */
export function setCursorKey(key) {
  processKey = key === undefined || key === null ? null : asKey(key)
}

function encodeCursor(offset, key) {
  const payload = Buffer.from(JSON.stringify({ v: 1, o: offset }), 'utf8').toString('base64url')
  return `v1.${payload}.${sign(payload, key)}`
}

function decodeCursor(cursor, key) {
  if (typeof cursor !== 'string') throw invalid('cursor must be a string')
  const parts = cursor.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1] === '' || parts[2] === '') throw invalid('invalid cursor')
  const expected = Buffer.from(sign(parts[1], key), 'base64url')
  const actual = Buffer.from(parts[2], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid('invalid cursor signature')
  let data
  try {
    data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw invalid('invalid cursor payload')
  }
  if (!isObject(data) || data.v !== 1 || !Number.isSafeInteger(data.o) || data.o < 0) throw invalid('invalid cursor payload')
  return data
}

/**
 * Take one signed page (`v1.<base64url payload>.<hmac>`); returns the selected
 * `items` plus the wire page fields, and can be passed to `ok(..., { page })`.
 * @param {unknown[]} items
 * @param {{limit?:number,cursor?:string|null,key?:string|Uint8Array}} [options]
 * @returns {{items:unknown[],limit:number,returned:number,total:number,hasMore:boolean,nextCursor:string|null}}
 */
export function page(items, options = {}) {
  if (!Array.isArray(items)) throw invalid('items must be an array')
  const { limit = DEFAULT_PAGE_LIMIT, cursor = null } = options
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PAGE_LIMIT) {
    throw invalid(`limit must be an integer between 0 and ${MAX_PAGE_LIMIT}`)
  }
  const key = getKey(options.key)
  const offset = cursor === null ? 0 : decodeCursor(cursor, key).o
  const total = items.length
  if (offset > total) throw invalid('cursor is stale for this result set')
  const returned = Math.min(limit, total - offset)
  const hasMore = limit > 0 && offset + returned < total
  return {
    items: items.slice(offset, offset + returned),
    limit, returned, total, hasMore,
    nextCursor: hasMore ? encodeCursor(offset + returned, key) : null,
  }
}

/** Build a canonical handle ref for a supported kind. */
export function makeHandle(kind, id) {
  if (typeof kind !== 'string' || !HANDLE_KIND_SET.has(kind)) throw invalid(`unknown handle kind: ${String(kind)}`)
  if (typeof id !== 'string' || !REF_ID.test(id)) throw invalid(`invalid handle id: ${String(id)}`)
  return `dsh://${kind}/${id}`
}

/** Parse a `dsh://<kind>/<id>` handle back into `{ kind, id }`. */
export function parseHandle(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('dsh://')) throw invalid(`invalid handle: ${String(ref)}`)
  const rest = ref.slice(6)
  const slash = rest.indexOf('/')
  const kind = rest.slice(0, slash)
  const id = rest.slice(slash + 1)
  if (slash < 1 || !HANDLE_KIND_SET.has(kind) || !REF_ID.test(id)) throw invalid(`invalid handle: ${ref}`)
  return { kind, id }
}

/**
 * Build a bounded `OsResult`; cuts items/handles, sets `truncated` and signs an
 * invented page. `data` is tool-owned scalar data (an array is treated as items).
 * @param {unknown} data
 * @param {object} [options] `{tool,summary,items,page,handles,cost,next,provenance,requestId,auditId}`
 * @returns {object}
 */
export function ok(data, options = {}) {
  if (!isObject(options)) throw invalid('options must be an object')
  const tool = typeof options.tool === 'string' && options.tool !== '' ? options.tool : null
  const givenPage = isObject(options.page) ? options.page : null
  const rawItems = Array.isArray(options.items)
    ? options.items
    : Array.isArray(data) ? data : givenPage && Array.isArray(givenPage.items) ? givenPage.items : []
  const rawHandles = Array.isArray(options.handles) ? options.handles : []
  const p = givenPage ?? page(rawItems, { limit: Math.min(MAX_ITEMS, rawItems.length) })
  const pageLimit = Number.isInteger(p.limit) ? p.limit : MAX_ITEMS
  const items = (Array.isArray(p.items) ? p.items : rawItems).slice(0, Math.min(MAX_ITEMS, pageLimit))
  const { items: _pageItems, ...pageMeta } = p
  const handles = rawHandles.slice(0, MAX_HANDLES)
  const total = Number.isInteger(pageMeta.total) ? pageMeta.total : items.length
  const fallback = `${total} item(s) from ${tool ?? 'tool'}.`
  const summaryText = typeof options.summary === 'string' && options.summary.trim() !== '' ? options.summary : fallback
  const summary = clip(summaryText, MAX_SUMMARY)
  const itemsCut = rawItems.length > items.length
  const handlesCut = rawHandles.length > handles.length
  const summaryCut = summaryText.length > MAX_SUMMARY
  const truncated = options.truncated === true || itemsCut || handlesCut || summaryCut
  const warnings = (Array.isArray(options.warnings) ? options.warnings : []).slice(0, MAX_WARNINGS)
  if ((itemsCut || handlesCut || summaryCut) && warnings.length < MAX_WARNINGS) {
    warnings.push({
      code: 'E_LIMIT', subcode: 'result_budget', retryable: false,
      message: 'Result exceeded the OsResult budget and was truncated.',
    })
  }
  const cost = {
    tokens: 0, tokensEstimated: true, latencyMs: 0, money: { usd: 0, estimated: false },
    ...(isObject(options.cost) ? options.cost : {}),
  }
  cost.money = { usd: 0, estimated: false, ...(isObject(cost.money) ? cost.money : {}) }
  if (!isObject(options.cost) || options.cost.tokens === undefined) {
    cost.tokens = Math.ceil(JSON.stringify({ summary, items, page: pageMeta }).length / 4)
  }
  const next = (Array.isArray(options.next) ? options.next : []).slice(0, MAX_NEXT)
  const dataField = isObject(data) ? data : undefined
  const observedAt = Date.now()
  const provenance = isObject(options.provenance)
    ? { source: tool ?? 'unknown', observedAt, freshness: 'live', ...options.provenance }
    : {
      source: tool ?? 'unknown', observedAt, freshness: 'live', hashScope: 'items+page+data',
      hash: `sha256:${createHash('sha256').update(canonical({ items, page: pageMeta, data: dataField })).digest('hex')}`,
    }
  const result = {
    schema: RESULT_SCHEMA,
    ok: true,
    tool,
    requestId: typeof options.requestId === 'string' && options.requestId !== '' ? options.requestId : newId('req_'),
    auditId: typeof options.auditId === 'string' && options.auditId !== '' ? options.auditId : null,
    summary, items, page: pageMeta, handles, truncated, warnings, cost, next, provenance,
  }
  if (dataField !== undefined) result.data = dataField
  return result
}
