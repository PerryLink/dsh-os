/**
 * @perrylink/dsh-backup — read-only snapshot manifests and restore plans.
 *
 * 0.1.0 records filesystem metadata and compares manifests. It never copies,
 * moves, deletes or writes a file, and it never touches the restore target.
 * Executing a plan is scoped for 0.2.0.
 * @module @perrylink/dsh-backup
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
export const name = '@perrylink/dsh-backup'
export const inject = ['tools']
export const SNAPSHOT_SCHEMA = 'dsh.backup.snapshot/v1'
export const DIFF_SCHEMA = 'dsh.backup.diff/v1'
export const PLAN_SCHEMA = 'dsh.backup.plan/v1'
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const HASH = 'sha256'
const CHUNK = 1024 * 1024
const COMPARED = ['type', 'size', 'mtimeMs', 'mode', 'hash', 'target']
const clone = value => structuredClone(value)
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const fail = (code, message) => Object.assign(new Error(message), { code })
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function absolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('E_INVALID_ARGUMENT', `${field} must be a non-empty string`)
  if (value.includes('\0')) throw fail('E_INVALID_ARGUMENT', `${field} must not contain NUL`)
  if (!isAbsolute(value)) throw fail('E_INVALID_ARGUMENT', `${field} must be absolute: ${JSON.stringify(value)}`)
  if (value.split(/[\\/]/).includes('..')) throw fail('E_INVALID_ARGUMENT', `${field} must not contain "..": ${JSON.stringify(value)}`)
  return resolvePath(value)
}
function limit(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw fail('E_INVALID_ARGUMENT', `${field} must be a positive integer`)
  return value
}
function hashOption(value) {
  if (value === undefined || value === null || value === false) return null
  if (value !== HASH) throw fail('E_INVALID_ARGUMENT', 'hash must be "sha256" or omitted')
  return HASH
}
function idOf(value) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('E_INVALID_ARGUMENT', 'id must be a non-empty string')
  return value
}

/** Relative glob patterns only: absolute patterns and `..` are rejected. */
function patternList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('E_INVALID_ARGUMENT', `${field} must be an array`)
  return value.map(item => {
    if (typeof item !== 'string' || item.trim() === '' || item.includes('\0')) {
      throw fail('E_INVALID_ARGUMENT', `${field} must contain non-empty strings`)
    }
    const pattern = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern === '' || /^(\/|[A-Za-z]:)/.test(pattern) || pattern.split('/').includes('..')) {
      throw fail('E_INVALID_ARGUMENT', `${field} must stay inside root: ${JSON.stringify(item)}`)
    }
    return pattern
  })
}
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] !== '*') source += '[^/]*'
      else {
        index += 1
        if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?' } else source += '.*'
      }
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
/** A literal pattern also matches everything underneath it. */
function matcher(pattern) {
  if (!/[*?]/.test(pattern)) return rel => rel === pattern || rel.startsWith(`${pattern}/`)
  const regexp = globToRegExp(pattern)
  return rel => regexp.test(rel)
}
const anyMatch = (matchers, rel) => matchers.some(matches => matches(rel))
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

/** In-memory snapshot ledger exposed as `ctx.backup`. */
export class BackupService {
  #snapshots = new Map()
  #maxFiles
  #maxBytes
  #hash
  constructor(config = {}) {
    this.#maxFiles = limit(config.maxFiles, DEFAULT_MAX_FILES, 'maxFiles')
    this.#maxBytes = limit(config.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes')
    this.#hash = hashOption(config.hash)
  }

  /** Record a manifest for `root`; returns it. Writes nothing to disk. */
  snapshot(options = {}) {
    if (!plainObject(options)) throw fail('E_INVALID_ARGUMENT', 'snapshot options must be an object')
    const root = absolute(options.root, 'root')
    statDirectory(root, 'root')
    const manifest = {
      schema: SNAPSHOT_SCHEMA,
      id: `bkp_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      root, createdAt: Date.now(), hash: hashOption(options.hash ?? this.#hash),
      include: patternList(options.include, 'include'),
      exclude: patternList(options.exclude, 'exclude'),
      limits: { maxFiles: limit(options.maxFiles, this.#maxFiles, 'maxFiles'), maxBytes: limit(options.maxBytes, this.#maxBytes, 'maxBytes') },
      entries: [], counts: null,
    }
    const result = scan(root, { ...manifest.limits, include: manifest.include, exclude: manifest.exclude, hash: manifest.hash })
    manifest.entries = result.entries
    manifest.counts = result.counts
    this.#snapshots.set(manifest.id, manifest)
    return clone(manifest)
  }

  /** Summaries (without entries), newest first. */
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

  /** What a 0.2.0 restore from `id` into `target` would add, overwrite or delete. */
  planRestore(id, options = {}) {
    const manifest = this.#require(id)
    if (!plainObject(options)) throw fail('E_INVALID_ARGUMENT', 'plan options must be an object')
    const target = absolute(options.target, 'target')
    let stats
    try { stats = statSync(target, { throwIfNoEntry: false }) } catch (error) {
      throw fail('E_UNAVAILABLE', `cannot stat target ${target}: ${error.message}`)
    }
    if (stats && !stats.isDirectory()) throw fail('E_INVALID_ARGUMENT', `target must be a directory: ${target}`)
    const current = stats
      ? indexEntries(scan(target, {
        include: manifest.include, exclude: manifest.exclude,
        maxFiles: this.#maxFiles, maxBytes: this.#maxBytes, hash: manifest.hash,
      }).entries)
      : new Map()
    const source = indexEntries(manifest.entries)
    const add = []
    const overwrite = []
    let unchanged = 0
    for (const [rel, entry] of source) {
      const existing = current.get(rel)
      if (existing === undefined) add.push(join(target, rel))
      else if (changesBetween(existing, entry).length > 0) overwrite.push(join(target, rel))
      else unchanged += 1
    }
    const remove = [...current.keys()].filter(rel => !source.has(rel)).map(rel => join(target, rel))
    add.sort(compare)
    overwrite.sort(compare)
    remove.sort(compare)
    return {
      schema: PLAN_SCHEMA, id: manifest.id, source: manifest.root, target, createdAt: Date.now(), execute: false,
      counts: { add: add.length, overwrite: overwrite.length, delete: remove.length, unchanged },
      add, overwrite, delete: remove,
    }
  }

  /** Remove a manifest from the ledger; returns whether it existed. */
  forget(id) {
    return this.#snapshots.delete(idOf(id))
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
      'Record a read-only metadata manifest of an absolute directory. Never copies, moves or deletes files.',
      objectSchema({
        root: { type: 'string', description: 'Absolute directory path; no ".." segments.' },
        include: { type: 'array', items: { type: 'string' }, description: 'Optional relative globs to include.' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Optional relative globs to prune.' },
      }, ['root']),
      args => service.snapshot(args)),
    tool('backup_diff',
      'Compare two snapshot manifests by relative path: added, removed and changed files. Read-only.',
      objectSchema({ idA: { type: 'string' }, idB: { type: 'string' } }, ['idA', 'idB']),
      args => service.diff(args.idA, args.idB)),
    tool('backup_plan_restore',
      'List the paths a restore into target would add, overwrite or delete. Does not create, write or delete anything.',
      objectSchema({
        id: { type: 'string' },
        target: { type: 'string', description: 'Absolute target directory; no ".." segments.' },
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
