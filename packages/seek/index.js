/**
 * dsh-seek — cross-source evidence search for DeepSeek Harness.
 *
 * 0.1.0 is the provider protocol MVP: `ctx.evidence` fans one query out to
 * named providers, normalizes and deduplicates their hits, and returns a
 * partial result plus per-provider errors. First-party locator / library /
 * memento / web adapters are intentionally out of scope until 0.2.0.
 * @module dsh-seek
 */

/** Cordis plugin name. */
export const name = 'dsh-seek'

/** The host tool registry is only needed for the two agent tools. */
export const inject = ['tools']

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
/** Default per-provider budget; a hanging provider never blocks the query for longer. */
export const DEFAULT_TIMEOUT_MS = 10_000
/** Refs longer than this are rejected instead of being passed around as evidence. */
export const MAX_REF_LENGTH = 512

/** Provider names use the same token grammar as the `<source>` ref segment. */
const SOURCE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/

/** `dsh://<source>/<id>`, where id is one or more non-empty path segments. */
const REF_PATTERN = /^dsh:\/\/([a-z][a-z0-9._-]{0,63})\/([^\s/?#]+(?:\/[^\s/?#]+)*)$/

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (plainObject(error) && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Parse and validate a `dsh://<source>/<id>` ref. Empty, overlong, malformed
 * and dot-segment (`..`) ids are rejected.
 * @param {unknown} ref
 * @returns {{ source: string, id: string } | undefined}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_LENGTH) return undefined
  const match = REF_PATTERN.exec(ref)
  if (match === null) return undefined
  if (match[2].split('/').some(segment => segment === '.' || segment === '..')) return undefined
  return { source: match[1], id: match[2] }
}

/** Validate the caller's per-provider timeout; invalid values fail closed. */
function timeoutOf(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1) {
    throw fail('invalid_timeout', 'seek: timeoutMs must be a positive integer')
  }
  return value
}

/** Validate the caller's cancellation signal, if one was supplied. */
function signalOf(value) {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal)) {
    throw fail('invalid_signal', 'seek: signal must be an AbortSignal')
  }
  return value
}

const abortedError = () => fail('aborted', 'seek: search aborted')

/** Normalize the caller's limit; invalid explicit values fail closed. */
function limitOf(value) {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1) {
    throw fail('invalid_limit', 'seek: limit must be a positive integer')
  }
  return Math.min(value, MAX_LIMIT)
}

/**
 * Validate one provider hit and reduce it to the documented shape. Invalid
 * refs and ref/source mismatches are dropped by the caller and reported.
 */
function normalizeHit(value) {
  if (!plainObject(value)) return undefined
  const parsed = parseRef(value.ref)
  if (parsed === undefined) return undefined
  if (value.source !== undefined && value.source !== parsed.source) return undefined

  const hit = {
    ref: value.ref,
    source: parsed.source,
    title: typeof value.title === 'string' ? value.title : '',
    snippet: typeof value.snippet === 'string' ? value.snippet : '',
  }
  if (typeof value.score === 'number' && Number.isFinite(value.score)) hit.score = value.score
  if (value.freshness !== undefined) hit.freshness = value.freshness
  return hit
}

/** Missing scores sort as zero. */
function scoreOf(hit) {
  return hit.score ?? 0
}

/**
 * Call one provider under a hard per-provider budget. The provider receives
 * `{ limit, signal, timeoutMs }`; `signal` is the caller's signal combined with
 * `AbortSignal.timeout(timeoutMs)`, so a cooperative provider can stop its own
 * work, and racing that signal bounds even a provider that ignores it.
 */
async function askProvider(provider, text, { limit, timeoutMs, signal }) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const budget = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
  const timedOut = () => fail('provider_timeout', `seek: provider "${provider.name}" timed out after ${timeoutMs} ms`)
  if (budget.aborted) throw deadline.aborted ? timedOut() : abortedError()
  const work = Promise.resolve().then(() => provider.search(text, { limit, signal: budget, timeoutMs }))
  const failure = new Promise((_, reject) => {
    budget.addEventListener('abort', () => reject(deadline.aborted ? timedOut() : abortedError()), { once: true })
  })
  return await Promise.race([work, failure])
}

/** Named provider registry and fan-out search exposed to plugins as `ctx.evidence`. */
export class SeekService {
  #providers = new Map()

