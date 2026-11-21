/**
 * Legacy ToolDefinition -> capability descriptor adapter.
 * Migration only: the module keeps working unchanged; the registry can list it.
 */
import { normalizeDescriptor } from './descriptor.js'

const EXECUTE = ['exec', 'execute', 'invoke', 'run', 'spawn', 'shell', 'fire', 'apply', 'move', 'resize', 'undo', 'capture', 'start', 'stop', 'trigger', 'kill']
const WRITE = ['write', 'set', 'add', 'remove', 'delete', 'forget', 'clear', 'issue', 'revoke', 'send', 'raise', 'ack', 'escalate', 'register', 'import', 'restore', 'snapshot', 'budget', 'remember', 'open', 'close', 'create', 'update', 'save', 'put', 'notify', 'layout']

const firstLine = text => String(text ?? '').trim().split(/\r?\n/)[0].trim()
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const titleize = name => name.replace(/[_.]+/g, ' ').replace(/^\w/, char => char.toUpperCase())

/** Infer read/write/execute from the tool name first, then its description. */
export function inferRisk(tool) {
  const name = String(tool?.name ?? '').toLowerCase()
  const words = `${name} ${String(tool?.description ?? '').toLowerCase()}`
  const tokens = name.split(/[^a-z0-9]+/).filter(Boolean)
  const hit = list => list.some(word => tokens.includes(word) || new RegExp(`\\b${word}\\b`).test(words))
  if (hit(EXECUTE)) return 'execute'
  if (hit(WRITE)) return 'write'
  return 'read'
}

/**
 * Adapt a host ToolDefinition into a normalized descriptor.
 * The id is always `legacy.<tool.name>`; `handler` forwards to `tool.execute`.
 * @param {any} tool
 * @param {any} [options] risk/permissions/cost/tags overrides
 * @returns {any}
 */
export function fromTool(tool, options = {}) {
  if (!tool || typeof tool.name !== 'string' || tool.name === '') {
    throw Object.assign(new TypeError('tool.name must be a non-empty string'), { code: 'E_INVALID_ARGUMENT' })
  }
  if (typeof tool.execute !== 'function') {
    throw Object.assign(new TypeError(`tool ${tool.name} must have execute()`), { code: 'E_INVALID_ARGUMENT' })
  }
  const risk = options.risk ?? inferRisk(tool)
  const summary = clip(firstLine(tool.description) || `Legacy tool ${tool.name}.`, 120)
  const descriptor = {
    id: `legacy.${tool.name}`,
    title: clip(options.title ?? titleize(tool.name), 40),
    summary,
    whenToUse: options.whenToUse ?? [`Use when the task needs the legacy ${tool.name} tool.`],
    whenNotToUse: options.whenNotToUse ?? ['Prefer a registered capability that covers the same intent.'],
    inputSchema: tool.parameters ?? { type: 'object', additionalProperties: true },
    outputSchema: tool.output?.schema ?? { type: 'object', additionalProperties: true },
    risk: Array.isArray(risk) ? risk : [risk],
    permissions: options.permissions ?? [],
    cost: { tokens: 0, latencyMs: 0, moneyUsd: 0, ...(options.cost ?? {}) },
    idempotency: options.idempotency ?? ((Array.isArray(risk) ? risk : [risk]).includes('read') ? 'pure' : 'non-idempotent'),
    examples: options.examples ?? [],
    returns: options.returns ?? `${summary} Returns the legacy tool payload.`,
    errors: options.errors ?? [],
    version: options.version ?? '0.0.0',
    tags: [...new Set(['legacy', ...(options.tags ?? [])])],
    handler: async (args, _ctx, exec) => tool.execute(args, exec ?? {}),
    ui: null,
    aliases: options.aliases ?? [tool.name],
    deprecated: options.deprecated ?? null,
    audience: options.audience ?? ['agent', 'human', 'cli'],
    legacy: true,
  }
  return normalizeDescriptor(descriptor)
}

export default fromTool
