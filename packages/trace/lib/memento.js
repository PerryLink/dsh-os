/**
 * dsh-trace — dsh-memory-protocol/v1 bridge.
 * memento is the predecessor and migration source; Trace is the governance
 * layer. Imports are read-only (`ctx.get('memory').query()` -> restore) and
 * exports are pure data; no memento write, no network, zero dependencies.
 * @module dsh-trace/memento
 */
export const PROTOCOL = 'dsh-memory-protocol/v1'
export const ADAPTER_ID = 'trace'
export const ADAPTER_VERSION = '0.2.0'
export const FORMAT = 'trace-memento-v1'
export const TRACE_SCOPES = Object.freeze(['user', 'workspace', 'preset', 'team'])

const DEFAULT_CONFIDENCE = 0.5
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_KEY_LENGTH = 256
const MAX_TAGS = 16
const MAX_TAG_LENGTH = 32
const EXTENSION = 'trace'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

/** Trace scope -> memento layer. Every non-user scope lives in workspace. */
export function mementoScopeOf(scope) {
  return scope === 'user' ? 'user-global' : 'workspace'
}

/** Trace scope -> memento track. `user` is the user profile, the rest is agent memory. */
export function trackOf(scope) {
  return scope === 'user' ? 'user' : 'agent'
}

/**
 * Resolve the Trace scope of one entry. An explicit `trace.scope` extension
 * wins (round-trip fidelity); otherwise the memento layer decides.
 */
export function traceScopeOf(entry) {
  if (!plain(entry)) return 'workspace'
  const extension = entry[EXTENSION]
  if (plain(extension) && TRACE_SCOPES.includes(extension.scope)) return extension.scope
  if (TRACE_SCOPES.includes(entry.scope)) return entry.scope
  return entry.scope === 'user-global' ? 'user' : 'workspace'
}

function sourceOf(entry) {
  if (typeof entry.source === 'string' && entry.source.trim() !== '') return entry.source.trim()
  if (plain(entry.provenance)
    && typeof entry.provenance.source === 'string'
    && entry.provenance.source.trim() !== '') return entry.provenance.source.trim()
  return 'dsh-trace'
}

function confidenceOf(entry) {
  const extension = plain(entry[EXTENSION]) ? entry[EXTENSION].confidence : undefined
  const value = extension ?? entry.confidence
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_CONFIDENCE
}

function timestampOf(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

/** Validate and normalize tags the way protocol v1 expects them. */
function tagsOf(value, index) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('E_MEMENTO_PAYLOAD', `entry ${index} tags must be an array`)
  const tags = []
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      fail('E_MEMENTO_PAYLOAD', `entry ${index} tags must be non-empty strings`)
    }
    const tag = raw.trim()
    if (tag.length > MAX_TAG_LENGTH) {
      fail('E_MEMENTO_PAYLOAD', `entry ${index} tag "${tag.slice(0, 12)}…" exceeds ${MAX_TAG_LENGTH} characters`)
    }
    if (/[\u0000-\u001f\u007f]/.test(tag)) {
      fail('E_MEMENTO_PAYLOAD', `entry ${index} tag contains control characters`)
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > MAX_TAGS) {
    fail('E_MEMENTO_PAYLOAD', `entry ${index} has ${tags.length} tags; at most ${MAX_TAGS} are allowed`)
  }
  return tags
}

/**
 * Derive the Trace key from a memento entry. The Trace extension key is
 * preserved when valid; otherwise the stable memento id is used so repeated
 * imports hit the same key (idempotency) instead of duplicating memory.
 */
function keyOf(entry) {
  const extension = plain(entry[EXTENSION]) ? entry[EXTENSION] : undefined
  const candidate = extension?.key
  if (typeof candidate === 'string') {
    const key = candidate.trim()
    if (key !== '' && key.length <= MAX_KEY_LENGTH && !/[\0\r\n]/.test(key)) return key
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '' || id.length > 200 || /[\0\r\n]/.test(id)) return null
  return `memento:${id}`
}

function limitOf(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1) fail('invalid_limit', 'limit must be a positive integer')
  return Math.min(value, MAX_LIMIT)
}

