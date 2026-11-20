/**
 * In-memory adapter for tests and unsupported platforms.
 *
 * It never spawns anything and never touches the desktop. The fixture is
 * deliberately multi-display (one negative-origin screen with 1.5x scale) so
 * layout code is exercised on coordinates it will meet on real hosts.
 */
import { asRect, displayForRect, sameRect, sameSize } from './base.js'

const displays = () => [
  {
    id: 'mock:display:0',
    bounds: { x: 0, y: 0, w: 1600, h: 1000 },
    workArea: { x: 0, y: 25, w: 1600, h: 950 },
    dpi: 96,
    scale: 1,
    primary: true,
  },
  {
    id: 'mock:display:1',
    bounds: { x: 1600, y: -200, w: 1200, h: 1920 },
    workArea: { x: 1600, y: -200, w: 1200, h: 1920 },
    dpi: 144,
    scale: 1.5,
    primary: false,
  },
]

const windows = () => [
  {
    id: 'mock:100:0',
    pid: 100,
    app: 'Editor',
    displayId: 'mock:display:0',
    bounds: { x: 40, y: 40, w: 800, h: 600 },
    focused: true,
    minimized: false,
    fullscreen: false,
    spanning: false,
  },
  {
    id: 'mock:101:0',
    pid: 101,
    app: 'Browser',
    displayId: 'mock:display:0',
    bounds: { x: 860, y: 40, w: 700, h: 600 },
    focused: false,
    minimized: false,
    fullscreen: false,
    spanning: false,
  },
  {
    id: 'mock:102:0',
    pid: 102,
    app: 'Chat',
    displayId: 'mock:display:1',
    bounds: { x: 1700, y: 0, w: 500, h: 900 },
    focused: false,
    minimized: false,
    fullscreen: false,
    spanning: false,
  },
]

const clone = value => structuredClone(value)

export const available = () => true

export class MockAdapter {
  constructor(options = {}) {
    this.platform = 'mock'
    this._displays = options.displays ?? displays()
    this._windows = options.windows ?? windows()
    this._observed = new Set()
    this._platform = options.platform ?? 'mock'
  }

  available() {
    return true
  }

  capabilities() {
    return {
      displays: true, windows: true, move: true, resize: true,
      focus: true, spaces: false, permission: 'none',
    }
  }

  async displays() {
    return clone(this._displays)
  }

  async windows(options = {}) {
    const list = this._windows
      .filter(window => options.displayId === undefined || window.displayId === options.displayId)
      .map(window => clone(window))
    this._observed = new Set(list.map(window => window.id))
    return list
  }

  _find(id) {
    if (typeof id !== 'string' || !/^mock:\d+:\d+$/.test(id)) {
      return { error: { ok: false, id, code: 'E_DENIED', reason: 'invalid_id' } }
    }
    const window = this._windows.find(item => item.id === id)
    if (window === undefined) {
      return { error: { ok: false, id, code: 'E_UNAVAILABLE', reason: 'window_gone' } }
    }
    if (!this._observed.has(id)) {
      return { error: { ok: false, id, code: 'E_DENIED', reason: 'unobserved_window' } }
    }
    return { window }
  }

  async move(id, rect) {
    const found = this._find(id)
    if (found.error) return found.error
    let target
    try {
      target = asRect(rect, 'E_DENIED')
    } catch (error) {
      return { ok: false, id, code: error.code, reason: error.reason }
    }
    const before = clone(found.window.bounds)
    found.window.bounds = target
    found.window.displayId = displayForRect(target, this._displays).displayId
    return { ok: true, id, before, after: clone(target), verified: sameRect(target, found.window.bounds) }
  }

  async resize(id, size) {
    const found = this._find(id)
    if (found.error) return found.error
    if (!Number.isFinite(size?.w) || !Number.isFinite(size?.h) || size.w <= 0 || size.h <= 0) {
      return { ok: false, id, code: 'E_DENIED', reason: 'invalid_size' }
    }
    const before = clone(found.window.bounds)
    const after = { ...before, w: size.w, h: size.h }
    found.window.bounds = after
    return { ok: true, id, before, after: clone(after), verified: sameSize(after, size) }
  }

  async focus(id) {
    const found = this._find(id)
    if (found.error) return found.error
    for (const window of this._windows) window.focused = window.id === id
    return { ok: true, id }
  }

  async spaces() {
    return []
  }

  async doctor() {
    return { ok: true, platform: 'mock', permission: 'none', warnings: [] }
  }
}
