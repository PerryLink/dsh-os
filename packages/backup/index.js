/**
 * dsh-timecapsule — read-only, allowlisted snapshot manifests and restore plans.
 *
 * 0.2.0 adds a root allowlist, default sensitive-path exclusions, hard limits
 * and an in-memory audit ledger. It never copies, moves, deletes or writes a
 * file, and it never touches the restore target.
 * @module dsh-timecapsule
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readlinkSync,
  realpathSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve as resolvePath, sep } from 'node:path'
import {
  HASH, fail, plainObject, normalize, HOME, absolute, limit, hashOption, idOf,
  isForbidden, inside, canonical, canonicalLoose, patternList, matcher, anyMatch,
} from './lib/path.js'
export const name = 'dsh-timecapsule'
export const inject = ['tools']
export const SNAPSHOT_SCHEMA = 'dsh.backup.snapshot/v1'
export const DIFF_SCHEMA = 'dsh.backup.diff/v1'
export const PLAN_SCHEMA = 'dsh.backup.plan/v1'
/** Hard caps. Service or per-call limits may lower them, never raise them. */
export const HARD_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
})
/** Applied at any depth unless the host opts out explicitly in config. */
export const DEFAULT_SENSITIVE_EXCLUDES = Object.freeze([
  '**/.ssh', '**/.env*', '**/credentials*', '**/*.pem', '**/*.key',
  '**/id_rsa*', '**/.git', '**/node_modules',
])
const CHUNK = 1024 * 1024
const AUDIT_MAX = 200
const COMPARED = ['type', 'size', 'mtimeMs', 'mode', 'hash', 'target']
const clone = value => structuredClone(value)
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

