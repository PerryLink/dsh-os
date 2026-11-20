import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, TriggerService } from '../index.js'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** Fake Cordis context with a usable `on()` registry (docs/implementation-contract.md). */
function fakeContext(extra = {}) {
  const tools = new Map()
  const services = new Map()
  const listeners = new Map()
  const provided = new Map(Object.entries(extra))
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name) ?? provided.get(name),
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    _tools: tools,
    _services: services,
    _listeners: listeners,
    _emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    _listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    ...extra,
  }
}

/** In-memory fs provider: `stat` / `listDir` / `watch` over one path→entry map. */
function fakeFs(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([path, entry]) => [path, { ...entry }]))
  const watchers = []
  return {
    entries,
    watchers,
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const entry = entries.get(target.displayPath)
      return entry === undefined
        ? undefined
        : { type: entry.type, size: entry.size, version: entry.version }
    },
    async listDir(target) {
      const prefix = `${target.displayPath}/`
      const result = []
      for (const [path, entry] of entries) {
        if (!path.startsWith(prefix)) continue
        const name = path.slice(prefix.length)
        if (name.includes('/')) continue
        result.push({
          name, type: entry.type, size: entry.size, version: entry.version,
          target: { targetKey: path, displayPath: path },
        })
      }
      return result
    },
    async watch(target, changed, signal) {
      const record = { target, changed, signal, closed: false }
      watchers.push(record)
      return async () => {
        record.closed = true
      }
    },
  }
}

/** Fake web server: `register` records named routes and builds the disposer. */
function fakeWebServer({ host = '127.0.0.1' } = {}) {
  const routes = new Map()
  return {
    host,
    protocol: 'http',
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function makeRequest({ method = 'POST', headers = {}, body = '', remote = '127.0.0.1' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.headers = headers
  req.socket = { remoteAddress: remote }
  return req
}

function makeResponse() {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
    },
  }
}

async function post(route, { headers = {}, body = '', method = 'POST', remote = '127.0.0.1' } = {}) {
  const res = makeResponse()
  await route.handler(makeRequest({ method, headers, body, remote }), res)
  return { status: res.status, headers: res.headers, body: res.body === '' ? {} : JSON.parse(res.body) }
}

const sign = (secret, timestamp, body) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

test('agent source projects session/agent events, dedupes by session:seq and unsubscribes', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  const seen = []
  for (const event of [
    'session/turn-end', 'session/approval-asked', 'session/tool-result', 'agent/error', 'agent/status',
  ]) {
    service.register({ id: `tg_${event.replace(/[/-]/g, '_')}`, event, action: payload => seen.push({ event, payload }) })
  }

  const source = await service.startSource('agent')
  assert.match(source.id, /^src_/)
  assert.equal(source.info.sessionId, null)
  assert.equal(ctx._listenerCount(), 3)

  const session = { id: 'ses_1' }
  ctx._emit('session/event', session, { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } })
  // A re-delivered seq must not run the action again.
  ctx._emit('session/event', session, { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } })
  ctx._emit('session/event', session, { type: 'step/end', seq: 8, data: { turn: 2, step: 1 } })
  ctx._emit('session/event', session, {
    type: 'tool/result',
    seq: 9,
    data: {
      turn: 2,
      step: 1,
      message: { callId: 'c1', isError: true, content: 'secret tool output' },
      error: { code: 'E_TOOL', name: 'ToolError' },
    },
  })
  ctx._emit('session/event', session, {
    type: 'approval/asked', seq: 10, data: { id: 'ask_1', toolName: 'bash', callId: 'c2' },
  })
  ctx._emit('agent/error', { agent: { session }, turn: 2, step: 1, error: new Error('boom') })
  ctx._emit('agent/status', { agent: { session }, status: 'running' })
  await tick()

  assert.deepEqual(seen.map(entry => entry.event), [
    'session/turn-end', 'session/tool-result', 'session/approval-asked', 'agent/error', 'agent/status',
  ])
  assert.deepEqual(seen[0].payload, {
    type: 'session/turn-end', sessionId: 'ses_1', seq: 7, data: { turn: 2, reason: 'completed' },
  })
  assert.deepEqual(seen[1].payload.data, {
    turn: 2, step: 1, callId: 'c1', isError: true, error: 'E_TOOL',
  })
  assert.equal(JSON.stringify(seen[1].payload).includes('secret tool output'), false)
  assert.deepEqual(seen[2].payload.data, { id: 'ask_1', toolName: 'bash', callId: 'c2' })
  assert.deepEqual(seen[3].payload.error, { name: 'Error', code: null, message: 'boom' })
  assert.deepEqual(seen[4].payload, { type: 'agent/status', sessionId: 'ses_1', status: 'running' })
  assert.equal(service.runs().length, 5)

  const listed = service.sources()[0]
  assert.equal(listed.events, 5)
  assert.equal(listed.dropped, 0)
  assert.equal(await service.stopSource(source.id), true)
  assert.equal(ctx._listenerCount(), 0)

  ctx._emit('session/event', session, { type: 'turn/end', seq: 11, data: { turn: 3, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(seen.length, 5)
  assert.equal(await service.stopSource(source.id), false)
})

test('agent source honours a sessionId filter and fails closed without ctx.on', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  const hits = []
  service.register({ id: 'tg_keep', event: 'session/turn-end', action: payload => hits.push(payload.sessionId) })
  await service.startSource('agent', { sessionId: 'ses_keep' })

  const event = { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }
  ctx._emit('session/event', { id: 'ses_drop' }, event)
  ctx._emit('session/event', { id: 'ses_keep' }, event)
  await tick()
  assert.deepEqual(hits, ['ses_keep'])

  const bare = apply({ provide() {} })
  await assert.rejects(bare.startSource('agent'), { code: 'E_UNAVAILABLE' })
  assert.ok(service instanceof TriggerService)
})

