/**
 * dsh-nest — versioned workspace profiles for DeepSeek Harness.
 *
 * 0.1.0 is a profile ledger: validate, version, diff and resolve workspace
 * profiles in memory or in an optional atomic JSON snapshot. It deliberately
 * does not apply profiles to sessions, sandboxes or environments yet; that
 * integration is scoped for 0.2.0.
 * @module dsh-nest
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-nest'

/** The bundle needs the host tool registry to expose its agent tools. */
export const inject = ['tools']

/** Reserved key of the base profile inherited by every workspace. */
export const GLOBAL = 'global'

const STATE_VERSION = 1
const PROFILE_FIELDS = [
  'path', 'title', 'contextFiles', 'permissionPreset', 'envProfile',
  'defaults', 'skills', 'lifecycle', 'owners', 'version',
]
const FIELDS = new Set(PROFILE_FIELDS)
const DIFF_FIELDS = PROFILE_FIELDS.filter(field => field !== 'path' && field !== 'version')
const DEFAULT_FIELDS = new Set(['model', 'reasoning'])
const LIFECYCLE_FIELDS = new Set(['ttlDays', 'archiveAfterDays'])

const clone = value => structuredClone(value)

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('E_FIELD', `${field} must be a non-empty string`)
  }
  if (value.includes('\0')) throw fail('E_FIELD', `${field} must not contain NUL`)
  return value
}

function stringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw fail('E_ARRAY', `${field} must be an array of strings`)
  const result = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\0')) {
      throw fail('E_ARRAY', `${field} must contain non-empty strings`)
    }
    if (!result.includes(item)) result.push(item)
  }
  return result
}

function profilePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('E_PATH', 'path must be a non-empty absolute path or "global"')
  }
  if (value === GLOBAL) return GLOBAL
  if (value.includes('\0') || !isAbsolute(value)) {
    throw fail('E_PATH', `path must be absolute: ${JSON.stringify(value)}`)
  }
  return resolvePath(value)
}

