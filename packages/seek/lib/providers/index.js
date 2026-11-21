/**
 * Default-provider registration. Missing optional plugins are reported as
 * `unavailable`, never thrown; `apply` calls this once, and the
 * `seek_register_defaults` tool calls it again after plugins mount later.
 * @module dsh-seek/providers
 */

import { createLocatorProvider, probeLocator } from './locator.js'
import { createMementoProvider, probeMemento } from './memento.js'
import { createTraceProvider, probeTrace } from './trace.js'
import { fail, serviceOf } from './util.js'

/** First-party providers, in deterministic registration order. */
export const DEFAULT_PROVIDERS = Object.freeze([
  { name: 'locator', probe: probeLocator, create: createLocatorProvider },
  { name: 'memento', probe: probeMemento, create: createMementoProvider },
  { name: 'trace', probe: probeTrace, create: createTraceProvider },
])

/**
 * Register every available first-party provider on `ctx.evidence`.
 * Idempotent: an already-registered provider is left alone.
 * @param {object} ctx - Cordis context.
 * @param {object} [service] - evidence service; defaults to `ctx.get('evidence')`.
 * @returns {Array<{ name: string, status: string, reason?: string }>}
 */
export function registerDefaultProviders(ctx, service = serviceOf(ctx, 'evidence')) {
  if (service === undefined || typeof service.registerProvider !== 'function') {
    throw fail('E_UNAVAILABLE', 'seek: ctx.evidence is not available')
  }
  const statuses = []
  for (const provider of DEFAULT_PROVIDERS) {
    let probe
    try {
      probe = provider.probe(ctx)
    } catch (error) {
      probe = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (!probe.ok) {
      service.noteSource(provider.name, probe.reason)
      statuses.push({ name: provider.name, status: 'unavailable', reason: probe.reason })
      continue
    }
    if (!service.providers().includes(provider.name)) {
      service.registerProvider(provider.create(ctx), { builtin: true })
    }
    service.noteSource(provider.name)
    statuses.push({ name: provider.name, status: 'ready' })
  }
  return statuses
}
