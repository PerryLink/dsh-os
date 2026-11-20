/**
 * macOS adapter: one fixed JXA program for displays, AX windows and writes.
 *
 * Reads use AppKit's `NSScreen` (no permission) and System Events (AX).
 * Writes use System Events `position`/`size`, which is the documented AX path
 * for 0.2.0; no private APIs, no screen recording and no window titles.
 */
import {
  asRect, displayForRect, expectOk, resolveRunner, runAdapter, sameRect,
  sameSize, StageAdapterError,
} from './base.js'

/** The fixed JXA program. The request arrives as JSON in DSH_STAGE_REQUEST. */
export const JXA_SCRIPT = String.raw`
ObjC.import('AppKit')
try { ObjC.import('ApplicationServices') } catch (error) {}

function env(name) {
  try {
    const value = $.NSProcessInfo.processInfo.environment.objectForKey(name)
    return value && !value.isNil() ? value.js : ''
  } catch (error) { return '' }
}
function reply(value) { return JSON.stringify(value) }
function boundsOf(window) {
  const position = window.position()
  const size = window.size()
  if (!position || !size) return null
  return { x: position[0], y: position[1], w: size[0], h: size[1] }
}
function close(left, right) {
  if (!left || !right) return false
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1 &&
    Math.abs(left.w - right.w) <= 1 && Math.abs(left.h - right.h) <= 1
}
function attribute(window, name) {
  try { return window.attributes.byName(name).value() } catch (error) { return null }
}

function run() {
  let request
  try { request = JSON.parse(env('DSH_STAGE_REQUEST') || '{}') } catch (error) {
    return reply({ ok: false, code: 'E_UNAVAILABLE', reason: 'bad_request' })
  }
  try {
    if (request.op === 'trusted') {
      let trusted = false
      try { trusted = Boolean($.AXIsProcessTrusted()) } catch (error) {}
      return reply({ ok: true, trusted: trusted })
    }
    if (request.op === 'displays') {
      const screens = $.NSScreen.screens.js
      const rows = []
      for (let index = 0; index < screens.length; index += 1) {
        const screen = screens[index]
        rows.push({
          frame: {
            x: screen.frame.origin.x, y: screen.frame.origin.y,
            w: screen.frame.size.width, h: screen.frame.size.height,
          },
          visibleFrame: {
            x: screen.visibleFrame.origin.x, y: screen.visibleFrame.origin.y,
            w: screen.visibleFrame.size.width, h: screen.visibleFrame.size.height,
          },
          scale: screen.backingScaleFactor,
        })
      }
      return reply({ ok: true, primaryHeight: screens[0].frame.size.height, screens: rows })
    }

    const se = Application('System Events')
    if (request.op === 'windows') {
      const rows = []
      const processes = se.applicationProcesses.whose({ backgroundOnly: false })()
      for (let p = 0; p < processes.length; p += 1) {
        const process = processes[p]
        let pid = 0
        let app = ''
        let frontmost = false
        let list = []
        try { pid = process.unixId() } catch (error) { continue }
        try { app = String(process.name()) } catch (error) { app = '' }
        try { frontmost = Boolean(process.frontmost()) } catch (error) { frontmost = false }
        try { list = process.windows() } catch (error) { continue }
        let focusedSeen = false
        for (let index = 0; index < list.length; index += 1) {
          const window = list[index]
          const bounds = boundsOf(window)
          if (!bounds) continue
          let focused = false
          if (frontmost) {
            const value = attribute(window, 'AXFocused')
            focused = value === null ? index === 0 : Boolean(value)
          }
          if (focused && focusedSeen) focused = false
          if (focused) focusedSeen = true
          rows.push({
            pid: pid, app: app, index: index, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h,
            focused: focused, minimized: Boolean(attribute(window, 'AXMinimized')),
            fullscreen: Boolean(attribute(window, 'AXFullScreen')),
          })
        }
      }
      return reply({ ok: true, windows: rows })
    }

    if (request.op === 'move' || request.op === 'resize') {
      let trusted = false
      try { trusted = Boolean($.AXIsProcessTrusted()) } catch (error) {}
      if (!trusted) {
        try { trusted = Boolean(se.UIElementsEnabled()) } catch (error) {}
      }
      if (!trusted) return reply({ ok: false, code: 'E_DENIED', reason: 'accessibility' })
      const target = request.target || {}
      const process = se.applicationProcesses.whose({ unixId: target.pid }).at(0)
      const windows = process.windows()
      if (target.index < 0 || target.index >= windows.length) {
        return reply({ ok: false, code: 'E_UNAVAILABLE', reason: 'window_gone' })
      }
      const window = windows[target.index]
      const before = boundsOf(window)
      if (request.expect && !close(before, request.expect)) {
        return reply({ ok: false, code: 'E_UNAVAILABLE', reason: 'stale_window' })
      }
      if (request.op === 'move') {
        window.size.set([request.rect.w, request.rect.h])
        window.position.set([request.rect.x, request.rect.y])
      } else {
        window.size.set([request.size.w, request.size.h])
      }
      return reply({ ok: true, before: before, after: boundsOf(window) })
    }
    return reply({ ok: false, code: 'E_UNAVAILABLE', reason: 'unknown_op' })
  } catch (error) {
    const message = String((error && error.message) || error || '')
    const denied = /-1743|-1719|-25211|not authorized|not allowed|accessibility|assistive|not permitted/i.test(message)
    return reply({
      ok: false, code: denied ? 'E_DENIED' : 'E_UNAVAILABLE',
      reason: denied ? 'permission_denied' : 'jxa_error',
    })
  }
}
`

