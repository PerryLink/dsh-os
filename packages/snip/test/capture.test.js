import test from 'node:test'
import assert from 'node:assert/strict'
import { createClipboardAdapter } from '../lib/capture.js'
import { SnipService, apply } from '../index.js'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function fakeRunner(handler) {
  const calls = []
  function run(command, args, options) {
    calls.push({ command, args, options })
    return handler({ command, args, options, index: calls.length - 1 })
  }
  run.calls = calls
  return run
}

function b64(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

function enabledService(handler, extra = {}) {
  const runner = fakeRunner(handler)
  const service = new SnipService({
    now: () => T0,
    capture: { enabled: true, platform: 'win32', available: true, runner, ...extra },
  })
  return { service, runner }
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

test('windows adapter reads UTF-8 text through fixed argv without a shell', () => {
  const text = '第一行\r\nemoji 🚀\nlast'
  const runner = fakeRunner(() => ({ status: 0, stdout: `TEXT:${b64(text)}\r\n`, stderr: '' }))
  process.env.DSH_SNIP_TEST_API_KEY = 'must-not-leak'
  process.env.SNIP_TEST_PASSWORD = 'must-not-leak'
  try {
    const adapter = createClipboardAdapter({ platform: 'win32', runner, available: true })
    assert.deepEqual(adapter.read(), { ok: true, kind: 'text', text })

    const call = runner.calls[0]
    assert.equal(call.command, 'powershell.exe')
    assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    assert.match(call.args[3], /Clipboard\]::GetContent\(\)/)
    assert.match(call.args[3], /Get-Clipboard -Raw/)
    assert.equal(call.args.length, 4, 'argv is fixed; clipboard text never becomes an argument')
    assert.equal(call.options.timeoutMs, 5000)
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsHide, true)
    assert.ok(!('DSH_SNIP_TEST_API_KEY' in call.options.env))
    assert.ok(!('SNIP_TEST_PASSWORD' in call.options.env))
  } finally {
    delete process.env.DSH_SNIP_TEST_API_KEY
    delete process.env.SNIP_TEST_PASSWORD
  }
})

test('windows adapter marks empty, image and file without returning content', () => {
  for (const [marker, expected] of [
    ['EMPTY', { ok: true, kind: 'empty' }],
    ['IMAGE', { ok: true, kind: 'image' }],
    ['FILE', { ok: true, kind: 'file' }],
  ]) {
    const runner = fakeRunner(() => ({ status: 0, stdout: `noise\n${marker}\r\n` }))
    const adapter = createClipboardAdapter({ platform: 'win32', runner, available: true })
    assert.deepEqual(adapter.read(), expected, marker)
  }

  const excludedRunner = fakeRunner(() => ({ status: 0, stdout: 'EXCLUDED' }))
  const excluded = createClipboardAdapter({ platform: 'win32', runner: excludedRunner, available: true })
  assert.deepEqual(excluded.read(), {
    ok: false,
    code: 'SNIP_CLIPBOARD_EXCLUDED',
    reason: 'clipboard content opted out of monitoring',
  })
})

