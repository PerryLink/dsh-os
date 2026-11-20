import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, RootService } from '../index.js'

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

function profile(overrides = {}) {
  return {
    vars: {},
    secretRefs: {},
    pathPrepend: [],
    inherit: null,
    deny: [],
    trust: 'user',
    scope: 'user',
    ...overrides,
  }
}

function setup(config) {
  const ctx = fakeContext()
  const service = apply(ctx, config)
  return { ctx, service }
}

const coded = code => error => error?.code === code

test('apply provides ctx.env and registers all five tools', () => {
  const { ctx } = setup()
  assert.ok(ctx.get('env') instanceof RootService)
  assert.deepEqual([...ctx._tools.keys()], ['root_set', 'root_get', 'root_list', 'root_resolve', 'root_explain'])
})

test('set/get/list/remove and defensive copies', () => {
  const { service } = setup()
  const stored = service.set('base', profile({ vars: { NODE_ENV: 'development' } }))
  assert.equal(stored.name, 'base')
  assert.deepEqual(stored.vars, { NODE_ENV: 'development' })
  assert.equal(stored.proxy, undefined)

  const copy = service.get('base')
  copy.vars.NODE_ENV = 'mutated'
  assert.equal(service.get('base').vars.NODE_ENV, 'development')
  assert.deepEqual(service.list().map(item => item.name), ['base'])

  assert.equal(service.remove('base'), true)
  assert.equal(service.remove('base'), false)
  assert.equal(service.get('base'), undefined)
})

test('resolve composes inheritance, proxy, pathPrepend and sources', () => {
  const { service } = setup()
  service.set('base', profile({
    vars: { NODE_ENV: 'development', SHARED: 'base', BASE_ONLY: '1' },
    secretRefs: { TOKEN: 'cred:token' },
    proxy: { http: 'http://base:8080', noProxy: 'localhost' },
    pathPrepend: ['/base/bin', '/shared/bin'],
  }))
  service.set('child', profile({
    vars: { SHARED: 'child', CHILD_ONLY: '1' },
    secretRefs: { API_KEY: 'cred:api' },
    proxy: { https: 'http://child:8443' },
    pathPrepend: ['/shared/bin', '/child/bin'],
    inherit: 'base',
    trust: 'workspace',
    scope: 'workspace',
  }))

  const resolved = service.resolve('child')
  assert.deepEqual(resolved.vars, { NODE_ENV: 'development', SHARED: 'child', BASE_ONLY: '1', CHILD_ONLY: '1' })
  assert.deepEqual(resolved.secretRefs, { TOKEN: 'cred:token', API_KEY: 'cred:api' })
  assert.deepEqual(resolved.proxy, { http: 'http://base:8080', noProxy: 'localhost', https: 'http://child:8443' })
  assert.deepEqual(resolved.pathPrepend, ['/base/bin', '/shared/bin', '/child/bin'])
  assert.deepEqual(resolved.sources, {
    NODE_ENV: 'base',
    SHARED: 'child',
    BASE_ONLY: 'base',
    CHILD_ONLY: 'child',
    TOKEN: 'base',
    API_KEY: 'child',
  })
  assert.deepEqual(resolved.denied, [])
})

test('vars and secretRefs share one namespace and later layers win', () => {
  const { service } = setup()
  service.set('base', profile({ vars: { API_KEY: 'plain-value' } }))
  service.set('child', profile({
    inherit: 'base',
    secretRefs: { API_KEY: 'cred:api' },
  }))
  const resolved = service.resolve('child')
  assert.equal(Object.hasOwn(resolved.vars, 'API_KEY'), false)
  assert.deepEqual(resolved.secretRefs, { API_KEY: 'cred:api' })
  assert.equal(resolved.sources.API_KEY, 'child')
})

test('deny removes matching vars and secret references and records the keys', () => {
  const { service } = setup()
  service.set('base', profile({
    vars: { AWS_KEY: 'base', SAFE: 'yes', DB_TOKEN: 'db' },
    secretRefs: { API_TOKEN: 'cred:api' },
    deny: ['AWS_*'],
  }))
  service.set('child', profile({
    inherit: 'base',
    vars: { AWS_KEY: 'child', OK: '1' },
    deny: ['*_TOKEN'],
  }))
  const resolved = service.resolve('child')
  assert.deepEqual(resolved.vars, { SAFE: 'yes', OK: '1' })
  assert.deepEqual(resolved.secretRefs, {})
  assert.deepEqual([...resolved.denied].sort(), ['API_TOKEN', 'AWS_KEY', 'DB_TOKEN'])
  assert.equal(Object.hasOwn(resolved.sources, 'AWS_KEY'), false)
})

