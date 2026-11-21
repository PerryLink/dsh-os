import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function setup() {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  const service = apply(ctx)
  return { ctx, service, tool: tools.get('act_list') }
}

test('act_list returns an os.result/v1 envelope and keeps actions', async () => {
  const { service, tool } = setup()
  const result = await tool.execute({})
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'act_list')
  assert.equal(result.summary, '7 actions')
  assert.equal(result.summary.length <= 200, true)
  assert.deepEqual(result.items, result.actions)
  assert.equal(result.items.length, 7)
  assert.deepEqual(result.page, { limit: 7, offset: 0, returned: 7, total: 7, hasMore: false })
  assert.equal(result.truncated, false)
  assert.equal(result.error, null)
  assert.equal(result.next[0].tool, 'act_invoke')
  assert.equal(result.next[0].args.id, 'echo')
  assert.equal(result.next.some(step => step.tool === 'allow_request'), true)
  assert.deepEqual(service.list().map(action => action.id), result.items.map(action => action.id))
})

test('act_list keeps the query filter and always exposes the legacy actions field', async () => {
  const { tool } = setup()
  const result = await tool.execute({ query: 'fs.' })
  assert.equal(result.summary, '4 actions')
  assert.equal(result.items.length, 4)
  assert.deepEqual(result.actions.map(action => action.id), ['fs.read', 'fs.write', 'fs.list', 'fs.undo'])
  assert.equal(result.page.total, 4)
})

test('act_list wraps failures in the new envelope without changing the code', async () => {
  const { service, tool } = setup()
  service.list = () => {
    throw Object.assign(new Error('broken registry'), { code: 'invalid_action' })
  }
  const result = await tool.execute({})
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_action')
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.items, [])
  assert.equal(result.next[0].tool, 'act_list')
  assert.equal(result.error.code, 'invalid_action')
  assert.equal(result.error.retryable, false)
  assert.equal(typeof result.error.remediation, 'string')
  assert.equal(result.error.nextTools, result.next)
})