const MAC_ID = /^mac:(\d+):(\d+)$/

/** `available()` follows the host platform; the constructor can override it for tests. */
export const available = () => process.platform === 'darwin'

/** Convert an NSScreen frame (bottom-left, y up) into AX space (top-left, y down). */
export function axBounds(frame, primaryHeight) {
  return {
    x: Number(frame.x),
    y: primaryHeight - Number(frame.y) - Number(frame.h),
    w: Number(frame.w),
    h: Number(frame.h),
  }
}

function finiteRect(value) {
  return ['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(value?.[key])))
}

/** Parse the raw `displays` payload into normalized display records. */
export function parseDisplays(payload) {
  expectOk(payload)
  const screens = Array.isArray(payload?.screens) ? payload.screens : []
  const primaryHeight = Number(payload?.primaryHeight)
  if (screens.length === 0 || !Number.isFinite(primaryHeight)) {
    throw new StageAdapterError('E_UNAVAILABLE', 'macOS reported no displays', { reason: 'no_displays' })
  }
  return screens.map((screen, index) => {
    if (!finiteRect(screen?.frame) || !finiteRect(screen?.visibleFrame)) {
      throw new StageAdapterError('E_UNAVAILABLE', 'macOS returned an invalid display frame', { reason: 'bad_display' })
    }
    const scale = Number(screen.scale) > 0 ? Number(screen.scale) : 1
    return {
      id: `mac:display:${index}`,
      bounds: axBounds(screen.frame, primaryHeight),
      workArea: axBounds(screen.visibleFrame, primaryHeight),
      dpi: 96 * scale,
      scale,
      primary: index === 0,
    }
  })
}

/** Parse raw AX windows, drop unmanageable ones and attribute each to a display. */
export function parseWindows(payload, displays) {
  expectOk(payload)
  const rows = Array.isArray(payload?.windows) ? payload.windows : []
  const windows = []
  for (const row of rows) {
    if (!Number.isInteger(row?.pid) || !Number.isInteger(row?.index)) continue
    if (!finiteRect(row) || Number(row.w) <= 0 || Number(row.h) <= 0) continue
    if (row.minimized || row.fullscreen) continue
    const bounds = { x: Number(row.x), y: Number(row.y), w: Number(row.w), h: Number(row.h) }
    const { displayId, spanning } = displayForRect(bounds, displays)
    windows.push({
      id: `mac:${row.pid}:${row.index}`, pid: row.pid, displayId, bounds,
      focused: Boolean(row.focused), minimized: false, fullscreen: false,
      app: typeof row.app === 'string' ? row.app : '', spanning,
    })
  }
  let focused = false
  for (const window of windows) {
    if (window.focused && focused) window.focused = false
    if (window.focused) focused = true
  }
  return windows
}

export function parseWindowId(id) {
  const match = typeof id === 'string' ? MAC_ID.exec(id) : null
  return match === null ? null : { id, pid: Number(match[1]), index: Number(match[2]) }
}

export class MacAdapter {
  constructor(options = {}) {
    this.platform = 'darwin'
    this._platform = options.platform ?? process.platform
    this._runner = resolveRunner(options)
    this._env = options.env
    this._windows = new Map()
  }

  available() {
    return this._platform === 'darwin'
  }

  capabilities() {
    return {
      displays: true, windows: true, move: true, resize: true,
      focus: false, spaces: false, permission: 'accessibility+automation',
    }
  }

  _request(request) {
    return runAdapter({
      runner: this._runner,
      command: 'osascript',
      args: ['-l', 'JavaScript', '-e', JXA_SCRIPT],
      request,
      timeout: 5000,
      env: this._env,
    })
  }

  async displays() {
    return parseDisplays(this._request({ op: 'displays' }))
  }

  async windows(options = {}) {
    const displays = options.displays ?? await this.displays()
    const windows = parseWindows(this._request({ op: 'windows' }), displays)
    this._windows = new Map(windows.map(window => [window.id, window]))
    return windows
  }

  _placement(id, rect, expect) {
    const payload = this._request({
      op: 'move', target: { pid: expect.pid, index: expect.index }, rect,
      ...(expect.bounds === undefined ? {} : { expect: expect.bounds }),
    })
    if (payload?.ok === false) {
      return {
        ok: false, id,
        code: payload.code === 'E_DENIED' ? 'E_DENIED' : 'E_UNAVAILABLE',
        reason: payload.reason,
      }
    }
    const before = finiteRect(payload?.before) ? payload.before : null
    const after = finiteRect(payload?.after) ? payload.after : null
    const verified = sameRect(after, rect, 1)
    if (verified) this._windows.set(id, { ...expect, bounds: after })
    return {
      ok: verified, id, before, after, verified,
      ...(verified ? {} : { code: 'E_UNAVAILABLE', reason: 'verify_mismatch' }),
    }
  }

  async move(id, rect) {
    const target = parseWindowId(id)
    if (target === null) return { ok: false, id, code: 'E_DENIED', reason: 'invalid_id' }
    let bounds
    try {
      bounds = asRect(rect, 'E_DENIED')
    } catch (error) {
      return { ok: false, id, code: error.code, reason: error.reason }
    }
    const cached = this._windows.get(id)
    if (cached === undefined) return { ok: false, id, code: 'E_DENIED', reason: 'unobserved_window' }
    return this._placement(id, bounds, {
      pid: target.pid, index: target.index, bounds: cached.bounds,
    })
  }

  async resize(id, size) {
    const target = parseWindowId(id)
    if (target === null) return { ok: false, id, code: 'E_DENIED', reason: 'invalid_id' }
    if (!Number.isFinite(size?.w) || !Number.isFinite(size?.h) || size.w <= 0 || size.h <= 0) {
      return { ok: false, id, code: 'E_DENIED', reason: 'invalid_size' }
    }
    const cached = this._windows.get(id)
    if (cached === undefined) return { ok: false, id, code: 'E_DENIED', reason: 'unobserved_window' }
    const payload = this._request({
      op: 'resize', target: { pid: target.pid, index: target.index }, size: { w: size.w, h: size.h },
      ...(cached?.bounds === undefined ? {} : { expect: cached.bounds }),
    })
    if (payload?.ok === false) {
      return { ok: false, id, code: payload.code === 'E_DENIED' ? 'E_DENIED' : 'E_UNAVAILABLE', reason: payload.reason }
    }
    const before = finiteRect(payload?.before) ? payload.before : null
    const after = finiteRect(payload?.after) ? payload.after : null
    const verified = sameSize(after, size, 1)
    if (verified) this._windows.set(id, { ...cached, pid: target.pid, index: target.index, bounds: after })
    return {
      ok: verified, id, before, after, verified,
      ...(verified ? {} : { code: 'E_UNAVAILABLE', reason: 'verify_mismatch' }),
    }
  }

  async focus(id) {
    return { ok: false, id, code: 'E_UNAVAILABLE', reason: 'unsupported' }
  }

  async spaces() {
    return []
  }

  async doctor() {
    try {
      const payload = expectOk(this._request({ op: 'trusted' }))
      const trusted = Boolean(payload?.trusted)
      return {
        ok: trusted, platform: 'darwin', permission: trusted ? 'granted' : 'denied',
        warnings: trusted ? [] : ['accessibility_required'],
      }
    } catch (error) {
      return {
        ok: false, platform: 'darwin', permission: 'unknown',
        warnings: [error.code === 'E_DENIED' ? 'automation_denied' : 'adapter_unavailable'],
      }
    }
  }
}