/** Convert one Trace/memento/exported entry into a protocol v1 entry input. */
export function toMementoInput(entry, index = 0) {
  if (!plain(entry)) fail('E_MEMENTO_PAYLOAD', `entry ${index} must be an object`)
  if (typeof entry.text !== 'string' || entry.text.trim() === '') {
    fail('E_MEMENTO_PAYLOAD', `entry ${index} has no non-empty text`)
  }
  const scope = traceScopeOf(entry)
  const input = {
    track: trackOf(scope),
    scope: mementoScopeOf(scope),
    text: entry.text,
    source: sourceOf(entry),
    tags: tagsOf(entry.tags, index),
  }
  if (typeof entry.workspaceKey === 'string') input.workspaceKey = entry.workspaceKey
  if (typeof entry.agentKey === 'string') input.agentKey = entry.agentKey
  return input
}

/** Trace active record -> memento-facing export entry (scope is the memento layer). */
export function traceRecordToExport(record) {
  const scope = TRACE_SCOPES.includes(record.scope) ? record.scope : 'workspace'
  const provenance = plain(record.provenance) ? record.provenance : {}
  const entry = {
    id: record.id,
    track: trackOf(scope),
    scope: mementoScopeOf(scope),
    text: record.text,
    source: typeof provenance.source === 'string' ? provenance.source : 'trace',
    tags: [],
    confidence: typeof record.confidence === 'number' ? record.confidence : DEFAULT_CONFIDENCE,
    createdAt: provenance.createdAt,
    updatedAt: provenance.updatedAt,
    [EXTENSION]: { key: record.key, scope },
  }
  if (Number.isInteger(record.expiresAt)) entry.expiresAt = record.expiresAt
  return entry
}

/** memento entry -> Trace-facing export entry (keeps the layer and extension). */
export function mementoEntryToExport(entry) {
  const scope = traceScopeOf(entry)
  const exported = {
    id: entry.id,
    track: entry.track === 'user' ? 'user' : 'agent',
    scope: mementoScopeOf(scope),
    text: entry.text,
    source: typeof entry.source === 'string' ? entry.source : 'memento',
    tags: tagsOf(entry.tags, 0),
    confidence: confidenceOf(entry),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    [EXTENSION]: { scope },
  }
  const key = keyOf(entry)
  if (key !== null) exported[EXTENSION].key = key
  if (Number.isInteger(entry.expiresAt)) exported.expiresAt = entry.expiresAt
  return exported
}

/** The stable JSON envelope both export paths emit. */
export function exportEnvelope(entries, now = Date.now()) {
  return {
    plugin: 'dsh-trace',
    format: FORMAT,
    protocol: PROTOCOL,
    exportedAt: now,
    entries,
  }
}

/** Read the entry list out of a bare array, Trace export or trace-memento-v1. */
function payloadEntries(payload) {
  if (Array.isArray(payload)) return payload
  if (plain(payload)) {
    if (Array.isArray(payload.entries)) return payload.entries
    if (Array.isArray(payload.records)) {
      // A full trace-export-v1 also carries superseded/expired history; only
      // active records are memory, the rest is audit history for Trace.
      return payload.records.filter(record =>
        record === null || typeof record !== 'object' || record.status === undefined || record.status === 'active')
    }
  }
  fail(
    'E_MEMENTO_PAYLOAD',
    'payload must be an array, or an object with an "entries" or "records" array',
  )
}

/** Adapter `adapt`: external Trace export -> protocol v1 entry inputs. */
export function adaptPayload(payload) {
  const entries = payloadEntries(payload).map((entry, index) => toMementoInput(entry, index))
  if (entries.length === 0) fail('E_MEMENTO_PAYLOAD', 'payload contains no entries')
  return { entries }
}

/** Protocol adapter registered on `ctx.memoryAdapters`. Conversion only. */
export const MEMENTO_ADAPTER = Object.freeze({
  id: ADAPTER_ID,
  name: 'Trace memory governance',
  description: 'Converts Trace exports (trace-memento-v1) to dsh-memory-protocol/v1 '
    + 'entries and back. memento is the predecessor and migration source; Trace is the '
    + 'governance layer. Import into memento is lossy for confidence/expiry because '
    + 'protocol v1 has no such fields.',
  version: ADAPTER_VERSION,
  importFormats: Object.freeze([FORMAT, 'trace-export-v1']),
  exportFormat: FORMAT,
  adapt: payload => adaptPayload(payload),
  export: entries => exportEnvelope(
    (Array.isArray(entries) ? entries : []).map(mementoEntryToExport),
  ),
})

