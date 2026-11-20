import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import {
  ADAPTER_ID,
  FORMAT,
  MEMENTO_ADAPTER,
  registerDefaultAdapter,
} from '../lib/memento.js'

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = 1_700_000_000_000

function entry(n, overrides = {}) {
  return {
    id: uuid(n),
    track: 'user',
    scope: 'user-global',
    workspaceKey: '',
    agentKey: '',
    text: `Memory ${n}.`,
    source: 'memento',
    tags: [],
    version: 1,
    createdAt: T0 + n,
    updatedAt: T0 + n,
    lastRecalled: null,
    recallCount: 0,
    sessionId: null,
    ...overrides,
  }
}

/** Fake Cordis context: tools + provide/get, optional memento services. */
function fakeContext({ memory, adapters } = {}) {
  const tools = new Map()
  const services = new Map()
  if (memory !== undefined) services.set('memory', memory)
  if (adapters !== undefined) services.set('memoryAdapters', adapters)
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}

function setup(options = {}) {
  const ctx = fakeContext(options)
  return { ctx, service: apply(ctx) }
}

/** Synchronous mock of ctx.memory (protocol v1 query is synchronous). */
function mockMemory(entries) {
  const calls = []
  return {
    calls,
    query(filter = {}, opts = {}) {
      calls.push({ filter, opts })
      let hits = entries.filter(item => !filter.scope || item.scope === filter.scope)
      if (filter.track !== undefined) hits = hits.filter(item => item.track === filter.track)
      const limit = Math.min(filter.limit ?? 100, 1000)
      return { entries: hits.slice(0, limit), total: hits.length, truncated: hits.length > limit }
    },
  }
}

function mockAdapters() {
  const map = new Map()
  const registers = []
  return {
    map,
    registers,
    register(adapter) {
      registers.push(adapter.id)
      if (map.has(adapter.id)) {
        throw Object.assign(new Error(`adapter ${adapter.id} already registered`), { code: 'INVALID_INPUT' })
      }
      map.set(adapter.id, adapter)
      return () => map.delete(adapter.id)
    },
    list: () => [...map.values()].map(adapter => adapter.id),
    adapt(id, payload) {
      const adapter = map.get(id)
      if (adapter === undefined) throw Object.assign(new Error('adapter not found'), { code: 'ADAPTER_NOT_FOUND' })
      return adapter.adapt(payload)
    },
    export(id, entries) {
      const adapter = map.get(id)
      if (adapter === undefined) throw Object.assign(new Error('adapter not found'), { code: 'ADAPTER_NOT_FOUND' })
      return adapter.export(entries)
    },
  }
}

const call = (ctx, name, args = {}) => ctx._tools.get(name).execute(args)

test('apply probes memento but does not register an adapter (read-only posture)', async () => {
  const adapters = mockAdapters()
  const { ctx } = setup({ memory: mockMemory([entry(1)]), adapters })

  assert.deepEqual(adapters.registers, [], 'apply must not install an adapter')
  const status = await call(ctx, 'trace_adapter_status')
  assert.equal(status.ok, true)
  assert.equal(status.available, true)
  assert.deepEqual(status.services, { memory: true, memoryAdapters: true })
  assert.equal(status.adapter.id, ADAPTER_ID)
  assert.equal(status.adapter.registered, false)
  assert.equal(status.adapter.mode, 'read-only')
  assert.equal(status.adapter.reason, null)
  assert.deepEqual(status.adapter.importFormats, [FORMAT, 'trace-export-v1'])
})

test('import defaults to user-global and maps id/text/source/scope/createdAt', async () => {
  const memory = mockMemory([
    entry(1, { text: 'Prefers pnpm.', tags: ['tooling'] }),
    entry(2, { track: 'agent', scope: 'workspace', workspaceKey: '/repo', text: 'Node 22.' }),
  ])
  const { ctx, service } = setup({ memory })

  const result = await call(ctx, 'trace_import_memento')
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'user')
  assert.equal(result.imported, 1)
  assert.equal(result.total, 1)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(memory.calls[0], { filter: { scope: 'user-global', limit: 20 }, opts: {} })

  const record = service.get(`memento:${uuid(1)}`)
  assert.equal(record.text, 'Prefers pnpm.')
  assert.equal(record.provenance.source, 'memento')
  assert.equal(record.scope, 'user')
  assert.equal(record.confidence, 0.5)
  assert.equal(record.provenance.createdAt, T0 + 1)
  assert.equal(record.provenance.updatedAt, T0 + 1)
  assert.equal(service.get(`memento:${uuid(2)}`), null)
})

