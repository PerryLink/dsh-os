/**
 * KernelService: the registry plus a lazy bridge to the host's legacy tools.
 *
 * DSH exposes `ctx.tools.schemas(scope)` (visible schemas) and
 * `ctx.tools.get(name, scope)` (the definition with `execute`). The service
 * enumerates them, skips `os_*` and occupied ids, and adapts the rest with
 * `fromTool` as `legacy.<tool name>`. Repeated or concurrent calls are safe:
 * an occupied id is kept, not overwritten.
 */
import { CapabilityRegistry } from './registry.js'
import { fromTool } from './from-tool.js'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nameOf = value => typeof value === 'string' ? value : isObject(value) && typeof value.name === 'string' ? value.name : null

/** Registry plus `refreshLegacy()` and `stats()`. */
export class KernelService extends CapabilityRegistry {
  constructor(options = {}) {
    super(options)
    this.legacyOptions = isObject(options.legacyOptions) ? options.legacyOptions : {}
    this.lastLegacyRefresh = null
  }

  /** Count aliased-by-`legacy` entries separately from real capabilities. */
  stats() {
    let legacy = 0
    for (const entry of this.entries.values()) if ((entry.descriptor ?? entry.meta).legacy === true) legacy += 1
    const total = this.entries.size
    return { legacy, capabilities: total - legacy, total }
  }

  /** The tools seam, or null when the host does not expose enumeration. */
  #seam() {
    const tools = this.ctx?.tools
    return tools && typeof tools.schemas === 'function' && typeof tools.get === 'function' ? tools : null
  }

  /**
   * Adapt every host tool visible in `scope` into the registry.
   * Without the tools seam this is a silent no-op; id collisions keep the
   * existing descriptor (the legacy entry is always `legacy.<name>`).
   * @param {{scope?: any}} [options]
   * @returns {Promise<{ok: true, available: boolean, scanned: number, added: number, deduped: number, skipped: number, legacy: number, capabilities: number, total: number}>}
   */
  async refreshLegacy({ scope } = {}) {
    const tools = this.#seam()
    const counts = this.stats()
    const report = { ok: true, available: tools !== null, scanned: 0, added: 0, deduped: 0, skipped: 0, ...counts }
    if (!tools) return report
    let schemas
    try { schemas = await tools.schemas(scope) } catch { return { ...report, available: false } }
    const names = [...new Set((Array.isArray(schemas) ? schemas : []).map(nameOf).filter(name => name && !name.startsWith('os_')))]
    for (const name of names) {
      report.scanned += 1
      const id = `legacy.${name}`
      if (this.entries.has(id)) { report.deduped += 1; continue }
      let tool
      try { tool = await tools.get(name, scope) } catch { report.skipped += 1; continue }
      if (!tool || typeof tool.execute !== 'function') { report.skipped += 1; continue }
      const toolName = nameOf(tool) ?? name
      if (toolName.startsWith('os_')) { report.deduped += 1; continue }
      let descriptor
      try { descriptor = fromTool(tool, this.legacyOptions) } catch { report.skipped += 1; continue }
      if (descriptor.id !== id) {
        if (this.entries.has(descriptor.id)) { report.deduped += 1; continue }
        report.skipped += 1
        continue
      }
      const aliases = descriptor.aliases.filter(alias => alias !== descriptor.id && !this.entries.has(alias) && !this.aliases.has(alias))
      if (aliases.length !== descriptor.aliases.length) descriptor = { ...descriptor, aliases }
      try { this.register(descriptor); report.added += 1 } catch { report.skipped += 1 }
    }
    this.lastLegacyRefresh = Date.now()
    return { ...report, ...this.stats() }
  }

  /** Project Act's registered actions as `act.<id>` capabilities. */
  async refreshAct() {
    const act = typeof this.ctx?.get === 'function' ? this.ctx.get('act') : null
    if (!act || typeof act.list !== 'function' || typeof act.invoke !== 'function') {
      return { ok: true, available: false, added: 0, ...this.stats() }
    }
    let actions
    try { actions = act.list() } catch { return { ok: true, available: false, added: 0, ...this.stats() } }
    if (!Array.isArray(actions)) return { ok: true, available: false, added: 0, ...this.stats() }
    let added = 0
    for (const action of actions) {
      if (!action || typeof action.id !== 'string') continue
      const id = `act.${action.id}`
      if (this.entries.has(id) || this.aliases.has(id)) continue
      const risk = action.risk === 'danger' ? ['execute'] : action.risk === 'write' ? ['write'] : ['read']
      try {
        this.register({
          id,
          title: (action.title ?? action.id).slice(0, 40),
          summary: (action.description ?? `Act action ${action.id}`).slice(0, 120),
          whenToUse: [`Use when the task needs the ${action.id} action.`],
          whenNotToUse: [],
          inputSchema: { type: 'object', additionalProperties: true },
          outputSchema: { type: 'object', additionalProperties: true },
          risk,
          permissions: [`act:invoke:${action.id}`],
          cost: { tokens: 0, latencyMs: 0, moneyUsd: 0 },
          idempotency: risk[0] === 'read' ? 'pure' : 'non-idempotent',
          examples: [],
          errors: [],
          version: '0.1.0',
          tags: ['act'],
          handler: async (args, _ctx, exec) => {
            const subject = exec?.subject ?? exec?.agent?.session?.id ?? exec?.agent?.id
            const result = await act.invoke(action.id, args, {
              subject,
              agent: exec?.agent,
              signal: exec?.signal,
            })
            if (!result || result.ok !== true) {
              const error = new Error(result?.message ?? `act.${action.id} failed`)
              error.code = result?.code ?? 'E_UNAVAILABLE'
              throw error
            }
            return result.result ?? result
          },
        })
        added += 1
      } catch { /* occupied or invalid; keep going */ }
    }
    return { ok: true, available: true, added, ...this.stats() }
  }
}

export const createKernelService = options => new KernelService(options)
export default KernelService