function objectField(value, field, allowed) {
  if (!plainObject(value)) throw fail('E_FIELD', `${field} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw fail('E_FIELD', `unknown ${field} field: ${key}`)
  }
}

function defaultsField(value) {
  if (value === undefined) return undefined
  objectField(value, 'defaults', DEFAULT_FIELDS)
  const result = {}
  for (const key of DEFAULT_FIELDS) {
    if (value[key] !== undefined) result[key] = text(value[key], `defaults.${key}`)
  }
  return result
}

function lifecycleField(value) {
  if (value === undefined) return undefined
  objectField(value, 'lifecycle', LIFECYCLE_FIELDS)
  const result = {}
  for (const key of LIFECYCLE_FIELDS) {
    const days = value[key]
    if (days === undefined) continue
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
      throw fail('E_FIELD', `lifecycle.${key} must be a non-negative number`)
    }
    result[key] = days
  }
  return result
}

function normalizeProfile(path, input, version) {
  if (!plainObject(input)) throw fail('E_PROFILE', 'profile must be an object')
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) throw fail('E_FIELD', `unknown profile field: ${key}`)
  }
  if (input.path !== undefined && profilePath(input.path) !== path) {
    throw fail('E_PATH', 'profile.path must match the set path')
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw fail('E_VERSION', 'version must be a positive integer')
  }
  const profile = { path }
  if (input.title !== undefined) profile.title = text(input.title, 'title')
  profile.contextFiles = stringArray(input.contextFiles, 'contextFiles')
  if (input.permissionPreset !== undefined) {
    profile.permissionPreset = text(input.permissionPreset, 'permissionPreset')
  }
  if (input.envProfile !== undefined) profile.envProfile = text(input.envProfile, 'envProfile')
  const defaults = defaultsField(input.defaults)
  if (defaults !== undefined) profile.defaults = defaults
  profile.skills = stringArray(input.skills, 'skills')
  const lifecycle = lifecycleField(input.lifecycle)
  if (lifecycle !== undefined) profile.lifecycle = lifecycle
  profile.owners = stringArray(input.owners, 'owners')
  profile.version = version
  return profile
}

function assertVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw fail('E_VERSION', 'version must be a positive integer')
  }
  return value
}

/** New profiles start at 1; overwrites always advance exactly one step. */
function nextVersion(existing, requested) {
  if (existing === undefined) {
    return requested === undefined ? 1 : assertVersion(requested)
  }
  if (requested !== undefined) {
    assertVersion(requested)
    if (requested !== existing.version && requested !== existing.version + 1) {
      throw fail('E_VERSION', `version must be ${existing.version} (current), got ${requested}`)
    }
  }
  return existing.version + 1
}

function union(...lists) {
  return [...new Set(lists.flatMap(list => list ?? []))]
}

/** global -> workspace: scalars override, arrays union, nested objects merge. */
function merge(base, own, path) {
  const result = { path }
  for (const field of ['title', 'permissionPreset', 'envProfile']) {
    const value = own?.[field] ?? base?.[field]
    if (value !== undefined) result[field] = value
  }
  for (const field of ['contextFiles', 'skills', 'owners']) {
    result[field] = union(base?.[field], own?.[field])
  }
  for (const field of ['defaults', 'lifecycle']) {
    const value = { ...(base?.[field] ?? {}), ...(own?.[field] ?? {}) }
    if (Object.keys(value).length > 0) result[field] = value
  }
  result.version = own?.version ?? base?.version ?? 1
  return result
}

/** Profile ledger exposed as `ctx.nest`. */
export class NestService {
  #profiles = new Map()
  #stateFile

  constructor(config = {}) {
    if (config.stateFile !== undefined && config.stateFile !== null) {
      if (typeof config.stateFile !== 'string' || config.stateFile.trim() === '') {
        throw fail('E_STATE', 'stateFile must be a non-empty path string')
      }
      this.#stateFile = config.stateFile
    }
    if (this.#stateFile) this.#load()
  }

  /** Create or update the profile at `path`; returns the stored record. */
  set(path, profile = {}) {
    const key = profilePath(path)
    const existing = this.#profiles.get(key)
    const version = nextVersion(existing, profile?.version)
    const record = normalizeProfile(key, profile, version)
    this.#profiles.set(key, record)
    this.#persist()
    return clone(record)
  }

  /** Stored profile at `path`, or `null`. */
  get(path) {
    const record = this.#profiles.get(profilePath(path))
    return record === undefined ? null : clone(record)
  }

  /** Every stored profile, sorted by path. */
  list() {
    return [...this.#profiles.values()]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(clone)
  }

  /** Delete the profile at `path`; returns whether it existed. */
  remove(path) {
    const key = profilePath(path)
    const removed = this.#profiles.delete(key)
    if (removed) this.#persist()
    return removed
  }

  /**
   * Effective profile for `path`: the reserved `global` base merged with the
   * workspace profile in one step. Read-only; never creates a record.
   */
  resolve(path) {
    const key = profilePath(path)
    if (key === GLOBAL) {
      const global = this.#profiles.get(GLOBAL)
      if (global === undefined) throw fail('E_NOT_FOUND', 'no profile at global')
      return { path: GLOBAL, sources: { global: true, workspace: false }, profile: clone(global) }
    }
    const base = this.#profiles.get(GLOBAL)
    const own = this.#profiles.get(key)
    if (base === undefined && own === undefined) {
      throw fail('E_NOT_FOUND', `no profile at ${key}`)
    }
    return {
      path: key,
      sources: { global: base !== undefined, workspace: own !== undefined },
      profile: clone(merge(base, own, key)),
    }
  }

  /** Field-level preview of what `set(path, patch)` would change. */
  diff(path, patch = {}) {
    const key = profilePath(path)
    const existing = this.#profiles.get(key)
    const version = nextVersion(existing, patch?.version)
    const next = normalizeProfile(key, patch, version)
    const current = existing === undefined ? null : clone(existing)
    const before = existing ?? { contextFiles: [], skills: [], owners: [] }
    const changes = []
    for (const field of DIFF_FIELDS) {
      const from = before[field] ?? null
      const to = next[field] ?? null
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to })
    }
    return {
      path: key,
      created: existing === undefined,
      hasChanges: existing === undefined || changes.length > 0,
      changes,
      current,
      next,
    }
  }

  #load() {
    if (!existsSync(this.#stateFile)) return
    let parsed
    try {
      const raw = readFileSync(this.#stateFile, 'utf8').trim()
      if (raw === '') return
      parsed = JSON.parse(raw)
    } catch (error) {
      throw fail('E_STATE_INVALID', `cannot read state file: ${error.message}`)
    }
    if (!plainObject(parsed) || !Array.isArray(parsed.profiles)) {
      throw fail('E_STATE_INVALID', 'state file must contain a profiles array')
    }
    if (parsed.version !== undefined && parsed.version !== STATE_VERSION) {
      throw fail('E_STATE_INVALID', `unsupported state version: ${parsed.version}`)
    }
    for (const entry of parsed.profiles) {
      try {
        const key = profilePath(entry?.path)
        this.#profiles.set(key, normalizeProfile(key, entry, entry.version))
      } catch (error) {
        throw fail('E_STATE_INVALID', `invalid profile in state file: ${error.message}`)
      }
    }
  }

  #persist() {
    if (!this.#stateFile) return
    const payload = `${JSON.stringify({
      version: STATE_VERSION,
      profiles: [...this.#profiles.values()],
    }, null, 2)}\n`
    const temp = `${this.#stateFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.#stateFile), { recursive: true, mode: 0o700 })
      writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.#stateFile)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch {}
      throw fail('E_STATE_WRITE', `cannot write state file: ${error.message}`)
    }
  }
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const PROFILE_INPUT = {
  type: 'object',
  additionalProperties: true,
  description: 'Profile fields: path?, title?, contextFiles?, permissionPreset?, envProfile?, '
    + 'defaults?{model,reasoning}, skills?, lifecycle?{ttlDays,archiveAfterDays}, owners?, version?.',
}

function objectSchema(properties, required = []) {
  const schema = { type: 'object', additionalProperties: false, properties }
  if (required.length > 0) schema.required = required
  return schema
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args) {
      return execute(args ?? {})
    },
  }
}

