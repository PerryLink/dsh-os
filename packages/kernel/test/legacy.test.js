import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createTools } from '../index.js'

const counters = { writes: 0, execs: 0 }
const calls = { args: null, exec: null }

function tool(name, description, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true } },
    execute,
  }
}

// Three legacy host tools: read, write and execute risk.
function definitions() {
  counters.writes = 0
  counters.execs = 0
  return [
    tool('demo_read', 'Read a demo value.', async (args, exec) => {
      calls.args = args
      calls.exec = exec
      if (args.value === 'throw') throw Object.assign(new Error('slow'), { code: 'demo_timeout' })
      return args.value === 'boom'
        ? { ok: false, error: { code: 'demo_not_found', message: 'no demo value' } }
        : { ok: true, data: { value: args.value ?? 'demo' } }
    }),
    tool('demo_write', 'Write a demo value.', async args => {
      counters.writes += 1
      return { ok: true, written: args.value }
    }),
    tool('demo_execute', 'Execute a demo command.', async () => {
      counters.execs += 1
      return { ok: true, ran: true }
    }),
    // Must never be adapted: the kernel's own namespace.
    tool('os_extra', 'A kernel-namespaced tool.', async () => ({ ok: true })),
  ]
}

function mount(mode = 'full', config = {}) {
  const provided = {}
  const registered = []
  const seen = { schemas: [], get: [] }
  const list = mode === 'full' ? definitions() : []
  const ctx = {
    provide: (name, value) => { provided[name] = value },
    tools: mode === 'none' ? undefined : {
      register: definition => registered.push(definition),
      ...(mode === 'full' ? {
        schemas: scope => { seen.schemas.push(scope); return list.map(item => ({ name: item.name, description: item.description })) },
        get: (name, scope) => { seen.get.push([name, scope]); return list.find(item => item.name === name) },
      } : {}),
    },
  }
  const kernel = apply(ctx, config)
  return { ctx, kernel, provided, registered, seen, tool: name => registered.find(item => item.name === name) }
}

test('refreshLegacy adapts visible non-os tools, excludes os_* and stays idempotent', async () => {
  const { kernel, seen, provided } = mount()
  const first = await kernel.refreshLegacy()
  assert.equal(provided.kernel, kernel)
  assert.equal(first.available, true)
  assert.equal(first.scanned, 3)
  assert.equal(first.added, 3)
  assert.deepEqual(kernel.names(), ['legacy.demo_execute', 'legacy.demo_read', 'legacy.demo_write'])
  assert.deepEqual(kernel.stats(), { legacy: 3, capabilities: 0, total: 3 })
  assert.equal(kernel.resolve('legacy.demo_write').risk[0], 'write')
  assert.equal(kernel.resolve('legacy.demo_execute').risk[0], 'execute')
  assert.equal(seen.get.some(([name]) => name === 'os_extra'), false)
  assert.equal(kernel.names().includes('legacy.os_extra'), false)

  const second = await kernel.refreshLegacy()
  assert.equal(second.added, 0)
  assert.equal(second.deduped, 3)
  assert.equal(second.legacy, 3)
  assert.deepEqual(kernel.names(), ['legacy.demo_execute', 'legacy.demo_read', 'legacy.demo_write'])

  const scoped = mount()
  const scope = { agent: 'a1' }
  await scoped.kernel.refreshLegacy({ scope })
  assert.deepEqual(scoped.seen.schemas, [scope])
  assert.ok(scoped.seen.get.every(([, item]) => item === scope))
})

test('first os_find lazily refreshes and searches legacy plus new capabilities', async () => {
  const { kernel, tool: agentTool, seen } = mount()
  kernel.register({
    id: 'demo.echo', title: 'Echo text', summary: 'Echo the supplied text.',
    inputSchema: { type: 'object', additionalProperties: true },
    risk: 'read', handler: async () => ({ echoed: true }),
  })
  assert.equal(kernel.names().length, 1)
  const found = await agentTool('os_find').execute({ intent: 'demo', limit: 10 })
  assert.equal(found.ok, true)
  assert.equal(found.total, 4)
  assert.deepEqual(found.items.map(item => item.id).sort(),
    ['demo.echo', 'legacy.demo_execute', 'legacy.demo_read', 'legacy.demo_write'])
  assert.equal(seen.schemas.length, 1)
  await agentTool('os_find').execute({ intent: 'demo' })
  assert.equal(seen.schemas.length, 1, 'lazy refresh runs once')
})

