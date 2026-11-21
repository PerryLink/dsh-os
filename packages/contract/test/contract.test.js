import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CAPABILITIES,
  ERROR_CODES,
  OS_OBJECT_KEYS,
  SERVICES,
  assertManifest,
  defineTool,
  isOsObject,
  makeRef,
  parseRef,
} from '../index.js'

const isInvalidArgument = error => error instanceof Error && error.code === 'E_INVALID_ARGUMENT'

const throwsInvalid = (fn, label) => assert.throws(fn, isInvalidArgument, label)

/** A valid manifest; `os` overrides selected `dsh.os` fields. */
function manifest(os = {}) {
  return {
    name: 'dsh-snip',
    version: '0.1.0',
    dsh: {
      manifestVersion: 1,
      os: {
        service: 'snip',
        provides: ['snip'],
        capabilities: ['fs.read'],
        tools: ['snip_search'],
        stability: 'experimental',
        since: '0.1.0',
        ...os,
      },
    },
  }
}

/** A valid tool definition; `overrides` replaces selected fields. */
function tool(overrides = {}) {
  return {
    name: 'snip_search',
    description: 'Search snippets.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: '{}' }],
    },
    async execute() {
      return {}
    },
    ...overrides,
  }
}

test('SERVICES is the canonical product to Host seam table', () => {
  assert.deepEqual(SERVICES, {
    act: 'act',
    allow: 'allow',
    snip: 'snip',
    check: 'check',
    nest: 'nest',
    trigger: 'triggers',
    seek: 'evidence',
    trace: 'trace',
    stage: 'stage',
    ring: 'ring',
    root: 'env',
    help: 'help',
    context: 'context',
    cost: 'cost',
    backup: 'backup',
    notify: 'notify',
    kernel: 'kernel',
  })
  assert.ok(Object.isFrozen(SERVICES))
})

test('ERROR_CODES, CAPABILITIES and OS_OBJECT_KEYS are canonical and frozen', () => {
  assert.deepEqual(Object.keys(ERROR_CODES), [
    'E_INVALID_ARGUMENT',
    'E_NOT_FOUND',
    'E_CONFLICT',
    'E_DENIED',
    'E_UNAVAILABLE',
    'E_STATE',
    'E_LIMIT',
  ])
  for (const [code, value] of Object.entries(ERROR_CODES)) assert.equal(value, code)
  assert.ok(Object.isFrozen(ERROR_CODES))

  assert.deepEqual([...CAPABILITIES], [
    'fs.read', 'fs.write', 'net', 'secret', 'spawn', 'model', 'clipboard', 'ui', 'notify',
  ])
  assert.ok(Object.isFrozen(CAPABILITIES))

  assert.deepEqual([...OS_OBJECT_KEYS], [
    'id', 'owner', 'scope', 'createdAt', 'updatedAt', 'expiresAt', 'auditRef',
  ])
  assert.ok(Object.isFrozen(OS_OBJECT_KEYS))
})

test('isOsObject accepts the object base and rejects malformed values', () => {
  assert.equal(isOsObject({ id: 's1', createdAt: 1 }), true)
  assert.equal(isOsObject({
    id: 's1',
    owner: 'user:acme',
    scope: 'workspace',
    createdAt: 1,
    updatedAt: 2,
    expiresAt: null,
    auditRef: 'dsh://trace/t1',
  }), true)

  const malformed = [
    null,
    undefined,
    's1',
    [],
    {},
    { id: '', createdAt: 1 },
    { id: 's1' },
    { id: 's1', createdAt: 'now' },
    { id: 's1', createdAt: NaN },
    { id: 's1', createdAt: 1, owner: 5 },
    { id: 's1', createdAt: 1, scope: null },
    { id: 's1', createdAt: 1, updatedAt: null },
    { id: 's1', createdAt: 1, expiresAt: 'soon' },
    { id: 's1', createdAt: 1, auditRef: [] },
  ]
  for (const value of malformed) {
    assert.equal(isOsObject(value), false, `expected false for ${String(value)}`)
  }
})

