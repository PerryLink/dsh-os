import test from 'node:test'
import assert from 'node:assert/strict'
import { StageService, apply, createTools, inject, name, SCHEMAS } from '../index.js'

const MAIN = {
  id: 'main',
  bounds: { x: 0, y: 0, w: 1600, h: 1000 },
  workArea: { x: 0, y: 25, w: 1600, h: 950 },
  dpi: 96,
}
const SIDE = {
  id: 'side',
  bounds: { x: 1600, y: -200, w: 1200, h: 1920 },
  dpi: 144,
}

function topology() {
  return {
    displays: [structuredClone(MAIN), structuredClone(SIDE)],
    windows: [
      { id: 'editor', displayId: 'main', bounds: { x: 10, y: 10, w: 600, h: 400 } },
      { id: 'browser', displayId: 'main', bounds: { x: 20, y: 20, w: 700, h: 500 }, focused: true },
      { id: 'chat', displayId: 'side', bounds: { x: 1700, y: 0, w: 400, h: 900 } },
    ],
    spaces: [{ id: 'desk-1', displayId: 'main', current: true }],
  }
}

function observed() {
  const service = new StageService()
  service.setTopology(topology())
  return service
}

const codeIs = code => error => {
  assert.equal(error.code, code)
  return true
}

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (serviceName, value) => services.set(serviceName, value),
    get: serviceName => services.get(serviceName),
    _tools: tools,
    _services: services,
  }
}

test('setTopology normalizes and snapshots displays, windows and spaces', () => {
  const service = new StageService()
  const empty = service.topology()
  assert.equal(empty.schema, SCHEMAS.topology)
  assert.deepEqual([empty.displays, empty.windows, empty.spaces], [[], [], []])
  assert.equal(empty.topologyHash, null)
  assert.equal(empty.observedAt, null)

  const snapshot = service.setTopology(topology())
  assert.equal(snapshot.schema, 'dsh.stage.topology/v1')
  assert.deepEqual(snapshot.displays[0], MAIN)
  assert.deepEqual(snapshot.displays[1], { ...SIDE, workArea: SIDE.bounds })
  assert.deepEqual(snapshot.windows.map(window => [window.id, window.displayId, window.focused]), [
    ['editor', 'main', false],
    ['browser', 'main', true],
    ['chat', 'side', false],
  ])
  assert.deepEqual(snapshot.spaces, [{ id: 'desk-1', displayId: 'main', index: 0, current: true }])
  assert.match(snapshot.topologyHash, /^[0-9a-f]{16}$/)
  assert.equal(typeof snapshot.observedAt, 'string')
  assert.deepEqual(service.topology(), snapshot)

  const again = service.setTopology(topology())
  assert.equal(again.topologyHash, snapshot.topologyHash)
  const moved = topology()
  moved.windows[0].bounds.x = 99
  assert.notEqual(service.setTopology(moved).topologyHash, snapshot.topologyHash)

  snapshot.displays[0].bounds.w = 1
  assert.equal(service.topology().displays[0].bounds.w, 1600)
  assert.deepEqual(service.history().map(entry => entry.type), ['topology', 'topology', 'topology'])
})

