/**
 * `locator` provider: content search through dsh-locator's `locator_find` tool.
 * Only content mode is used, and `pathPrefix` is always the caller's cwd so the
 * locator can apply its root ACL before returning hits.
 * @module dsh-seek/providers/locator
 */

import { resolve as resolvePath } from 'node:path'
import { RESOLVE_STATUSES } from '../resolve.js'
import { fail, rankScore, serviceOf, text, throwIfAborted } from './util.js'

const LOCATOR_TOOL = 'locator_find'
const LOCATOR_RESOLVE_TOOL = 'locator_resolve'
/** Keep in sync with `MAX_REF_LENGTH` in index.js. */
const MAX_REF_LENGTH = 512

/** Locate the tool without assuming it is mounted. */
export function probeLocator(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const tool = tools?.get?.(LOCATOR_TOOL)
  if (tool === undefined || typeof tool.execute !== 'function') {
    return { ok: false, reason: 'locator_find is not registered (install/enable dsh-locator)' }
  }
  return { ok: true, tool }
}

/** Locate `locator_resolve`; an older locator without it reports `unsupported`. */
export function probeLocatorResolve(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const tool = tools?.get?.(LOCATOR_RESOLVE_TOOL)
  if (tool === undefined || typeof tool.execute !== 'function') {
    return { ok: false, reason: 'locator_resolve is not registered (install/enable dsh-locator >= 0.19)' }
  }
  return { ok: true, tool }
}

function basenameOf(value) {
  const parts = value.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? ''
}

/** Workspace-relative, segment-encoded ref id; dot segments are refused. */
function normalizePath(value, cwd) {
  let path = value.replace(/\\/g, '/')
  const base = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (base !== '' && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length)
  path = path.replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return undefined
  return segments.map(segment => encodeURIComponent(segment)).join('/')
}

function toHit(raw, index, cwd) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.permissions?.read === 'denied') return undefined
  if (typeof raw.path !== 'string' || raw.path === '') return undefined
  const path = normalizePath(raw.path, cwd)
  if (path === undefined) return undefined
  const ref = `dsh://locator/${path}`
  if (ref.length > MAX_REF_LENGTH) return undefined
  const freshness = raw.freshness !== undefined
    ? raw.freshness
    : raw.refStatus !== undefined ? { state: raw.refStatus } : { state: 'unknown' }
  const snippet = text(raw.snippet ?? (Array.isArray(raw.context) ? raw.context.join('\n') : ''), 2000)
  const title = text(raw.title ?? raw.name ?? basenameOf(raw.path), 300) || basenameOf(raw.path)
  return {
    ref,
    source: 'locator',
    title,
    snippet,
    score: Number.isFinite(raw.score) ? raw.score : rankScore(index),
    freshness,
  }
}

/** Extract the ref id, preferring the id the Seek service already parsed. */
function idOf(ref, options) {
  if (typeof options.id === 'string') return options.id
  const prefix = 'dsh://locator/'
  if (typeof ref === 'string' && ref.startsWith(prefix)) return ref.slice(prefix.length)
  return undefined
}

/**
 * Rebuild the locator-native `ref://file?...` from a workspace-relative Seek id.
 * Seek refs do not carry locator snapshot fields, so `locator_resolve` compares
 * the current file against its own index; that is the verification we want.
 * A missing cwd or a dot/traversal segment refuses instead of guessing.
 */
export function nativeFileRef(ref, options = {}) {
  const id = idOf(ref, options)
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof options.cwd !== 'string' || options.cwd.trim() === '') return undefined
  let segments
  try {
    segments = id.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return undefined
  }
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\/]/.test(segment))) {
    return undefined
  }
  const params = new URLSearchParams({ path: resolvePath(options.cwd, segments.join('/')) })
  return `ref://file?${params.toString()}`
}

/** First-party locator adapter. */
export function createLocatorProvider(ctx) {
  return {
    name: 'locator',
    async search(query, options = {}) {
      const probe = probeLocator(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      if (typeof options.cwd !== 'string' || options.cwd.trim() === '') {
        throw fail('E_UNAUTHORIZED', 'seek: locator requires the caller cwd (pathPrefix)')
      }
      throwIfAborted(options.signal)
      const value = await probe.tool.execute({
        query,
        mode: 'content',
        scope: 'workspace',
        limit: options.limit,
        pathPrefix: options.cwd,
      }, { signal: options.signal, agent: options.agent })
      if (value !== null && typeof value === 'object' && value.ok === false) {
        const reason = typeof value.error === 'string' ? value.error : 'locator_find failed'
        throw fail(/denied/i.test(reason) ? 'E_UNAUTHORIZED' : 'E_UNAVAILABLE', `seek: locator: ${reason}`)
      }
      if (!Array.isArray(value?.hits)) throw fail('E_STATE', 'seek: locator_find returned no hits array')
      return value.hits.map((hit, index) => toHit(hit, index, options.cwd)).filter(Boolean)
    },

    /**
     * Verify one `dsh://locator/<path>` ref through `locator_resolve` in `meta`
     * mode. The Seek ref is rebuilt as a locator-native file ref with the
     * caller's cwd, so locator applies its root ACL before reading anything.
     */
    async resolve(ref, options = {}) {
      const probe = probeLocatorResolve(ctx)
      if (!probe.ok) throw fail('E_UNAVAILABLE', `seek: ${probe.reason}`)
      const native = nativeFileRef(ref, options)
      if (native === undefined) {
        throw fail('E_UNAUTHORIZED', 'seek: locator resolve requires the caller cwd and a workspace-relative ref id')
      }
      throwIfAborted(options.signal)
      const value = await probe.tool.execute(
        { ref: native, mode: 'meta' },
        { signal: options.signal, agent: options.agent },
      )
      if (value !== null && typeof value === 'object' && value.ok === false) {
        const reason = typeof value.error === 'string' ? value.error : 'locator_resolve failed'
        if (/denied|outside-roots|not-authorized/i.test(reason)) {
          throw fail('E_UNAUTHORIZED', `seek: locator: ${reason}`)
        }
        if (/invalid-ref/i.test(reason)) throw fail('E_INVALID_ARGUMENT', `seek: locator: ${reason}`)
        throw fail('E_STATE', `seek: locator: ${reason}`)
      }
      const status = value?.status ?? value?.freshness?.state ?? 'unknown'
      if (!RESOLVE_STATUSES.includes(status)) {
        throw fail('E_STATE', `seek: locator: invalid resolve status: ${String(status)}`)
      }
      return {
        found: status === 'fresh' || status === 'stale',
        status,
        ...(typeof value?.title === 'string' && value.title !== '' ? { title: value.title } : {}),
        ...(value?.freshness === undefined ? {} : { freshness: value.freshness }),
        ...(Number.isInteger(value?.checkedAt) ? { checkedAt: value.checkedAt } : {}),
      }
    },
  }
}
