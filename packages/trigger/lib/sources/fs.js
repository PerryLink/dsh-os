/** Filesystem source: `fs.watch` invalidation signal + non-recursive snapshot diff. */
import { join } from 'node:path'
import { createDedupe, fail } from './shared.js'

const childPath = (dir, name) => join(dir, name)
const identity = info => `${info.size ?? ''}:${info.version}`

/** Direct children of a directory, or the single watched target, keyed by path. */
async function snapshot(fs, target, displayPath) {
  const info = await fs.stat(target)
  if (info === undefined || info === null) return new Map()
  if (info.type !== 'directory') return new Map([[displayPath, identity(info)]])
  const entries = await fs.listDir(target)
  const map = new Map()
  for (const entry of entries) map.set(childPath(displayPath, entry.name), identity(entry))
  return map
}

/** Classify a previous/next snapshot pair into add, change and unlink events. */
function diff(previous, next) {
  const changes = []
  for (const [path, key] of next) {
    const before = previous.get(path)
    if (before === undefined) changes.push({ path, kind: 'add', key })
    else if (before !== key) changes.push({ path, kind: 'change', key })
  }
  for (const path of previous.keys()) if (!next.has(path)) changes.push({ path, kind: 'unlink', key: '' })
  return changes
}

export function createFsSource(ctx, opts, emit) {
  const fs = typeof ctx.get === 'function' ? ctx.get('fs') : ctx.fs
  if (fs === undefined || fs === null || typeof fs.watch !== 'function') {
    throw fail('E_UNAVAILABLE', 'fs source needs ctx.fs with watch()')
  }
  if (typeof opts.path !== 'string' || opts.path === '') throw fail('invalid_source', 'fs source requires a non-empty path')
  const debounceMs = Number.isSafeInteger(opts.debounceMs) && opts.debounceMs >= 0 ? opts.debounceMs : 300
  const seen = createDedupe(opts.dedupeLimit)
  const stats = { emitted: 0, skipped: 0, errors: 0 }
  const controller = new AbortController()
  const lifecycle = { running: false, target: null, displayPath: null, previous: new Map(), close: null, timer: null }

  async function flush() {
    if (!lifecycle.running) return
    const next = await snapshot(fs, lifecycle.target, lifecycle.displayPath)
    if (!lifecycle.running) return
    const previous = lifecycle.previous
    lifecycle.previous = next
    for (const change of diff(previous, next)) {
      if (!seen.add(`${change.path}|${change.kind}|${change.key}`)) {
        stats.skipped += 1
        continue
      }
      stats.emitted += 1
      emit({ type: 'fs.change', path: change.path, kind: change.kind })
    }
  }

  const changed = error => {
    if (error !== undefined) stats.errors += 1
    if (!lifecycle.running) return
    clearTimeout(lifecycle.timer)
    lifecycle.timer = setTimeout(() => {
      lifecycle.timer = null
      flush().catch(() => {
        stats.errors += 1
      })
    }, debounceMs)
    lifecycle.timer.unref?.()
  }

  return {
    async start() {
      if (lifecycle.running) return
      lifecycle.target = await fs.resolve(opts.path, opts.cwd === undefined ? undefined : { cwd: opts.cwd })
      lifecycle.displayPath = lifecycle.target.displayPath ?? opts.path
      lifecycle.previous = await snapshot(fs, lifecycle.target, lifecycle.displayPath)
      try {
        lifecycle.close = await fs.watch(lifecycle.target, changed, controller.signal)
      } catch (error) {
        throw fail('E_UNAVAILABLE', `fs source cannot watch ${lifecycle.displayPath}: ${String(error?.message ?? error)}`)
      }
      lifecycle.running = true
      // Close the race between the baseline snapshot and an active watcher.
      await flush()
    },
    async stop() {
      lifecycle.running = false
      clearTimeout(lifecycle.timer)
      lifecycle.timer = null
      controller.abort()
      const close = lifecycle.close
      lifecycle.close = null
      if (close !== null) await close()
    },
    describe: () => ({ path: lifecycle.displayPath ?? opts.path, recursive: false, debounceMs, ...stats }),
  }
}
