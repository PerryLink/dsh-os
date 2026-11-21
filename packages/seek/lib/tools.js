/**
 * Plain-object agent tools for Seek. `index.js` only mounts the service, so the
 * tool descriptions and argument schemas live here.
 * @module dsh-seek/tools
 */

import { registerDefaultProviders } from './providers/index.js'
import { agentKeyOf } from './providers/util.js'

/** Keep in sync with `MAX_LIMIT` in index.js. */
const MAX_LIMIT = 100

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
function searchTool(service) {
  return tool(
    'seek_search',
    'Search registered evidence providers and return deduplicated hits with dsh:// refs, a resolvable marker and per-provider errors.',
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
          description: 'Maximum hits to return (default 10).',
        },
      },
    },
    async (args, exec) => service.search(args?.query, {
      sources: args?.sources,
      limit: args?.limit,
      ...callerOf(exec),
    }),
  )
}

/**
 * `seek_resolve` tool: verify one `dsh://` ref against its source provider.
 * Read-only: it never mutates provider data and returns a partial result for an
 * unavailable or failing provider instead of throwing.
 */
function resolveTool(service) {
  return tool(
    'seek_resolve',
    'Resolve one dsh://<source>/<id> evidence ref through its provider and report found/status, source, title, freshness and checkedAt. Read-only.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: {
        ref: { type: 'string', description: 'Ref in dsh://<source>/<id> form, normally copied from a seek_search hit.' },
      },
    },
    async (args, exec) => service.resolve(args?.ref, callerOf(exec)),
  )
}

/** Compact provider/source report shared by `seek_providers` and `seek_register_defaults`. */
function providerReport(service) {
  return { providers: service.providers(), sources: service.sources() }
}

/** `seek_providers` tool: provider discovery, including unavailable reasons. */
function providersTool(service) {
  return tool(
    'seek_providers',
    'List Seek evidence providers and whether each first-party source is ready or unavailable, with the reason.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => providerReport(service),
  )
}

/** `seek_register_defaults` tool: retry first-party registration after plugins mount. */
function registerDefaultsTool(ctx, service) {
  return tool(
    'seek_register_defaults',
    'Register the first-party locator and memento providers when their host services are available. Safe to call repeatedly; missing dependencies are reported in sources, not thrown.',
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
    searchTool(service),
    resolveTool(service),
    providersTool(service),
    registerDefaultsTool(ctx, service),
  ]
}
