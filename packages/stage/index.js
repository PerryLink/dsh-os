/**
 * dsh-stage — display, window and space topology protocol for DeepSeek Harness.
 *
 * 0.1.0 is the topology protocol MVP: the `ctx.stage` service, named layouts
 * made of display-relative 0..1 zones, applied-intent assignments, bounded
 * history and undo. It never calls a native window API; macOS AX and Windows
 * Win32 adapters are scoped for 0.2.0.
 * @module dsh-stage
 */
import { createHash } from 'node:crypto'

/** Cordis plugin name. */
export const name = 'dsh-stage'

/** The protocol is usable without tools; the agent tools need the registry. */
export const inject = ['tools']

/** Stable schema ids for returned values. */
export const SCHEMAS = { topology: 'dsh.stage.topology/v1', undo: 'dsh.stage.undo/v1' }

const MAX_ZONES = 20
const MAX_HISTORY = 200
const DEFAULT_HISTORY = 20
const EPSILON = 1e-9
const RECT_KEYS = ['x', 'y', 'w', 'h']

const fail = (code, message) => Object.assign(new Error(message), { code })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => structuredClone(value)
const round = value => Math.round(value * 1e6) / 1e6
const now = () => new Date().toISOString()

function text(value, code, label) {
  if (typeof value !== 'string' || value.trim() === '') throw fail(code, `${label} must be a non-empty string`)
  if (value.includes('\0')) throw fail(code, `${label} must not contain NUL`)
  return value
}

function rectOf(value, label) {
  if (!isObject(value)) throw fail('invalid_bounds', `${label} must be an object`)
  const { x, y, w, h } = value
  if (![x, y, w, h].every(number => typeof number === 'number' && Number.isFinite(number))) {
    throw fail('invalid_bounds', `${label}.x, .y, .w and .h must be finite numbers`)
  }
  if (w <= 0 || h <= 0) throw fail('invalid_bounds', `${label}.w and .h must be positive`)
  return { x, y, w, h }
}

function arrayOf(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw fail('invalid_topology', `${label} must be an array`)
  return value
}

function unique(seen, id, code, label) {
  if (seen.has(id)) throw fail(code, `${label} "${id}" is repeated`)
  seen.add(id)
}

function normalizeDisplay(value, index) {
  if (!isObject(value)) throw fail('invalid_display', `displays[${index}] must be an object`)
  const id = text(value.id, 'invalid_display', `displays[${index}].id`)
  const bounds = rectOf(value.bounds, `displays[${index}].bounds`)
  const workArea = value.workArea === undefined ? bounds : rectOf(value.workArea, `displays[${index}].workArea`)
  if (typeof value.dpi !== 'number' || !Number.isFinite(value.dpi) || value.dpi <= 0) {
    throw fail('invalid_display', `displays[${index}].dpi must be a positive finite number`)
  }
  return { id, bounds, workArea, dpi: value.dpi }
}

function normalizeWindow(value, index, displayIds) {
  if (!isObject(value)) throw fail('invalid_window', `windows[${index}] must be an object`)
  const id = text(value.id, 'invalid_window', `windows[${index}].id`)
  const displayId = text(value.displayId, 'invalid_window', `windows[${index}].displayId`)
  if (!displayIds.has(displayId)) throw fail('unknown_display', `windows[${index}].displayId "${displayId}" is not in displays`)
  const bounds = rectOf(value.bounds, `windows[${index}].bounds`)
  const focused = value.focused === undefined ? false : value.focused
  if (typeof focused !== 'boolean') throw fail('invalid_window', `windows[${index}].focused must be a boolean`)
  return { id, displayId, bounds, focused }
}

function normalizeSpace(value, index, displayIds) {
  if (!isObject(value)) throw fail('invalid_space', `spaces[${index}] must be an object`)
  const id = text(value.id, 'invalid_space', `spaces[${index}].id`)
  const displayId = text(value.displayId, 'invalid_space', `spaces[${index}].displayId`)
  if (!displayIds.has(displayId)) throw fail('unknown_display', `spaces[${index}].displayId "${displayId}" is not in displays`)
  const spaceIndex = value.index === undefined ? 0 : value.index
  if (!Number.isInteger(spaceIndex) || spaceIndex < 0) throw fail('invalid_space', `spaces[${index}].index must be a non-negative integer`)
  const current = value.current === undefined ? false : value.current
  if (typeof current !== 'boolean') throw fail('invalid_space', `spaces[${index}].current must be a boolean`)
  return { id, displayId, index: spaceIndex, current }
}

