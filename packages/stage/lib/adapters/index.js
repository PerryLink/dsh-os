/**
 * Adapter registry. `mock` is the default so a fresh mount never spawns an OS
 * process; native adapters exist but only become usable after an explicit
 * `useAdapter()` (or a configured `adapter`) has armed them.
 */
import { StageAdapterError } from './base.js'
import { MacAdapter } from './macos.js'
import { MockAdapter } from './mock.js'
import { WindowsAdapter } from './windows.js'

export { StageAdapterError } from './base.js'

export const ADAPTER_NAMES = Object.freeze(['mock', 'macos', 'windows'])

const ALIASES = Object.freeze({
  mock: 'mock',
  macos: 'macos',
  darwin: 'macos',
  mac: 'macos',
  windows: 'windows',
  win32: 'windows',
  win: 'windows',
})

/** Canonicalize a user-facing adapter name; unknown names are unavailable. */
export function adapterName(name) {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const canonical = ALIASES[key]
  if (canonical === undefined) {
    throw new StageAdapterError('E_UNAVAILABLE', `unknown adapter "${String(name)}"`, { reason: 'unknown_adapter' })
  }
  return canonical
}

/** Build one adapter; the default is the in-memory mock. */
export function createAdapter(name = 'mock', options = {}) {
  if (name !== null && typeof name === 'object') {
    options = name
    name = options.name ?? (options.platform === 'darwin' ? 'macos' : options.platform === 'win32' ? 'windows' : 'mock')
  }
  if (name === 'auto') {
    name = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'mock'
  }
  const canonical = adapterName(name)
  const adapter = canonical === 'macos'
    ? new MacAdapter(options)
    : canonical === 'windows' ? new WindowsAdapter(options) : new MockAdapter(options)
  adapter.name = canonical
  return adapter
}

/** List every adapter with its availability and declared capabilities. */
export function listAdapters(options = {}) {
  return ADAPTER_NAMES.map(name => {
    const adapter = createAdapter(name, options)
    return {
      name,
      platform: adapter.platform,
      available: adapter.available(),
      capabilities: adapter.capabilities(),
    }
  })
}
