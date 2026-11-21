/**
 * Filesystem actions for dsh-act 0.3.0: `fs.read` / `fs.write` / `fs.list` /
 * `fs.undo`. Paths are absolute and confined to the workdir allowlist; writes
 * are atomic; previews never touch disk; undo tokens are single use.
 * @module dsh-act/fs-actions
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_READ = 256 * 1024, DEFAULT_MAX_WRITE = 1024 * 1024
const MAX_UNDO_BYTES = 1024 * 1024, MAX_UNDO_ENTRIES = 16, UNDO_TTL_MS = 5 * 60 * 1000
const DEFAULT_LIST_LIMIT = 200, MAX_LIST_LIMIT = 1000, MAX_DIFF_CHARS = 16 * 1024

const fail = (code, message) => Object.assign(new Error(message), { code })
const digest = data => createHash('sha256').update(data).digest('hex')
const exact = (args, keys) => { for (const key of Object.keys(args ?? {})) if (!keys.includes(key)) throw fail('E_INVALID_ARGUMENT', `unknown argument: ${key}`) }
const schema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, ...(required === undefined ? {} : { required }) })

/** True when `target` is `root` or below it (platform-aware separators/case). */
const inside = (root, target) => {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Realpath, or the realpath of the deepest existing parent plus the remainder. */
function realOrParent(path) {
  try { return realpathSync(path) }
  catch (error) {
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(realOrParent(parent), basename(path))
  }
}

/**
 * Resolve an absolute path, reject `..`, canonicalize symlinks, and require the
 * canonical target (or its deepest existing parent for writes) to stay in `root`.
 */
function canonical(root, input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw fail('E_PATH', 'path must be a non-empty string')
  if (input.includes('\0')) throw fail('E_PATH', 'path must not contain NUL')
  if (!isAbsolute(input)) throw fail('E_PATH', `path must be absolute: ${JSON.stringify(input)}`)
  if (input.split(/[\\/]+/).includes('..')) throw fail('E_PATH', `path must not contain "..": ${JSON.stringify(input)}`)
  let target
  try {
    target = mustExist ? realpathSync(resolve(input)) : realOrParent(resolve(input))
  } catch {
    throw fail('E_PATH', `path does not exist: ${JSON.stringify(input)}`)
  }
  if (!inside(root, target)) throw fail('E_PATH_OUTSIDE', `path escapes the workdir allowlist: ${JSON.stringify(input)}`)
  return target
}

/** Write through a sibling temp file and rename, so readers never see a half file. */
function atomicWrite(target, data) {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, data, { flag: 'wx' })
    renameSync(temp, target)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

/** Compact line diff with a hard output cap. */
function diffText(path, before, after, existed = true) {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tailA = a.length
  let tailB = b.length
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1
    tailB -= 1
  }
  const lines = [
    `--- ${existed ? path : '/dev/null'}`,
    `+++ ${path}`,
    `@@ -${head + 1},${tailA - head} +${head + 1},${tailB - head} @@`,
  ]
  for (const line of a.slice(head, tailA)) lines.push(`-${line}`)
  for (const line of b.slice(head, tailB)) lines.push(`+${line}`)
  const diff = lines.join('\n')
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff
}

/** Bounded in-memory undo ledger: 16 entries, 1 MiB each, 5 minutes, single use. */
class UndoStore {
  #entries = new Map()