test('fs source diffs path+size+version snapshots non-recursively and stops cleanly', async () => {
  const fs = fakeFs({
    '/work': { type: 'directory' },
    '/work/keep.txt': { type: 'file', size: 1, version: 'v1' },
  })
  const service = apply(fakeContext({ fs }))
  const changes = []
  service.register({ id: 'tg_fs', event: 'fs.change', action: payload => changes.push(payload) })
  const source = await service.startSource('fs', { path: '/work', debounceMs: 5 })
  assert.equal(source.info.path, '/work')
  assert.equal(source.info.recursive, false)
  assert.equal(fs.watchers.length, 1)

  const invalidate = async () => {
    fs.watchers[0].changed()
    await tick(30)
  }

  fs.entries.set('/work/new.txt', { type: 'file', size: 3, version: 'v1' })
  await invalidate()
  fs.entries.set('/work/new.txt', { type: 'file', size: 3, version: 'v2' })
  await invalidate()
  fs.entries.set('/work/new.txt', { type: 'file', size: 4, version: 'v2' })
  await invalidate()
  fs.entries.set('/work/sub', { type: 'directory' })
  fs.entries.set('/work/sub/nested.txt', { type: 'file', size: 1, version: 'v1' })
  await invalidate()
  fs.entries.delete('/work/new.txt')
  await invalidate()
  await invalidate()

  assert.deepEqual(changes, [
    { type: 'fs.change', path: join('/work', 'new.txt'), kind: 'add' },
    { type: 'fs.change', path: join('/work', 'new.txt'), kind: 'change' },
    { type: 'fs.change', path: join('/work', 'new.txt'), kind: 'change' },
    { type: 'fs.change', path: join('/work', 'sub'), kind: 'add' },
    { type: 'fs.change', path: join('/work', 'new.txt'), kind: 'unlink' },
  ])
  assert.equal(changes.some(change => change.path.includes('nested.txt')), false)

  assert.equal(await service.stopSource(source.id), true)
  assert.equal(fs.watchers[0].closed, true)
  fs.entries.set('/work/after.txt', { type: 'file', size: 1, version: 'v1' })
  fs.watchers[0].changed()
  await tick(30)
  assert.equal(changes.length, 5)
})