test('setTopology rejects invalid fields, duplicates and dangling references', () => {
  const service = new StageService()
  const withPatch = patch => ({ ...topology(), ...patch })
  const single = display => withPatch({ displays: [display], windows: [], spaces: [] })

  assert.throws(() => service.setTopology(null), codeIs('invalid_topology'))
  assert.throws(() => service.setTopology({ displays: 'main' }), codeIs('invalid_topology'))
  assert.throws(() => service.setTopology(single({ ...MAIN, id: ' ' })), codeIs('invalid_display'))
  assert.throws(() => service.setTopology(single({ ...MAIN, bounds: { x: 0, y: 0, w: 0, h: 10 } })), codeIs('invalid_bounds'))
  assert.throws(() => service.setTopology(single({ ...MAIN, bounds: { x: 0, y: 0, w: 10, h: Infinity } })), codeIs('invalid_bounds'))
  assert.throws(() => service.setTopology(single({ ...MAIN, dpi: 0 })), codeIs('invalid_display'))
  assert.throws(() => service.setTopology(single({ ...MAIN, dpi: '96' })), codeIs('invalid_display'))
  assert.throws(() => service.setTopology(withPatch({ displays: [MAIN, MAIN] })), codeIs('duplicate_display'))
  assert.throws(() => service.setTopology(withPatch({
    windows: [{ id: 'w', displayId: 'main', bounds: { x: 0, y: 0, w: 1, h: 1 }, focused: 'yes' }],
  })), codeIs('invalid_window'))
  assert.throws(() => service.setTopology(withPatch({
    windows: [{ id: 'w', displayId: 'ghost', bounds: { x: 0, y: 0, w: 1, h: 1 } }],
  })), codeIs('unknown_display'))
  assert.throws(() => service.setTopology(withPatch({
    windows: [
      { id: 'a', displayId: 'main', bounds: { x: 0, y: 0, w: 1, h: 1 }, focused: true },
      { id: 'b', displayId: 'main', bounds: { x: 0, y: 0, w: 1, h: 1 }, focused: true },
    ],
  })), codeIs('duplicate_focus'))
  assert.throws(() => service.setTopology(withPatch({
    windows: [
      { id: 'a', displayId: 'main', bounds: { x: 0, y: 0, w: 1, h: 1 } },
      { id: 'a', displayId: 'side', bounds: { x: 0, y: 0, w: 1, h: 1 } },
    ],
  })), codeIs('duplicate_window'))
  assert.throws(() => service.setTopology(withPatch({ spaces: [{ id: 's', displayId: 'ghost' }] })), codeIs('unknown_display'))
  assert.throws(() => service.setTopology(withPatch({ spaces: [{ id: 's', displayId: 'main', index: -1 }] })), codeIs('invalid_space'))
  assert.throws(() => service.setTopology(withPatch({ spaces: [{ id: 's', displayId: 'main', current: 1 }] })), codeIs('invalid_space'))
  assert.equal(service.topology().topologyHash, null)
})

test('setLayout normalizes zones and rejects illegal zones', () => {
  const service = new StageService()
  const halves = {
    name: 'halves',
    displayId: 'main',
    zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
  }
  assert.deepEqual(service.setLayout('halves', { displayId: 'main', zones: halves.zones }), halves)
  assert.deepEqual(service.layouts(), [halves])

  service.setLayout('halves', { displayId: 'side', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  assert.equal(service.layouts().length, 1)
  assert.equal(service.layouts()[0].displayId, 'side')

  const badZones = [
    { x: -0.01, y: 0, w: 0.5, h: 1 },
    { x: 0, y: 1.01, w: 0.5, h: 1 },
    { x: 0.6, y: 0, w: 0.5, h: 1 },
    { x: 0, y: 0.8, w: 1, h: 0.5 },
    { x: 0, y: 0, w: 0, h: 1 },
    { x: 0, y: 0, w: 0.5 },
    { x: 0, y: 0, w: '0.5', h: 1 },
    { x: Number.NaN, y: 0, w: 0.5, h: 1 },
    { x: 0, y: Number.NaN, w: 0.5, h: 1 },
    { x: 0, y: 0, w: Number.NaN, h: 1 },
    { x: 0, y: 0, w: 0.5, h: Number.NaN },
    { x: Number.POSITIVE_INFINITY, y: 0, w: 0.5, h: 1 },
    { x: 0, y: Number.NEGATIVE_INFINITY, w: 0.5, h: 1 },
    { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 },
    { x: 0, y: 0, w: 1, h: Number.NEGATIVE_INFINITY },
    { x: -0.25, y: 0, w: 0.5, h: 1 },
    { x: 0, y: -1, w: 0.5, h: 1 },
    { x: 0, y: 0, w: 1.25, h: 1 },
    { x: 0, y: 0, w: 1, h: 1.25 },
    null,
  ]
  for (const zone of badZones) {
    assert.throws(
      () => service.setLayout('bad', { displayId: 'main', zones: [zone] }),
      codeIs('invalid_zone'),
    )
  }
  assert.throws(() => service.setLayout('', halves), codeIs('invalid_layout'))
  assert.throws(() => service.setLayout('bad', { displayId: '', zones: halves.zones }), codeIs('invalid_layout'))
  assert.throws(() => service.setLayout('bad', { displayId: 'main', zones: [] }), codeIs('invalid_zone'))
  assert.throws(
    () => service.setLayout('bad', {
      displayId: 'main',
      zones: Array.from({ length: 21 }, () => ({ x: 0, y: 0, w: 1, h: 1 })),
    }),
    codeIs('invalid_zone'),
  )
  assert.deepEqual(service.layouts().map(layout => layout.name), ['halves'])
})

test('applyLayout records focused-first assignments and undo reverses the latest apply', () => {
  const service = observed()
  service.setLayout('quadrants', {
    displayId: 'main',
    zones: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.75, w: 1, h: 0.25 },
    ],
  })

  const result = service.applyLayout('quadrants')
  assert.deepEqual(Object.keys(result).sort(), ['assignments', 'layout'])
  assert.equal(result.layout.name, 'quadrants')
  assert.deepEqual(result.assignments.map(assignment => [assignment.windowId, assignment.zone]), [
    ['browser', 0],
    ['editor', 1],
  ])
  assert.deepEqual(result.assignments[0].rect, { x: 0, y: 25, w: 800, h: 475 })
  assert.deepEqual(result.assignments[1].rect, { x: 800, y: 25, w: 800, h: 475 })
  assert.equal(result.assignments.some(assignment => assignment.windowId === 'chat'), false)

  const entries = service.history()
  assert.deepEqual(entries.map(entry => entry.type), ['apply', 'layout', 'topology'])
  assert.equal(entries[0].undone, false)
  assert.equal(entries[0].topologyHash, service.topology().topologyHash)

  const receipt = service.undo()
  assert.equal(receipt.schema, SCHEMAS.undo)
  assert.equal(receipt.undone.id, entries[0].id)
  assert.deepEqual(receipt.undone.layout, result.layout)
  assert.deepEqual(receipt.undone.assignments, result.assignments)
  assert.deepEqual(service.history().map(entry => entry.type), ['undo', 'apply', 'layout', 'topology'])
  assert.equal(service.history()[1].undone, true)
  assert.throws(() => service.undo(), codeIs('nothing_to_undo'))

  service.applyLayout('quadrants')
  assert.equal(service.undo().undone.layout.name, 'quadrants')
  assert.deepEqual(
    service.history().map(entry => entry.type),
    ['undo', 'apply', 'undo', 'apply', 'layout', 'topology'],
  )
})