test('os_do executes legacy tools, normalizes envelopes and gates write/execute', async () => {
  const { tool: agentTool } = mount()
  const run = agentTool('os_do')

  const read = await run.execute({ id: 'legacy.demo_read', args: { value: 'hi' } })
  assert.equal(read.ok, true)
  assert.equal(read.schema, 'os.result/v1')
  assert.equal(read.tool, 'legacy.demo_read')
  assert.deepEqual(read.data, { value: 'hi' })
  assert.deepEqual(calls.args, { value: 'hi' })
  assert.equal(typeof calls.exec, 'object')

  const denied = await run.execute({ id: 'legacy.demo_write', args: { value: 'x' } })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'E_DENIED')
  assert.equal(denied.error.nextTools[0].tool, 'os_request')
  assert.equal(counters.writes, 0)

  const written = await run.execute({ id: 'legacy.demo_write', args: { value: 'x' }, grant: { status: 'active' } })
  assert.equal(written.ok, true)
  assert.equal(written.data.written, 'x')
  assert.equal(counters.writes, 1)

  const deniedExec = await run.execute({ id: 'legacy.demo_execute', args: {} })
  assert.equal(deniedExec.error.code, 'E_DENIED')
  assert.equal(counters.execs, 0)

  const failed = await run.execute({ id: 'legacy.demo_read', args: { value: 'boom' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'E_NOT_FOUND')
  assert.equal(failed.error.details.legacyCode, 'demo_not_found')

  const threw = await run.execute({ id: 'legacy.demo_read', args: { value: 'throw' } })
  assert.equal(threw.ok, false)
  assert.equal(threw.error.code, 'E_TIMEOUT')
  assert.equal(threw.error.details.legacyCode, 'demo_timeout')
})

test('os_status lazily refreshes and reports legacy and capability counts', async () => {
  const { kernel, tool: agentTool } = mount()
  kernel.register({
    id: 'demo.echo', title: 'Echo text', summary: 'Echo the supplied text.',
    inputSchema: { type: 'object', additionalProperties: true },
    risk: 'read', handler: async () => ({ echoed: true }),
  })
  const status = await agentTool('os_status').execute({})
  assert.equal(status.ok, true)
  assert.equal(status.version, '0.3.0')
  assert.equal(status.legacy, 3)
  assert.equal(status.capabilities, 1)
  assert.equal(status.total, 4)
  assert.equal(status.health.legacy, 3)
  assert.equal(status.health.capabilities, 1)
  assert.deepEqual(status.modules, ['demo'])
})

test('refreshLegacy silently skips hosts without the tools seam', async () => {
  const missing = mount('none')
  const report = await missing.kernel.refreshLegacy()
  assert.equal(report.available, false)
  assert.equal(missing.kernel.names().length, 0)
  const agent = createTools(missing.kernel, { ctx: missing.ctx })
  const find = agent.find(item => item.name === 'os_find')
  const statusTool = agent.find(item => item.name === 'os_status')
  assert.equal((await find.execute({ intent: 'demo' })).ok, true)
  const status = await statusTool.execute({})
  assert.equal(status.legacy, 0)
  assert.equal(status.capabilities, 0)

  const partial = mount('partial')
  const partialReport = await partial.kernel.refreshLegacy()
  assert.equal(partialReport.available, false)
  assert.equal((await partial.tool('os_find').execute({ intent: 'demo' })).total, 0)
})

test('existing descriptors win: the legacy entry is namespaced, never shadowing', async () => {
  const { kernel } = mount()
  kernel.register({
    id: 'demo.read', title: 'Read demo', summary: 'The new read capability.',
    aliases: ['demo_read'], inputSchema: { type: 'object', additionalProperties: true },
    risk: 'read', handler: async () => ({ read: true }),
  })
  const report = await kernel.refreshLegacy()
  assert.equal(report.added, 3)
  assert.equal(kernel.resolve('demo_read').id, 'demo.read')
  assert.equal(kernel.resolve('legacy.demo_read').legacy, true)
  assert.deepEqual(kernel.stats(), { legacy: 3, capabilities: 1, total: 4 })

  const occupied = mount()
  occupied.kernel.register({
    id: 'legacy.demo_write', title: 'Owned write', summary: 'A descriptor owns this id.',
    inputSchema: { type: 'object', additionalProperties: true },
    risk: 'write', handler: async () => ({ owned: true }),
  })
  const second = await occupied.kernel.refreshLegacy()
  assert.equal(second.added, 2)
  assert.equal(second.deduped, 1)
  assert.equal(occupied.kernel.resolve('legacy.demo_write').title, 'Owned write')
  assert.deepEqual(occupied.kernel.stats(), { legacy: 2, capabilities: 1, total: 3 })
})