test('capture stores text but reports empty/image without an entry', () => {
  for (const [marker, kind] of [['EMPTY', 'empty'], ['IMAGE', 'image'], ['FILE', 'file']]) {
    const { service, runner } = enabledService(() => ({ status: 0, stdout: marker }))
    assert.deepEqual(service.capture(), { ok: true, kind, captured: false })
    assert.equal(service.list().length, 0)
    assert.equal(runner.calls.length, 1)
  }

  const { service } = enabledService(() => ({ status: 0, stdout: `TEXT:${b64('a note')}` }))
  const captured = service.capture({ sourceApp: 'editor' })
  assert.equal(captured.captured, true)
  assert.equal(captured.kind, 'text')
  assert.match(captured.handle, /^clipboard:\/\//)
  assert.equal(captured.bytes, 6)
  assert.equal(captured.redacted, false)
  assert.ok(!JSON.stringify(captured).includes('a note'), 'tool result must not carry the text')
  assert.equal(service.get(captured.handle).text, 'a note')
  assert.equal(service.get(captured.handle).sourceApp, 'editor')
  assert.equal(Date.parse(captured.expiresAt) - T0, DAY)
})

test('maxChars truncates captured text and marks the result', () => {
  const { service } = enabledService(
    () => ({ status: 0, stdout: `TEXT:${b64('0123456789')}` }),
    { maxChars: 5 },
  )
  const captured = service.capture()
  assert.equal(captured.captured, true)
  assert.equal(captured.truncated, true)
  assert.equal(captured.bytes, 5)
  assert.equal(service.get(captured.handle).text, '01234')
})

test('capture redacts secrets and dedupes repeated content by hash', () => {
  const secret = `sk-${'a'.repeat(32)}`
  const { service, runner } = enabledService(() => ({ status: 0, stdout: `TEXT:${b64(secret)}` }))

  const first = service.capture({ sourceApp: 'shell' })
  assert.equal(first.captured, true)
  assert.equal(first.redacted, true)
  assert.equal(service.get(first.handle).text, '[redacted:openai-key]')
  assert.ok(!JSON.stringify(first).includes(secret))
  assert.equal(service.list().length, 1)

  const second = service.capture()
  assert.deepEqual(second, {
    ok: true,
    kind: 'text',
    captured: false,
    duplicate: true,
    handle: first.handle,
    redacted: true,
    tainted: true,
    taintSource: 'clipboard',
  })
  assert.equal(service.list().length, 1)
  assert.equal(runner.calls.length, 2)
})

test('dedupe does not suppress the same text after its entry expires', () => {
  let clock = T0
  const runner = fakeRunner(() => ({ status: 0, stdout: `TEXT:${b64('same text')}` }))
  const service = new SnipService({
    now: () => clock,
    ttlMs: 1000,
    capture: { enabled: true, platform: 'win32', available: true, runner },
  })
  const first = service.capture()
  assert.equal(first.captured, true)
  clock += 2000
  const second = service.capture()
  assert.equal(second.captured, true)
  assert.notEqual(second.handle, first.handle)
  assert.equal(service.list().length, 1, 'the expired entry is swept, not duplicated')
})

test('macOS and Linux adapters use their fixed commands', () => {
  const macRunner = fakeRunner(() => ({ status: 0, stdout: 'mac text' }))
  const mac = createClipboardAdapter({ platform: 'darwin', runner: macRunner, available: true })
  assert.deepEqual(mac.read(), { ok: true, kind: 'text', text: 'mac text' })
  assert.equal(macRunner.calls[0].command, 'pbpaste')
  assert.deepEqual(macRunner.calls[0].args, [])

  const wlRunner = fakeRunner(() => ({ status: 0, stdout: 'wayland text' }))
  const wl = createClipboardAdapter({
    platform: 'linux', backend: 'wl-paste', runner: wlRunner, available: true,
  })
  assert.deepEqual(wl.read(), { ok: true, kind: 'text', text: 'wayland text' })
  assert.equal(wlRunner.calls[0].command, 'wl-paste')
  assert.deepEqual(wlRunner.calls[0].args, ['--no-newline'])

  const xclipRunner = fakeRunner(() => ({ status: 0, stdout: 'x11 text' }))
  const xclip = createClipboardAdapter({
    platform: 'linux', backend: 'xclip', runner: xclipRunner, available: true,
  })
  assert.deepEqual(xclip.read(), { ok: true, kind: 'text', text: 'x11 text' })
  assert.equal(xclipRunner.calls[0].command, 'xclip')
  assert.deepEqual(xclipRunner.calls[0].args, ['-selection', 'clipboard', '-o'])
})

test('timeouts map to a stable code and never expose stderr', () => {
  const { service } = enabledService(() => ({
    status: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: 'clipboard text that must not surface',
    error: { code: 'ETIMEDOUT', message: 'spawnSync powershell.exe ETIMEDOUT' },
  }))
  assert.throws(() => service.capture(), { code: 'SNIP_CLIPBOARD_TIMEOUT' })
  assert.equal(service.list().length, 0)
})

test('missing platform and missing tools report availability instead of spawning', () => {
  const unsupported = createClipboardAdapter({ platform: 'aix' })
  const probe = unsupported.available()
  assert.equal(probe.available, false)
  assert.match(probe.reason, /unsupported/)

  const service = new SnipService({ capture: { enabled: true, platform: 'aix' } })
  assert.throws(() => service.capture(), { code: 'SNIP_CLIPBOARD_UNAVAILABLE' })
  assert.throws(() => service.watch(), { code: 'SNIP_CLIPBOARD_UNAVAILABLE' })

  const noRunner = createClipboardAdapter({ platform: 'win32', available: false })
  assert.deepEqual(noRunner.available(), { available: false, reason: 'disabled by configuration' })
})

test('capture and watch are disabled by default', () => {
  const service = new SnipService({ now: () => T0 })
  assert.equal(service.captureEnabled, false)
  assert.throws(() => service.capture(), { code: 'SNIP_CAPTURE_DISABLED' })
  assert.throws(() => service.watch(), { code: 'SNIP_CAPTURE_DISABLED' })
  assert.deepEqual(service.stopWatch(), {
    ok: true, watching: false, stopped: false, lastError: null,
  })
  assert.equal(service.list().length, 0)
})

test('watch polls with fake timers, dedupes and stops', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    const values = ['alpha', 'alpha', 'beta']
    let index = 0
    const runner = fakeRunner(() => {
      const value = values[Math.min(index, values.length - 1)]
      index += 1
      return { status: 0, stdout: `TEXT:${b64(value)}` }
    })
    const service = new SnipService({
      now: () => T0,
      capture: { enabled: true, platform: 'win32', available: true, runner },
    })

    const started = service.watch({ intervalMs: 1000 })
    assert.deepEqual(started, { ok: true, watching: true, intervalMs: 1000 })
    assert.deepEqual(service.watch({ intervalMs: 1000 }), started, 'watch is idempotent')
    assert.equal(service.list().length, 0, 'watch does not read synchronously')

    t.mock.timers.tick(1000)
    assert.equal(service.list().length, 1)
    assert.equal(runner.calls.length, 1)

    t.mock.timers.tick(1000)
    assert.equal(service.list().length, 1, 'repeated content is deduped')
    assert.equal(runner.calls.length, 2)

    t.mock.timers.tick(1000)
    assert.equal(service.list().length, 2)
    assert.equal(runner.calls.length, 3)

    const stopped = service.stopWatch()
    assert.deepEqual(stopped, { ok: true, watching: false, stopped: true, lastError: null })
    t.mock.timers.tick(5000)
    assert.equal(runner.calls.length, 3, 'a stopped watcher does not read')
    assert.equal(service.list().length, 2)

    assert.equal(service.stopWatch().stopped, false)
  } finally {
    t.mock.timers.reset()
  }
})

