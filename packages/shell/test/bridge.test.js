import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const PATHS = [
  '/api/os-shell/snapshot',
  '/api/os-shell/act/invoke',
  '/api/os-shell/snip/search',
  '/api/os-shell/check/last',
]

function fakeContext(services = {}, webServer) {
  const map = new Map(Object.entries(services))
  const tools = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => map.set(name, value),
    get: name => map.get(name),
    webServer,
    _services: map,
  }
}

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers = {}) {
      this.statusCode = status
      Object.assign(this.headers, headers)
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
    },
    json() { return JSON.parse(this.body) },
  }
}

function request(url, method = 'GET', body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  return req
}

async function call(webServer, path, req) {
  const res = fakeRes()
  await webServer.routes.get(path).handler(req, res)
  return res
}

const report = {
  schema: 'dsh.check.diff/v1',
  verdict: 'regression',
  summary: { tasks: 1, compared: 1, regressions: 1, warnings: 0, ignored: 0, added: 0 },
  tasks: [{ id: 'golden', verdict: 'regression', ignored: false, diffs: [] }],
}

test('apply without a webserver skips routes and snapshot marks absent services', async () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  assert.equal(ctx.get('osShell'), service)
  assert.deepEqual(await service.snapshot(), {
    act: { available: false },
    snip: { available: false },
    check: { available: false },
  })
})

test('snapshot aggregates Act actions, Snip summaries and the last Check report', async () => {
  const act = {
    list: () => [
      { id: 'echo', title: 'Echo', risk: 'read', execute() {}, parameters: { type: 'object' } },
      { id: 'write.file', title: 'Write', risk: 'write', description: 'Writes.', execute() {} },
    ],
  }
  const snip = { list: ({ limit }) => (assert.equal(limit, 50), [{ id: 's1', kind: 'text', preview: 'hi' }]) }
  const check = { last: () => report }
  const service = apply(fakeContext({ act, snip, check }))

  const snapshot = await service.snapshot()
  assert.deepEqual(snapshot.act, {
    available: true,
    actions: [
      { id: 'echo', title: 'Echo', risk: 'read' },
      { id: 'write.file', title: 'Write', risk: 'write', description: 'Writes.' },
    ],
  })
  assert.deepEqual(snapshot.snip, {
    available: true,
    entries: [{ id: 's1', kind: 'text', preview: 'hi' }],
  })
  assert.deepEqual(snapshot.check, { available: true, last: report, exitCode: 1 })
})

test('snapshot accepts a check last/lastReport property and maps pass to exit 0', async () => {
  const service = apply(fakeContext({ check: { last: { verdict: 'pass' } } }))
  assert.deepEqual((await service.snapshot()).check, {
    available: true, last: { verdict: 'pass' }, exitCode: 0,
  })
  const wrapped = apply(fakeContext({ check: { lastReport: { verdict: 'warning' } } }))
  assert.deepEqual((await wrapped.snapshot()).check, {
    available: true, last: { verdict: 'warning' }, exitCode: 0,
  })
  const history = apply(fakeContext({ check: { history: [{ verdict: 'pass' }, report] } }))
  assert.deepEqual((await history.snapshot()).check, { available: true, last: report, exitCode: 1 })
})

test('apply registers exactly the four exact routes on a webserver', async () => {
  const webServer = fakeWebServer()
  const act = { list: () => [], invoke: async () => ({ ok: true }) }
  const snip = { list: () => [], search: () => [] }
  apply(fakeContext({ act, snip }, webServer))
  assert.deepEqual([...webServer.routes.keys()], PATHS)
  for (const route of webServer.routes.values()) assert.equal(route.kind, 'exact')
})

test('a webserver that mounts after the shell is picked up through ctx.inject', () => {
  const webServer = fakeWebServer()
  let pending
  const ctx = fakeContext()
  ctx.inject = (deps, callback) => { pending = { deps, callback } }
  apply(ctx)
  assert.deepEqual(pending.deps, { webServer: null })
  pending.callback({ webServer, effect: callback => callback() })
  assert.deepEqual([...webServer.routes.keys()], PATHS)
})

test('GET snapshot answers JSON with no-store', async () => {
  const webServer = fakeWebServer()
  const act = { list: () => [{ id: 'echo', title: 'Echo', risk: 'read' }] }
  apply(fakeContext({ act }, webServer))
  const res = await call(webServer, PATHS[0], request(PATHS[0]))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(res.json(), {
    ok: true,
    snapshot: {
      act: { available: true, actions: [{ id: 'echo', title: 'Echo', risk: 'read' }] },
      snip: { available: false },
      check: { available: false },
    },
  })
})

