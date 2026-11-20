/**
 * `locator` provider: content search through dsh-locator's `locator_find` tool.
 * Only content mode is used, and `pathPrefix` is always the caller's cwd so the
 * locator can apply its root ACL before returning hits.
 * @module dsh-seek/providers/locator
 */

import { fail, rankScore, serviceOf, text, throwIfAborted } from './util.js'

const LOCATOR_TOOL = 'locator_find'
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
  }
}
