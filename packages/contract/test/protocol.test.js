import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_SCHEMA,
  ERROR_CLASSES,
  HANDLE_KINDS,
  RESULT_SCHEMA,
  OsError,
  auditEvent,
  err,
  isRetryable,
  makeHandle,
  ok,
  page,
  parseHandle,
  setCursorKey,
  toToolError,
} from '../index.js'

const ids = count => Array.from({ length: count }, (_, index) => ({ id: `i${index}` }))
const invalidCode = error => error instanceof Error && error.code === 'E_INVALID_ARGUMENT'

test('ok builds an OsResult, caps fields and sets truncated', () => {
  const result = ok({ source: 'trace' }, {
    tool: 'trace_search',
    summary: 'x'.repeat(250),
    items: ids(25),
    handles: Array.from({ length: 6 }, (_, index) => makeHandle('trace', `t${index}`)),
    requestId: 'req_1',
    auditId: 'aud_1',
    next: [{ tool: 'trace_get' }, { tool: 'a' }, { tool: 'b' }, { tool: 'c' }],
    cost: { latencyMs: 12, money: { usd: 0.01 } },
  })
  assert.equal(result.schema, RESULT_SCHEMA)
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'trace_search')
  assert.equal(result.requestId, 'req_1')
  assert.equal(result.auditId, 'aud_1')
  assert.equal(result.summary.length, 200)
  assert.equal(result.items.length, 20)
  assert.equal(result.handles.length, 5)
  assert.equal(result.next.length, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.page.limit, 20)
  assert.equal(result.page.returned, 20)
  assert.equal(result.page.total, 25)
  assert.equal(result.page.hasMore, true)
  assert.match(result.page.nextCursor, /^v1\./)
  assert.equal(result.page.items, undefined)
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].code, 'E_LIMIT')
  assert.equal(result.warnings[0].subcode, 'result_budget')
  assert.equal(result.cost.latencyMs, 12)
  assert.equal(result.cost.money.usd, 0.01)
  assert.equal(result.cost.money.estimated, false)
  assert.equal(result.data.source, 'trace')
  assert.match(result.provenance.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.provenance.hashScope, 'items+page+data')
})

test('ok stays within budget, aggregates a page and generates ids', () => {
  const items = ids(5)
  const first = page(items, { limit: 2 })
  const result = ok({}, { tool: 'list', summary: 'ok', page: first })
  assert.deepEqual(result.items, first.items)
  assert.equal(result.page.nextCursor, first.nextCursor)
  assert.equal(result.truncated, false)
  assert.equal(result.warnings.length, 0)

  const empty = ok({ count: 1 }, { tool: 'x', summary: 'one' })
  assert.match(empty.requestId, /^req_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(empty.auditId, null)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.page.limit, 0)
  assert.equal(empty.page.hasMore, false)
  assert.equal(empty.truncated, false)
})

test('page returns a signed opaque cursor that round-trips', () => {
  const list = ids(5)
  const first = page(list, { limit: 2 })
  assert.deepEqual(first.items.map(item => item.id), ['i0', 'i1'])
  assert.equal(first.limit, 2)
  assert.equal(first.returned, 2)
  assert.equal(first.total, 5)
  assert.equal(first.hasMore, true)

  const second = page(list, { limit: 2, cursor: first.nextCursor })
  assert.deepEqual(second.items.map(item => item.id), ['i2', 'i3'])
  assert.equal(second.hasMore, true)

  const last = page(list, { limit: 2, cursor: second.nextCursor })
  assert.deepEqual(last.items.map(item => item.id), ['i4'])
  assert.equal(last.returned, 1)
  assert.equal(last.hasMore, false)
  assert.equal(last.nextCursor, null)
})

test('page rejects tampered and foreign-key cursors', () => {
  const list = ids(5)
  const first = page(list, { limit: 2 })
  const [version, payload, mac] = first.nextCursor.split('.')
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  data.o = 4
  const forged = `v1.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${mac}`
  assert.throws(() => page(list, { limit: 2, cursor: forged }), invalidCode)
  assert.throws(() => page(list, { limit: 2, cursor: 'v1.bad' }), invalidCode)

  const foreign = page(list, { limit: 2, key: 'another-32-byte-secret-000000000' })
  assert.throws(
    () => page(list, { limit: 2, cursor: foreign.nextCursor, key: 'foreign-key-32-bytes-000000000000' }),
    invalidCode,
  )
})

test('setCursorKey injects the process-wide signing key', () => {
  const key = 'injected-key-0123456789abcdef'
  setCursorKey(key)
  const first = page(ids(3), { limit: 1 })
  assert.deepEqual(
    page(ids(3), { limit: 1, cursor: first.nextCursor }).items.map(item => item.id),
    ['i1'],
  )
  setCursorKey(null)
  assert.throws(() => page(ids(3), { limit: 1, cursor: first.nextCursor }), invalidCode)
})

test('handles round-trip every supported kind and reject bad refs', () => {
  for (const kind of HANDLE_KINDS) {
    const ref = makeHandle(kind, 'id_1')
    assert.equal(ref, `dsh://${kind}/id_1`)
    assert.deepEqual(parseHandle(ref), { kind, id: 'id_1' })
  }
  assert.throws(() => makeHandle('unknown', 'x'), invalidCode)
  assert.throws(() => makeHandle('trace', 'a/b'), invalidCode)
  assert.throws(() => parseHandle('dsh://trace/a/b'), invalidCode)
  assert.throws(() => parseHandle('dsh://unknown/x'), invalidCode)
  assert.throws(() => parseHandle('http://trace/x'), invalidCode)
})

