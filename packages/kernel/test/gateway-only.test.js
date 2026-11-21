import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply, TOOL_NAMES } from '../index.js'

function scopedContext({ restrict = true } = {}) {
  const registered = []
  const definitions = new Map()
  const filters = []
  const ctx = {
    provide: () => {},
    tools: {
      register: definition => { registered.push(definition.name); definitions.set(definition.name, definition); return () => {} },
      schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'os_find' }, { name: 'run_code' }],
      ...(restrict ? { restrict: filter => { filters.push(filter); return () => filters.push('lifted') } } : {}),
    },
  }
  return { ctx, registered, definitions, filters }
}

test('gatewayOnly registers the six os_* verbs and denies every other inherited tool', () => {
  const h = scopedContext()
  const kernel = apply(h.ctx, { gatewayOnly: true })
  assert.deepEqual(h.registered, [...TOOL_NAMES])
  assert.deepEqual(h.filters, [{ deny: ['read', 'write'] }], 'os_* stay visible and run_code is not restricted')
  assert.equal(typeof kernel.gatewayRestriction, 'function')
})

test('gatewayOnly keeps legacy capabilities reachable through the global view', async () => {
  const legacy = {
    name: 'read_demo', description: 'Read a demo value.',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true, value: 'demo' }),
  }
  const h = scopedContext()
  h.ctx.tools.schemas = scope => scope === undefined ? [legacy] : []
  h.ctx.tools.get = (name, scope) => scope === undefined && name === 'read_demo' ? legacy : undefined
  apply(h.ctx, { gatewayOnly: true })
  const found = await h.definitions.get('os_find').execute({ intent: 'read demo' })
  assert.ok(found.items.some(item => item.id === 'legacy.read_demo'))
  assert.deepEqual(h.filters, [{ deny: ['read_demo'] }])
})

test('gatewayOnly fails closed without a scoped tools.restrict()', () => {
  assert.throws(() => apply(scopedContext({ restrict: false }).ctx, { gatewayOnly: true }), /requires ctx\.tools\.restrict/)
  const globalish = scopedContext()
  globalish.ctx.tools.restrict = () => { throw new Error('tools.restrict() requires a scoped context') }
  assert.throws(() => apply(globalish.ctx, { gatewayOnly: true }), /scoped agent\/preset mount/)
})

test('the shipped preset is static-checkable and mounts no other tool plugin', () => {
  const preset = fileURLToPath(new URL('../../../docs/presets/os-gateway.cordis.yml', import.meta.url))
  const yaml = readFileSync(preset, 'utf8')
  assert.match(yaml, /id: os-gateway/)
  assert.match(yaml, /name: 'dsh-os-kernel'/)
  assert.match(yaml, /gatewayOnly: true/)
  assert.equal(/name: '@deepseek-ai\/dsh-tool-/.test(yaml), false, 'only the kernel may expose model-facing tools')

  const guide = readFileSync(fileURLToPath(new URL('../../../docs/presets/os-gateway.md', import.meta.url)), 'utf8')
  assert.match(guide, /toolFilter/)
  assert.match(guide, /gatewayOnly/)
  assert.match(guide, /ctx\.tools\.restrict/)
  assert.match(guide, /cap:<descriptor\.id>/)
  for (const name of TOOL_NAMES) assert.ok(guide.includes(name), `guide should name ${name}`)
})
