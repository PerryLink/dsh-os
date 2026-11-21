/**
 * dsh-os-kernel — the thin capability kernel for dsh-os.
 *
 * It owns a registry, six agent verbs and the descriptor protocol. It owns no
 * business logic: every capability stays in its own module and is registered
 * here (or adapted from a legacy ToolDefinition with fromTool).
 */
import { KernelService } from './lib/service.js'
import { createTools, TOOL_NAMES } from './lib/gateway.js'
import { fromTool } from './lib/from-tool.js'

export { CapabilityRegistry, createRegistry } from './lib/registry.js'
export { KernelService, createKernelService } from './lib/service.js'
export { validateDescriptor, normalizeDescriptor, RISKS, IDEMPOTENCY } from './lib/descriptor.js'
export { fromTool } from './lib/from-tool.js'
export {
  createGateway, createTools, gatewayTools, VERSION, TOOL_NAMES, CAPABILITY_PREFIX, capabilityName,
} from './lib/gateway.js'
export { createStateStore, STATE_VERSION, MAX_ENTRIES } from './lib/state.js'
export { TaintRegistry, TAINT_TTL_MS, MAX_TAINT_RECORDS, TOKEN_PATTERN, TAINT_SOURCES, isTaintSource, sha256 } from './lib/taint.js'
export { ok, err, legacyOutcome, resolveCode, ERROR_CLASSES, RESULT_SCHEMA } from './lib/envelope.js'

/** Cordis plugin name. */
export const name = 'dsh-os-kernel'
/** The kernel registers six agent tools through the host registry. */
export const inject = ['tools']

/**
 * Hide every inherited global tool except the six `os_*` verbs. This only
 * works in a scoped context (an agent preset / agent.ctx): a global
 * `tools.restrict()` would mask every agent, so DSH rejects it.
 * @param {any} ctx
 * @returns {Function|null} the restriction disposer, or null when nothing was inherited
 */
function restrictToGateway(ctx) {
  const tools = ctx?.tools
  if (!tools || typeof tools.restrict !== 'function' || typeof tools.schemas !== 'function') {
    throw new Error('config.gatewayOnly requires ctx.tools.restrict() and ctx.tools.schemas()')
  }
  let schemas
  try { schemas = tools.schemas() } catch (error) {
    throw new Error(`config.gatewayOnly cannot read ctx.tools.schemas(): ${error?.message ?? String(error)}`)
  }
  if (!Array.isArray(schemas)) throw new Error('config.gatewayOnly requires synchronous ctx.tools.schemas()')
  const own = new Set(TOOL_NAMES)
  const names = schemas.map(item => typeof item === 'string' ? item : item?.name)
  const deny = [...new Set(names.filter(name => typeof name === 'string' && name !== 'run_code' && !own.has(name)))]
  if (deny.length === 0) return null
  try {
    return tools.restrict({ deny })
  } catch (error) {
    throw new Error(
      `config.gatewayOnly needs a scoped agent/preset mount because ctx.tools.restrict() rejected the mask: ${error?.message ?? String(error)}. `
      + 'Mount the kernel inside an agent preset; see docs/presets/os-gateway.md.',
    )
  }
}

/**
 * Mount the kernel: provide `ctx.kernel`, adapt legacy tools, register six verbs.
 * `config.legacyTools` remains for hosts that cannot enumerate tools; when
 * `ctx.tools.schemas/get` exist, the first `os_find`/`os_status` lazily adapts
 * every visible non-`os_*` tool as `legacy.<tool name>`.
 * @param {any} ctx
 * @param {{authorize?: Function, strict?: boolean, legacyTools?: any[], legacyOptions?: any, capabilities?: any[], stateFile?: string, gatewayOnly?: boolean, taint?: {ttlMs?: number, max?: number, now?: Function}}} [config]
 * @returns {KernelService}
 */
export function apply(ctx, config = {}) {
  const registry = new KernelService({
    authorize: config.authorize,
    ctx,
    strict: config.strict,
    legacyOptions: config.legacyOptions ?? {},
  })
  ctx.provide('kernel', registry)
  for (const descriptor of Array.isArray(config.capabilities) ? config.capabilities : []) registry.register(descriptor)
  for (const tool of Array.isArray(config.legacyTools) ? config.legacyTools : []) registry.register(fromTool(tool, config.legacyOptions ?? {}))
  const tools = createTools(registry, {
    ctx,
    stateFile: config.stateFile,
    gatewayOnly: config.gatewayOnly === true,
    taint: config.taint,
  })
  if (ctx.tools && typeof ctx.tools.register === 'function') for (const tool of tools) ctx.tools.register(tool)
  if (config.gatewayOnly === true) {
    const restriction = restrictToGateway(ctx)
    if (typeof restriction === 'function') registry.gatewayRestriction = restriction
  }
  return registry
}