  issue(record) {
    if (record.bytes === null && record.existed) return null
    if (record.bytes !== null && record.bytes.length > MAX_UNDO_BYTES) return null
    while (this.#entries.size >= MAX_UNDO_ENTRIES) this.#entries.delete(this.#entries.keys().next().value)
    const token = randomUUID()
    this.#entries.set(token, { ...record, expiresAt: Date.now() + UNDO_TTL_MS })
    return token
  }

  get(token) {
    const entry = this.#entries.get(token)
    if (entry === undefined) return undefined
    if (entry.expiresAt > Date.now()) return entry
    this.#entries.delete(token)
  }

  drop(token) { this.#entries.delete(token) }
}

/** Canonical workdir allowlist root: config `workdir` or `process.cwd()`. */
export function filesystem(config) {
  const input = typeof config?.workdir === 'string' && config.workdir.trim() !== '' ? config.workdir : process.cwd()
  const root = realpathSync(resolve(input))
  if (!statSync(root).isDirectory()) throw fail('E_WORKDIR', 'workdir must be a directory')
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback)
  return {
    root,
    maxReadBytes: positive(config?.maxReadBytes, DEFAULT_MAX_READ),
    maxWriteBytes: positive(config?.maxWriteBytes, DEFAULT_MAX_WRITE),
    undo: new UndoStore(),
  }
}

/**
 * Build and validate a write plan without touching the target. `before.bytes` is
 * null when the file is new or too large to retain for undo/preview.
 */
function planWrite(fs, args) {
  exact(args, ['path', 'text', 'create'])
  if (typeof args?.text !== 'string') throw fail('E_INVALID_ARGUMENT', 'text must be a string')
  if (args?.create !== undefined && typeof args.create !== 'boolean') throw fail('E_INVALID_ARGUMENT', 'create must be a boolean')
  const data = Buffer.from(args.text, 'utf8')
  if (data.length > fs.maxWriteBytes) throw fail('E_TOO_LARGE', `text exceeds the ${fs.maxWriteBytes}-byte write cap`)
  const target = canonical(fs.root, args?.path, { mustExist: false })
  let before = { exists: false, bytes: null, size: 0 }
  try {
    const stat = lstatSync(target)
    if (!stat.isFile()) throw fail('E_NOT_FILE', `not a regular file: ${target}`)
    before = { exists: true, bytes: stat.size > MAX_UNDO_BYTES ? null : readFileSync(target), size: stat.size }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (args?.create === false) throw fail('E_NOT_FOUND', `file does not exist: ${target}`)
  }
  return { target, data, before }
}

/** The filesystem action descriptors, sharing one workdir/undo context. */
export function fsActions(fs) {
  return [
    {
      id: 'fs.read', title: 'Read a file', risk: 'read',
      description: 'Read UTF-8 text from an absolute path inside the workdir. '
        + 'The read cap is 256 KiB by default and can only be lowered per call.',
      parameters: schema({
        path: { type: 'string', description: 'Absolute path inside the workdir.' },
        maxBytes: { type: 'integer', minimum: 1, description: 'Per-call read cap.' },
      }, ['path']),
      execute(args) {
        exact(args, ['path', 'maxBytes'])
        if (args?.maxBytes !== undefined && (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1)) {
          throw fail('E_INVALID_ARGUMENT', 'maxBytes must be a positive integer')
        }
        const target = canonical(fs.root, args?.path, { mustExist: true })
        const stat = lstatSync(target)
        if (!stat.isFile()) throw fail('E_NOT_FILE', `not a regular file: ${target}`)
        const limit = Math.min(args?.maxBytes ?? fs.maxReadBytes, fs.maxReadBytes, Math.max(stat.size, 0))
        const fd = openSync(target, 'r')
        const buffer = Buffer.alloc(limit)
        let read = 0
        try {
          while (read < limit) {
            const count = readSync(fd, buffer, read, limit - read, read)
            if (count === 0) break
            read += count
          }
        } finally { closeSync(fd) }
        return { path: target, size: stat.size, text: buffer.subarray(0, read).toString('utf8') }
      },
    },
    {
      id: 'fs.write', title: 'Write a file', risk: 'write',
      description: 'Write UTF-8 text inside the workdir atomically. '
        + 'Requires capability act:invoke:fs.write; supports meta.preview and returns an undoToken.',
      parameters: schema({
        path: { type: 'string', description: 'Absolute path inside the workdir.' },
        text: { type: 'string', description: 'Full UTF-8 content to write.' },
        create: { type: 'boolean', description: 'When false, an existing file is required.' },
      }, ['path', 'text']),
      preview(args) {
        const plan = planWrite(fs, args)
        const before = plan.before.bytes === null ? '' : plan.before.bytes.toString('utf8')
        const diff = plan.before.exists && plan.before.bytes === null
          ? `(existing file is ${plan.before.size} bytes; too large to diff, undo unavailable)`
          : diffText(plan.target, before, args.text, plan.before.exists)
        return { path: plan.target, bytes: plan.data.length, diff }
      },
      execute(args) {
        const plan = planWrite(fs, args)
        atomicWrite(plan.target, plan.data)
        const undoToken = fs.undo.issue({
          path: plan.target,
          existed: plan.before.exists,
          bytes: plan.before.bytes,
          afterHash: digest(plan.data),
        })
        if (undoToken !== null) return { path: plan.target, bytes: plan.data.length, undoToken }
        return { path: plan.target, bytes: plan.data.length, undoToken, undoable: false, reason: 'undo_limit' }
      },
    },
    {
      id: 'fs.list', title: 'List a directory', risk: 'read',
      description: 'List directory entries inside the workdir; symlinks are reported, not followed.',
      parameters: schema({
        path: { type: 'string', description: 'Absolute directory path inside the workdir.' },
        recursive: { type: 'boolean', description: 'Descend into real subdirectories.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum entries (default 200, max 1000).' },
      }, ['path']),
      execute(args) {
        exact(args, ['path', 'recursive', 'limit'])
        if (args?.recursive !== undefined && typeof args.recursive !== 'boolean') throw fail('E_INVALID_ARGUMENT', 'recursive must be a boolean')
        const limit = args?.limit === undefined ? DEFAULT_LIST_LIMIT : args.limit
        if (!Number.isSafeInteger(limit) || limit < 1) throw fail('E_INVALID_ARGUMENT', 'limit must be a positive integer')
        const cap = Math.min(limit, MAX_LIST_LIMIT)
        const root = canonical(fs.root, args?.path, { mustExist: true })
        if (!lstatSync(root).isDirectory()) throw fail('E_NOT_DIR', `not a directory: ${root}`)
        const entries = []
        const queue = [root]
        while (queue.length > 0 && entries.length < cap) {
          const dir = queue.shift()
          const names = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
          for (const dirent of names) {
            if (entries.length >= cap) break
            const path = join(dir, dirent.name)
            let stat
            try { stat = lstatSync(path) } catch { continue }
            const type = stat.isDirectory() ? 'directory'
              : stat.isFile() ? 'file'
                : stat.isSymbolicLink() ? 'symlink' : 'other'
            entries.push({ path, type, size: stat.size })
            if (args?.recursive === true && type === 'directory') queue.push(path)
          }
        }
        return { entries }
      },
    },
    {
      id: 'fs.undo', title: 'Undo a write', risk: 'write',
      description: 'Restore the content before an fs.write, or delete a file that fs.write created. '
        + 'The undoToken is single use and expires after 5 minutes.',
      // The single-use token minted by an authorized fs.write is the capability;
      // requiring a second grant would deadlock recovery.
      authorize: false,
      parameters: schema({
        undoToken: { type: 'string', description: 'Token returned by fs.write.' },
      }, ['undoToken']),
      execute(args) {
        exact(args, ['undoToken'])
        if (typeof args?.undoToken !== 'string' || args.undoToken === '') throw fail('E_INVALID_ARGUMENT', 'undoToken must be a non-empty string')
        const entry = fs.undo.get(args.undoToken)
        if (entry === undefined) throw fail('E_UNDO_TOKEN', 'unknown or expired undo token')
        const target = canonical(fs.root, entry.path, { mustExist: true })
        if (target !== entry.path) throw fail('E_UNDO_STALE', 'undo target changed since the write')
        if (!lstatSync(target).isFile()) throw fail('E_UNDO_STALE', 'undo target is no longer a regular file')
        if (digest(readFileSync(target)) !== entry.afterHash) {
          throw fail('E_UNDO_STALE', 'file changed after the write; refusing to overwrite')
        }
        if (entry.existed) atomicWrite(target, entry.bytes)
        else rmSync(target)
        fs.undo.drop(args.undoToken)
        return { path: target, restored: entry.existed, bytes: entry.bytes === null ? 0 : entry.bytes.length }
      },
    },
  ]
}