function normalizeZones(value) {
  if (!Array.isArray(value) || value.length === 0) throw fail('invalid_zone', 'zones must be a non-empty array')
  if (value.length > MAX_ZONES) throw fail('invalid_zone', `zones must contain at most ${MAX_ZONES} entries`)
  return value.map((zone, index) => {
    if (!isObject(zone)) throw fail('invalid_zone', `zones[${index}] must be an object`)
    for (const key of RECT_KEYS) {
      const number = zone[key]
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) {
        throw fail('invalid_zone', `zones[${index}].${key} must be a finite number within 0..1`)
      }
    }
    if (zone.w === 0 || zone.h === 0) throw fail('invalid_zone', `zones[${index}].w and .h must be positive`)
    if (zone.x + zone.w > 1 + EPSILON || zone.y + zone.h > 1 + EPSILON) {
      throw fail('invalid_zone', `zones[${index}] must fit inside 0..1`)
    }
    return { x: zone.x, y: zone.y, w: zone.w, h: zone.h }
  })
}

const hashTopology = (displays, windows, spaces) => createHash('sha256')
  .update(JSON.stringify({ displays, windows, spaces })).digest('hex').slice(0, 16)

const placeZone = (zone, area) => ({
  x: round(area.x + zone.x * area.w), y: round(area.y + zone.y * area.h),
  w: round(zone.w * area.w), h: round(zone.h * area.h),
})

/** Host seam exposed as `ctx.stage`. */
export class StageService {
  constructor() {
    this._topology = null
    this._layouts = new Map()
    this._history = []
    this._undone = new Map()
    this._sequence = 0
  }

  _record(entry) {
    const record = { id: `h${++this._sequence}`, at: now(), ...entry }
    this._history.push(record)
    if (this._history.length > MAX_HISTORY) {
      for (const dropped of this._history.splice(0, this._history.length - MAX_HISTORY)) {
        this._undone.delete(dropped.id)
      }
    }
    return record
  }

  /**
   * Validate and replace the observed topology snapshot. Displays need `id`,
   * `bounds` and a positive `dpi`; windows need `id`, a known `displayId`,
   * `bounds` and an optional boolean `focused`. Spaces are best-effort.
   */
  setTopology(input) {
    if (!isObject(input)) throw fail('invalid_topology', 'topology must be an object')
    const displayIds = new Set()
    const displays = arrayOf(input.displays, 'displays').map((value, index) => {
      const display = normalizeDisplay(value, index)
      unique(displayIds, display.id, 'duplicate_display', 'display id')
      return display
    })
    const windowIds = new Set()
    let focused = 0
    const windows = arrayOf(input.windows, 'windows').map((value, index) => {
      const window = normalizeWindow(value, index, displayIds)
      unique(windowIds, window.id, 'duplicate_window', 'window id')
      if (window.focused) focused += 1
      return window
    })
    if (focused > 1) throw fail('duplicate_focus', 'at most one window may be focused')
    const spaceIds = new Set()
    const spaces = arrayOf(input.spaces, 'spaces').map((value, index) => {
      const space = normalizeSpace(value, index, displayIds)
      unique(spaceIds, space.id, 'duplicate_space', 'space id')
      return space
    })
    const snapshot = {
      schema: SCHEMAS.topology, displays, windows, spaces,
      topologyHash: hashTopology(displays, windows, spaces), observedAt: now(),
    }
    this._topology = snapshot
    this._record({
      type: 'topology', displays: displays.length, windows: windows.length,
      spaces: spaces.length, topologyHash: snapshot.topologyHash,
    })
    return clone(snapshot)
  }

  /** Read the latest snapshot; an unobserved topology is empty with null hash. */
  topology() {
    return this._topology === null
      ? { schema: SCHEMAS.topology, displays: [], windows: [], spaces: [], topologyHash: null, observedAt: null }
      : clone(this._topology)
  }

  /** Create or replace a named layout definition. Does not touch topology. */
  setLayout(name, spec) {
    const layoutName = text(name, 'invalid_layout', 'layout name')
    if (!isObject(spec)) throw fail('invalid_layout', 'layout spec must be an object')
    const displayId = text(spec.displayId, 'invalid_layout', 'layout displayId')
    const layout = { name: layoutName, displayId, zones: normalizeZones(spec.zones) }
    this._layouts.set(layoutName, layout)
    this._record({ type: 'layout', name: layoutName, displayId, zones: layout.zones.length })
    return clone(layout)
  }

