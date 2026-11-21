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
const APPROVALS = '/api/os-approvals'
const ACTIVITY = '/api/os-activity'
const ROUTES = [
  'exact:/api/os-shell/snapshot',
  'exact:/api/os-shell/act/invoke',
  'exact:/api/os-shell/snip/search',
  'exact:/api/os-shell/check/last',
  'exact:/api/os-approvals',
  'prefix:/api/os-approvals',
  'exact:/api/os-activity',
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
      const key = route.kind + ':' + route.path
      if (routes.has(key)) throw new Error('duplicate route ' + key)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    /** Mirror DSH dispatch: exact first, then the longest matching prefix. */
    find(pathname) {
      const exact = routes.get('exact:' + pathname)
      if (exact !== undefined) return exact
      let best
      for (const [key, route] of routes) {
        if (!key.startsWith('prefix:')) continue
        const prefix = key.slice('prefix:'.length)
        if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
        if (best === undefined || prefix.length > best.prefix.length) best = { route, prefix }
      }
      return best && best.route
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
  const route = webServer.find(path.split('?')[0])
  assert.ok(route, 'no route for ' + path)
  await route.handler(req, res)
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

test('apply registers the shell, approval and activity routes', async () => {
  const webServer = fakeWebServer()
  const act = { list: () => [], invoke: async () => ({ ok: true }) }
  const snip = { list: () => [], search: () => [] }
  apply(fakeContext({ act, snip }, webServer))
  assert.deepEqual([...webServer.routes.keys()], ROUTES)
  for (const route of webServer.routes.values()) assert.ok(route.kind === 'exact' || route.kind === 'prefix')
})

test('a webserver that mounts after the shell is picked up through ctx.inject', () => {
  const webServer = fakeWebServer()
  let pending
  const ctx = fakeContext()
  ctx.inject = (deps, callback) => { pending = { deps, callback } }
  apply(ctx)
  assert.deepEqual(pending.deps, { webServer: null })
  pending.callback({ webServer, effect: callback => callback() })
  assert.deepEqual([...webServer.routes.keys()], ROUTES)
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

test('GET os-approvals maps the inbox and passes the status filter', async () => {
  const webServer = fakeWebServer()
  const calls = []
  const allow = {
    requests: async filter => {
      calls.push(filter)
      return [{
        id: 'req_1',
        subject: { kind: 'session', id: '7f3a', chain: ['session:7f3a', 'agent:worker-2'] },
        capability: 'fs.write',
        scope: 'repo:/work/src',
        reason: 'write the confirmed fix',
        createdAt: 1000,
        expiresAt: 2000,
        risk: 'write',
        argsPreview: 'secret',
      }]
    },
  }
  apply(fakeContext({ allow }, webServer))
  const res = await call(webServer, APPROVALS + '?status=pending', request(APPROVALS + '?status=pending'))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [{ status: 'pending' }])
  assert.deepEqual(res.json(), {
    ok: true,
    status: 'pending',
    items: [{
      id: 'req_1',
      subject: 'session:7f3a › agent:worker-2',
      capability: 'fs.write',
      scope: 'repo:/work/src',
      reason: 'write the confirmed fix',
      createdAt: 1000,
      expiresAt: 2000,
      risk: 'write',
    }],
  })
})

test('POST approve requires by, calls Allow with the human and passes scope through', async () => {
  const webServer = fakeWebServer()
  const calls = []
  const allow = {
    requests: async filter => {
      calls.push(['requests', filter])
      return filter.status === 'pending' ? [{ id: 'req_1', subject: 'agent:worker-2' }] : []
    },
    approve: async input => {
      calls.push(['approve', input])
      return { request: { id: input.id, status: 'approved' } }
    },
  }
  apply(fakeContext({ allow }, webServer))
  const res = await call(webServer, APPROVALS + '/req_1/approve', request(APPROVALS + '/req_1/approve', 'POST', JSON.stringify({
    by: ' owner ', scope: 'repo:/work/src', subject: 'agent:worker-2',
  })))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true, approval: { request: { id: 'req_1', status: 'approved' } },
  })
  assert.deepEqual(calls, [
    ['requests', { status: 'pending' }],
    ['approve', { id: 'req_1', by: 'owner', scope: 'repo:/work/src' }],
  ])
})

test('approve/deny reject missing by, machine identities and self-approval', async () => {
  const webServer = fakeWebServer()
  let approvals = 0
  const allow = {
    requests: async () => [
      { id: 'req_1', subject: 'owner' },
      { id: 'req_2', subject: 'agent:worker-2' },
    ],
    approve: async () => { approvals += 1; return { id: 'req_1' } },
    deny: async () => { approvals += 1; return { id: 'req_1' } },
  }
  apply(fakeContext({ allow }, webServer))
  const path = APPROVALS + '/req_1/approve'

  const missing = await call(webServer, path, request(path, 'POST', '{"scope":"repo:/x"}'))
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json().code, 'by_required')

  const machine = await call(webServer, path, request(path, 'POST', '{"by":"agent:worker-2"}'))
  assert.equal(machine.statusCode, 403)
  assert.equal(machine.json().code, 'E_HUMAN_REQUIRED')

  const self = await call(webServer, path, request(path, 'POST', '{"by":"owner"}'))
  assert.equal(self.statusCode, 403)
  assert.equal(self.json().code, 'E_SELF_APPROVAL')

  const agent = APPROVALS + '/req_2/approve'
  const selfAgent = await call(webServer, agent, request(agent, 'POST', '{"by":"worker-2"}'))
  assert.equal(selfAgent.statusCode, 403)
  assert.equal(selfAgent.json().code, 'E_SELF_APPROVAL')

  const denyMissing = await call(webServer, APPROVALS + '/req_1/deny',
    request(APPROVALS + '/req_1/deny', 'POST', '{}'))
  assert.equal(denyMissing.statusCode, 400)
  assert.equal(denyMissing.json().code, 'by_required')
  assert.equal(approvals, 0, 'no decision reaches Allow without a human by')
})

