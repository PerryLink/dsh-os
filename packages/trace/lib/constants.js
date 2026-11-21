/**
 * Shared limits and enums for dsh-trace. Kept in one module so the ledger
 * (`index.js`) and the agent tools (`lib/tools.js`) cannot drift apart.
 * @module dsh-trace/constants
 */

/** Memory scopes accepted by `remember`/`restore`. */
export const SCOPES = Object.freeze(['user', 'workspace', 'preset', 'team'])

/** Sensitivity labels accepted by `remember`/`restore`. */
export const SENSITIVITIES = Object.freeze(['normal', 'public', 'internal', 'private', 'secret'])

/** Default and maximum page size of `search`/`list`. */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

/**
 * Maximum provenance label length. A `dsh://` evidence ref may be up to 512
 * characters in dsh-seek 0.3.0, and future ref v2 allows 2048.
 */
export const MAX_SOURCE_LENGTH = 2048

/** Default per-ref resolve budget used by `trace_remember`. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10_000
