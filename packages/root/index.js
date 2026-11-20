/**
 * dsh-root — named, explainable environment profiles for DeepSeek Harness.
 *
 * 0.1.0 MVP: Host service `ctx.env` plus the `root_*` agent tools. A profile is
 * a ledger entry (vars, secret *references*, proxy policy, PATH prepends,
 * inheritance and deny patterns) that can be composed and explained.
 *
 * It deliberately never reads or writes `process.env`: materialization into a
 * launcher or shell seam belongs to 0.2.0. Plain ESM, no runtime dependencies.
 * @module dsh-root
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-root'

/** The ledger is standalone; the agent tools need the host tool registry. */
export const inject = ['tools']

const LAYERS = ['user', 'workspace', 'agent']
const LAYER_RANK = { user: 0, workspace: 1, agent: 2 }
const VAR_NAME = /^[A-Z_][A-Z0-9_]*$/
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/
const DENY_PATTERN = /^[A-Za-z0-9_.*-]{1,128}$/
const PROFILE_KEYS = new Set(['name', 'vars', 'secretRefs', 'proxy', 'pathPrepend', 'inherit', 'deny', 'trust', 'scope'])
const STATE_VERSION = 1
const clone = value => structuredClone(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(code, message, extra) {
  throw Object.assign(new Error(message), { code }, extra)
}
function normalizeEnvRecord(record, field, secret) {
  if (record === undefined || record === null) return {}
  if (!plain(record)) fail('invalid_profile', `${field} must be an object`)
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    if (!VAR_NAME.test(key)) fail('invalid_var_name', `${field} key "${key}" must match ${VAR_NAME}`, { key, field })
    if (typeof value !== 'string' || value.includes('\0')) fail('invalid_profile', `${field}.${key} must be a string without NUL`, { key })
    if (secret) {
      if (value.trim() === '') fail('invalid_secret_ref', `secretRefs.${key} must be a non-empty reference`)
      out[key] = value.trim()
    } else out[key] = value
  }
  return out
}

function normalizeProxy(proxy) {
  if (!plain(proxy)) fail('invalid_profile', 'proxy must be an object')
  const out = {}
  for (const [key, value] of Object.entries(proxy)) {
    if (!['http', 'https', 'noProxy'].includes(key)) fail('invalid_proxy', `unknown proxy field "${key}"`)
    if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/.test(value)) {
      fail('invalid_proxy', `proxy.${key} must be a non-empty single-line string`)
    }
    out[key] = value.trim()
  }
  if (Object.keys(out).length === 0) fail('invalid_proxy', 'proxy must set http, https or noProxy')
  return out
}

function normalizePathPrepend(entries) {
  if (entries === undefined || entries === null) return []
  if (!Array.isArray(entries)) fail('invalid_profile', 'pathPrepend must be an array')
  const out = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.includes('\0')) {
      fail('invalid_profile', 'pathPrepend entries must be non-empty strings without NUL')
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

function normalizeDeny(patterns) {
  if (patterns === undefined || patterns === null) return []
  if (!Array.isArray(patterns)) fail('invalid_profile', 'deny must be an array')
  const out = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !DENY_PATTERN.test(pattern)) fail('invalid_deny', `invalid deny pattern: ${String(pattern)}`)
    if (!out.includes(pattern)) out.push(pattern)
  }
  return out
}