test('POST deny forwards by and reason and requires an explicit human identity', async () => {
  const webServer = fakeWebServer()
  const calls = []
  const allow = {
    deny: async input => {
      calls.push(input)
      return { request: { id: input.id, status: 'denied' } }
    },
  }
  apply(fakeContext({ allow }, webServer))
  const path = APPROVALS + '/req_9/deny'
  const res = await call(webServer, path, request(path, 'POST', JSON.stringify({ by: 'owner', reason: 'not now' })))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true, approval: { request: { id: 'req_9', status: 'denied' } },
  })
  assert.deepEqual(calls, [{ id: 'req_9', by: 'owner', reason: 'not now' }])

  const noReason = await call(webServer, path, request(path, 'POST', JSON.stringify({ by: 'owner' })))
  assert.equal(noReason.statusCode, 400)
  assert.equal(noReason.json().code, 'E_REASON')
  assert.equal(calls.length, 1, 'deny without a reason never reaches Allow')
})

test('approval routes fail closed without Allow and on invalid ids', async () => {
  const noAllow = fakeWebServer()
  apply(fakeContext({}, noAllow))
  const list = await call(noAllow, APPROVALS, request(APPROVALS))
  assert.equal(list.statusCode, 503)
  assert.deepEqual(list.json(), { ok: false, code: 'service_unavailable', service: 'allow' })
  const decide = await call(noAllow, APPROVALS + '/req_1/approve',
    request(APPROVALS + '/req_1/approve', 'POST', '{"by":"owner"}'))
  assert.equal(decide.statusCode, 503)

  const webServer = fakeWebServer()
  let called = 0
  const allow = {
    requests: async () => { called += 1; return [] },
    approve: async () => { called += 1; return {} },
  }
  apply(fakeContext({ allow }, webServer))
  const invalid = await call(webServer, APPROVALS + '/bad%20id/approve',
    request(APPROVALS + '/bad%20id/approve', 'POST', '{"by":"owner"}'))
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().code, 'E_INVALID_ARGUMENT')
  assert.equal(called, 0, 'invalid ids never reach Allow')

  const unknown = await call(webServer, APPROVALS + '/req_1/delete',
    request(APPROVALS + '/req_1/delete', 'POST', '{"by":"owner"}'))
  assert.equal(unknown.statusCode, 404)
  const wrongMethod = await call(webServer, APPROVALS + '/req_1/approve',
    request(APPROVALS + '/req_1/approve', 'GET'))
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('GET os-activity merges Allow audit and Act audit newest first', async () => {
  const webServer = fakeWebServer()
  const allow = {
    audit: async limit => {
      assert.equal(limit, 50)
      return [
        { at: 100, event: 'issued', grantId: 'grant_1', subject: 'agent:a', capability: 'fs.write', scope: 'repo:/a' },
        { at: 300, event: 'denied', reason: 'no-grant', subject: 'agent:b', capability: 'net' },
      ]
    },
  }
  const act = {
    audit: async limit => {
      assert.equal(limit, 50)
      return [{ id: 'call_1', at: 200, actionId: 'echo', title: 'Echo', status: 'ok', risk: 'read' }]
    },
  }
  apply(fakeContext({ allow, act }, webServer))
  const res = await call(webServer, ACTIVITY + '?limit=50', request(ACTIVITY + '?limit=50'))
  assert.equal(res.statusCode, 200)
  const data = res.json()
  assert.equal(data.ok, true)
  assert.deepEqual(data.entries.map(entry => [entry.kind, entry.id, entry.at]), [
    ['approval', null, 300],
    ['action', 'call_1', 200],
    ['approval', 'grant_1', 100],
  ])
  assert.deepEqual(data.sources, { approvals: true, actions: true })
})

test('GET os-activity returns an empty feed when Allow and Act are absent', async () => {
  const webServer = fakeWebServer()
  apply(fakeContext({}, webServer))
  const res = await call(webServer, ACTIVITY, request(ACTIVITY))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true, limit: 50, entries: [], sources: { approvals: false, actions: false },
  })
})