/** Detect memento services without assuming they are mounted. */
export function detectMemento(ctx) {
  const get = typeof ctx?.get === 'function' ? name => ctx.get(name) : () => undefined
  const memory = get('memory')
  const adapters = get('memoryAdapters')
  return {
    memory: memory !== null && typeof memory === 'object' && typeof memory.query === 'function'
      ? memory
      : null,
    adapters: adapters !== null && typeof adapters === 'object'
      && typeof adapters.register === 'function'
      ? adapters
      : null,
  }
}

/**
 * Probe the default Trace adapter and, only on explicit opt-in, register it on
 * `ctx.memoryAdapters`. Trace treats memento as read-only, so `apply()` and
 * `trace_adapter_status` call this with the default `{ register: false }`:
 * the adapter is discovered and described, never installed behind the user's
 * back. Pass `{ register: true }` from an explicit integration/admin path.
 */
export function registerDefaultAdapter(ctx, { register = false, state = {} } = {}) {
  const { adapters } = detectMemento(ctx)
  state.adapter = MEMENTO_ADAPTER
  state.available = adapters !== null
  if (adapters === null) {
    state.registered = false
    state.reason = 'E_UNAVAILABLE'
    state.message = 'dsh-memento is not mounted: ctx.get("memoryAdapters") is unavailable'
    return state
  }
  if (state.registered === true) return state
  if (!register) {
    state.registered = false
    state.reason = null
    state.message = null
    return state
  }
  try {
    const install = () => {
      const dispose = adapters.register(MEMENTO_ADAPTER)
      state.dispose = typeof dispose === 'function' ? dispose : null
      return dispose
    }
    if (typeof ctx.effect === 'function') ctx.effect(install, 'dsh-trace.memento-adapter')
    else install()
    state.registered = true
    state.reason = null
    state.message = null
  } catch (error) {
    state.registered = false
    state.reason = error?.code ?? 'E_ADAPTER'
    state.message = error?.message ?? String(error)
  }
  return state
}

/** Build one Trace draft from a memento entry. Returns null when unusable. */
function draftOf(entry) {
  if (!plain(entry) || typeof entry.text !== 'string' || entry.text.trim() === '') return null
  const key = keyOf(entry)
  if (key === null) return null
  const createdAt = timestampOf(entry.createdAt) ?? Date.now()
  const extension = plain(entry[EXTENSION]) ? entry[EXTENSION] : {}
  const expiration = timestampOf(entry.expiresAt) ?? timestampOf(extension.expiresAt)
  const draft = {
    key,
    text: entry.text,
    source: sourceOf(entry),
    scope: traceScopeOf(entry),
    confidence: confidenceOf(entry),
    createdAt,
  }
  if (expiration !== null && expiration > createdAt) draft.expiresAt = expiration
  return draft
}

/**
 * Create the Trace-side memento bridge.
 * @param {object} ctx - Cordis context (only `get`/`effect` are used).
 * @param {object} service - `TraceService` instance.
 */
