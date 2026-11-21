/**
 * Types, constants and validation shared by dsh-os modules.
 * Not a framework: importing this registers nothing, starts nothing and pulls in nothing.
 * @module dsh-os-contract
 */

/** @typedef {{ id: string, owner?: string, scope?: string, createdAt: number, updatedAt?: number, expiresAt?: number|null, auditRef?: string }} OsObject */

/** Canonical Host seams (`ctx.<service>`), keyed by product. */
export const SERVICES = Object.freeze({
  act: 'act', allow: 'allow', snip: 'snip', check: 'check', nest: 'nest',
  trigger: 'triggers', seek: 'evidence', trace: 'trace', stage: 'stage',
  ring: 'ring', root: 'env', help: 'help', context: 'context', cost: 'cost', backup: 'backup', notify: 'notify', kernel: 'kernel',
})

/** Agent tool prefix per canonical service. */
const TOOL_PREFIX = Object.freeze({
  act: 'act_', allow: 'allow_', snip: 'snip_', check: 'check_', nest: 'nest_',
  triggers: 'trigger_', evidence: 'seek_', trace: 'trace_', stage: 'stage_',
  ring: 'ring_', env: 'root_', help: 'help_', context: 'context_', cost: 'cost_', backup: 'backup_', notify: 'notify_', kernel: 'os_',
})

/** Capabilities a module may declare in `dsh.os.capabilities`. @type {ReadonlyArray<string>} */
export const CAPABILITIES = Object.freeze([
  'fs.read', 'fs.write', 'net', 'secret', 'spawn', 'model',
  'clipboard', 'ui', 'notify',
])

/** Stable error codes; put one on thrown errors as `err.code`. */
export const ERROR_CODES = Object.freeze({
  E_INVALID_ARGUMENT: 'E_INVALID_ARGUMENT', E_NOT_FOUND: 'E_NOT_FOUND',
  E_CONFLICT: 'E_CONFLICT', E_DENIED: 'E_DENIED', E_UNAVAILABLE: 'E_UNAVAILABLE',
  E_STATE: 'E_STATE', E_LIMIT: 'E_LIMIT',
})

/** Object-base keys: `id` and `createdAt` are required; the rest are optional. */
export const OS_OBJECT_KEYS = Object.freeze([
  'id', 'owner', 'scope', 'createdAt', 'updatedAt', 'expiresAt', 'auditRef',
])

const STABILITY = new Set(['experimental', 'stable', 'frozen', 'archived'])
const SERVICE_SET = new Set(Object.values(SERVICES))
const PREFIXES = Object.values(TOOL_PREFIX)
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/
const REF_KIND = /^[a-z][a-z0-9-]{0,31}$/
const REF_ID = /^[^\s/?#\u0000-\u001f]+$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stamp = (value, nullable) => value === undefined || (nullable && value === null)
  || (typeof value === 'number' && Number.isFinite(value))
const fail = message => Object.assign(new Error(message), { code: ERROR_CODES.E_INVALID_ARGUMENT })

/**
 * Whether `value` is a well-formed dsh-os object.
 * @param {unknown} value
 * @returns {value is OsObject}
 */
export function isOsObject(value) {
  if (!isObject(value) || typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return false
  for (const key of ['owner', 'scope', 'auditRef']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  return stamp(value.updatedAt, false) && stamp(value.expiresAt, true)
}

/**
 * Build a canonical `dsh://<kind>/<id>` ref.
 * @param {string} kind
 * @param {string} id
 * @returns {string}
 */
export function makeRef(kind, id) {
  if (typeof kind !== 'string' || !REF_KIND.test(kind)) throw fail(`invalid ref kind: ${String(kind)}`)
  if (typeof id !== 'string' || !REF_ID.test(id)) throw fail(`invalid ref id: ${String(id)}`)
  return `dsh://${kind}/${id}`
}

/**
 * Parse a canonical ref back into `{ kind, id }`.
 * @param {string} ref
 * @returns {{ kind: string, id: string }}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('dsh://')) throw fail(`invalid ref: ${String(ref)}`)
  const rest = ref.slice(6)
  const slash = rest.indexOf('/')
  const kind = rest.slice(0, slash)
  const id = rest.slice(slash + 1)
  if (slash < 1 || !REF_KIND.test(kind) || !REF_ID.test(id)) throw fail(`invalid ref: ${ref}`)
  return { kind, id }
}

/**
 * Minimal v1 manifest check: `dsh.manifestVersion === 1`, canonical `service`,
 * `<prefix>_` tool names and a known `stability`. Throws `E_INVALID_ARGUMENT`.
 * @param {any} manifest
 * @returns {any}
 */
export function assertManifest(manifest) {
  if (!isObject(manifest) || !isObject(manifest.dsh)) throw fail('manifest needs a dsh object')
  const { dsh } = manifest
  if (dsh.manifestVersion !== 1) throw fail('dsh.manifestVersion must be 1')
  if (!isObject(dsh.os)) throw fail('dsh.os must be an object')
  const os = dsh.os
  if (os.service !== null && !SERVICE_SET.has(os.service)) throw fail(`unknown service: ${String(os.service)}`)
  if (!STABILITY.has(os.stability)) throw fail(`unknown stability: ${String(os.stability)}`)
  if (!Array.isArray(os.tools)) throw fail('dsh.os.tools must be an array')
  const prefix = os.service === null ? null : TOOL_PREFIX[os.service]
  for (const tool of os.tools) {
    if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) throw fail(`invalid tool name: ${String(tool)}`)
    if (prefix !== null && !tool.startsWith(prefix)) throw fail(`tool ${tool} must start with ${prefix}`)
  }
  return manifest
}

/**
 * Validate and return a plain host `ToolDefinition`.
 * @param {any} tool
 * @returns {any}
 */
export function defineTool(tool) {
  if (!isObject(tool)) throw fail('tool definition must be a plain object')
  const { name, description, parameters, output, execute } = tool
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw fail(`invalid tool name: ${String(name)}`)
  if (!PREFIXES.some(prefix => name.startsWith(prefix))) throw fail(`tool ${name} needs a canonical prefix`)
  if (typeof description !== 'string' || description.trim() === '') throw fail('tool description must be a non-empty string')
  if (!isObject(parameters)) throw fail('tool parameters must be an object')
  if (!isObject(output) || !isObject(output.schema) || typeof output.render !== 'function') {
    throw fail('tool output must be { schema, render }')
  }
  if (typeof execute !== 'function') throw fail('tool execute must be a function')
  return { ...tool }
}

// OsResult v1, OsError v1 and the audit event contract.
export {
  DEFAULT_PAGE_LIMIT, HANDLE_KINDS, MAX_HANDLES, MAX_ITEMS, MAX_SUMMARY, RESULT_SCHEMA,
  makeHandle, ok, page, parseHandle, setCursorKey,
} from './lib/result.js'
export { ERROR_CLASSES, OsError, err, isRetryable, toToolError } from './lib/error.js'
export { AUDIT_SCHEMA, auditEvent } from './lib/audit.js'