test('fs source reports E_UNAVAILABLE without ctx.fs and validates its path', async () => {
  const bare = apply(fakeContext())
  await assert.rejects(bare.startSource('fs', { path: '/work' }), { code: 'E_UNAVAILABLE' })
  const withFs = apply(fakeContext({ fs: fakeFs() }))
  await assert.rejects(withFs.startSource('fs', {}), { code: 'invalid_source' })

  const noWatch = fakeFs()
  noWatch.watch = async () => {
    throw Object.assign(new Error('watching is not supported'), { code: 'FS_IO_ERROR' })
  }
  const unsupported = apply(fakeContext({ fs: noWatch }))
  await assert.rejects(unsupported.startSource('fs', { path: '/work' }), { code: 'E_UNAVAILABLE' })
  assert.deepEqual(unsupported.sources(), [])
})

test('webhook source verifies HMAC, timestamp, body bound, loopback and delivery dedupe', async () => {
  const webServer = fakeWebServer()
  const service = apply(fakeContext({ webServer }))
  const received = []
  service.register({ id: 'tg_hook', event: 'webhook/received', action: payload => received.push(payload) })

  const secret = 'top-secret'
  const source = await service.startSource('webhook', {
    token: 'test-token-1234', secret, maxBodyBytes: 256,
  })
  assert.equal(source.info.path, '/os-trigger/test-token-1234')
  assert.equal(source.info.signed, true)
  assert.equal(source.info.loopbackOnly, true)
  const route = webServer.routes.get(source.info.path)
  assert.equal(route.kind, 'exact')
  assert.equal(route.auth, 'anonymous')
  assert.equal(typeof route.handler, 'function')

  const body = JSON.stringify({ action: 'opened', number: 7 })
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = {
    'content-type': 'application/json',
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'pull_request',
    'x-dsh-trigger-timestamp': String(timestamp),
    'x-dsh-trigger-signature-256': sign(secret, timestamp, body),
  }

  const accepted = await post(route, { headers, body })
  assert.equal(accepted.status, 202)
  await tick()
  assert.deepEqual(received, [{
    type: 'webhook/received',
    deliveryId: 'delivery-1',
    event: 'pull_request',
    body: { action: 'opened', number: 7 },
    remote: '127.0.0.1',
  }])

  const duplicate = await post(route, { headers, body })
  assert.equal(duplicate.status, 202)
  assert.equal(duplicate.headers['x-dsh-trigger-duplicate'], '1')
  await tick()
  assert.equal(received.length, 1)

  assert.equal((await post(route, {
    headers: { ...headers, 'x-github-delivery': 'delivery-2' }, body: `${body} `,
  })).status, 401)

  const stale = timestamp - 301
  assert.equal((await post(route, {
    headers: {
      ...headers,
      'x-github-delivery': 'delivery-3',
      'x-dsh-trigger-timestamp': String(stale),
      'x-dsh-trigger-signature-256': sign(secret, stale, body),
    },
    body,
  })).status, 401)

  const future = timestamp + 301
  assert.equal((await post(route, {
    headers: {
      ...headers,
      'x-github-delivery': 'delivery-5',
      'x-dsh-trigger-timestamp': String(future),
      'x-dsh-trigger-signature-256': sign(secret, future, body),
    },
    body,
  })).status, 401)

  assert.equal((await post(route, { headers, body, remote: '10.0.0.5' })).status, 403)
  assert.equal((await post(route, { headers, body, method: 'GET' })).status, 405)

  const oversized = await post(route, {
    headers: { ...headers, 'x-github-delivery': 'delivery-4' }, body: 'x'.repeat(300),
  })
  assert.equal(oversized.status, 413)
  assert.equal(oversized.headers.connection, 'close')
  await tick()
  assert.equal(received.length, 1)
  assert.equal(webServer.routes.size, 1)
})

