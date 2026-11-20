/** Shared helpers for the first-party Seek providers. @module dsh-seek/providers */

/** Stable provider failure. */
export function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Read a host service through `ctx.get` and fall back to the `ctx.<name>` property. */
export function serviceOf(ctx, name) {
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

/** Stop before doing provider work when the caller already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw fail('aborted', 'seek: search aborted')
}

/** Trim and cap model-facing text. */
export function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed
}

/** First non-empty line, capped. */
export function firstLine(value, max) {
  if (typeof value !== 'string') return ''
  const line = value.split(/\r?\n/, 1)[0].trim()
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

/** Reciprocal-rank score so cross-provider ordering compares ranks, not native scores. */
export function rankScore(index) {
  return 1 / (60 + index)
}

/** Normalize a session's `agentPreset` the same way dsh-memento's `agentKeyOf` does. */
export function agentKeyOf(agentPreset) {
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) return ''
  const trimmed = agentPreset.trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