test('makeRef/parseRef round-trip canonical dsh:// refs', () => {
  for (const [kind, id] of [
    ['memory', 'm-1'],
    ['evidence', 'ev_01'],
    ['snip', '9f8e7d3a'],
    ['trace', 'a.b:c'],
  ]) {
    const ref = makeRef(kind, id)
    assert.equal(ref, `dsh://${kind}/${id}`)
    assert.deepEqual(parseRef(ref), { kind, id })
  }

  for (const bad of [
    '',
    'dsh://memory',
    'dsh://memory/',
    'dsh:///m-1',
    'http://memory/m-1',
    'dsh://Memory/m-1',
    'dsh://memory/a/b',
    'dsh://memory/a b',
  ]) {
    throwsInvalid(() => parseRef(bad), bad)
  }

  for (const [kind, id] of [
    ['', 'x'],
    ['Memory', 'x'],
    ['memory', ''],
    ['memory', 'a/b'],
    ['memory', 'a b'],
    [null, 'x'],
    ['memory', null],
  ]) {
    throwsInvalid(() => makeRef(kind, id), `${String(kind)}/${String(id)}`)
  }
})

test('assertManifest accepts valid v1 manifests and returns them', () => {
  const valid = manifest()
  assert.equal(assertManifest(valid), valid)

  assert.doesNotThrow(() => assertManifest(manifest({ service: null, tools: [] })))
  for (const stability of ['experimental', 'stable', 'frozen', 'archived']) {
    assert.doesNotThrow(() => assertManifest(manifest({ stability })))
  }

  const toolsByService = {
    act: 'act_list',
    allow: 'allow_check',
    snip: 'snip_search',
    check: 'check_run',
    nest: 'nest_get',
    triggers: 'trigger_fire',
    evidence: 'seek_find',
    trace: 'trace_add',
    stage: 'stage_show',
    ring: 'ring_ack',
    env: 'root_show',
  }
  for (const [service, name] of Object.entries(toolsByService)) {
    assert.doesNotThrow(() => assertManifest(manifest({ service, tools: [name] })), service)
  }
})

test('assertManifest rejects malformed manifests', () => {
  const malformed = [
    null,
    {},
    { dsh: {} },
    { dsh: { manifestVersion: 2, os: manifest().dsh.os } },
    { dsh: { manifestVersion: 1 } },
    manifest({ service: undefined }),
    manifest({ service: 'root' }),
    manifest({ stability: 'beta' }),
    manifest({ stability: undefined }),
    manifest({ tools: 'snip_search' }),
    manifest({ tools: ['snipsearch'] }),
    manifest({ tools: ['snip_'] }),
    manifest({ tools: ['other_search'] }),
    manifest({ tools: [1] }),
  ]
  for (const value of malformed) throwsInvalid(() => assertManifest(value))
})

test('this package manifest is a non-plugin contract manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-os-contract')
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.dsh.bundle, undefined)
  assert.deepEqual(pkg.dsh.os, {
    service: null,
    provides: [],
    capabilities: [],
    tools: [],
    stability: 'experimental',
    since: '0.1.0',
  })
  assert.equal(assertManifest(pkg), pkg)
})

test('defineTool accepts every canonical prefix and returns a plain object', () => {
  const names = [
    'act_list', 'allow_check', 'snip_search', 'check_run', 'nest_get',
    'trigger_fire', 'seek_find', 'trace_add', 'stage_show', 'ring_ack', 'root_show',
  ]
  for (const name of names) {
    const definition = defineTool(tool({ name }))
    assert.equal(Object.getPrototypeOf(definition), Object.prototype)
    assert.equal(definition.name, name)
    assert.equal(typeof definition.execute, 'function')
  }

  const definition = defineTool(tool())
  assert.deepEqual(Object.keys(definition).sort(), [
    'description', 'execute', 'name', 'output', 'parameters',
  ])
})

test('defineTool rejects malformed definitions', () => {
  const malformed = [
    null,
    [],
    'snip_search',
    {},
    tool({ name: 'snipsearch' }),
    tool({ name: 'Snip_search' }),
    tool({ name: 'snip_' }),
    tool({ name: 'other_search' }),
    tool({ name: 'snip_search', description: '' }),
    tool({ name: 'snip_search', description: 1 }),
    tool({ name: 'snip_search', parameters: null }),
    tool({ name: 'snip_search', parameters: [] }),
    tool({ name: 'snip_search', output: undefined }),
    tool({ name: 'snip_search', output: { schema: { type: 'object' } } }),
    tool({ name: 'snip_search', output: { schema: [], render: () => [] } }),
    tool({ name: 'snip_search', execute: undefined }),
    tool({ name: 'snip_search', execute: 'run' }),
  ]
  for (const value of malformed) throwsInvalid(() => defineTool(value))
})
