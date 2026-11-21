/**
 * dsh-snip — local-first clipboard ledger for DeepSeek Harness.
 *
 * 0.4.0 marks every ledger entry as clipboard-tainted (`tainted: true`,
 * `taintSource: "clipboard"`) and mints a process-local `taintToken` from
 * `snip_get`; the token is a random id mapped to the SHA-256 of the stored
 * text. This is a minimal gate, not full taint tracking.
 * 0.3.0 adds an `os.result/v1` envelope to `snip_search` (default limit 20,
 * max 100, `page`/`truncated`/`next`/`error`) while keeping `query`/`entries`.
 * 0.2.0 adds explicit OS clipboard capture through `lib/capture.js`. Capture
 * is disabled by default: nothing is read until the caller sets
 * `capture.enabled` or asks via `snip_capture` / `snip_watch_start`. Secret
 * screening, TTL, atomic snapshots and `clipboard://` handles are unchanged.
 * @module dsh-snip
 */
import { KINDS, SENSITIVITIES, SnipService, fail } from './lib/ledger.js'
import { failEnvelope, okEnvelope, pageOf, step } from './lib/result.js'

export { SnipService, detectSecret } from './lib/ledger.js'
export {
  ClipboardAdapter,
  LinuxClipboardAdapter,
  MacClipboardAdapter,
  WindowsClipboardAdapter,
  createAdapter,
  createClipboardAdapter,
} from './lib/capture.js'

export const name = 'dsh-snip'
export const inject = ['tools']

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100

/** Clamp search paging to the tool budget; invalid values fall back to defaults. */
function searchLimit(value) {
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT
}

function searchOffset(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args) {
      return run(args ?? {})
    },
  }
}

/** Plain-object ToolDefinition list; deliberately no @deepseek-ai/dsh-tools import. */
export function makeTools(service) {
  return [
    tool(
      'snip_add',
      'Add a text clipping to the local Snip ledger and return a clipboard:// handle. Secret-looking text is redacted and not stored by default.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text to record.' },
          kind: { type: 'string', enum: [...KINDS] },
          sourceApp: { type: 'string', description: 'Optional source application label.' },
          sensitivity: { type: 'string', enum: [...SENSITIVITIES] },
        },
      },
      args => service.add(args),
    ),
    tool(
      'snip_capture',
      'Read the current OS clipboard once and store text in the local Snip ledger. Disabled unless capture.enabled is set. Returns a clipboard:// handle, never the text.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceApp: { type: 'string', description: 'Optional source application label.' },
        },
      },
      args => service.capture(args),
    ),
    tool(
      'snip_watch_start',
      'Start explicit clipboard polling. Off by default; only call when the user asks to watch the clipboard. On macOS each poll may trigger a pasteboard permission prompt.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          intervalMs: { type: 'integer', minimum: 250, description: 'Polling interval; defaults to 700 ms.' },
        },
      },
      args => service.watch(args),
    ),
    tool(
      'snip_watch_stop',
      'Stop clipboard polling started by snip_watch_start.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => service.stopWatch(),
    ),
    tool(
      'snip_search',
      'Search the local Snip ledger (case-insensitive substring) and return matching handles and previews. '
        + 'Returns an os.result/v1 envelope with paging (default limit 20, max 100).',
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Text to look for.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT, description: 'Matches per page (default 20, max 100).' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Matches to skip for the next page.' },
        },
      },
      async args => {
        const limit = searchLimit(args.limit)
        const offset = searchOffset(args.offset)
        try {
          const found = service.searchPage(args.query, { limit, offset })
          const items = found.entries
          const page = pageOf({ limit, offset, returned: items.length, total: found.total })
          const next = []
          if (page.hasMore) {
            next.push(step('snip_search', { query: args.query, limit, offset: offset + items.length }, 'Fetch the next page of matches.'))
          }
          if (items.length > 0) {
            next.push(step('snip_get', { id: items[0].id }, 'Read the full text of the newest match.'))
          }
          if (items.length === 0 && offset > 0) {
            next.push(step('snip_search', { query: args.query, limit, offset: Math.max(0, offset - limit) }, 'Go back to the previous page.'))
          }
          if (items.length === 0 && offset === 0) {
            next.push(step('snip_list', { limit }, 'No matches; browse recent clippings.'))
          }
          const summary = found.total === 0
            ? `No clippings matching "${args.query}"`
            : `${found.total} clipping${found.total === 1 ? '' : 's'} matching "${args.query}"`
          return okEnvelope('snip_search', {
            items,
            summary,
            page,
            truncated: page.hasMore,
            next,
            legacy: { query: args.query, entries: items },
          })
        } catch (error) {
          const retryable = error?.code === 'SNIP_STATE_WRITE_FAILED'
          return failEnvelope('snip_search', error, {
            retryable,
            remediation: error?.code === 'SNIP_BAD_QUERY'
              ? 'Pass a non-empty query string, then retry.'
              : retryable
                ? 'Check ledger disk space and permissions, then retry.'
                : 'Check the ledger state, then retry.',
            nextTools: [step('snip_list', { limit }, 'Browse clippings without a query.')],
            legacy: { query: args.query, entries: [] },
          })
        }
      },
    ),
    tool(
      'snip_get',
      'Read one clipping by id or clipboard:// handle. Returned text becomes part of this conversation session log. '
        + 'The reply is marked tainted (taintSource "clipboard") and includes a process-local taintToken.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Clipping id or clipboard:// handle.' } },
      },
      args => {
        const entry = service.get(args.id)
        if (!entry) throw fail('SNIP_NOT_FOUND', 'snip: clipping not found')
        return entry
      },
    ),
    tool(
      'snip_list',
      'List recent clippings newest first, optionally filtered by kind.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: [...KINDS] },
          limit: { type: 'integer', minimum: 1 },
        },
      },
      args => ({ entries: service.list(args) }),
    ),
    tool(
      'snip_forget',
      'Delete one clipping by id or clipboard:// handle.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Clipping id or clipboard:// handle.' } },
      },
      args => {
        const removed = service.forget(args.id)
        return { ok: removed, removed }
      },
    ),
    tool(
      'snip_clear',
      'Delete every clipping in the local Snip ledger.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => ({ removed: service.clear() }),
    ),
  ]
}

/** Mount `ctx.snip` and the snip_* agent tools. */
export function apply(ctx, config = {}) {
  const service = new SnipService(config)
  ctx.provide('snip', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const definition of makeTools(service)) ctx.tools.register(definition)
  }
  return service
}
