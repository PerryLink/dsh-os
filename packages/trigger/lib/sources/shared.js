/** Helpers shared by the fs, webhook and agent source adapters. */

/** Build an Error carrying a stable `code`, matching the service error shape. */
export const fail = (code, message) => Object.assign(new Error(message), { code })

/** Bounded first-in-first-out key set; every adapter dedupes within one window. */
export function createDedupe(limit = 4096) {
  const seen = new Set()
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 4096
  return {
    add(key) {
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > max) seen.delete(seen.values().next().value)
      return true
    },
  }
}
