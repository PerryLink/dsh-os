import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, GLOBAL, makeTools, NestService } from '../index.js'

/** Fake Cordis context from docs/implementation-contract.md. */
function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}

test('apply provides ctx.nest and registers the five nest tools', () => {
  const ctx = fakeContext()
  const service = apply(ctx, {})
  assert.ok(service instanceof NestService)
  assert.equal(ctx.get('nest'), service)
  assert.deepEqual([...ctx._tools.keys()], [
    'nest_set', 'nest_get', 'nest_list', 'nest_diff', 'nest_remove',
  ])
  assert.equal(makeTools(service).length, 5)
})

test('apply keeps the service usable without a tool registry', () => {
  const services = new Map()
  const service = apply({ provide: (name, value) => services.set(name, value) })
  assert.equal(services.get('nest'), service)
})

test('set and get normalize a profile and return defensive copies', () => {
  const service = new NestService()
  const stored = service.set('/work/acme/', {
    title: 'Acme',
    contextFiles: ['AGENTS.md'],
    permissionPreset: 'workspace-write',
    envProfile: 'root:acme',
    defaults: { model: 'deepseek-chat', reasoning: 'high' },
    skills: ['pdf'],
    lifecycle: { ttlDays: 30 },
    owners: ['team:acme'],
  })
  assert.equal(stored.path, '/work/acme')
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.contextFiles, ['AGENTS.md'])
  assert.deepEqual(service.get('/work/acme'), stored)

  stored.title = 'mutated'
  assert.equal(service.get('/work/acme').title, 'Acme')
  assert.equal(service.get('/work/missing'), null)
})

test('overwrites advance version and stale versions are rejected', () => {
  const service = new NestService()
  assert.equal(service.set('/work/v', { title: 'one', version: 1 }).version, 1)
  assert.equal(service.set('/work/v', { title: 'two' }).version, 2)
  assert.equal(service.set('/work/v', { title: 'three', version: 2 }).version, 3)
  assert.throws(
    () => service.set('/work/v', { title: 'stale', version: 1 }),
    error => error.code === 'E_VERSION',
  )
  assert.equal(service.get('/work/v').version, 3)
  assert.equal(service.get('/work/v').title, 'three')
})

test('resolve inherits global first, then overrides and merges the workspace', () => {
  const service = new NestService()
  service.set(GLOBAL, {
    title: 'Global',
    contextFiles: ['GLOBAL.md', 'AGENTS.md'],
    permissionPreset: 'read-only',
    envProfile: 'root:base',
    defaults: { model: 'deepseek-chat', reasoning: 'high' },
    skills: ['office'],
    lifecycle: { ttlDays: 30 },
    owners: ['team:all'],
  })
  service.set('/work/a', {
    title: 'A',
    contextFiles: ['AGENTS.md', 'docs/a.md'],
    defaults: { model: 'deepseek-reasoner' },
    skills: ['pdf'],
    lifecycle: { archiveAfterDays: 7 },
    owners: ['team:a'],
  })

  const resolved = service.resolve('/work/a')
  assert.deepEqual(resolved.sources, { global: true, workspace: true })
  assert.equal(resolved.profile.path, '/work/a')
  assert.equal(resolved.profile.title, 'A')
  assert.equal(resolved.profile.permissionPreset, 'read-only')
  assert.equal(resolved.profile.envProfile, 'root:base')
  assert.deepEqual(resolved.profile.contextFiles, ['GLOBAL.md', 'AGENTS.md', 'docs/a.md'])
  assert.deepEqual(resolved.profile.skills, ['office', 'pdf'])
  assert.deepEqual(resolved.profile.owners, ['team:all', 'team:a'])
  assert.deepEqual(resolved.profile.defaults, { model: 'deepseek-reasoner', reasoning: 'high' })
  assert.deepEqual(resolved.profile.lifecycle, { ttlDays: 30, archiveAfterDays: 7 })

  const inherited = service.resolve('/work/other')
  assert.deepEqual(inherited.sources, { global: true, workspace: false })
  assert.equal(inherited.profile.title, 'Global')
  assert.equal(inherited.profile.path, '/work/other')

  assert.throws(
    () => new NestService().resolve('/work/none'),
    error => error.code === 'E_NOT_FOUND',
  )
})