test('workspace import is an explicit, warned opt-in and forwards agentKey', async () => {
  const memory = mockMemory([
    entry(1),
    entry(2, { track: 'agent', scope: 'workspace', text: 'Repo uses Node 22.' }),
  ])
  const { ctx, service } = setup({ memory })

  const result = await call(ctx, 'trace_import_memento', { scope: 'workspace', agentKey: 'preset:web' })
  assert.equal(result.imported, 1)
  assert.equal(result.scope, 'workspace')
  assert.match(result.warning, /workspaceKey/)
  assert.deepEqual(memory.calls[0], {
    filter: { scope: 'workspace', limit: 20 },
    opts: { agentKey: 'preset:web' },
  })
  assert.equal(service.get(`memento:${uuid(2)}`).scope, 'workspace')
})

test('import honors the trace extension: key, scope, confidence, expiresAt', async () => {
  const future = Date.now() + 86_400_000
  const memory = mockMemory([
    entry(3, {
      scope: 'workspace',
      text: 'Team decision: ship Trace.',
      createdAt: T0,
      trace: {
        key: 'team:decision',
        scope: 'team',
        confidence: 0.8,
        expiresAt: future,
      },
    }),
  ])
  const { ctx, service } = setup({ memory })

  const result = await call(ctx, 'trace_import_memento', { scope: 'workspace' })
  assert.equal(result.imported, 1)
  const record = service.get('team:decision')
  assert.equal(record.text, 'Team decision: ship Trace.')
  assert.equal(record.scope, 'team')
  assert.equal(record.confidence, 0.8)
  assert.equal(record.expiresAt, future)
  assert.equal(record.provenance.createdAt, T0)
})

test('import reports a higher-confidence conflict instead of overwriting it', async () => {
  const memory = mockMemory([
    entry(4, {
      text: 'Use npm.',
      trace: { key: 'tool:pnpm', confidence: 0.2 },
    }),
  ])
  const { ctx, service } = setup({ memory })
  const current = service.remember({ key: 'tool:pnpm', text: 'Use pnpm.', confidence: 0.9 })

  const result = await call(ctx, 'trace_import_memento')
  assert.equal(result.imported, 0)
  assert.equal(result.total, 1)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].key, 'tool:pnpm')
  assert.equal(result.skipped[0].code, 'trace_confidence_too_low')
  const kept = service.get('tool:pnpm')
  assert.equal(kept.id, current.id)
  assert.equal(kept.text, 'Use pnpm.')
})

test('re-importing the same entry is idempotent', async () => {
  const memory = mockMemory([entry(1), entry(2)])
  const { ctx, service } = setup({ memory })
  assert.equal((await call(ctx, 'trace_import_memento')).imported, 2)

  const second = await call(ctx, 'trace_import_memento')
  assert.equal(second.imported, 0)
  assert.equal(second.unchanged, 2)
  assert.deepEqual(second.skipped, [])
  assert.equal(service.list().length, 2)
})

test('export maps active records only and preserves confidence/createdAt/expiresAt', async () => {
  const { ctx, service } = setup({ memory: mockMemory([]) })
  const user = service.remember({
    key: 'user:editor',
    text: 'Prefers Vim.',
    source: 'user',
    scope: 'user',
    confidence: 0.8,
    ttlMs: 86_400_000,
  })
  service.remember({ key: 'repo:node', text: 'Node 22.', source: 'agent', scope: 'workspace', confidence: 0.6 })
  const latest = service.remember({
    key: 'repo:node',
    text: 'Node 22.19.',
    source: 'agent',
    scope: 'workspace',
    confidence: 0.7,
  })

  const exported = await call(ctx, 'trace_export_memento')
  assert.equal(exported.ok, true)
  assert.equal(exported.format, FORMAT)
  assert.equal(exported.protocol, 'dsh-memory-protocol/v1')
  assert.equal(exported.entries.length, 2, 'superseded versions are not exported')

  const byKey = new Map(exported.entries.map(item => [item.trace.key, item]))
  const userEntry = byKey.get('user:editor')
  assert.equal(userEntry.track, 'user')
  assert.equal(userEntry.scope, 'user-global')
  assert.equal(userEntry.text, 'Prefers Vim.')
  assert.equal(userEntry.source, 'user')
  assert.equal(userEntry.confidence, 0.8)
  assert.equal(userEntry.createdAt, user.provenance.createdAt)
  assert.equal(userEntry.expiresAt, user.expiresAt)
  assert.equal(userEntry.trace.scope, 'user')

  const repoEntry = byKey.get('repo:node')
  assert.equal(repoEntry.track, 'agent')
  assert.equal(repoEntry.scope, 'workspace')
  assert.equal(repoEntry.trace.scope, 'workspace')
  assert.equal(repoEntry.createdAt, latest.provenance.createdAt)
})