/** Plain-object ToolDefinitions; no @deepseek-ai/dsh-tools dependency. */
export function makeTools(service) {
  return [
    tool(
      'nest_set',
      'Create or update a Nest workspace profile. Overwrites advance version by one. '
        + 'This records the profile only; it does not change the workspace yet.',
      objectSchema({
        path: { type: 'string', description: 'Absolute workspace path, or "global" for the base profile.' },
        profile: PROFILE_INPUT,
      }, ['path', 'profile']),
      args => ({ profile: service.set(args.path, args.profile) }),
    ),
    tool(
      'nest_get',
      'Read one stored Nest workspace profile by path.',
      objectSchema({ path: { type: 'string' } }, ['path']),
      args => {
        const profile = service.get(args.path)
        if (profile === null) throw fail('E_NOT_FOUND', `no profile at ${args.path}`)
        return { profile }
      },
    ),
    tool(
      'nest_list',
      'List every stored Nest workspace profile, sorted by path.',
      objectSchema({}),
      () => ({ profiles: service.list() }),
    ),
    tool(
      'nest_diff',
      'Preview the field-level changes that nest_set(path, patch) would make, without writing.',
      objectSchema({ path: { type: 'string' }, patch: PROFILE_INPUT }, ['path']),
      args => service.diff(args.path, args.patch),
    ),
    tool(
      'nest_remove',
      'Delete one stored Nest workspace profile by path.',
      objectSchema({ path: { type: 'string' } }, ['path']),
      args => ({ path: args.path, removed: service.remove(args.path) }),
    ),
  ]
}

/** Mount `ctx.nest` and the five nest_* agent tools. */
export function apply(ctx, config = {}) {
  const service = new NestService(config)
  ctx.provide('nest', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const definition of makeTools(service)) ctx.tools.register(definition)
  }
  return service
}