test('diff previews field changes without writing', () => {
  const service = new NestService()
  service.set('/work/d', { title: 'Before', skills: ['a'], version: 1 })

  const preview = service.diff('/work/d', { title: 'After', skills: ['b'] })
  assert.equal(preview.created, false)
  assert.equal(preview.hasChanges, true)
  assert.deepEqual(preview.changes.map(change => change.field), ['title', 'skills'])
  assert.deepEqual(preview.changes[0], { field: 'title', from: 'Before', to: 'After' })
  assert.equal(preview.current.version, 1)
  assert.equal(preview.next.version, 2)
  assert.equal(service.get('/work/d').title, 'Before')
  assert.equal(service.get('/work/d').version, 1)

  const same = service.diff('/work/d', { title: 'Before', skills: ['a'] })
  assert.equal(same.hasChanges, false)
  assert.deepEqual(same.changes, [])

  const created = service.diff('/work/new', {})
  assert.equal(created.created, true)
  assert.equal(created.hasChanges, true)
  assert.deepEqual(created.changes, [])

  const createdWithTitle = service.diff('/work/new', { title: 'New' })
  assert.deepEqual(createdWithTitle.changes.map(change => change.field), ['title'])
})

test('remove deletes a profile once', () => {
  const service = new NestService()
  service.set('/work/r', { title: 'R' })
  assert.equal(service.remove('/work/r'), true)
  assert.equal(service.get('/work/r'), null)
  assert.equal(service.remove('/work/r'), false)
})

test('invalid paths, fields and versions fail with stable codes', () => {
  const service = new NestService()
  assert.throws(() => service.set('relative/path', {}), error => error.code === 'E_PATH')
  assert.throws(() => service.set('', {}), error => error.code === 'E_PATH')
  assert.throws(() => service.set('/work/a\0', {}), error => error.code === 'E_PATH')
  assert.throws(() => service.set('/work/a', null), /profile must be an object/)
  assert.throws(() => service.set('/work/a', { path: '/work/b' }), error => error.code === 'E_PATH')
  assert.throws(
    () => service.set('/work/a', { contextFiles: 'AGENTS.md' }),
    error => error.code === 'E_ARRAY',
  )
  assert.throws(() => service.set('/work/a', { skills: [1] }), error => error.code === 'E_ARRAY')
  assert.throws(() => service.set('/work/a', { owners: [''] }), error => error.code === 'E_ARRAY')
  assert.throws(
    () => service.set('/work/a', { title: 'x', unknown: true }),
    error => error.code === 'E_FIELD',
  )
  assert.throws(() => service.set('/work/a', { version: 0 }), error => error.code === 'E_VERSION')
  assert.throws(
    () => service.set('/work/a', { defaults: { temperature: 1 } }),
    error => error.code === 'E_FIELD',
  )
  assert.throws(
    () => service.set('/work/a', { lifecycle: { ttlDays: -1 } }),
    error => error.code === 'E_FIELD',
  )
  assert.equal(service.get('/work/a'), null)
})

test('stateFile persists profiles atomically and reloads them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-nest-'))
  const stateFile = join(dir, 'states', 'nest.json')
  try {
    const first = new NestService({ stateFile })
    first.set(GLOBAL, { title: 'Global', skills: ['base'] })
    first.set('/work/p', { title: 'Persisted', defaults: { model: 'deepseek-chat' } })

    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.profiles.length, 2)

    const second = new NestService({ stateFile })
    assert.equal(second.get('/work/p').title, 'Persisted')
    assert.equal(second.get('/work/p').version, 1)
    assert.deepEqual(second.resolve('/work/p').profile.skills, ['base'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent tools drive the service through plain ToolDefinitions', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const { _tools: tools } = ctx

  const set = await tools.get('nest_set').execute({
    path: '/work/t',
    profile: { title: 'T', skills: ['pdf'] },
  })
  assert.equal(set.profile.version, 1)
  assert.equal((await tools.get('nest_get').execute({ path: '/work/t' })).profile.title, 'T')
  assert.equal((await tools.get('nest_list').execute({})).profiles.length, 1)

  const diff = await tools.get('nest_diff').execute({
    path: '/work/t',
    patch: { title: 'T2' },
  })
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.next.version, 2)

  assert.deepEqual(
    await tools.get('nest_remove').execute({ path: '/work/t' }),
    { path: '/work/t', removed: true },
  )
  await assert.rejects(
    () => tools.get('nest_get').execute({ path: '/work/t' }),
    error => error.code === 'E_NOT_FOUND',
  )
})