test('err builds OsError with protocol defaults and normalized retry fields', () => {
  const error = err('E_TIMEOUT', {
    subcode: 'deadline', message: 'deadline exceeded', retryable: true, retryAfterMs: 1500,
    remediation: 'retry with timeoutMs=20000', nextTools: [{ tool: 'seek_search', why: 'retry' }],
    requestId: 'req_1', auditId: 'aud_1', details: { timeoutMs: 8000 },
  })
  assert.ok(error instanceof OsError)
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'E_TIMEOUT')
  assert.equal(error.subcode, 'deadline')
  assert.equal(error.retryable, true)
  assert.equal(error.retryAfterMs, 1500)
  assert.equal(error.requestId, 'req_1')
  assert.equal(error.auditId, 'aud_1')
  assert.deepEqual(error.toJSON().details, { timeoutMs: 8000 })
  assert.equal(error.toJSON().cause, null)

  const notRetryable = err('E_INVALID_ARGUMENT', { retryable: false, retryAfterMs: 500, message: 'bad argument' })
  assert.equal(notRetryable.retryAfterMs, null)
  assert.equal(err('E_UNAVAILABLE', { retryable: true, retryAfterMs: 9e9 }).retryAfterMs, 600000)
  assert.equal(err('E_INTERNAL', { message: 'y'.repeat(500) }).message.length, 240)

  const pending = err('E_DENIED', {
    subcode: 'grant_required', message: 'need a grant', details: { approvalRequestId: 'arq_1' },
  })
  assert.equal(pending.retryable, true)
  assert.equal(pending.retryAfterMs, 2000)
})

test('err aliases legacy codes and keeps details.legacyCode', () => {
  const aliased = err('E_INPUT', { message: 'bad' })
  assert.equal(aliased.code, 'E_INVALID_ARGUMENT')
  assert.equal(aliased.subcode, 'invalid_argument')
  assert.equal(aliased.details.legacyCode, 'E_INPUT')
  assert.equal(err('snip_not_found').code, 'E_NOT_FOUND')
  assert.equal(err('action_exists').subcode, 'already_exists')
  assert.equal(err('action_failed').code, 'E_INTERNAL')
})

test('ERROR_CLASSES is the closed nine-class enum', () => {
  assert.deepEqual([...ERROR_CLASSES], [
    'E_INVALID_ARGUMENT', 'E_DENIED', 'E_NOT_FOUND', 'E_CONFLICT', 'E_UNAVAILABLE',
    'E_LIMIT', 'E_STATE', 'E_TIMEOUT', 'E_INTERNAL',
  ])
  assert.ok(Object.isFrozen(ERROR_CLASSES))
})

test('isRetryable follows class and subcode defaults', () => {
  assert.equal(isRetryable('E_TIMEOUT'), true)
  assert.equal(isRetryable('E_INVALID_ARGUMENT'), false)
  assert.equal(isRetryable('E_LIMIT', 'rate_limited'), true)
  assert.equal(isRetryable('E_LIMIT', 'quota_exceeded'), false)
  assert.equal(isRetryable('E_TIMEOUT', 'outcome_unknown'), false)
  assert.equal(isRetryable('E_INTERNAL', 'transient'), true)
  assert.equal(isRetryable('E_INPUT'), false)
  assert.equal(isRetryable(err('E_DENIED')), false)
  assert.equal(isRetryable(err('E_TIMEOUT', { retryable: true })), true)
})

test('toToolError normalizes OsError, legacy codes and old envelopes', () => {
  const direct = toToolError(err('E_DENIED', {
    subcode: 'grant_required', message: 'need a grant', requestId: 'req_2',
  }))
  assert.equal(direct.ok, false)
  assert.equal(direct.error.code, 'E_DENIED')
  assert.equal(direct.error.subcode, 'grant_required')
  assert.equal(direct.error.requestId, 'req_2')

  const legacy = toToolError(Object.assign(new Error('invalid input'), { code: 'E_INPUT' }))
  assert.equal(legacy.error.code, 'E_INVALID_ARGUMENT')
  assert.equal(legacy.error.details.legacyCode, 'E_INPUT')
  assert.match(legacy.error.requestId, /^req_/)

  const old = toToolError({ ok: false, code: 'E_NOT_FOUND', message: 'missing', requestId: 'req_3' })
  assert.equal(old.error.code, 'E_NOT_FOUND')
  assert.equal(old.error.requestId, 'req_3')

  const wrapped = toToolError({ ok: false, error: 'down', requestId: 'req_4' })
  assert.equal(wrapped.error.code, 'E_INTERNAL')
  assert.equal(wrapped.error.message, 'down')
  assert.equal(wrapped.error.requestId, 'req_4')

  const abort = toToolError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  assert.equal(abort.error.code, 'E_TIMEOUT')
  assert.equal(abort.error.subcode, 'cancelled')
  assert.equal(abort.error.retryable, false)

  const internal = toToolError(new TypeError('boom'))
  assert.equal(internal.error.code, 'E_INTERNAL')
  assert.deepEqual(internal.error.cause, { name: 'TypeError', code: null, message: 'boom' })
})

test('auditEvent returns a minimal in-memory event', () => {
  const result = { ok: true }
  const cost = { tokens: 12 }
  const event = auditEvent({
    actor: 'user:acme', tool: 'trace_search', capability: 'trace.read',
    argsHash: 'sha256:abc', result, cost,
  })
  assert.equal(event.schema, AUDIT_SCHEMA)
  assert.match(event.id, /^aud_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(event.actor, 'user:acme')
  assert.equal(event.tool, 'trace_search')
  assert.equal(event.capability, 'trace.read')
  assert.equal(event.argsHash, 'sha256:abc')
  assert.equal(event.result, result)
  assert.equal(event.cost, cost)
  assert.equal(typeof event.at, 'number')
  assert.throws(() => auditEvent(null), invalidCode)
})