test('secretRefs store references only and reject non-string values', () => {
  const { service } = setup()
  service.set('secrets', profile({ secretRefs: { OPENAI_API_KEY: 'cred:openai' } }))
  assert.deepEqual(service.get('secrets').secretRefs, { OPENAI_API_KEY: 'cred:openai' })
  assert.deepEqual(service.resolve('secrets').secretRefs, { OPENAI_API_KEY: 'cred:openai' })
  assert.equal(Object.hasOwn(service.resolve('secrets').vars, 'OPENAI_API_KEY'), false)

  assert.throws(
    () => service.set('bad-ref', profile({ secretRefs: { TOKEN: { value: 'sk-secret' } } })),
    coded('invalid_profile'),
  )
  assert.throws(
    () => service.set('empty-ref', profile({ secretRefs: { TOKEN: '   ' } })),
    coded('invalid_secret_ref'),
  )
  assert.throws(
    () => service.set('overlap', profile({ vars: { TOKEN: 'a' }, secretRefs: { TOKEN: 'cred:token' } })),
    coded('invalid_profile'),
  )
})

test('explain reports the winning source, overrides, secrets and deny', () => {
  const { service } = setup()
  service.set('base', profile({
    vars: { MODE: 'base', AWS_KEY: 'secret' },
    secretRefs: { TOKEN: 'cred:token' },
  }))
  service.set('child', profile({ inherit: 'base', vars: { MODE: 'child' }, deny: ['AWS_*'] }))

  const mode = service.explain('child', 'MODE')
  assert.equal(mode.found, true)
  assert.equal(mode.kind, 'var')
  assert.equal(mode.source, 'child')
  assert.equal(mode.value, 'child')
  assert.deepEqual(mode.overridden, ['base'])

  const token = service.explain('child', 'TOKEN')
  assert.equal(token.found, true)
  assert.equal(token.kind, 'secretRef')
  assert.equal(token.source, 'base')
  assert.equal(token.secretRef, 'cred:token')
  assert.equal(token.value, undefined)

  const denied = service.explain('child', 'AWS_KEY')
  assert.equal(denied.found, false)
  assert.equal(denied.denied, true)
  assert.equal(denied.deniedBy, 'AWS_*')
  assert.equal(denied.value, undefined)

  const missing = service.explain('child', 'MISSING')
  assert.equal(missing.found, false)
  assert.equal(missing.denied, false)
  assert.equal(missing.deniedBy, null)
})

test('invalid variable names, profiles and inheritance are rejected', () => {
  const { service } = setup()
  for (const key of ['lower', '1BAD', 'BAD-NAME', 'BAD NAME']) {
    assert.throws(() => service.set('bad', profile({ vars: { [key]: 'x' } })), coded('invalid_var_name'), key)
    assert.throws(() => service.set('bad', profile({ secretRefs: { [key]: 'cred:x' } })), coded('invalid_var_name'), key)
  }
  assert.throws(() => service.set('bad', profile({ trust: 'team' })), coded('invalid_profile'))
  assert.throws(() => service.set('bad', profile({ proxy: {} })), coded('invalid_proxy'))
  assert.throws(() => service.set('bad', profile({ pathPrepend: [''] })), coded('invalid_profile'))
  assert.throws(() => service.set('bad', profile({ deny: ['has space'] })), coded('invalid_deny'))
  assert.throws(() => service.set('bad', profile({ unknown: true })), coded('invalid_profile'))
  assert.throws(() => service.set('self', profile({ inherit: 'self' })), coded('inherit_cycle'))

  service.set('custom', profile({ vars: { CUSTOM_ENV: 'ok' } }))
  service.set('defaults', profile())
  assert.equal(service.get('defaults').trust, 'user')
  assert.equal(service.get('defaults').scope, 'user')
  assert.equal(service.resolve('custom').vars.CUSTOM_ENV, 'ok')
})

test('missing parents and cycles fail resolution with stable codes', () => {
  const { service } = setup()
  service.set('orphan', profile({ inherit: 'nobody' }))
  assert.throws(() => service.resolve('orphan'), coded('profile_not_found'))
  assert.throws(() => service.explain('orphan', 'PATH'), coded('profile_not_found'))
  assert.throws(() => service.resolve('missing'), coded('profile_not_found'))

  service.set('a', profile({ inherit: 'b' }))
  service.set('b', profile({ inherit: 'a' }))
  assert.throws(() => service.resolve('a'), coded('inherit_cycle'))
})