/** Validate an input profile and fill the schema defaults. */
function normalizeProfile(name, input) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) fail('invalid_profile_name', `invalid profile name: ${String(name)}`)
  if (!plain(input)) fail('invalid_profile', 'profile must be an object')
  if (input.name !== undefined && input.name !== name) fail('invalid_profile', `profile.name "${input.name}" does not match "${name}"`)
  for (const key of Object.keys(input)) if (!PROFILE_KEYS.has(key)) fail('invalid_profile', `unknown profile field "${key}"`)
  const trust = input.trust ?? 'user'
  const scope = input.scope ?? trust
  if (!LAYERS.includes(trust)) fail('invalid_profile', `invalid trust: ${String(trust)}`)
  if (!LAYERS.includes(scope)) fail('invalid_profile', `invalid scope: ${String(scope)}`)
  const vars = normalizeEnvRecord(input.vars, 'vars', false)
  const secretRefs = normalizeEnvRecord(input.secretRefs, 'secretRefs', true)
  const overlap = Object.keys(vars).filter(key => Object.hasOwn(secretRefs, key))
  if (overlap.length > 0) fail('invalid_profile', `vars and secretRefs both define ${overlap.join(', ')}`)
  const inherit = input.inherit ?? null
  if (inherit !== null) {
    if (typeof inherit !== 'string' || !PROFILE_NAME.test(inherit)) fail('invalid_profile', `invalid inherit: ${String(inherit)}`)
    if (inherit === name) fail('inherit_cycle', `profile "${name}" cannot inherit itself`)
  }
  const profile = {
    name,
    vars,
    secretRefs,
    pathPrepend: normalizePathPrepend(input.pathPrepend),
    inherit,
    deny: normalizeDeny(input.deny),
    trust,
    scope,
  }
  if (input.proxy !== undefined && input.proxy !== null) profile.proxy = normalizeProxy(input.proxy)
  return profile
}