test('undo refuses with stale_topology after the topology changes', () => {
  const service = observed()
  service.setLayout('full', { displayId: 'main', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  const applied = service.applyLayout('full')
  assert.deepEqual(applied.assignments[0].rect, { x: 0, y: 25, w: 1600, h: 950 })
  const recordedHash = service.topology().topologyHash
  assert.equal(recordedHash, service.history()[0].topologyHash)

  const moved = topology()
  moved.displays[0].workArea.w = 800
  const movedHash = service.setTopology(moved).topologyHash
  assert.notEqual(movedHash, recordedHash)

  const before = service.history()
  const stale = service.undo()
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale_topology')
  assert.equal(stale.applyId, before.find(entry => entry.type === 'apply').id)
  assert.equal(stale.recordedTopologyHash, recordedHash)
  assert.equal(stale.topologyHash, movedHash)
  // Nothing is recorded, marked undone or otherwise mutated by a refused undo.
  assert.deepEqual(service.history(), before)
  assert.deepEqual(service.history().find(entry => entry.type === 'apply').undone, false)
  assert.equal(service.undo().code, 'stale_topology')

  // The stale apply becomes valid again if the topology returns to its hash.
  service.setTopology(topology())
  const restored = service.undo()
  assert.equal(restored.ok, true)
  assert.equal(restored.undone.id, stale.applyId)

  // Re-applying on the current topology gives undo a fresh, non-stale record.
  service.setTopology(moved)
  const reapplied = service.applyLayout('full')
  assert.deepEqual(reapplied.assignments[0].rect, { x: 0, y: 25, w: 800, h: 950 })
  const receipt = service.undo()
  assert.equal(receipt.ok, true)
  assert.equal(receipt.schema, SCHEMAS.undo)
  assert.equal(receipt.undone.id, service.history()[1].id)
  assert.deepEqual(receipt.undone.assignments, reapplied.assignments)

  // Observing the same topology again does not make a healthy apply stale.
  service.setTopology(topology())
  service.applyLayout('full')
  assert.equal(service.undo().ok, true)
})

test('history entries are copies and undo state is append-only', () => {
  const service = observed()
  service.setLayout('full', { displayId: 'main', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  const applied = service.applyLayout('full')
  const snapshot = service.history()
  assert.equal(snapshot[0].undone, false)

  snapshot[0].undone = true
  snapshot[0].assignments = []
  assert.equal(service.history()[0].undone, false)
  assert.equal(service.history()[0].assignments.length, 1)

  const receipt = service.undo()
  receipt.undone.assignments[0].rect.w = 1
  assert.equal(service.history()[1].assignments[0].rect.w, 1600)
  assert.equal(service.history()[1].undone, true)
  assert.equal(typeof service.history()[1].undoneAt, 'string')
  assert.equal(applied.assignments[0].rect.w, 1600)
})

test('applyLayout fails clearly without topology, layout or display', () => {
  const service = new StageService()
  service.setLayout('orphan', { displayId: 'ghost', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  assert.throws(() => service.applyLayout('orphan'), codeIs('no_topology'))

  service.setTopology(topology())
  assert.throws(() => service.applyLayout('orphan'), codeIs('unknown_display'))
  assert.throws(() => service.applyLayout('missing'), codeIs('unknown_layout'))
  assert.throws(() => service.applyLayout(''), codeIs('invalid_layout'))

  service.setTopology({ displays: [{ ...MAIN, id: 'lonely' }], windows: [], spaces: [] })
  service.setLayout('full', { displayId: 'lonely', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  assert.deepEqual(service.applyLayout('full').assignments, [])
  assert.equal(service.undo().undone.layout.name, 'full')
})

test('history is newest-first, bounded and validates its limit', () => {
  const service = observed()
  service.setLayout('a', { displayId: 'main', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  service.setLayout('b', { displayId: 'main', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  assert.deepEqual(service.history(2).map(entry => entry.type), ['layout', 'layout'])
  assert.equal(service.history(2)[0].name, 'b')
  for (const limit of [0, 1.5, 201, '2']) {
    assert.throws(() => service.history(limit), codeIs('invalid_limit'))
  }

  for (let index = 0; index < 205; index += 1) {
    service.setLayout(`l${index}`, { displayId: 'main', zones: [{ x: 0, y: 0, w: 1, h: 1 }] })
  }
  const all = service.history()
  const capped = service.history(200)
  assert.equal(all.length, 20)
  assert.equal(capped.length, 200)
  assert.equal(all[0].name, 'l204')
  assert.equal(capped[199].name, 'l5')
})

test('apply provides ctx.stage and registers five plain-object tools', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  assert.equal(ctx.get('stage'), service)
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    'stage_layout_apply',
    'stage_layout_list',
    'stage_layout_set',
    'stage_topology',
    'stage_undo',
  ])
  for (const tool of ctx._tools.values()) {
    assert.equal(typeof tool, 'object')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }

  assert.deepEqual((await ctx._tools.get('stage_topology').execute({})).displays, [])
  service.setTopology(topology())
  const set = await ctx._tools.get('stage_layout_set').execute({
    name: 'right',
    displayId: 'main',
    zones: [{ x: 0.5, y: 0, w: 0.5, h: 1 }],
  })
  assert.equal(set.layout.name, 'right')
  const applied = await ctx._tools.get('stage_layout_apply').execute({ name: 'right' })
  assert.equal(applied.assignments[0].windowId, 'browser')
  assert.deepEqual(
    (await ctx._tools.get('stage_layout_list').execute({})).layouts.map(layout => layout.name),
    ['right'],
  )
  assert.equal((await ctx._tools.get('stage_undo').execute({})).undone.layout.name, 'right')
  await ctx._tools.get('stage_layout_apply').execute({ name: 'right' })
  const shifted = topology()
  shifted.displays[0].workArea.w = 900
  service.setTopology(shifted)
  assert.equal((await ctx._tools.get('stage_undo').execute({})).code, 'stale_topology')
  await assert.rejects(
    ctx._tools.get('stage_layout_set').execute({ name: 'bad', displayId: 'main', zones: [{ x: 2, y: 0, w: 1, h: 1 }] }),
    codeIs('invalid_zone'),
  )
  await assert.rejects(
    ctx._tools.get('stage_layout_apply').execute({ name: 'missing' }),
    codeIs('unknown_layout'),
  )
  assert.equal((await ctx._tools.get('stage_topology').execute({})).windows.length, 3)
  assert.deepEqual(inject, ['tools'])
  assert.equal(name, 'dsh-stage')
  assert.equal(createTools(service).length, 5)
})

test('the service mounts without a tools registry', () => {
  const services = new Map()
  const service = apply({ provide: (serviceName, value) => services.set(serviceName, value) })
  assert.equal(services.get('stage'), service)
  assert.throws(() => service.applyLayout('anything'), codeIs('no_topology'))
})