  /** All layouts, sorted by name. */
  layouts() {
    return [...this._layouts.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(item => clone(item))
  }

  /**
   * Compute and record the intent to place windows of the layout's display.
   * The focused window comes first, then windows in observation order; zones
   * are consumed in listed order. No native API is called.
   */
  applyLayout(name) {
    const layoutName = text(name, 'invalid_layout', 'layout name')
    if (this._topology === null) throw fail('no_topology', 'setTopology() must be called before applyLayout()')
    const layout = this._layouts.get(layoutName)
    if (layout === undefined) throw fail('unknown_layout', `layout "${layoutName}" is not registered`)
    const display = this._topology.displays.find(item => item.id === layout.displayId)
    if (display === undefined) throw fail('unknown_display', `layout display "${layout.displayId}" is not in the current topology`)
    const windows = this._topology.windows
      .map((window, index) => ({ window, index }))
      .filter(item => item.window.displayId === display.id)
      .sort((a, b) => Number(b.window.focused) - Number(a.window.focused) || a.index - b.index)
      .map(item => item.window)
    const assignments = layout.zones.slice(0, windows.length).map((zone, index) => ({
      windowId: windows[index].id, displayId: display.id, zone: index, rect: placeZone(zone, display.workArea),
    }))
    this._record({
      type: 'apply', name: layout.name, displayId: display.id, layout: clone(layout),
      assignments: clone(assignments), topologyHash: this._topology.topologyHash,
    })
    return { layout: clone(layout), assignments: clone(assignments) }
  }

  /** Newest-first history entries, capped by `limit` (default 20, max 200). */
  history(limit = DEFAULT_HISTORY) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
      throw fail('invalid_limit', `history limit must be an integer from 1 to ${MAX_HISTORY}`)
    }
    return clone(this._history.slice(-limit).reverse().map(entry => (
      entry.type === 'apply' && this._undone.has(entry.id)
        ? { ...entry, undone: true, undoneAt: this._undone.get(entry.id) }
        : entry.type === 'apply' ? { ...entry, undone: false } : entry
    )))
  }

  /**
   * Mark the latest not-yet-undone apply as undone and return its receipt.
   *
   * The apply records the topology hash it was computed against. If the
   * topology has changed since, the recorded rectangles are stale, so undo
   * refuses with `{ ok: false, code: 'stale_topology' }` and changes nothing;
   * re-apply the layout on the current topology and undo that record instead.
   */
  undo() {
    const entry = [...this._history].reverse()
      .find(item => item.type === 'apply' && !this._undone.has(item.id))
    if (entry === undefined) throw fail('nothing_to_undo', 'no applied layout is available to undo')
    const topologyHash = this._topology === null ? null : this._topology.topologyHash
    if (entry.topologyHash !== topologyHash) {
      return {
        ok: false,
        code: 'stale_topology',
        message: 'the topology changed after this layout was applied; re-apply the layout and undo the new record',
        applyId: entry.id,
        recordedTopologyHash: entry.topologyHash,
        topologyHash,
      }
    }
    this._undone.set(entry.id, now())
    this._record({
      type: 'undo', applyId: entry.id, name: entry.name, displayId: entry.displayId, topologyHash,
    })
    return {
      ok: true,
      schema: SCHEMAS.undo,
      undone: { id: entry.id, at: entry.at, layout: clone(entry.layout), assignments: clone(entry.assignments) },
    }
  }
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const objectSchema = (properties, required) => ({
  type: 'object', additionalProperties: false, properties,
  ...(required === undefined ? {} : { required }),
})

const ZONE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(RECT_KEYS.map(key => [key, { type: 'number', minimum: 0, maximum: 1 }])),
  required: RECT_KEYS,
}

const tool = (name, description, parameters, execute) => ({
  name, description, parameters, output: TOOL_OUTPUT,
  async execute(args) {
    return execute(args ?? {})
  },
})

/** Plain-object ToolDefinitions; no `@deepseek-ai/dsh-tools` dependency. */
export function createTools(service) {
  return [
    tool(
      'stage_topology',
      'Read the current display/window/space topology snapshot. Topology is supplied '
        + 'by a platform adapter; 0.1.0 ships no native adapter.',
      objectSchema({}),
      () => service.topology(),
    ),
    tool(
      'stage_layout_set',
      'Create or replace a named layout of display-relative 0..1 zones. '
        + 'Records a definition only; it does not move windows.',
      objectSchema({
        name: { type: 'string', description: 'Layout name, e.g. "left-right".' },
        displayId: { type: 'string', description: 'Target display id from stage_topology.' },
        zones: {
          type: 'array',
          items: ZONE_SCHEMA,
          minItems: 1,
          maxItems: MAX_ZONES,
          description: 'Normalized zones in application order.',
        },
      }, ['name', 'displayId', 'zones']),
      args => ({
        layout: service.setLayout(args?.name, {
          displayId: args?.displayId,
          zones: args?.zones,
        }),
      }),
    ),
    tool(
      'stage_layout_apply',
      'Record a layout application: pair windows on the target display (focused '
        + 'first) with zones, append it to history and return { layout, assignments }. '
        + 'No native window API is called.',
      objectSchema({ name: { type: 'string' } }, ['name']),
      args => service.applyLayout(args?.name),
    ),
    tool(
      'stage_layout_list',
      'List every registered layout, sorted by name.',
      objectSchema({}),
      () => ({ layouts: service.layouts() }),
    ),
    tool(
      'stage_undo',
      'Undo the most recent applied layout in the Stage ledger. Reverses recorded '
        + 'intent only; native window restore is an adapter concern.',
      objectSchema({}),
      () => service.undo(),
    ),
  ]
}

/** Mount dsh-stage: provide `ctx.stage` and the five `stage_*` tools. */
export function apply(ctx, _config = {}) {
  const stage = new StageService()
  ctx.provide('stage', stage)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const item of createTools(stage)) ctx.tools.register(item)
  }
  return stage
}
