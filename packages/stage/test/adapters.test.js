import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, StageService } from '../index.js'
import {
  JXA_SCRIPT, MacAdapter, available as macosAvailable, parseDisplays as parseMacDisplays,
} from '../lib/adapters/macos.js'
import {
  PS_SCRIPT, WindowsAdapter, available as windowsAvailable, compensate,
  parseWindowId, parseWindows as parseWinWindows,
} from '../lib/adapters/windows.js'
import { MockAdapter } from '../lib/adapters/mock.js'
import {
  createAdapter, listAdapters, StageAdapterError,
} from '../lib/adapters/index.js'

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const json = name => JSON.parse(fixture(name))

function replies(...payloads) {
  const calls = []
  let index = 0
  return {
    calls,
    runner(command, args, options) {
      calls.push({ command, args, options })
      const payload = payloads[Math.min(index, payloads.length - 1)]
      index += 1
      return {
        status: 0,
        stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
        stderr: '',
      }
    },
  }
}

const noTitle = windows => assert.equal(windows.some(window => 'title' in window || 'name' in window), false)

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (serviceName, value) => services.set(serviceName, value),
    get: serviceName => services.get(serviceName),
    _tools: tools,
  }
}

test('macOS adapter reads NSScreen frames as AX coordinates', async () => {
  const { runner, calls } = replies(fixture('macos-displays.json'))
  const adapter = new MacAdapter({ runner, platform: 'darwin' })
  assert.equal(adapter.available(), true)
  assert.equal(macosAvailable(), process.platform === 'darwin')

  const displays = await adapter.displays()
  assert.deepEqual(displays.map(display => display.id), ['mac:display:0', 'mac:display:1'])
  assert.deepEqual(displays[0].bounds, { x: 0, y: 0, w: 1600, h: 1000 })
  assert.deepEqual(displays[0].workArea, { x: 0, y: 50, w: 1600, h: 950 })
  assert.equal(displays[0].dpi, 192)
  assert.equal(displays[1].bounds.y, -1120)
  assert.equal(displays[1].workArea.y, -920)
  assert.equal(displays[1].dpi, 144)
  assert.equal(displays[1].primary, false)
  assert.equal(calls[0].command, 'osascript')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.equal(calls[0].options.shell, false)
  assert.match(calls[0].options.env.DSH_STAGE_REQUEST, /"op":"displays"/)
  assert.equal(JXA_SCRIPT.includes('NSScreen.screens'), true)
  assert.equal(JXA_SCRIPT.includes('System Events'), true)
})

test('macOS adapter parses AX windows, drops minimized/fullscreen and invents no titles', async () => {
  const { runner, calls } = replies(fixture('macos-displays.json'), fixture('macos-windows.json'))
  const adapter = new MacAdapter({ runner, platform: 'darwin' })
  const windows = await adapter.windows()
  assert.equal(windows.length, 4)
  noTitle(windows)
  assert.deepEqual(windows.map(window => window.id), ['mac:100:0', 'mac:100:1', 'mac:101:0', 'mac:101:1'])
  assert.equal(windows[0].focused, true)
  assert.equal(windows.filter(window => window.focused).length, 1)
  assert.equal(windows[0].displayId, 'mac:display:0')
  assert.equal(windows[2].displayId, 'mac:display:1')
  assert.equal(windows[3].spanning, true)
  assert.equal(windows.some(window => window.minimized || window.fullscreen), false)
  assert.equal(calls.length, 2)
  assert.match(calls[1].options.env.DSH_STAGE_REQUEST, /"op":"windows"/)
})

test('macOS move re-reads the snapshot, sends pid/index and verifies the result', async () => {
  const { runner, calls } = replies(
    fixture('macos-displays.json'), fixture('macos-windows.json'), fixture('macos-move.json'),
  )
  const adapter = new MacAdapter({ runner, platform: 'darwin' })
  await adapter.windows()
  const result = await adapter.move('mac:100:0', { x: 100, y: 120, w: 640, h: 480 })
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.deepEqual(result.after, { x: 100, y: 120, w: 640, h: 480 })
  const request = JSON.parse(calls[2].options.env.DSH_STAGE_REQUEST)
  assert.deepEqual(request.target, { pid: 100, index: 0 })
  assert.deepEqual(request.expect, { x: 10, y: 10, w: 600, h: 400 })
  assert.equal(request.title, undefined)
})

