/**
 * dsh-snip — local-first clipboard ledger for DeepSeek Harness.
 *
 * 0.2.0 adds explicit OS clipboard capture through `lib/capture.js`. Capture
 * is disabled by default: nothing is read until the caller sets
 * `capture.enabled` or asks via `snip_capture` / `snip_watch_start`. Secret
 * screening, TTL, atomic snapshots and `clipboard://` handles are unchanged.
 * @module dsh-snip
 */
import { KINDS, SENSITIVITIES, SnipService, fail } from './lib/ledger.js'

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
      'Search the local Snip ledger (case-insensitive substring) and return matching handles and previews.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Text to look for.' },
          limit: { type: 'integer', minimum: 1 },
        },
      },
      args => ({ query: args.query, entries: service.search(args.query, { limit: args.limit }) }),
    ),
    tool(
      'snip_get',
      'Read one clipping by id or clipboard:// handle. Returned text becomes part of this conversation session log.',
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
