import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const T0 = 1_700_000_000_000

function setup() {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  const service = apply(ctx, { now: () => T0 })
  return { service, tool: tools.get('snip_search') }
}

function seed(service, count, word = 'needle') {
  for (let index = 0; index < count; index += 1) service.add({ text: `${word} ${index}` })
}

test('snip_search returns an os.result/v1 envelope with default limit 20', async () => {
  const { service, tool } = setup()
  seed(service, 25)
  const result = await tool.execute({ query: 'needle' })
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'snip_search')
  assert.equal(result.items.length, 20)
  assert.deepEqual(result.entries, result.items)
  assert.equal(result.query, 'needle')
  assert.deepEqual(result.page, { limit: 20, offset: 0, returned: 20, total: 25, hasMore: true })
  assert.equal(result.truncated, true)
  assert.equal(result.summary, '25 clippings matching "needle"')
  assert.equal(result.summary.length <= 200, true)
  assert.equal(result.error, null)
  assert.equal(result.next[0].tool, 'snip_search')
  assert.deepEqual(result.next[0].args, { query: 'needle', limit: 20, offset: 20 })
})

test('snip_search pages with offset and caps limit at 100', async () => {
  const { service, tool } = setup()
  seed(service, 120)
  const capped = await tool.execute({ query: 'needle', limit: 500 })
  assert.equal(capped.items.length, 100)
  assert.equal(capped.page.limit, 100)
  assert.equal(capped.page.total, 120)
  assert.equal(capped.page.hasMore, true)

  const second = await tool.execute({ query: 'needle', limit: 20, offset: 100 })
  assert.equal(second.items.length, 20)
  assert.equal(second.page.offset, 100)
  assert.equal(second.page.hasMore, false)
  assert.equal(second.truncated, false)
  assert.equal(second.next[0].tool, 'snip_get')

  const tail = await tool.execute({ query: 'needle', limit: 20, offset: 115 })
  assert.equal(tail.items.length, 5)
  assert.equal(tail.page.hasMore, false)
})

test('snip_search errors use the new envelope and keep SNIP_BAD_QUERY', async () => {
  const { tool } = setup()
  const result = await tool.execute({ query: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SNIP_BAD_QUERY')
  assert.equal(result.error.code, 'SNIP_BAD_QUERY')
  assert.equal(result.error.retryable, false)
  assert.equal(typeof result.error.message, 'string')
  assert.equal(typeof result.error.remediation, 'string')
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.items, [])
  assert.equal(result.next[0].tool, 'snip_list')
})
