/**
 * Optional idempotency journal for `os_do`.
 *
 * Only the request fingerprint and the finished OsResult are stored — never
 * the capability args. The file is read once at mount and rewritten atomically
 * after every successful keyed execution, so a restarted kernel can return the
 * original result for the same capability + key.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const STATE_VERSION = 1
/** Bound the journal so a busy session cannot grow it without limit. */
export const MAX_ENTRIES = 500

const isEntry = entry => entry !== null && typeof entry === 'object'
  && typeof entry.argsHash === 'string'
  && entry.result !== null && typeof entry.result === 'object'

/**
 * Open a journal at `stateFile`, or return null when the option is absent.
 * @param {string|undefined|null} stateFile
 * @returns {{file: string, get: Function, set: Function, size: Function}|null}
 */
export function createStateStore(stateFile) {
  if (stateFile === undefined || stateFile === null) return null
  if (typeof stateFile !== 'string' || stateFile.trim() === '') {
    throw new TypeError('config.stateFile must be a non-empty path string')
  }
  const file = resolve(stateFile)
  const entries = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || raw.version !== STATE_VERSION
      || raw.entries === null || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
      throw new Error('unsupported state file shape')
    }
    for (const [key, entry] of Object.entries(raw.entries)) {
      if (!isEntry(entry)) continue
      entries.set(key, { argsHash: entry.argsHash, result: entry.result, at: Number(entry.at) || 0 })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`cannot read kernel state file ${file}: ${error.message}`)
  }

  function persist() {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: STATE_VERSION, entries: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }

  return {
    file,
    get: key => entries.get(key),
    set(key, entry) {
      const stored = { argsHash: entry.argsHash, result: entry.result, at: Date.now() }
      entries.set(key, stored)
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
      persist()
      return stored
    },
    size: () => entries.size,
  }
}
