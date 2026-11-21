/**
 * @perrylink/dsh-os-kernel — the thin capability kernel for dsh-os.
 *
 * It owns a registry, six agent verbs and the descriptor protocol. It owns no
 * business logic: every capability stays in its own module and is registered
 * here (or adapted from a legacy ToolDefinition with fromTool).
 */
import { CapabilityRegistry } from './lib/registry.js'
import { createTools } from './lib/gateway.js'
import { fromTool } from './lib/from-tool.js'

export { CapabilityRegistry, createRegistry } from './lib/registry.js'
export { validateDescriptor, normalizeDescriptor, RISKS, IDEMPOTENCY } from './lib/descriptor.js'
export { fromTool } from './lib/from-tool.js'
export { createGateway, createTools, gatewayTools, VERSION, TOOL_NAMES } from './lib/gateway.js'

/** Cordis plugin name. */
export const name = '@perrylink/dsh-os-kernel'
/** The kernel registers six agent tools through the host registry. */
export const inject = ['tools']

/**
 * Mount the kernel: provide `ctx.kernel`, adapt legacy tools, register six verbs.
 * `config.legacyTools` is an array of host ToolDefinitions (DSH exposes no
 * enumeration, so the kernel never reaches into `ctx.tools` by itself).
 * @param {any} ctx
 * @param {{authorize?: Function, strict?: boolean, legacyTools?: any[], legacyOptions?: any, capabilities?: any[]}} [config]
 * @returns {CapabilityRegistry}
 */
export function apply(ctx, config = {}) {
  const registry = new CapabilityRegistry({ authorize: config.authorize, ctx, strict: config.strict })
  ctx.provide('kernel', registry)
  for (const descriptor of Array.isArray(config.capabilities) ? config.capabilities : []) registry.register(descriptor)
  for (const tool of Array.isArray(config.legacyTools) ? config.legacyTools : []) registry.register(fromTool(tool, config.legacyOptions ?? {}))
  const tools = createTools(registry, { ctx })
  if (ctx.tools && typeof ctx.tools.register === 'function') for (const tool of tools) ctx.tools.register(tool)
  return registry
}