test('export → adapter → import round-trips keys, scopes and timestamps', async () => {
  const source = setup({ memory: mockMemory([]) }).service
  const user = source.remember({ key: 'user:editor', text: 'Prefers Vim.', scope: 'user', confidence: 0.8 })
  const repo = source.remember({ key: 'repo:node', text: 'Node 22.', scope: 'workspace' })
  const exported = source.memento.exportToMemento()

  const adapted = MEMENTO_ADAPTER.adapt(exported)
  assert.equal(adapted.entries.length, 2)
  const userInput = adapted.entries.find(item => item.text === 'Prefers Vim.')
  assert.deepEqual(userInput, {
    track: 'user',
    scope: 'user-global',
    text: 'Prefers Vim.',
    source: 'user',
    tags: [],
  })
  assert.equal(adapted.entries.find(item => item.text === 'Node 22.').track, 'agent')

  const target = setup({ memory: mockMemory(exported.entries) })
  assert.equal((await call(target.ctx, 'trace_import_memento')).imported, 1)
  assert.equal((await call(target.ctx, 'trace_import_memento', { scope: 'workspace' })).imported, 1)
  const userRecord = target.service.get('user:editor')
  assert.equal(userRecord.scope, 'user')
  assert.equal(userRecord.provenance.createdAt, user.provenance.createdAt)
  const repoRecord = target.service.get('repo:node')
  assert.equal(repoRecord.scope, 'workspace')
  assert.equal(repoRecord.provenance.createdAt, repo.provenance.createdAt)
})

test('adapter conversion validates payloads and emits trace-memento-v1', () => {
  const payload = MEMENTO_ADAPTER.export([entry(1)])
  assert.equal(payload.format, FORMAT)
  assert.equal(payload.entries[0].trace.key, `memento:${uuid(1)}`)
  assert.equal(payload.entries[0].trace.scope, 'user')
  assert.equal(payload.entries[0].scope, 'user-global')
  assert.equal(payload.entries[0].confidence, 0.5)

  assert.throws(() => MEMENTO_ADAPTER.adapt({ entries: [] }), error => error.code === 'E_MEMENTO_PAYLOAD')
  assert.throws(
    () => MEMENTO_ADAPTER.adapt({ entries: [{ text: '  ' }] }),
    error => error.code === 'E_MEMENTO_PAYLOAD',
  )
  assert.throws(
    () => MEMENTO_ADAPTER.adapt({ entries: [{ text: 'x', tags: ['x'.repeat(33)] }] }),
    error => error.code === 'E_MEMENTO_PAYLOAD',
  )

  // A full trace-export-v1 carries audit history; only active records migrate.
  const migrated = MEMENTO_ADAPTER.adapt({
    format: 'trace-export-v1',
    records: [
      { id: uuid(1), key: 'k', text: 'Active.', scope: 'user', status: 'active' },
      { id: uuid(2), key: 'k', text: 'Old.', scope: 'user', status: 'superseded' },
      { id: uuid(3), key: 'k', text: 'Expired.', scope: 'user', status: 'expired' },
    ],
  })
  assert.equal(migrated.entries.length, 1)
  assert.equal(migrated.entries[0].text, 'Active.')
  assert.equal(migrated.entries[0].track, 'user')
})

test('explicit opt-in registers the adapter; apply itself never does', () => {
  const adapters = mockAdapters()
  const ctx = fakeContext({ adapters })
  assert.equal(registerDefaultAdapter(ctx, { register: false }).registered, false)
  assert.deepEqual(adapters.registers, [])

  const state = registerDefaultAdapter(ctx, { register: true, state: {} })
  assert.equal(state.registered, true)
  assert.deepEqual(adapters.registers, [ADAPTER_ID])
  assert.equal(adapters.map.get(ADAPTER_ID).name, MEMENTO_ADAPTER.name)
})

test('missing memento yields E_UNAVAILABLE without breaking apply or local memory', async () => {
  const { ctx, service } = setup()
  const status = await call(ctx, 'trace_adapter_status')
  assert.equal(status.available, false)
  assert.deepEqual(status.services, { memory: false, memoryAdapters: false })
  assert.equal(status.adapter.mode, 'read-only')
  assert.equal(status.adapter.reason, 'E_UNAVAILABLE')

  for (const name of ['trace_import_memento', 'trace_export_memento']) {
    const result = await call(ctx, name)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_UNAVAILABLE')
  }

  service.remember({ key: 'local:only', text: 'Local ledger still works.' })
  assert.equal(service.get('local:only').text, 'Local ledger still works.')
})

test('status sees memento mounted after Trace and stays read-only', async () => {
  const { ctx } = setup()
  assert.equal((await call(ctx, 'trace_adapter_status')).available, false)

  const adapters = mockAdapters()
  ctx._services.set('memory', mockMemory([entry(1)]))
  ctx._services.set('memoryAdapters', adapters)
  const status = await call(ctx, 'trace_adapter_status')
  assert.equal(status.available, true)
  assert.equal(status.adapter.registered, false)
  assert.deepEqual(adapters.registers, [])
  assert.equal((await call(ctx, 'trace_import_memento')).imported, 1)
})
