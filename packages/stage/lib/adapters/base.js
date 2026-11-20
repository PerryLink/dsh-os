/**
 * Shared adapter plumbing: one error type, one child-process seam and the
 * geometry helpers used to turn raw OS output into `stage` topology.
 *
 * Nothing here logs, and raw child stdout/stderr is never copied into an
 * error message: adapters never read window titles, so there is nothing
 * sensitive to leak through a failure path either.
 */
import { spawnSync } from 'node:child_process'

const RECT_KEYS = ['x', 'y', 'w', 'h']

/** Adapter failures use two stable codes: `E_UNAVAILABLE` and `E_DENIED`. */
export class StageAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'StageAdapterError'
    this.code = code
    Object.assign(this, details)
  }
}

export const fail = (code, message, details) => {
  throw new StageAdapterError(code, message, details)
}

/** Default seam: spawn an argument array with `shell:false` and capture JSON. */
/** Resolve the injected runner: `runner`, research-era `spawn`, or the default. */
export function resolveRunner(options = {}) {
  if (typeof options.runner === 'function') return options.runner
  if (typeof options.spawn === 'function') {
    return (command, args, opts = {}) => options.spawn(command, args, { encoding: 'utf8', ...opts })
  }
  return spawnRunner
}

export function spawnRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    env: options.env,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

/** Parse a JSON reply, tolerating a stray warning line before the payload. */
export function parseJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') fail('E_UNAVAILABLE', 'adapter produced no output', { reason: 'empty_output' })
  try {
    return JSON.parse(text)
  } catch {
    const line = text.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'))
    if (line !== undefined) {
      try {
        return JSON.parse(line)
      } catch {
        // Fall through to the stable error below.
      }
    }
    fail('E_UNAVAILABLE', 'adapter produced invalid JSON', { reason: 'invalid_json' })
  }
}

/**
 * Run one fixed adapter script and decode its stdout.
 *
 * The request travels through a dedicated environment variable, never through
 * shell interpolation, and the child receives a minimal environment instead
 * of the host's secrets.
 */
const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'SystemRoot', 'SystemDrive',
  'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'PSModulePath',
]

export function runAdapter({ runner, command, args, request, timeout = 5000, env: overrides }) {
  const env = {}
  for (const key of CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, overrides ?? {})
  env.DSH_STAGE_REQUEST = JSON.stringify(request ?? {})
  const result = runner(command, args, { env, timeout, shell: false, windowsHide: true })
  if (result?.error?.code === 'ETIMEDOUT') {
    fail('E_UNAVAILABLE', 'adapter timed out', { reason: 'timeout' })
  }
  if (result?.error) {
    const missing = result.error.code === 'ENOENT'
    fail('E_UNAVAILABLE', 'adapter process could not start', { reason: missing ? 'not_installed' : 'process_failed' })
  }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? '')
    const denied = /-1743|-1719|-25211|not authorized|not allowed|accessibility|assistive|permission|denied|not permitted|access is denied/i.test(stderr)
    fail(denied ? 'E_DENIED' : 'E_UNAVAILABLE', 'adapter process failed', {
      reason: denied ? 'permission_denied' : 'process_failed',
    })
  }
  return parseJson(result?.stdout)
}

/** Throw unless the adapter payload explicitly succeeded. */
export function expectOk(payload) {
  if (payload?.ok === false) {
    fail(payload.code === 'E_DENIED' ? 'E_DENIED' : 'E_UNAVAILABLE', 'adapter refused the request', {
      reason: payload.reason ?? 'refused',
    })
  }
  return payload
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const isRect = value => isObject(value)
  && RECT_KEYS.every(key => Number.isFinite(value[key]))
  && value.w > 0 && value.h > 0

/** Validate a rectangle coming from a tool argument; invalid targets are denied. */
export function asRect(value, code = 'E_UNAVAILABLE') {
  if (!isRect(value)) {
    fail(code, 'rect must be {x,y,w,h} with finite values and positive w/h', { reason: 'invalid_rect' })
  }
  return { x: value.x, y: value.y, w: value.w, h: value.h }
}

export const sameRect = (left, right, tolerance = 1) => isRect(left) && isRect(right)
  && Math.abs(left.x - right.x) <= tolerance
  && Math.abs(left.y - right.y) <= tolerance
  && Math.abs(left.w - right.w) <= tolerance
  && Math.abs(left.h - right.h) <= tolerance

export const sameSize = (rect, size, tolerance = 1) => isRect(rect)
  && Number.isFinite(size?.w) && Number.isFinite(size?.h)
  && Math.abs(rect.w - size.w) <= tolerance
  && Math.abs(rect.h - size.h) <= tolerance

export const insetOf = (frame, visible) => ({
  l: visible.x - frame.x,
  t: visible.y - frame.y,
  r: frame.x + frame.w - (visible.x + visible.w),
  b: frame.y + frame.h - (visible.y + visible.h),
})

export function overlap(left, right) {
  const w = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x)
  const h = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Attribute a global rectangle to the display with the largest overlap.
 * `spanning` is true when the rectangle touches more than one display.
 */
export function displayForRect(bounds, displays) {
  const list = Array.isArray(displays) ? displays : []
  let best = list[0]
  let bestArea = -1
  let touching = 0
  for (const display of list) {
    const area = overlap(bounds, display.workArea ?? display.bounds)
    if (area > bestArea) {
      best = display
      bestArea = area
    }
    if (overlap(bounds, display.bounds) > 0) touching += 1
  }
  return { displayId: best?.id ?? 'unknown', spanning: touching > 1 }
}