test('layer is an optional trust ceiling', () => {
  const { service } = setup()
  service.set('base', profile({ trust: 'user', vars: { USER_ONLY: '1' } }))
  service.set('agent', profile({ inherit: 'base', trust: 'agent', scope: 'agent', vars: { AGENT_ONLY: '1' } }))

  assert.deepEqual(service.resolve('agent').vars, { USER_ONLY: '1', AGENT_ONLY: '1' })
  // Agent-facing callers see only agent-trust profiles; user-trust stays hidden.
  assert.deepEqual(service.resolve('agent', { layer: 'agent' }).vars, { AGENT_ONLY: '1' })
  assert.deepEqual(service.resolve('agent', { layer: 'user' }).vars, { USER_ONLY: '1', AGENT_ONLY: '1' })
  assert.throws(() => service.resolve('base', { layer: 'workspace' }), coded('layer_forbidden'))
  assert.throws(() => service.resolve('base', { layer: 'root' }), coded('invalid_layer'))
})

test('stateFile round-trips atomically and survives reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-root-test-'))
  try {
    const stateFile = join(dir, 'nested', 'state.json')
    const first = setup({ stateFile })
    first.service.set('base', profile({ vars: { A: '1' }, secretRefs: { TOKEN: 'cred:token' } }))
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['state.json'])
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.profiles[0].secretRefs.TOKEN, 'cred:token')

    const second = setup({ stateFile })
    assert.deepEqual(second.service.get('base').vars, { A: '1' })
    assert.deepEqual(second.service.get('base').secretRefs, { TOKEN: 'cred:token' })
    second.service.remove('base')

    const third = setup({ stateFile })
    assert.equal(third.service.get('base'), undefined)
    assert.deepEqual(third.service.list(), [])

    writeFileSync(stateFile, '{ not json', 'utf8')
    assert.throws(() => setup({ stateFile }), coded('state_invalid'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools set, get, list, resolve and explain through the service', async () => {
  const { ctx } = setup()
  const saved = await ctx._tools.get('root_set').execute({
    name: 'tool-profile',
    profile: profile({ vars: { TOOL_VAR: 'via-tool' }, secretRefs: { TOOL_TOKEN: 'cred:tool' } }),
  })
  assert.equal(saved.profile.name, 'tool-profile')

  assert.deepEqual((await ctx._tools.get('root_get').execute({ name: 'tool-profile' })).profile.vars, { TOOL_VAR: 'via-tool' })
  assert.deepEqual((await ctx._tools.get('root_list').execute({})).profiles.map(item => item.name), ['tool-profile'])
  const resolved = await ctx._tools.get('root_resolve').execute({ name: 'tool-profile' })
  assert.equal(resolved.vars.TOOL_VAR, 'via-tool')
  assert.equal(resolved.sources.TOOL_VAR, 'tool-profile')
  const explained = await ctx._tools.get('root_explain').execute({ name: 'tool-profile', key: 'TOOL_TOKEN' })
  assert.equal(explained.secretRef, 'cred:tool')
  await assert.rejects(ctx._tools.get('root_get').execute({ name: 'nope' }), coded('profile_not_found'))
})

test('the ledger never mutates process.env', () => {
  const { service } = setup()
  const before = process.env.ROOT_MVP_PROBE
  service.set('probe', profile({ vars: { ROOT_MVP_PROBE: 'value' } }))
  service.resolve('probe')
  service.explain('probe', 'ROOT_MVP_PROBE')
  assert.equal(process.env.ROOT_MVP_PROBE, before)
})

test('agent-facing root_set cannot create a user-trust profile', async () => {
  const { ctx, service } = setup()
  const setTool = ctx._tools.get('root_set')
  const created = await setTool.execute({
    name: 'prod',
    profile: { vars: { API_KEY: 'v' }, trust: 'user', scope: 'user' },
  })
  assert.equal(created.profile.trust, 'agent')
  assert.equal(created.profile.scope, 'agent')

  service.set('human-only', profile({ vars: { TOKEN: 'secret' }, trust: 'user', scope: 'user' }))
  await assert.rejects(
    () => ctx._tools.get('root_resolve').execute({ name: 'human-only' }),
    coded('layer_forbidden'),
  )
})