function sha256File(path) {
  const hash = createHash(HASH)
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(CHUNK)
    let read
    while ((read = readSync(descriptor, buffer, 0, CHUNK, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}
function statDirectory(path, field) {
  let stats
  try { stats = statSync(path, { throwIfNoEntry: false }) } catch (error) {
    throw fail('E_UNAVAILABLE', `cannot stat ${field} ${path}: ${error.message}`)
  }
  if (!stats) throw fail('E_NOT_FOUND', `${field} does not exist: ${path}`)
  if (!stats.isDirectory()) throw fail('E_INVALID_ARGUMENT', `${field} must be a directory: ${path}`)
  return stats
}

/** Walk `root` without following symlinks; hard limits fail closed. */
function scan(root, options) {
  const include = options.include.map(matcher)
  const exclude = options.exclude.map(matcher)
  const state = { files: 0, bytes: 0 }
  let entries = []
  const stack = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()
    let dirents
    try { dirents = readdirSync(dir, { withFileTypes: true }) } catch (error) {
      throw fail('E_UNAVAILABLE', `cannot read ${dir}: ${error.message}`)
    }
    dirents.sort((left, right) => compare(left.name, right.name))
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      if (anyMatch(exclude, childRel)) continue
      const path = join(dir, dirent.name)
      let stats
      try { stats = lstatSync(path, { throwIfNoEntry: false }) } catch (error) {
        throw fail('E_UNAVAILABLE', `cannot stat ${path}: ${error.message}`)
      }
      if (!stats) continue
      const type = stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'other'
      if (type === 'other') continue
      const entry = { path, rel: childRel, type, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o7777 }
      if (type === 'dir') {
        entries.push(entry)
        stack.push({ dir: path, rel: childRel })
        continue
      }
      if (include.length > 0 && !anyMatch(include, childRel)) continue
      if (type === 'file' && stats.size > options.maxFileBytes) {
        throw fail('E_LIMIT', `file ${childRel} exceeds maxFileBytes (${options.maxFileBytes})`)
      }
      state.files += 1
      state.bytes += type === 'file' ? stats.size : 0
      if (state.files > options.maxFiles) throw fail('E_LIMIT', `snapshot exceeds maxFiles (${options.maxFiles})`)
      if (state.bytes > options.maxBytes) throw fail('E_LIMIT', `snapshot exceeds maxBytes (${options.maxBytes})`)
      if (type === 'symlink') entry.target = readlinkSync(path)
      if (options.hash && type === 'file') entry.hash = sha256File(path)
      if (options.hash && type === 'symlink') entry.hash = createHash(HASH).update(entry.target).digest('hex')
      entries.push(entry)
    }
  }
  if (include.length > 0) {
    const keep = new Set()
    for (const entry of entries) {
      if (entry.type === 'dir') continue
      const parts = entry.rel.split('/')
      for (let index = 1; index < parts.length; index += 1) keep.add(parts.slice(0, index).join('/'))
    }
    entries = entries.filter(entry => entry.type !== 'dir' || keep.has(entry.rel))
  }
  entries.sort((left, right) => compare(left.rel, right.rel))
  const counts = { files: 0, dirs: 0, symlinks: 0, bytes: 0 }
  for (const entry of entries) {
    if (entry.type === 'file') { counts.files += 1; counts.bytes += entry.size }
    else if (entry.type === 'dir') counts.dirs += 1
    else counts.symlinks += 1
  }
  return { entries, counts }
}
/** Directory metadata is presence-only; file metadata is compared field by field. */
function changesBetween(left, right) {
  if (left.type === 'dir' || right.type === 'dir') return left.type === right.type ? [] : ['type']
  return COMPARED.filter(field => left[field] !== right[field])
}
const indexEntries = entries => new Map(entries.map(entry => [entry.rel, entry]))

/** In-memory snapshot ledger and audit trail exposed as `ctx.backup`. */
export class BackupService {
  #snapshots = new Map()
  #audits = []
  #allowedRoots
  #defaultExclude
  #extraExclude
  #maxFiles
  #maxBytes
  #maxFileBytes
  #hash
  constructor(config = {}) {
    if (!plainObject(config)) throw fail('E_INVALID_ARGUMENT', 'config must be an object')
    const roots = config.allowedRoots === undefined || config.allowedRoots === null
      ? [process.cwd()] : config.allowedRoots
    if (!Array.isArray(roots) || roots.length === 0) {
      throw fail('E_INVALID_ARGUMENT', 'allowedRoots must be a non-empty array')
    }
    this.#allowedRoots = roots.map(root => {
      const resolved = absolute(root, 'allowedRoots')
      const real = existsSync(resolved) ? canonical(resolved, 'allowedRoots') : resolved
      if (isForbidden(real)) throw fail('E_FORBIDDEN_ROOT', `allowedRoots must not contain ${JSON.stringify(real)}`)
      return real
    })
    this.#maxFiles = limit(config.maxFiles, HARD_LIMITS.maxFiles, 'maxFiles', HARD_LIMITS.maxFiles)
    this.#maxBytes = limit(config.maxBytes, HARD_LIMITS.maxBytes, 'maxBytes', HARD_LIMITS.maxBytes)
    this.#maxFileBytes = limit(config.maxFileBytes, HARD_LIMITS.maxFileBytes, 'maxFileBytes', HARD_LIMITS.maxFileBytes)
    this.#hash = hashOption(config.hash)
    this.#extraExclude = patternList(config.exclude, 'exclude')
    this.#defaultExclude = config.defaultExclude !== undefined
      ? patternList(config.defaultExclude, 'defaultExclude')
      : config.excludeSensitive === false ? [] : patternList(DEFAULT_SENSITIVE_EXCLUDES, 'defaultExclude')
  }

  /** Record a manifest for an allowed `root`; returns it. Writes nothing to disk. */
  snapshot(options = {}) {
    const startedAt = Date.now()
    let root = null
    try {
      if (!plainObject(options)) throw fail('E_INVALID_ARGUMENT', 'snapshot options must be an object')
      root = absolute(options.root, 'root')
      const realRoot = this.#guard(canonicalLoose(root, 'root'), 'root')
      statDirectory(realRoot, 'root')
      const include = patternList(options.include, 'include')
      const exclude = [...new Set([...this.#defaultExclude, ...this.#extraExclude, ...patternList(options.exclude, 'exclude')])]
      const limits = {
        maxFiles: limit(options.maxFiles, this.#maxFiles, 'maxFiles', HARD_LIMITS.maxFiles),
        maxBytes: limit(options.maxBytes, this.#maxBytes, 'maxBytes', HARD_LIMITS.maxBytes),
        maxFileBytes: limit(options.maxFileBytes, this.#maxFileBytes, 'maxFileBytes', HARD_LIMITS.maxFileBytes),
      }
      const hash = hashOption(options.hash ?? this.#hash)
      const result = scan(realRoot, { ...limits, include, exclude, hash })
      const manifest = {
        schema: SNAPSHOT_SCHEMA,
        id: `bkp_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        root: realRoot, createdAt: Date.now(), hash,
        include, exclude, limits,
        entries: result.entries, counts: result.counts,
      }
      this.#snapshots.set(manifest.id, manifest)
      this.#record({
        at: Date.now(), op: 'snapshot', root: realRoot, fileCount: result.counts.files,
        bytes: result.counts.bytes, durationMs: Date.now() - startedAt, outcome: 'ok',
      })
      return clone(manifest)
    } catch (error) {
      this.#record({
        at: Date.now(), op: 'snapshot', root, outcome: 'error',
        code: error?.code ?? 'E_INTERNAL', durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  /** Newest-first snapshot summaries (without entries). */
  list() {
    return [...this.#snapshots.values()]
      .sort((left, right) => right.createdAt - left.createdAt || compare(left.id, right.id))
      .map(({ entries: _entries, ...summary }) => clone(summary))
  }

  /** Full manifest, or `null` when the id is unknown. */
  get(id) {
    const manifest = this.#snapshots.get(idOf(id))
    return manifest === undefined ? null : clone(manifest)
  }

  /** Newest-first audit events; never contains entry or file-name lists. */
  audit(count = 100) {
    const size = limit(count, 100, 'count', AUDIT_MAX)
    return this.#audits.slice(-size).reverse().map(clone)
  }

  /** Relative-path comparison of two manifests; read-only. */
  diff(idA, idB) {
    const left = this.#require(idA)
    const right = this.#require(idB)
    const before = indexEntries(left.entries)
    const after = indexEntries(right.entries)
    const added = []
    const removed = []
    const changed = []
    const changes = []
    for (const [rel, entry] of after) {
      const previous = before.get(rel)
      if (previous === undefined) { added.push(rel); continue }
      const fields = changesBetween(previous, entry)
      if (fields.length === 0) continue
      changed.push(rel)
      changes.push({
        path: rel,
        fields,
        from: Object.fromEntries(fields.map(field => [field, previous[field] ?? null])),
        to: Object.fromEntries(fields.map(field => [field, entry[field] ?? null])),
      })
    }
    for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel)
    added.sort(compare)
    removed.sort(compare)
    changed.sort(compare)
    changes.sort((one, other) => compare(one.path, other.path))
    return {
      schema: DIFF_SCHEMA, idA: left.id, idB: right.id, roots: { a: left.root, b: right.root },
      counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged: after.size - added.length - changed.length },
      added, removed, changed, changes,
    }
  }

  /** What a restore from `id` into an allowed `target` would add, overwrite or delete. */
  planRestore(id, options = {}) {
    const manifest = this.#require(id)
    if (!plainObject(options)) throw fail('E_INVALID_ARGUMENT', 'plan options must be an object')
    const target = absolute(options.target, 'target')
    const realTarget = this.#guard(canonicalLoose(target, 'target'), 'target')
    let stats
    try { stats = statSync(realTarget, { throwIfNoEntry: false }) } catch (error) {
      throw fail('E_UNAVAILABLE', `cannot stat target ${realTarget}: ${error.message}`)
    }
    if (stats && !stats.isDirectory()) throw fail('E_INVALID_ARGUMENT', `target must be a directory: ${realTarget}`)
    const current = stats
      ? indexEntries(scan(realTarget, {
        include: manifest.include, exclude: manifest.exclude, hash: manifest.hash,
        ...manifest.limits,
      }).entries)
      : new Map()
    const source = indexEntries(manifest.entries)
    const symlinkDirs = [...current.values()].filter(entry => entry.type === 'symlink').map(entry => `${entry.rel}/`)
    if (symlinkDirs.some(prefix => [...source.keys()].some(rel => rel.startsWith(prefix)))) {
      throw fail('E_OUTSIDE_ROOT', 'target contains a symlink in the path of a restore entry')
    }
    const add = []
    const overwrite = []
    let unchanged = 0
    for (const [rel, entry] of source) {
      const existing = current.get(rel)
      if (existing === undefined) add.push(join(realTarget, rel))
      else if (changesBetween(existing, entry).length > 0) overwrite.push(join(realTarget, rel))
      else unchanged += 1
    }
    const remove = [...current.keys()].filter(rel => !source.has(rel)).map(rel => join(realTarget, rel))
    add.sort(compare)
    overwrite.sort(compare)
    remove.sort(compare)
    return {
      schema: PLAN_SCHEMA, id: manifest.id, source: manifest.root, target: realTarget, createdAt: Date.now(), execute: false,
      counts: { add: add.length, overwrite: overwrite.length, delete: remove.length, unchanged },
      add, overwrite, delete: remove,
    }
  }

  /** Remove a manifest from the ledger; returns whether it existed. */
  forget(id) {
    return this.#snapshots.delete(idOf(id))
  }

  #record(entry) {
    this.#audits.push(entry)
    if (this.#audits.length > AUDIT_MAX) this.#audits.shift()
  }

  #guard(path, field) {
    if (isForbidden(path)) {
      throw fail('E_FORBIDDEN_ROOT', `${field} must not be the filesystem root or the home directory`)
    }
    const allowed = this.#allowedRoots.some(root => {
      let base = root
      try { base = realpathSync(root) } catch { /* keep the configured path */ }
      if (base !== root || isForbidden(base)) return false
      return inside(path, base)
    })
    if (!allowed) throw fail('E_OUTSIDE_ROOT', `${field} is outside allowedRoots: ${path}`)
    return path
  }

  #require(id) {
    const manifest = this.#snapshots.get(idOf(id))
    if (manifest === undefined) throw fail('E_NOT_FOUND', `no snapshot ${id}`)
    return manifest
  }
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const objectSchema = (properties, required = []) =>
  ({ type: 'object', additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) })
const tool = (toolName, description, parameters, execute) =>
  ({ name: toolName, description, parameters, output: TOOL_OUTPUT, async execute(args) { return execute(args ?? {}) } })

/** Plain-object ToolDefinitions; no @deepseek-ai/dsh-tools dependency. */
export function makeTools(service) {
  return [
    tool('backup_snapshot',
      'Record a read-only metadata manifest of a directory inside the configured allowedRoots. Sensitive paths are excluded and hard limits fail closed. Never copies, moves or deletes files.',
      objectSchema({
        root: { type: 'string', description: 'Absolute directory path inside allowedRoots; no ".." segments.' },
        include: { type: 'array', items: { type: 'string' }, description: 'Optional relative globs to include.' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Optional relative globs to prune (adds to sensitive defaults).' },
      }, ['root']),
      args => service.snapshot(args)),
    tool('backup_diff',
      'Compare two snapshot manifests by relative path: added, removed and changed files. Read-only.',
      objectSchema({ idA: { type: 'string' }, idB: { type: 'string' } }, ['idA', 'idB']),
      args => service.diff(args.idA, args.idB)),
    tool('backup_plan_restore',
      'List the paths a restore into an allowed target would add, overwrite or delete. Does not create, write or delete anything.',
      objectSchema({
        id: { type: 'string' },
        target: { type: 'string', description: 'Absolute target directory inside allowedRoots; no ".." segments.' },
      }, ['id', 'target']),
      args => service.planRestore(args.id, { target: args.target })),
  ]
}

/** Mount `ctx.backup` and the three backup_* agent tools. */
export function apply(ctx, config = {}) {
  const service = new BackupService(config)
  ctx.provide('backup', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const definition of makeTools(service)) ctx.tools.register(definition)
  }
  return service
}