/** Case-insensitive glob matcher for deny patterns (`AWS_*`, `*_TOKEN`). */
function denyRegex(pattern) {
  const body = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`, 'i')
}

/**
 * Host seam `ctx.env`: a profile ledger with inheritance, deny and provenance.
 * All methods are synchronous; optional state is an atomically written JSON file.
 */
export class RootService {
  #profiles = new Map()
  #stateFile = null

  constructor(ctx, config = {}) {
    this.ctx = ctx
    if (!plain(config)) fail('invalid_config', 'config must be an object')
    if (config.stateFile !== undefined && config.stateFile !== null) {
      if (typeof config.stateFile !== 'string' || config.stateFile.trim() === '') {
        fail('invalid_config', 'stateFile must be a non-empty path string')
      }
      this.#stateFile = resolve(config.stateFile)
      this.#load()
    }
  }

  /** Create or replace a profile. Returns the normalized profile. */
  set(name, profile) {
    const next = normalizeProfile(name, profile)
    const previous = this.#profiles.get(next.name)
    this.#profiles.set(next.name, next)
    try {
      this.#persist()
    } catch (error) {
      if (previous === undefined) this.#profiles.delete(next.name)
      else this.#profiles.set(next.name, previous)
      throw error
    }
    return clone(next)
  }

  /** Return a deep copy of one profile, or `undefined`. */
  get(name) {
    const profile = this.#profiles.get(name)
    return profile === undefined ? undefined : clone(profile)
  }

  /** All profiles in insertion order, as deep copies. */
  list() {
    return [...this.#profiles.values()].map(clone)
  }

  /** Remove a profile; returns whether it existed. */
  remove(name) {
    const previous = this.#profiles.get(name)
    if (previous === undefined) return false
    this.#profiles.delete(name)
    try {
      this.#persist()
    } catch (error) {
      this.#profiles.set(name, previous)
      throw error
    }
    return true
  }

  /**
   * Compose the inheritance chain (root first, profile last) and return the
   * effective values. `options.layer` is an optional visibility ceiling:
   * profiles with a trust level above it are omitted.
   */
  resolve(name, options = {}) {
    if (!plain(options)) fail('invalid_arguments', 'resolve options must be an object')
    const { layer } = options
    if (layer !== undefined && !LAYERS.includes(layer)) fail('invalid_layer', `layer must be one of ${LAYERS.join(', ')}`)
    const chain = this.#chain(name)
    const active = layer === undefined ? chain : chain.filter(profile => LAYER_RANK[profile.trust] <= LAYER_RANK[layer])
    if (!active.some(profile => profile.name === name)) fail('layer_forbidden', `profile "${name}" is above the ${layer} layer`)

    const entries = new Map()
    const proxy = {}
    const pathPrepend = []
    const deny = []
    for (const profile of active) {
      for (const [key, value] of Object.entries(profile.vars)) entries.set(key, { kind: 'var', value, source: profile.name })
      for (const [key, ref] of Object.entries(profile.secretRefs)) entries.set(key, { kind: 'secretRef', secretRef: ref, source: profile.name })
      if (profile.proxy) {
        for (const key of ['http', 'https', 'noProxy']) if (profile.proxy[key] !== undefined) proxy[key] = profile.proxy[key]
      }
      for (const entry of profile.pathPrepend) if (!pathPrepend.includes(entry)) pathPrepend.push(entry)
      for (const pattern of profile.deny) if (!deny.includes(pattern)) deny.push(pattern)
    }

    const matchers = deny.map(pattern => denyRegex(pattern))
    const denied = []
    for (const key of [...entries.keys()]) {
      if (matchers.some(regex => regex.test(key))) {
        denied.push(key)
        entries.delete(key)
      }
    }
    const vars = {}
    const secretRefs = {}
    const sources = {}
    for (const [key, entry] of entries) {
      sources[key] = entry.source
      if (entry.kind === 'var') vars[key] = entry.value
      else secretRefs[key] = entry.secretRef
    }
    return {
      vars,
      secretRefs,
      proxy: Object.keys(proxy).length > 0 ? proxy : null,
      pathPrepend,
      sources,
      denied,
    }
  }

  /** Explain where an effective key came from, or why deny removed it. */
  explain(name, key) {
    if (typeof key !== 'string' || key === '') fail('invalid_key', 'key must be a non-empty string')
    const chain = this.#chain(name)
    const definitions = []
    const deny = []
    for (const profile of chain) {
      deny.push(...profile.deny)
      if (Object.hasOwn(profile.vars, key)) definitions.push({ profile: profile.name, kind: 'var', value: profile.vars[key] })
      else if (Object.hasOwn(profile.secretRefs, key)) definitions.push({ profile: profile.name, kind: 'secretRef', secretRef: profile.secretRefs[key] })
    }
    const deniedBy = deny.map(pattern => [pattern, denyRegex(pattern)]).find(([, regex]) => regex.test(key))?.[0] ?? null
    const result = { profile: name, key, found: definitions.length > 0 && deniedBy === null, denied: deniedBy !== null, deniedBy }
    if (definitions.length === 0) return result
    const last = definitions[definitions.length - 1]
    const source = chain.find(profile => profile.name === last.profile)
    Object.assign(result, {
      kind: last.kind,
      source: last.profile,
      trust: source.trust,
      scope: source.scope,
      overridden: definitions.slice(0, -1).map(definition => definition.profile),
    })
    if (deniedBy === null) {
      if (last.kind === 'var') result.value = last.value
      else result.secretRef = last.secretRef
    }
    return result
  }

  /** Walk `inherit` first-class, returning root -> target and rejecting cycles. */
  #chain(name) {
    if (typeof name !== 'string' || !PROFILE_NAME.test(name)) fail('invalid_profile_name', `invalid profile name: ${String(name)}`)
    const chain = []
    const seen = new Set()
    let current = name
    while (current !== null) {
      if (seen.has(current)) fail('inherit_cycle', `inherit cycle: ${[...seen, current].join(' -> ')}`)
      const profile = this.#profiles.get(current)
      if (profile === undefined) fail('profile_not_found', `profile "${current}" is not registered`, { profileName: current })
      seen.add(current)
      chain.unshift(profile)
      current = profile.inherit
    }
    return chain
  }

  #load() {
    let text
    try {
      text = readFileSync(this.#stateFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      fail('state_read_failed', `cannot read state file ${this.#stateFile}: ${error.message}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      fail('state_invalid', `state file ${this.#stateFile} is not valid JSON: ${error.message}`)
    }
    const profiles = Array.isArray(data) ? data : data?.profiles
    if (!Array.isArray(profiles)) fail('state_invalid', `state file ${this.#stateFile} has no profiles array`)
    if (!Array.isArray(data) && data.version !== undefined && data.version !== STATE_VERSION) {
      fail('state_invalid', `unsupported state version: ${String(data.version)}`)
    }
    for (const input of profiles) {
      if (!plain(input) || typeof input.name !== 'string') fail('state_invalid', `invalid profile record in ${this.#stateFile}`)
      try {
        this.#profiles.set(input.name, normalizeProfile(input.name, input))
      } catch (error) {
        fail('state_invalid', `invalid profile in ${this.#stateFile}: ${error.message}`)
      }
    }
  }

  #persist() {
    if (this.#stateFile === null) return
    const temporary = `${this.#stateFile}.${process.pid}.${Date.now()}.tmp`
    const body = JSON.stringify({ version: STATE_VERSION, profiles: [...this.#profiles.values()] }, null, 2) + '\n'
    try {
      mkdirSync(dirname(this.#stateFile), { recursive: true })
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.#stateFile)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch {}
      fail('state_write_failed', `cannot write state file ${this.#stateFile}: ${error.message}`)
    }
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const argsSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
})

const PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-secret vars; keys match ^[A-Z_][A-Z0-9_]*$.' },
    secretRefs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Credential references only, never secret values.' },
    proxy: {
      type: 'object',
      additionalProperties: false,
      properties: { http: { type: 'string' }, https: { type: 'string' }, noProxy: { type: 'string' } },
    },
    pathPrepend: { type: 'array', items: { type: 'string' } },
    inherit: { type: ['string', 'null'], description: 'Parent profile name, or null.' },
    deny: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive glob patterns, e.g. AWS_*.' },
    trust: { type: 'string', enum: LAYERS },
    scope: { type: 'string', enum: LAYERS },
  },
}

function tool(name, description, parameters, execute) {
  return { name, description, parameters, output: OUTPUT, execute }
}

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    tool('root_set', 'Create or replace a Root environment profile (ledger only; does not modify process.env).',
      argsSchema({ name: { type: 'string', description: 'Profile name, e.g. "acme-dev".' }, profile: PROFILE_SCHEMA }, ['name', 'profile']),
      async args => ({ profile: service.set(args?.name, args?.profile) })),
    tool('root_get', 'Read one Root profile by name. Only secret references are ever stored.',
      argsSchema({ name: { type: 'string' } }, ['name']),
      async args => {
        const profile = service.get(args?.name)
        if (profile === undefined) fail('profile_not_found', `profile "${String(args?.name)}" is not registered`)
        return { profile }
      }),
    tool('root_list', 'List all Root environment profiles in insertion order.',
      argsSchema({}), async () => ({ profiles: service.list() })),
    tool('root_resolve', 'Resolve a profile with its inheritance chain: vars, secretRefs, proxy, pathPrepend, sources and denied keys.',
      argsSchema({
        name: { type: 'string' },
        layer: { type: 'string', enum: LAYERS, description: 'Optional visibility ceiling: omit profiles with a higher trust level.' },
      }, ['name']),
      async args => service.resolve(args?.name, args?.layer === undefined ? {} : { layer: args.layer })),
    tool('root_explain', 'Explain the effective source of one key (and overridden profiles), or why deny removed it.',
      argsSchema({ name: { type: 'string' }, key: { type: 'string' } }, ['name', 'key']),
      async args => service.explain(args?.name, args?.key)),
  ]
}

/** Mount the plugin at `ctx.env` and register the five agent tools. */
export function apply(ctx, config = {}) {
  const service = new RootService(ctx, config)
  ctx.provide('env', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