test('webhook source is unsigned without a secret, rejects unavailable profiles and stops its route', async () => {
  const webServer = fakeWebServer()
  const service = apply(fakeContext({ webServer }))
  const received = []
  service.register({ id: 'tg_unsigned', event: 'webhook/received', action: payload => received.push(payload) })
  const source = await service.startSource('webhook', {})
  assert.equal(source.info.signed, false)
  assert.match(source.info.path, /^\/os-trigger\/[A-Za-z0-9_-]{8,}$/)
  const route = webServer.routes.get(source.info.path)

  assert.equal((await post(route, { body: JSON.stringify({ ok: true }) })).status, 202)
  await tick()
  assert.equal(received.length, 1)
  assert.equal(received[0].remote, '127.0.0.1')
  assert.equal(received[0].event, null)

  const token = source.info.path.split('/').pop()
  await assert.rejects(service.startSource('webhook', { token }), { code: 'E_UNAVAILABLE' })
  await assert.rejects(service.startSource('webhook', { token: 'short' }), { code: 'invalid_source' })
  await assert.rejects(
    apply(fakeContext({ webServer: fakeWebServer({ host: '0.0.0.0' }) })).startSource('webhook', {}),
    { code: 'E_UNAVAILABLE' },
  )
  await assert.rejects(apply(fakeContext()).startSource('webhook', {}), { code: 'E_UNAVAILABLE' })

  assert.equal(await service.stopSource(source.id), true)
  assert.equal(webServer.routes.size, 0)

  process.env.DSH_TRIGGER_TEST_SECRET = 'env-secret'
  try {
    const fromEnv = await service.startSource('webhook', { secretEnv: 'DSH_TRIGGER_TEST_SECRET' })
    assert.equal(fromEnv.info.signed, true)
    assert.equal(await service.stopSource(fromEnv.id), true)
  } finally {
    delete process.env.DSH_TRIGGER_TEST_SECRET
  }
})

test('startSource validates types and ids; sources() and dispose() own the lifecycle', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  await assert.rejects(service.startSource('nope'), { code: 'invalid_source' })
  await assert.rejects(service.startSource('agent', null), { code: 'invalid_source' })
  await assert.rejects(new TriggerService().startSource('agent'), { code: 'E_UNAVAILABLE' })

  const first = await service.startSource('agent', { id: 'src_custom' })
  assert.equal(first.id, 'src_custom')
  await assert.rejects(service.startSource('agent', { id: 'src_custom' }), { code: 'source_exists' })
  await service.startSource('agent')
  assert.deepEqual(service.sources().map(entry => entry.type), ['agent', 'agent'])
  assert.equal(await service.stopSource('missing'), false)
  assert.equal(await service.stopSource('src_custom'), true)
  assert.equal(service.sources().length, 1)

  await service.dispose()
  assert.deepEqual(service.sources(), [])
  assert.equal(ctx._listenerCount(), 0)
})

test('apply disposes running sources on plugin unload', async () => {
  const effects = []
  const ctx = fakeContext({ effect: callback => (effects.push(callback()), () => {}) })
  const service = apply(ctx)
  await service.startSource('agent')
  assert.equal(service.sources().length, 1)
  await effects[0]()
  assert.deepEqual(service.sources(), [])
})

test('source tools start, list and stop a source end to end', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const start = args => ctx._tools.get('trigger_source_start').execute(args)
  const list = () => ctx._tools.get('trigger_sources').execute({})
  const stop = args => ctx._tools.get('trigger_source_stop').execute(args)

  const started = await start({ type: 'agent', sessionId: 'ses_tool' })
  assert.match(started.source.id, /^src_/)
  assert.equal(started.source.info.sessionId, 'ses_tool')
  assert.deepEqual((await list()).sources.map(entry => entry.id), [started.source.id])

  assert.deepEqual(await stop({ id: started.source.id }), { id: started.source.id, stopped: true })
  assert.deepEqual((await list()).sources, [])
  await assert.rejects(start({ type: 'nope' }), { code: 'invalid_source' })
  await assert.rejects(start({ type: '' }), { code: 'invalid_arguments' })
  await assert.rejects(stop({}), { code: 'invalid_arguments' })
})
