/**
 * @perrylink/dsh-context — read-only context provider protocol for dsh-os.
 *
 * 0.1.0 is the protocol and the `ctx.context` registry only. Real active
 * app/window/selection adapters land in 0.2.0. Context never reads the OS
 * clipboard: raw clipboard text belongs to Snip; the `clipboard` field is
 * reserved for a future metadata-only adapter.
 * @module @perrylink/dsh-context
 */

/** Cordis plugin name. */
export const name = 'dsh-context'

/** The registry works without tools; the agent tools need the tool registry. */
export const inject = ['tools']

const SCHEMA = 'dsh.context.snapshot/v1'
const PROVIDER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/
const FIELDS = new Set(['app', 'window', 'selection', 'clipboard', 'files'])
const DEMO = 'demo'

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code })
}

function checkName(value) {
  if (typeof value !== 'string' || !PROVIDER_NAME.test(value)) {
    fail('E_INVALID_ARGUMENT', 'provider name must match ^[a-z][a-z0-9_.-]{0,63}$')
  }
  return value
}

/** Validate a provider descriptor and return its canonical name. */
function providerNameOf(provider) {
  if (!isPlainObject(provider)) fail('E_INVALID_ARGUMENT', 'provider must be a plain object')
  const providerName = checkName(provider.name)
  if (typeof provider.get !== 'function') {
    fail('E_INVALID_ARGUMENT', `provider "${providerName}" must have a get() function`)
  }
  return providerName
}

/**
 * Validate a `get()` result and detach it from the provider. Only the protocol
 * fields are accepted; an unknown field fails this provider without affecting
 * the others.
 */
function normalizeResult(providerName, result) {
  if (!isPlainObject(result)) {
    fail('E_STATE', `provider "${providerName}" must return an object`)
  }
  const payload = {}
  for (const [field, value] of Object.entries(result)) {
    if (!FIELDS.has(field)) {
      fail('E_INVALID_ARGUMENT', `provider "${providerName}" returned unknown field "${field}"`)
    }
    if (value !== undefined) payload[field] = value
  }
  try {
    return structuredClone(payload)
  } catch (error) {
    fail('E_STATE', `provider "${providerName}" returned an uncloneable value: ${error.message}`)
  }
}

/** Normalise one isolated provider failure into a stable snapshot entry. */
function errorEntry(providerName, error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'E_UNAVAILABLE'
  const message = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : 'provider failed'
  return { provider: providerName, code, message }
}

/** A synthetic provider so the protocol can be tried without any OS access. */
export function demoProvider() {
  return {
    name: DEMO,
    get() {
      return {
        app: { id: 'demo.app', name: 'Context demo app', demo: true },
        window: { id: 'demo.window', title: 'Synthetic window', demo: true },
        selection: { text: 'Synthetic selection (demo)', demo: true },
        files: ['demo/example.txt'],
      }
    },
  }
}

/** Host seam `ctx.context`: an in-memory provider registry and snapshotter. */
export class ContextService {
  #providers = new Map()
  #now

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') fail('E_INVALID_ARGUMENT', 'now must be a function')
    this.#now = now
  }

  registerProvider(provider) {
    const providerName = providerNameOf(provider)
    if (this.#providers.has(providerName)) {
      fail('E_CONFLICT', `provider "${providerName}" is already registered`)
    }
    this.#providers.set(providerName, provider)
    return { name: providerName }
  }

  /** `true` when the provider was removed, `false` when it was not registered. */
  unregisterProvider(providerName) {
    checkName(providerName)
    return this.#providers.delete(providerName)
  }

  /** Registration descriptors in insertion order. */
  providers() {
    return [...this.#providers.keys()].map(providerName => ({ name: providerName }))
  }

  /**
   * Call every selected provider in parallel and merge results by provider
   * name. One failing provider yields an `errors` entry; it never rejects the
   * snapshot. Nothing is written and no OS state is touched.
   */
  async snapshot(options = {}) {
    if (!isPlainObject(options)) fail('E_INVALID_ARGUMENT', 'snapshot options must be a plain object')
    const selected = this.#selection(options)
    const results = await Promise.all(selected.map(async providerName => {
      try {
        const provider = this.#providers.get(providerName)
        return {
          providerName,
          payload: normalizeResult(providerName, await provider.get()),
        }
      } catch (error) {
        return { providerName, error: errorEntry(providerName, error) }
      }
    }))
    const context = {}
    const errors = []
    for (const result of results) {
      if (result.error !== undefined) errors.push(result.error)
      else context[result.providerName] = result.payload
    }
    return { schema: SCHEMA, at: this.#now(), providers: selected, context, errors }
  }

  #selection(options) {
    const { providers } = options
    if (providers === undefined) return [...this.#providers.keys()]
    if (!Array.isArray(providers)) {
      fail('E_INVALID_ARGUMENT', 'snapshot.providers must be an array of provider names')
    }
    const selected = [...new Set(providers.map(checkName))]
    for (const providerName of selected) {
      if (!this.#providers.has(providerName)) {
        fail('E_NOT_FOUND', `provider "${providerName}" is not registered`)
      }
    }
    return selected
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const NO_ARGS = { type: 'object', additionalProperties: false, properties: {} }

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    {
      name: 'context_snapshot',
      description: 'Read one read-only snapshot of registered context providers. '
        + 'Calls run in parallel; a failing provider is reported in `errors` and '
        + 'does not fail the snapshot. Options: `providers` to select names.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Provider names to call; defaults to every registered provider.',
          },
        },
      },
      output: OUTPUT,
      async execute(input) {
        if (input !== undefined && !isPlainObject(input)) {
          fail('E_INVALID_ARGUMENT', 'context_snapshot expects an object')
        }
        return service.snapshot(input ?? {})
      },
    },
    {
      name: 'context_providers',
      description: 'List registered context providers (name and whether it is the demo).',
      parameters: NO_ARGS,
      output: OUTPUT,
      async execute() {
        return {
          providers: service.providers().map(provider => ({ ...provider, demo: provider.name === DEMO })),
        }
      },
    },
    {
      name: 'context_register_demo',
      description: 'DEMO ONLY: register the built-in synthetic context provider named "demo". '
        + 'It reads no real app, window, selection or clipboard; re-running is harmless.',
      parameters: NO_ARGS,
      output: OUTPUT,
      async execute() {
        if (service.providers().some(provider => provider.name === DEMO)) {
          return {
            provider: DEMO,
            registered: false,
            demo: true,
            note: `a provider named "${DEMO}" is already registered and was left unchanged`,
          }
        }
        service.registerProvider(demoProvider())
        return {
          provider: DEMO,
          registered: true,
          demo: true,
          note: 'synthetic demo data only; no real app, window, selection or clipboard was read',
        }
      },
    },
  ]
}

/**
 * Mount dsh-context: provide `ctx.context` and, when available, register the
 * three agent tools.
 */
export function apply(ctx, config = {}) {
  const service = new ContextService(config)
  ctx.provide('context', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