  /**
   * Register `{ name, search(query, opts) }`. Returns a disposer.
   * @throws {Error} `invalid_provider` or `provider_exists`.
   */
  registerProvider(provider) {
    if (!plainObject(provider)) {
      throw fail('invalid_provider', 'seek: provider must be an object')
    }
    if (typeof provider.name !== 'string' || !SOURCE_PATTERN.test(provider.name)) {
      throw fail('invalid_provider', `seek: invalid provider name: ${String(provider.name)}`)
    }
    if (typeof provider.search !== 'function') {
      throw fail('invalid_provider', `seek: provider "${provider.name}" requires a search function`)
    }
    if (this.#providers.has(provider.name)) {
      throw fail('provider_exists', `seek: provider "${provider.name}" is already registered`)
    }

    const entry = Object.freeze({ name: provider.name, search: provider.search.bind(provider) })
    this.#providers.set(entry.name, entry)
    return () => (this.#providers.get(entry.name) === entry ? this.#providers.delete(entry.name) : false)
  }

  /** Remove a provider by name; true when it existed. */
  unregisterProvider(name) {
    return this.#providers.delete(name)
  }

  /** Registered provider names, in registration order. */
  providers() {
    return [...this.#providers.keys()]
  }

  /**
   * Query selected providers in parallel.
   *
   * Every provider is bounded by `timeoutMs` (default 10 s): it receives
   * `{ limit, signal, timeoutMs }`, where `signal` aborts at the deadline or
   * when the caller aborts. A provider that times out, rejects, aborts or
   * returns a malformed shape only adds one `errors` entry; it never blocks the
   * merged result. Hits are keyed by `ref`; the highest-scoring duplicate wins.
   * The merged list is sorted by score descending and then source, and
   * truncated to `limit`.
   *
   * @param {string} query
   * @param {{ sources?: string[], limit?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ query: string, hits: object[], total: number, errors: object[] }>}
   */
  async search(query, options = {}) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw fail('invalid_query', 'seek: query must be a non-empty string')
    }
    if (!plainObject(options)) {
      throw fail('invalid_options', 'seek: options must be an object')
    }

    const text = query.trim()
    const limit = limitOf(options.limit)
    const timeoutMs = timeoutOf(options.timeoutMs)
    const signal = signalOf(options.signal)
    if (signal !== undefined && signal.aborted) throw abortedError()
    const selected = this.#select(options.sources)
    const settled = await Promise.allSettled(
      selected.map(provider => askProvider(provider, text, { limit, timeoutMs, signal })),
    )
    if (signal !== undefined && signal.aborted) throw abortedError()

    const errors = []
    const byRef = new Map()
    settled.forEach((outcome, index) => {
      const source = selected[index].name
      if (outcome.status === 'rejected') {
        errors.push({
          source,
          code: outcome.reason?.code === 'provider_timeout' ? 'provider_timeout' : 'provider_failed',
          message: messageOf(outcome.reason),
        })
        return
      }
      if (!Array.isArray(outcome.value)) {
        errors.push({
          source,
          code: 'provider_failed',
          message: 'provider must return an array of hits',
        })
        return
      }

      let invalid = 0
      for (const raw of outcome.value) {
        const hit = normalizeHit(raw)
        if (hit === undefined) {
          invalid += 1
          continue
        }
        const current = byRef.get(hit.ref)
        if (current === undefined || scoreOf(hit) > scoreOf(current)) byRef.set(hit.ref, hit)
      }
      if (invalid > 0) {
        errors.push({
          source,
          code: 'invalid_hit',
          message: `${invalid} hit(s) omitted: refs must use dsh://<source>/<id> (at most ${MAX_REF_LENGTH} characters) and match hit.source`,
        })
      }
    })

    const hits = [...byRef.values()].sort((a, b) => scoreOf(b) - scoreOf(a)
      || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    if (hits.length > limit) hits.length = limit
    return { query: text, hits, total: hits.length, errors }
  }

  /** Snapshot the providers selected by `sources` (all when omitted). */
  #select(sources) {
    const providers = [...this.#providers.values()]
    if (sources === undefined) return providers
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
      throw fail('invalid_sources', 'seek: sources must be an array of provider names')
    }
    const wanted = new Set(sources)
    return providers.filter(provider => wanted.has(provider.name))
  }
}

/** Build a plain-object tool definition accepted by the host. */
function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute,
  }
}

/** `seek_search` tool: one query across all or selected providers. */
function searchTool(service) {
  return tool(
    'seek_search',
    'Search registered evidence providers and return deduplicated hits with dsh:// refs and per-provider errors.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Provider names to query; defaults to every registered provider.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: 'Maximum hits to return (default 10).',
        },
      },
    },
    async (args, exec) => service.search(args?.query, {
      sources: args?.sources,
      limit: args?.limit,
      signal: exec?.signal,
    }),
  )
}

/** `seek_providers` tool: provider discovery for agents. */
function providersTool(service) {
  return tool(
    'seek_providers',
    'List the names of registered Seek evidence providers.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => ({ providers: service.providers() }),
  )
}

/**
 * Mount dsh-seek: provide `ctx.evidence` and register the two agent tools.
 * @param {object} ctx - Cordis context with `provide` and `tools.register`.
 * @param {object} [_config] - Reserved for 0.2.0; unused by the MVP.
 */
export function apply(ctx, _config = {}) {
  const service = new SeekService()
  ctx.provide('evidence', service)
  ctx.tools.register(searchTool(service))
  ctx.tools.register(providersTool(service))
  return service
}
