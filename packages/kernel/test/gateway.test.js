import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const readCap = (overrides = {}) => ({
  id: 'demo.echo', title: 'Echo text', summary: 'Echo the supplied text back.',
  whenToUse: ['The user wants to echo text.'], whenNotToUse: ['The user wants to write a file.'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  risk: 'read', permissions: [], tags: ['demo'], aliases: [],
  handler: async ({ text }) => ({ text, items: [{ id: 'i1', preview: text }] }),
  ...overrides,
})
const writeCap = (overrides = {}) => ({
  id: 'demo.write', title: 'Write value', summary: 'Write a demo value.',
  whenToUse: ['The user wants to write a value.'], whenNotToUse: ['The user only wants to read.'],
  inputSchema: { type: 'object', additionalProperties: true, properties: {} },
  risk: 'write', permissions: [], tags: ['demo'], aliases: [],
  handler: async args => ({ written: true, args }),
  ...overrides,
})

function mount(config = {}) {
  const provided = {}
  const tools = []
  const ctx = { provide: (name, value) => { provided[name] = value }, tools: { register: tool => tools.push(tool) } }
  const registry = apply(ctx, config)
  return { ctx, tools, registry, provided, tool: name => tools.find(tool => tool.name === name) }
}

test('apply provides ctx.kernel, registers six verbs and adapts legacyTools', async () => {
  const legacy = {
    name: 'demo_legacy_write', description: 'Write a legacy value.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  }
  const { tools, registry, provided } = mount({ legacyTools: [legacy] })
  assert.equal(tools.length, 6)
  assert.deepEqual(tools.map(tool => tool.name), ['os_find', 'os_do', 'os_request', 'os_observe', 'os_help', 'os_status'])
  assert.equal(provided.kernel, registry)
  assert.ok(registry.names().includes('legacy.demo_legacy_write'))
  assert.deepEqual(registry.resolve('legacy.demo_legacy_write').risk, ['write'])
})

test('os_find returns compact cards and honours riskMax and limit', async () => {
  const { registry, tool } = mount()
  registry.register(readCap())
  registry.register(writeCap())
  const cards = await tool('os_find').execute({ intent: 'echo text' })
  assert.equal(cards.ok, true)
  assert.equal(cards.total, 1)
  assert.deepEqual(Object.keys(cards.items[0]).sort(), ['cost', 'example', 'id', 'permissions', 'risk', 'summary', 'title'])
  assert.equal(cards.items[0].risk[0], 'read')
  assert.equal((await tool('os_find').execute({ intent: 'write value', riskMax: 'read' })).total, 0)
  assert.equal((await tool('os_find').execute({ intent: 'write value', riskMax: 'write' })).total, 1)
  assert.equal((await tool('os_find').execute({ intent: 'demo' })).items.length, 2)
  assert.equal((await tool('os_find').execute({ intent: 'demo', limit: 1 })).truncated, true)
})

test('os_do returns an OsResult, previews without running and enforces grants', async () => {
  const { registry, tool } = mount()
  let echoes = 0
  let writes = 0
  registry.register(readCap({ handler: async ({ text }) => { echoes += 1; return { text } } }))
  registry.register(writeCap({ handler: async args => { writes += 1; return { written: true, args } } }))
  const run = tool('os_do')

  const read = await run.execute({ id: 'demo.echo', args: { text: 'hi' } })
  assert.equal(read.ok, true)
  assert.equal(read.schema, 'os.result/v1')
  assert.equal(read.tool, 'demo.echo')
  assert.equal(read.data.text, 'hi')
  assert.equal(echoes, 1)

  const preview = await run.execute({ id: 'demo.echo', args: { text: 'hi' }, preview: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.data.preview, true)
  assert.equal(echoes, 1)

  const denied = await run.execute({ id: 'demo.write', args: {} })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'E_DENIED')
  assert.match(denied.error.remediation, /^Call os_request/)
  assert.equal(denied.error.nextTools[0].tool, 'os_request')
  assert.equal(writes, 0)

  const allowed = await run.execute({ id: 'demo.write', args: {}, grant: { id: 'g1', status: 'active' } })
  assert.equal(allowed.ok, true)
  assert.equal(writes, 1)

  const unknown = await run.execute({ id: 'no.such', args: {} })
  assert.equal(unknown.error.code, 'E_NOT_FOUND')
  assert.equal((await run.execute({ id: 'demo.echo', args: {} })).error.code, 'E_INVALID_ARGUMENT')
})

test('os_do reuses idempotency keys and rejects key reuse with different args', async () => {
  const { registry, tool } = mount()
  let writes = 0
  registry.register(writeCap({ handler: async args => { writes += 1; return { written: true, args } } }))
  const run = tool('os_do')
  const grant = { id: 'g1', status: 'active' }
  const first = await run.execute({ id: 'demo.write', args: { value: 1 }, grant, idempotencyKey: 'k1' })
  const second = await run.execute({ id: 'demo.write', args: { value: 1 }, grant, idempotencyKey: 'k1' })
  assert.deepEqual(second, first)
  assert.equal(writes, 1)
  const conflict = await run.execute({ id: 'demo.write', args: { value: 2 }, grant, idempotencyKey: 'k1' })
  assert.equal(conflict.error.code, 'E_CONFLICT')
})

test('os_request needs ctx.allow.request and os_observe reads back the request', async () => {
  const { ctx, registry, tool } = mount()
  registry.register(writeCap())
  const missing = await tool('os_request').execute({ id: 'demo.write', args: {}, reason: 'need it' })
  assert.equal(missing.error.code, 'E_UNAVAILABLE')

  ctx.allow = {
    request: async request => ({ requestId: 'req_1', status: 'pending', hint: 'Ask a human.', echo: request }),
  }
  const requested = await tool('os_request').execute({ id: 'demo.write', args: { value: 1 }, reason: 'need it' }, { subject: 'session-1' })
  assert.equal(requested.ok, true)
  assert.equal(requested.requestId, 'req_1')
  assert.equal(requested.status, 'pending')
  assert.equal(requested.hint, 'Ask a human.')

  const observed = await tool('os_observe').execute({ requestId: 'req_1' })
  assert.equal(observed.ok, true)
  assert.equal(observed.state, 'pending')
  assert.equal(observed.kind, 'request')
  assert.equal((await tool('os_observe').execute({ requestId: 'req_x' })).error.code, 'E_NOT_FOUND')
  assert.equal((await tool('os_observe').execute({})).error.code, 'E_INVALID_ARGUMENT')
})

test('os_observe reads jobs and handles returned by a capability', async () => {
  const { registry, tool } = mount()
  registry.register(readCap({
    handler: async () => ({
      summary: 'Started a job.',
      job: { id: 'job_1', state: 'running', progress: { done: 0, total: 2 } },
      handles: [{ ref: 'dsh://trace/t1', kind: 'text' }],
    }),
  }))
  const result = await tool('os_do').execute({ id: 'demo.echo', args: { text: 'x' } })
  assert.equal(result.job.id, 'job_1')
  assert.equal((await tool('os_observe').execute({ jobId: 'job_1' })).state, 'running')
  assert.equal((await tool('os_observe').execute({ handle: 'dsh://trace/t1' })).state, 'available')
  assert.equal((await tool('os_observe').execute({ jobId: 'job_x' })).error.code, 'E_NOT_FOUND')
})

test('os_help returns a 4-step plan with capabilities and risks; os_status reports health', async () => {
  const { registry, tool } = mount()
  registry.register(readCap())
  registry.register(writeCap())
  const help = await tool('os_help').execute({ task: 'echo and write' })
  assert.equal(help.ok, true)
  assert.equal(help.steps.length, 4)
  assert.ok(help.capabilities.some(capability => capability.id === 'demo.echo'))
  assert.ok(help.risks.includes('read'))
  assert.ok(help.risks.includes('write'))

  const status = await tool('os_status').execute({})
  assert.equal(status.ok, true)
  assert.equal(status.version, '0.4.0')
  assert.deepEqual(status.modules, ['demo'])
  assert.equal(status.health.status, 'ok')
  assert.equal(status.tools.length, 6)
})