export function createMementoBridge(ctx, service) {
  const state = { registered: false, dispose: null, reason: null, available: false }
  const probe = () => registerDefaultAdapter(ctx, { state })
  probe()

  const requireAvailable = operation => {
    const { memory, adapters } = detectMemento(ctx)
    if (memory === null && adapters === null) {
      fail('E_UNAVAILABLE', `dsh-memento is not mounted: ${operation} needs ctx.get("memory") or ctx.get("memoryAdapters")`)
    }
    return { memory, adapters }
  }

  return {
    state,

    /** Explicit opt-in: install the Trace adapter on `ctx.memoryAdapters`. */
    registerAdapter() {
      return registerDefaultAdapter(ctx, { register: true, state })
    },

    /** Availability report for `trace_adapter_status`; probes, never registers. */
    status() {
      probe()
      const { memory, adapters } = detectMemento(ctx)
      return {
        ok: true,
        protocol: PROTOCOL,
        available: memory !== null || adapters !== null,
        services: { memory: memory !== null, memoryAdapters: adapters !== null },
        adapter: {
          id: ADAPTER_ID,
          registered: state.registered === true,
          mode: state.registered === true ? 'registered' : 'read-only',
          importFormats: [...MEMENTO_ADAPTER.importFormats],
          exportFormat: MEMENTO_ADAPTER.exportFormat,
          ...(state.registered === true
            ? {}
            : {
                reason: state.available ? null : 'E_UNAVAILABLE',
                message: state.message ?? null,
              }),
        },
      }
    },

    /**
     * Read memento entries and import them into Trace. Read-only on the
     * memento side: no `add`/`seed`, no approval bypass. Per-entry conflicts
     * (`trace_confidence_too_low`) are reported, never forced.
     *
     * The default is `scope: 'user'` (memento `user-global`) with an optional
     * caller `agentKey`: memento v1's `query()` has no `workspaceKey` filter,
     * so importing workspace entries is an explicit, warned opt-in.
     * @param {{scope?: 'user'|'workspace', limit?: number, agentKey?: string}} [options]
     */
    importFromMemento(options = {}) {
      const { memory } = requireAvailable('trace_import_memento')
      if (memory === null) fail('E_UNAVAILABLE', 'dsh-memento memory service is not available')
      if (!plain(options)) fail('invalid_arguments', 'import options must be an object')
      const scope = options.scope ?? 'user'
      if (scope !== 'user' && scope !== 'workspace') {
        fail('invalid_scope', 'import scope must be "user" or "workspace"')
      }
      const agentKey = options.agentKey ?? null
      if (agentKey !== null
        && (typeof agentKey !== 'string' || agentKey.trim() === '' || agentKey.length > 256)) {
        fail('invalid_agent_key', 'agentKey must be a non-empty string of at most 256 characters')
      }
      const limit = limitOf(options.limit)
      const filter = { scope: mementoScopeOf(scope), limit }
      const queryOptions = agentKey === null ? undefined : { agentKey: agentKey.trim() }
      const result = memory.query(filter, queryOptions)
      const entries = Array.isArray(result?.entries) ? result.entries : []
      const summary = {
        imported: 0,
        unchanged: 0,
        skipped: [],
        total: entries.length,
        truncated: result?.truncated === true,
        scope,
      }
      if (scope === 'workspace') {
        summary.warning = 'memento v1 query() has no workspaceKey filter; '
          + 'workspace entries may span working directories'
      }
      for (const entry of entries) {
        const draft = draftOf(entry)
        if (draft === null) {
          summary.skipped.push({ id: entry?.id ?? null, code: 'E_MEMENTO_PAYLOAD' })
          continue
        }
        const current = service.get(draft.key)
        if (current !== null
          && current.text === draft.text
          && current.provenance.source === draft.source) {
          summary.unchanged += 1
          continue
        }
        try {
          service.restore(draft)
          summary.imported += 1
        } catch (error) {
          summary.skipped.push({
            id: entry.id ?? null,
            key: draft.key,
            code: error?.code ?? 'E_IMPORT',
            message: error?.message ?? String(error),
          })
        }
      }
      return summary
    },

    /**
     * Map active Trace records into a trace-memento-v1 JSON payload that
     * memento's `trace` adapter (or `importFromMemento` on another machine)
     * can consume. Pure conversion: nothing is written to memento.
     * @param {{scope?: string}} [options] - Optional Trace scope filter.
     */
    exportToMemento(options = {}) {
      requireAvailable('trace_export_memento')
      if (!plain(options)) fail('invalid_arguments', 'export options must be an object')
      const scope = options.scope ?? null
      if (scope !== null && !TRACE_SCOPES.includes(scope)) {
        fail('invalid_scope', `scope must be one of ${TRACE_SCOPES.join(', ')}`)
      }
      const records = service.export().records.filter(record =>
        record.status === 'active' && (scope === null || record.scope === scope))
      return exportEnvelope(records.map(traceRecordToExport))
    },
  }
}
