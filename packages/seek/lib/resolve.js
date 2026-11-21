/**
 * Ref resolution for `ctx.evidence.resolve` / `seek_resolve`: route one
 * `dsh://<source>/<id>` ref to its provider, bound the call with a deadline and
 * the caller signal, and normalize the provider answer to one stable shape.
 * @module dsh-seek/resolve
 */

import { fail } from './providers/util.js'

/** Provider lifecycle statuses that `seek_resolve` reports. */
export const RESOLVE_STATUSES = Object.freeze(['fresh', 'stale', 'missing', 'tombstoned', 'unknown'])

const STATUS_SET = new Set(RESOLVE_STATUSES)
const FOUND_STATUSES = new Set(['fresh', 'stale'])

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Call one provider's `resolve(ref, options)` under a hard deadline. The
 * provider receives the caller signal combined with the timeout, so it can stop
 * its own work; racing that signal bounds a provider that ignores it.
 */
export async function askResolve(provider, ref, options) {
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const budget = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal])
  const aborted = () => fail('aborted', 'seek: resolve aborted')
  const timedOut = () => fail(
    'provider_timeout',
    `seek: provider "${provider.name}" resolve timed out after ${options.timeoutMs} ms`,
  )
  if (budget.aborted) throw deadline.aborted ? timedOut() : aborted()
  const work = Promise.resolve().then(() => provider.resolve(ref, {
    signal: budget,
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    agentKey: options.agentKey,
    agent: options.agent,
    source: options.source,
    id: options.id,
  }))
  const failure = new Promise((_, reject) => {
    budget.addEventListener('abort', () => reject(deadline.aborted ? timedOut() : aborted()), { once: true })
  })
  return await Promise.race([work, failure])
}

/**
 * Reduce a provider resolution to the documented shape. A provider that returns
 * an unknown status or a non-object is a contract violation (`E_STATE`).
 * `found` defaults to true only for `fresh`/`stale`; `unknown` stays false, so
 * callers that verify refs fail closed.
 */
export function normalizeResolution(ref, source, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('E_STATE', `seek: provider "${source}" resolve must return an object`)
  }
  if (!STATUS_SET.has(value.status)) {
    throw fail('E_STATE', `seek: provider "${source}" resolve returned an invalid status: ${String(value.status)}`)
  }
  const result = {
    ref,
    found: typeof value.found === 'boolean' ? value.found : FOUND_STATUSES.has(value.status),
    status: value.status,
    source,
    checkedAt: Number.isInteger(value.checkedAt) ? value.checkedAt : Date.now(),
  }
  if (typeof value.title === 'string' && value.title !== '') result.title = value.title
  if (typeof value.text === 'string' && value.text !== '') result.text = value.text
  if (value.freshness !== undefined) result.freshness = value.freshness
  return result
}

/** Human-readable failure details for a `seek_resolve` error result. */
export function resolutionError(error) {
  return {
    code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'E_RESOLVE_FAILED',
    message: messageOf(error),
  }
}
