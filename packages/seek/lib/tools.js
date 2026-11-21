/**
 * Plain-object agent tools for Seek. `index.js` only mounts the service, so the
 * tool descriptions and argument schemas live here.
 * @module dsh-seek/tools
 */

import { registerDefaultProviders } from './providers/index.js'
import { agentKeyOf } from './providers/util.js'
import { failEnvelope, okEnvelope, pageOf, step } from './result.js'

/** Tool paging budget; `MAX_LIMIT` here is deliberately tighter than the service's. */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
/** Errors the service already exposes as stable, documented codes: keep throwing them. */
const THROWN_CODES = new Set([
  'invalid_query', 'invalid_options', 'invalid_limit', 'invalid_sources',
  'invalid_timeout', 'invalid_signal', 'aborted',
])

/** Validate and clamp the tool page size, matching the service's `invalid_limit`. */
function limitOf(value) {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1) {
    throw Object.assign(new Error('seek: limit must be a positive integer'), { code: 'invalid_limit' })
  }
  return Math.min(value, MAX_LIMIT)
}

/** Clamp the tool page offset. */
function offsetOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** Build a plain-object tool definition accepted by the host. */
function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute,
  }
}

/**
 * Retry first-party registration before a call so providers mounted after Seek
 * (Cordis plugin order is not guaranteed) become ready without an extra tool.
 */
function refreshDefaults(ctx, service) {
  if (ctx !== undefined && typeof ctx.get === 'function') registerDefaultProviders(ctx, service)
}

/** Read the caller's session-derived context (cwd and agentKey) from `exec`. */
function callerOf(exec) {
  const session = exec?.agent?.session
  return {
    signal: exec?.signal,
    agent: exec?.agent,
    cwd: session?.header?.cwd,
    agentKey: session === undefined ? undefined : agentKeyOf(session.header?.agentPreset),
  }
}

/** `seek_search` tool: one query across all or selected providers. */
function searchTool(ctx, service) {
  return tool(
    'seek_search',
    'Search registered evidence providers and return deduplicated hits with dsh:// refs, '
      + 'a resolvable marker and per-provider errors. Returns an os.result/v1 envelope '
      + 'with paging (default limit 10, max 50).',
    {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Provider names to query; defaults to every registered provider.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: 'Maximum hits per page (default 10, max 50).',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Merged hits to skip for the next page.',
        },
      },
    },
    async (args, exec) => {
      const limit = limitOf(args?.limit)
      const offset = offsetOf(args?.offset)
      try {
        refreshDefaults(ctx, service)
        const found = await service.searchPage(args?.query, {
          sources: args?.sources,
          limit,
          offset,
          probe: true,
          ...callerOf(exec),
        })
        const items = found.hits
        const page = pageOf({ limit, offset, returned: items.length, total: found.matched })
        const retry = {
          query: found.query,
          ...(Array.isArray(args?.sources) ? { sources: args.sources } : {}),
          limit,
        }
        const next = []
        if (page.hasMore) {
          next.push(step('seek_search', { ...retry, offset: offset + items.length }, 'Fetch the next page of merged hits.'))
        }
        if (items.length > 0) {
          next.push(step('seek_resolve', { ref: items[0].ref }, 'Verify the top hit through its provider.'))
        }
        if (items.length === 0 && offset > 0) {
          next.push(step('seek_search', { ...retry, offset: Math.max(0, offset - limit) }, 'Go back to the previous page.'))
        }
        if (items.length === 0 && offset === 0) {
          next.push(step('seek_providers', {}, 'No hits; check which providers are ready.'))
        }
        const errorCount = found.errors.length
        const count = page.hasMore ? `${found.matched}+` : String(found.matched)
        const summary = found.matched === 0
          ? `No hits for "${found.query}"${errorCount > 0 ? ` (${errorCount} provider error(s))` : ''}`
          : `${count} hits for "${found.query}"${errorCount > 0 ? ` (${errorCount} provider error(s))` : ''}`
        return okEnvelope('seek_search', {
          items,
          summary,
          page,
          truncated: page.hasMore,
          next,
          legacy: { query: found.query, hits: items, total: found.total, errors: found.errors },
        })
      } catch (error) {
        if (THROWN_CODES.has(error?.code)) throw error
        return failEnvelope('seek_search', error, {
          remediation: 'Check provider health with seek_providers, then retry.',
          nextTools: [step('seek_providers', {}, 'Check which providers are ready.')],
          legacy: { query: args?.query, hits: [], total: 0, errors: [] },
        })
      }
    },
  )
}

/**
 * `seek_resolve` tool: verify one `dsh://` ref against its source provider.
 * Read-only: it never mutates provider data and returns a partial result for an
 * unavailable or failing provider instead of throwing.
 */
function resolveTool(ctx, service) {
  return tool(
    'seek_resolve',
    'Resolve one dsh://<source>/<id> evidence ref through its provider and report found/status, source, title, text, provenance, freshness and checkedAt. Read-only.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: {
        ref: { type: 'string', description: 'Ref in dsh://<source>/<id> form, normally copied from a seek_search hit.' },
      },
    },
    async (args, exec) => {
      refreshDefaults(ctx, service)
      return service.resolve(args?.ref, callerOf(exec))
    },
  )
}

/** Compact provider/source report shared by `seek_providers` and `seek_register_defaults`. */
function providerReport(service) {
  return { providers: service.providers(), sources: service.sources() }
}

/** `seek_providers` tool: provider discovery, including unavailable reasons. */
function providersTool(ctx, service) {
  return tool(
    'seek_providers',
    'List Seek evidence providers and whether each first-party source (locator, memento, trace) is ready or unavailable, with the reason.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => {
      refreshDefaults(ctx, service)
      return providerReport(service)
    },
  )
}

/** `seek_register_defaults` tool: retry first-party registration after plugins mount. */
function registerDefaultsTool(ctx, service) {
  return tool(
    'seek_register_defaults',
    'Register the first-party locator, memento and trace providers when their host services are available. Safe to call repeatedly; missing dependencies are reported in sources, not thrown.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => {
      registerDefaultProviders(ctx, service)
      return providerReport(service)
    },
  )
}

/** Build the Seek agent tools in registration order. */
export function createTools(ctx, service) {
  return [
    searchTool(ctx, service),
    resolveTool(ctx, service),
    providersTool(ctx, service),
    registerDefaultsTool(ctx, service),
  ]
}