test('watch records only the error code when a poll fails', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { service } = enabledService(() => ({
      status: null,
      stdout: '',
      stderr: 'secret-looking stderr',
      error: { code: 'ETIMEDOUT' },
    }))
    service.watch({ intervalMs: 500 })
    t.mock.timers.tick(500)
    assert.equal(service.list().length, 0)
    const stopped = service.stopWatch()
    assert.equal(stopped.lastError, 'SNIP_CLIPBOARD_TIMEOUT')
    assert.ok(!JSON.stringify(stopped).includes('secret-looking'))
  } finally {
    t.mock.timers.reset()
  }
})

test('capture tools are explicit, return handles only and are off by default', async () => {
  const runner = fakeRunner(() => ({ status: 0, stdout: `TEXT:${b64('tool clipboard text')}` }))
  const ctx = fakeContext()
  const service = apply(ctx, {
    now: () => T0,
    capture: { enabled: true, platform: 'win32', available: true, runner },
  })
  assert.equal(ctx.get('snip'), service)
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    'snip_add', 'snip_capture', 'snip_clear', 'snip_forget', 'snip_get',
    'snip_list', 'snip_search', 'snip_watch_start', 'snip_watch_stop',
  ])

  const captured = await ctx._tools.get('snip_capture').execute({ sourceApp: 'test' })
  assert.equal(captured.captured, true)
  assert.match(captured.handle, /^clipboard:\/\//)
  assert.ok(!JSON.stringify(captured).includes('tool clipboard text'))

  const started = await ctx._tools.get('snip_watch_start').execute({ intervalMs: 60_000 })
  assert.equal(started.watching, true)
  const stopped = await ctx._tools.get('snip_watch_stop').execute({})
  assert.equal(stopped.stopped, true)

  const offCtx = fakeContext()
  apply(offCtx, { now: () => T0 })
  await assert.rejects(offCtx._tools.get('snip_capture').execute({}), {
    code: 'SNIP_CAPTURE_DISABLED',
  })
  await assert.rejects(offCtx._tools.get('snip_watch_start').execute({}), {
    code: 'SNIP_CAPTURE_DISABLED',
  })
})