test('macOS surfaces stale_window from the script instead of reporting success', async () => {
  const { runner } = replies(
    fixture('macos-displays.json'), fixture('macos-windows.json'),
    { ok: false, code: 'E_UNAVAILABLE', reason: 'stale_window' },
  )
  const adapter = new MacAdapter({ runner, platform: 'darwin' })
  await adapter.windows()
  const result = await adapter.move('mac:100:0', { x: 1, y: 2, w: 300, h: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_UNAVAILABLE')
  assert.equal(result.reason, 'stale_window')
})

test('macOS refuses wildcard and unobserved ids without spawning, and maps permission payloads to E_DENIED', async () => {
  const none = replies(fixture('macos-denied.json'))
  const unobserved = new MacAdapter({ runner: none.runner, platform: 'darwin' })
  const rect = { x: 1, y: 2, w: 100, h: 200 }
  assert.equal((await unobserved.move('all', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('*', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('mac:100:0', rect)).reason, 'unobserved_window')
  assert.equal(none.calls.length, 0)

  const observed = replies(
    fixture('macos-displays.json'), fixture('macos-windows.json'), fixture('macos-denied.json'),
  )
  const adapter = new MacAdapter({ runner: observed.runner, platform: 'darwin' })
  await adapter.windows()
  const denied = await adapter.move('mac:100:0', rect)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'E_DENIED')
  assert.equal(denied.reason, 'accessibility')
})

test('macOS maps an automation-denied child process to E_DENIED', async () => {
  const adapter = new MacAdapter({
    platform: 'darwin',
    runner: () => ({ status: 1, stdout: '', stderr: 'Not authorized to send Apple events (-1743)' }),
  })
  await assert.rejects(adapter.displays(), error => error.code === 'E_DENIED')
})

test('Windows adapter parses mixed-DPI monitors and visible-frame geometry', async () => {
  const { runner, calls } = replies(fixture('windows-displays.json'), fixture('windows-windows.json'))
  const adapter = new WindowsAdapter({ runner, platform: 'win32' })
  assert.equal(adapter.available(), true)
  assert.equal(windowsAvailable(), process.platform === 'win32')

  const displays = await adapter.displays()
  assert.deepEqual(displays[0].bounds, { x: 0, y: 0, w: 2560, h: 1440 })
  assert.deepEqual(displays[0].workArea, { x: 0, y: 0, w: 2560, h: 1400 })
  assert.equal(displays[0].dpi, 144)
  assert.equal(displays[0].scale, 1.5)
  assert.deepEqual(displays[1].bounds, { x: -1920, y: -200, w: 1920, h: 1080 })

  const windows = await adapter.windows({ displays })
  assert.equal(windows.length, 2)
  noTitle(windows)
  assert.equal(windows[0].id, 'win:65552')
  assert.deepEqual(windows[0].bounds, { x: 100, y: 100, w: 800, h: 600 })
  assert.deepEqual(windows[0].frame, { x: 89, y: 89, w: 822, h: 622 })
  assert.deepEqual(windows[0].inset, { l: 11, t: 11, r: 11, b: 11 })
  assert.equal(windows[0].displayId, 'win:display:0')
  assert.equal(windows[1].displayId, 'win:display:1')
  assert.equal(windows[0].focused, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].options.shell, false)
  assert.equal(PS_SCRIPT.includes('SetProcessDpiAwarenessContext'), true)
  for (const api of ['EnumWindows', 'GetWindowRect', 'SetWindowPos', 'ShowWindow', 'DwmGetWindowAttribute']) {
    assert.equal(PS_SCRIPT.includes(api), true, api)
  }
  assert.equal(PS_SCRIPT.includes('GetWindowText'), false)
  assert.ok(PS_SCRIPT.indexOf('$processDpi =') < PS_SCRIPT.indexOf('switch ($request.op)'))
})

test('Windows move expands the DWM inset before SetWindowPos', async () => {
  const { runner, calls } = replies(
    fixture('windows-displays.json'), fixture('windows-windows.json'), fixture('windows-move.json'),
  )
  const adapter = new WindowsAdapter({ runner, platform: 'win32' })
  const displays = await adapter.displays()
  await adapter.windows({ displays })
  const target = { x: 200, y: 200, w: 800, h: 600 }
  assert.deepEqual(compensate(target, { l: 11, t: 11, r: 11, b: 11 }), {
    x: 189, y: 189, w: 822, h: 622,
  })

  const result = await adapter.move('win:65552', target)
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  const request = JSON.parse(calls[2].options.env.DSH_STAGE_REQUEST)
  assert.deepEqual(request.outer, { x: 189, y: 189, w: 822, h: 622 })
  assert.deepEqual(request.expect, { x: 100, y: 100, w: 800, h: 600 })
  assert.deepEqual(parseWindowId('win:0x10'), '16')
})

test('Windows resize compensates width/height and keeps the visible origin', async () => {
  const { runner, calls } = replies(
    fixture('windows-displays.json'), fixture('windows-windows.json'), fixture('windows-resize.json'),
  )
  const adapter = new WindowsAdapter({ runner, platform: 'win32' })
  await adapter.windows()
  const result = await adapter.resize('win:65552', { w: 1024, h: 768 })
  assert.equal(result.ok, true)
  assert.equal(result.after.w, 1024)
  const request = JSON.parse(calls[2].options.env.DSH_STAGE_REQUEST)
  assert.deepEqual(request.outer, { x: 89, y: 89, w: 1046, h: 790 })
})

test('Windows refuses non-explicit and unobserved ids, and returns E_DENIED on UIPI/UWP denial', async () => {
  const none = replies(fixture('windows-denied.json'))
  const unobserved = new WindowsAdapter({ runner: none.runner, platform: 'win32' })
  const rect = { x: 1, y: 2, w: 100, h: 200 }
  assert.equal((await unobserved.move('all', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('*', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('win:not-a-hwnd', rect)).code, 'E_DENIED')
  assert.equal((await unobserved.move('win:65552', rect)).reason, 'unobserved_window')
  assert.equal(none.calls.length, 0)

  const observed = replies(
    fixture('windows-displays.json'), fixture('windows-windows.json'), fixture('windows-denied.json'),
  )
  const adapter = new WindowsAdapter({ runner: observed.runner, platform: 'win32' })
  await adapter.windows()
  const denied = await adapter.move('win:65552', rect)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'E_DENIED')
  assert.equal(denied.reason, 'access_denied')
})

test('Windows maps a denied child process to E_DENIED', async () => {
  const adapter = new WindowsAdapter({
    platform: 'win32',
    runner: () => ({ status: 1, stdout: '', stderr: 'Access is denied.' }),
  })
  await assert.rejects(adapter.displays(), error => error.code === 'E_DENIED')
})

test('mock adapter moves, resizes and rejects implicit targets', async () => {
  const adapter = new MockAdapter()
  const before = await adapter.windows()
  const moved = await adapter.move(before[0].id, { x: 50, y: 60, w: 500, h: 400 })
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.after, { x: 50, y: 60, w: 500, h: 400 })
  const resized = await adapter.resize(before[0].id, { w: 640, h: 480 })
  assert.equal(resized.ok, true)
  assert.equal(resized.after.w, 640)
  assert.equal((await adapter.move('all', { x: 0, y: 0, w: 10, h: 10 })).code, 'E_DENIED')
  assert.equal((await adapter.move('mock:999:0', { x: 0, y: 0, w: 10, h: 10 })).code, 'E_UNAVAILABLE')
})

test('StageService defaults to an unarmed mock and arms adapters explicitly', async () => {
  const service = new StageService({ platform: 'linux' })
  const adapters = service.adapters()
  assert.deepEqual(adapters.map(adapter => adapter.name), ['mock', 'macos', 'windows'])
  assert.equal(adapters[0].available, true)
  assert.equal(adapters[1].available, false)
  assert.equal(adapters[2].available, false)
  assert.equal(adapters[0].active, true)

  await assert.rejects(service.topologyLive(), error => error.code === 'E_UNAVAILABLE')
  const selected = service.useAdapter('mock')
  assert.equal(selected.name, 'mock')
  assert.deepEqual(selected.capabilities, {
    displays: true, windows: true, move: true, resize: true,
    focus: true, spaces: false, permission: 'none',
  })
  const topology = await service.topologyLive()
  assert.equal(topology.displays.length, 2)
  assert.equal(topology.windows.length, 3)
  assert.equal(service.adapters()[0].active, true)

  assert.equal((await service.moveLive('mock:100:0', { x: 10, y: 20, w: 300, h: 200 })).ok, true)
  assert.equal((await service.resizeLive('mock:100:0', { w: 640, h: 480 })).ok, true)
  assert.equal((await service.moveLive('all', { x: 0, y: 0, w: 10, h: 10 })).code, 'E_DENIED')
  assert.equal((await service.moveLive('mock:999:0', { x: 0, y: 0, w: 10, h: 10 })).code, 'E_UNAVAILABLE')
  await assert.rejects(service.resizeLive('mock:100:0', { w: 0, h: 10 }), error => error.code === 'invalid_bounds')
  assert.throws(() => service.useAdapter('macos'), error => error.code === 'E_UNAVAILABLE')
  assert.throws(() => service.useAdapter('bogus'), error => error.code === 'E_UNAVAILABLE')
})

test('StageService drives a native adapter through topology and move', async () => {
  const { runner, calls } = replies(
    fixture('macos-displays.json'), fixture('macos-windows.json'), fixture('macos-move.json'),
  )
  const service = new StageService({ platform: 'darwin', runner })
  assert.equal(service.useAdapter('macos').name, 'macos')
  const snapshot = await service.topologyLive()
  assert.equal(snapshot.displays.length, 2)
  assert.equal(snapshot.windows.length, 4)
  assert.equal(snapshot.windows.some(window => 'app' in window), false)
  const moved = await service.moveLive('mac:100:0', { x: 100, y: 120, w: 640, h: 480 })
  assert.equal(moved.ok, true)
  assert.equal(moved.verified, true)
  assert.equal(calls.length, 3)
})

test('apply config arms the live tools; the default mount keeps them unavailable', async () => {
  const defaults = fakeContext()
  apply(defaults)
  assert.equal(defaults._tools.size, 8)
  await assert.rejects(
    defaults._tools.get('stage_live_topology').execute({}),
    error => error.code === 'E_UNAVAILABLE',
  )

  const ctx = fakeContext()
  apply(ctx, { adapter: 'mock' })
  const snapshot = await ctx._tools.get('stage_live_topology').execute({})
  assert.equal(snapshot.windows.length, 3)
  const target = snapshot.windows[0]
  const moved = await ctx._tools.get('stage_live_move').execute({
    id: target.id, rect: { x: 20, y: 20, w: 700, h: 500 },
  })
  assert.equal(moved.ok, true)
  const resized = await ctx._tools.get('stage_live_resize').execute({ id: target.id, w: 640, h: 480 })
  assert.equal(resized.ok, true)
  assert.equal((await ctx._tools.get('stage_live_move').execute({
    id: 'all', rect: { x: 0, y: 0, w: 10, h: 10 },
  })).code, 'E_DENIED')
})

test('adapter registry is discoverable, accepts research-era options and fails closed', async () => {
  const adapters = listAdapters({ platform: 'linux' })
  assert.deepEqual(adapters.map(adapter => adapter.name), ['mock', 'macos', 'windows'])
  assert.equal(adapters[0].available, true)
  assert.equal(createAdapter().name, 'mock')
  assert.equal(createAdapter('darwin', { platform: 'darwin' }).name, 'macos')
  const research = createAdapter({ platform: 'darwin', spawn: () => ({ status: 0, stdout: fixture('macos-displays.json'), stderr: '' }) })
  assert.equal(research.name, 'macos')
  assert.equal((await research.displays()).length, 2)
  assert.throws(() => createAdapter('nope'), error => error instanceof StageAdapterError && error.code === 'E_UNAVAILABLE')
  assert.deepEqual(parseMacDisplays(json('macos-displays.json')).map(display => display.dpi), [192, 144])
  assert.equal(parseWinWindows(json('windows-windows.json'), json('windows-displays.json').monitors.map((monitor, index) => ({
    id: `win:display:${index}`, bounds: monitor.bounds, workArea: monitor.workArea,
  }))).length, 2)
})
