/**
 * Optional evidence-ref verification for `trace_remember`.
 *
 * When `dsh-seek` is mounted (`ctx.get('evidence').resolve`) and the call's
 * `source` looks like a `dsh://` ref, the ref is resolved before the record is
 * stored. A ref that is not found is refused with `E_REF_NOT_FOUND` (enforce
 * mode, the default) or accepted with a warning (warn mode). Without an
 * evidence service Trace stays a standalone ledger and stores the label as
 * free text, as in 0.2.0.
 * @module dsh-trace/verify
 */

import { DEFAULT_VERIFY_TIMEOUT_MS } from './constants.js'

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read a host service through `ctx.get` and fall back to the property. */
function serviceOf(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(name)
      if (service !== undefined) return service
    } catch {
      // A throwing lookup means the service is unavailable.
    }
  }
  return ctx[name]
}

/** Normalize a session's agentPreset the same way dsh-memento/dsh-seek do. */
function agentKeyOf(agentPreset) {
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) return ''
  const trimmed = agentPreset.trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Build the lazy ref verifier used by `trace_remember`.
 *
 * @param {object} ctx - Cordis context.
 * @param {{ verifyRefs?: boolean, refVerifyMode?: 'enforce'|'warn',
 *   verifyTimeoutMs?: number }} [config]
 * @returns {{ enabled: boolean, mode: 'enforce'|'warn',
 *   resolve(source: unknown, exec?: object): Promise<object|undefined> }}
 */
export function createRefVerifier(ctx, config = {}) {
  const options = plainObject(config) ? config : {}
  const enabled = options.verifyRefs !== false
  const mode = options.refVerifyMode === 'warn' ? 'warn' : 'enforce'
  const timeoutMs = Number.isInteger(options.verifyTimeoutMs) && options.verifyTimeoutMs > 0
    ? options.verifyTimeoutMs
    : DEFAULT_VERIFY_TIMEOUT_MS

  return {
    enabled,
    mode,
    /**
     * Resolve one `dsh://` source label. Returns `undefined` when verification
     * does not apply (disabled, not a dsh ref, or no evidence resolver); throws
     * only for caller cancellation.
     */
    async resolve(source, exec) {
      if (!enabled || typeof source !== 'string' || !source.startsWith('dsh://')) return undefined
      const evidence = serviceOf(ctx, 'evidence')
      if (evidence === undefined || typeof evidence.resolve !== 'function') return undefined
      const session = exec?.agent?.session
      try {
        const outcome = await evidence.resolve(source, {
          signal: exec?.signal,
          timeoutMs,
          cwd: session?.header?.cwd,
          agentKey: agentKeyOf(session?.header?.agentPreset),
          agent: exec?.agent,
        })
        const status = typeof outcome?.status === 'string' ? outcome.status : 'unknown'
        return {
          ok: outcome?.found === true,
          status,
          ref: source,
          ...(Number.isInteger(outcome?.checkedAt) ? { checkedAt: outcome.checkedAt } : {}),
          ...(outcome?.error === undefined ? {} : { error: outcome.error }),
        }
      } catch (error) {
        if (error?.code === 'aborted' || exec?.signal?.aborted) throw error
        return {
          ok: false,
          status: 'error',
          ref: source,
          error: {
            code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'E_REF_NOT_FOUND',
            message: messageOf(error),
          },
        }
      }
    },
  }
}