test('POST act/invoke passes args and the fixed UI subject and preserves grant_required', async () => {
  const webServer = fakeWebServer()
  const calls = []
  const act = {
    list: () => [],
    async invoke(id, args, meta) {
      calls.push({ id, args, meta })
      return { ok: false, code: 'grant_required', actionId: id, capability: 'act:invoke:' + id }
    },
  }
  apply(fakeContext({ act }, webServer))
  const res = await call(webServer, PATHS[1], request(PATHS[1], 'POST', JSON.stringify({
    id: 'write.file', args: { path: 'x' },
  })))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [{
    id: 'write.file',
    args: { path: 'x' },
    meta: { subject: 'ui:os-shell', origin: 'ui' },
  }])
  assert.deepEqual(res.json(), {
    ok: false, code: 'grant_required', actionId: 'write.file', capability: 'act:invoke:write.file',
  })
})

test('POST act/invoke rejects bad input, missing service and wrong method', async () => {
  const missing = fakeWebServer()
  apply(fakeContext({}, missing))
  const unavailable = await call(missing, PATHS[1], request(PATHS[1], 'POST', '{"id":"x"}'))
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.json().code, 'service_unavailable')

  const webServer = fakeWebServer()
  apply(fakeContext({ act: { list: () => [], invoke: async () => ({ ok: true }) } }, webServer))
  const invalid = await call(webServer, PATHS[1], request(PATHS[1], 'POST', '{oops'))
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().code, 'invalid_json')
  const badShape = await call(webServer, PATHS[1], request(PATHS[1], 'POST', '{"args":{}}'))
  assert.equal(badShape.statusCode, 400)
  assert.equal(badShape.json().code, 'invalid_argument')
  const wrongMethod = await call(webServer, PATHS[1], request(PATHS[1], 'GET'))
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('snip search uses q, clamps limit and includes full text only when get succeeds', async () => {
  const webServer = fakeWebServer()
  const seen = []
  const snip = {
    list: options => (seen.push(['list', options]), [{ id: 's1', preview: 'one' }, { id: 's2', preview: 'two' }]),
    search: (query, options) => (seen.push(['search', query, options]), [{ id: 's1', preview: 'one' }]),
    get: id => (id === 's1' ? { id, text: '[redacted:secret]' } : null),
  }
  apply(fakeContext({ snip }, webServer))

  const searched = await call(webServer, PATHS[2], request(PATHS[2] + '?q=needle&limit=5'))
  assert.equal(searched.statusCode, 200)
  assert.deepEqual(seen[0], ['search', 'needle', { limit: 5 }])
  assert.deepEqual(searched.json().entries[0], { id: 's1', preview: 'one', text: '[redacted:secret]' })

  const listed = await call(webServer, PATHS[2], request(PATHS[2]))
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(seen[1], ['list', { limit: 50 }])
  assert.deepEqual(listed.json().entries, [
    { id: 's1', preview: 'one', text: '[redacted:secret]' },
    { id: 's2', preview: 'two' },
  ])
})

test('snip search maps a missing service to 503 and a SNIP_ error to 400', async () => {
  const missing = fakeWebServer()
  apply(fakeContext({}, missing))
  const unavailable = await call(missing, PATHS[2], request(PATHS[2]))
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.json().service, 'snip')

  const webServer = fakeWebServer()
  const snip = {
    list: () => [],
    search: () => { throw Object.assign(new Error('query must be non-empty'), { code: 'SNIP_BAD_QUERY' }) },
  }
  apply(fakeContext({ snip }, webServer))
  const badQuery = await call(webServer, PATHS[2], request(PATHS[2] + '?q=x'))
  assert.equal(badQuery.statusCode, 400)
  assert.equal(badQuery.json().code, 'SNIP_BAD_QUERY')
})

test('GET check/last returns availability, the report and its exit code', async () => {
  const webServer = fakeWebServer()
  const check = { last: () => report }
  apply(fakeContext({ check }, webServer))
  const res = await call(webServer, PATHS[3], request(PATHS[3]))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, available: true, last: report, exitCode: 1 })

  const empty = fakeWebServer()
  apply(fakeContext({}, empty))
  const unavailable = await call(empty, PATHS[3], request(PATHS[3]))
  assert.deepEqual(unavailable.json(), { ok: true, available: false })
})
