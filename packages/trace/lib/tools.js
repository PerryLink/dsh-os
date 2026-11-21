/**
 * Plain-object agent tools for dsh-trace. `index.js` mounts the ledger; this
 * module owns the tool surface and the optional ref-verification gate.
 * @module dsh-trace/tools
 */

import { MAX_LIMIT, SCOPES, SENSITIVITIES } from './constants.js'

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const argsSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
})

function tool(name, description, parameters, execute) {
  return { name, description, parameters, output: OUTPUT, execute }
}

/** One refusal/warning payload for an unverified `dsh://` source label. */
function refNotFound(check) {
  const message = `source ref is not resolvable: ${check.ref} (${check.status})`
  return {
    code: 'E_REF_NOT_FOUND',
    message,
    ref: check.ref,
    status: check.status,
    ...(check.checkedAt === undefined ? {} : { checkedAt: check.checkedAt }),
    ...(check.error === undefined ? {} : { error: check.error }),
  }
}

/**
 * Build the Trace tools. `verifier` is optional; when present, `trace_remember`
 * resolves a `dsh://` source before storing and fails closed on `found:false`
 * (unless the verifier is in `warn` mode).
 */
export function createTools(service, memento, verifier) {
  const bridge = async operation => {
    try {
      return { ok: true, ...operation() }
    } catch (error) {
      if (error?.code !== 'E_UNAVAILABLE') throw error
      return { ok: false, code: error.code, message: error.message }
    }
  }
  return [
    tool(
      'trace_remember',
      'Remember one auditable claim under a key. A newer claim supersedes the old one; '
        + 'lower confidence is refused unless force is true. sensitivity "secret" stores only [redacted]. '
        + 'A dsh:// source is verified against dsh-seek evidence when its resolve service is mounted.',
      argsSchema({
        key: { type: 'string', description: 'Normalized subject key, e.g. "repo:dsh/pkg".' },
        text: { type: 'string', description: 'One self-contained claim.' },
        source: { type: 'string', description: 'Provenance label or dsh:// evidence ref; defaults to "user".' },
        scope: { type: 'string', enum: SCOPES, description: 'Defaults to "workspace".' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Defaults to 0.5.' },
        ttlMs: { type: 'number', exclusiveMinimum: 0, description: 'Optional lifetime in milliseconds.' },
        sensitivity: { type: 'string', enum: SENSITIVITIES, description: 'Defaults to "normal".' },
        force: { type: 'boolean', description: 'Replace even a higher-confidence record.' },
      }, ['key', 'text']),
      async (args, exec) => {
        const check = verifier === undefined ? undefined : await verifier.resolve(args?.source, exec)
        if (check !== undefined && !check.ok && verifier.mode === 'enforce') {
          return { ok: false, ...refNotFound(check) }
        }
        try {
          const record = service.remember(args)
          if (check === undefined) return { record }
          if (check.ok) return { record, verification: check }
          return { record, warning: refNotFound(check) }
        } catch (error) {
          if (error?.code !== 'trace_confidence_too_low') throw error
          return { ok: false, code: error.code, message: error.message, current: error.current }
        }
      },
    ),
    tool(
      'trace_search',
      'Search active Trace records by case-insensitive substring over key and text.',
      argsSchema({
        query: { type: 'string', description: 'Substring; empty returns all active records.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Defaults to 20.' },
      }, ['query']),
      async args => ({ results: service.search(args?.query, { limit: args?.limit }) }),
    ),
    tool(
      'trace_forget',
      'Forget every version of a Trace key and leave a text-free audit tombstone.',
      argsSchema({ key: { type: 'string' } }, ['key']),
      async args => ({ forgotten: service.forget(args?.key) }),
    ),
    tool(
      'trace_list',
      'List active Trace records, most recently updated first.',
      argsSchema({
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Defaults to 20.' },
      }),
      async args => ({ records: service.list({ limit: args?.limit }) }),
    ),
    tool(
      'trace_import_memento',
      'Import memories from a mounted dsh-memento (read-only on the memento side) into Trace. '
        + 'Existing higher-confidence records are never overwritten; such entries are reported as skipped.',
      argsSchema({
        scope: {
          type: 'string',
          enum: ['user', 'workspace'],
          description: 'Memento layer: user (user-global, default) or workspace (warned: no workspaceKey filter).',
        },
        agentKey: { type: 'string', description: 'Optional memento agentKey visibility filter.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Defaults to 20.' },
      }),
      async args => bridge(() => memento.importFromMemento(args ?? {})),
    ),
    tool(
      'trace_export_memento',
      'Export active Trace records as trace-memento-v1 JSON for dsh-memento import. '
        + 'Pure data conversion; nothing is written to memento and its approval gate is not bypassed.',
      argsSchema({
        scope: { type: 'string', enum: SCOPES, description: 'Optional Trace scope filter.' },
      }),
      async args => bridge(() => memento.exportToMemento(args ?? {})),
    ),
    tool(
      'trace_adapter_status',
      'Report whether dsh-memento services are available and whether the opt-in Trace adapter is registered.',
      argsSchema({}),
      async () => memento.status(),
    ),
  ]
}
