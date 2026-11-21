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
  const calls = []
  service.registerProvider({
    name: 'alpha',
    async search(query, options) {
      calls.push({ query, options })
      return Array.from({ length: 60 }, (_, index) => ({
        ref: `dsh://alpha/hit-${String(index).padStart(2, '0')}`,
        source: 'alpha',
        title: `hit ${index}`,
        snippet: `snippet ${index}`,
        score: 1 - index / 100,
      })).slice(0, options.limit)
    },
  })
  return { service, tool: tools.get('seek_search'), calls }
}

test('seek_search returns an os.result/v1 envelope with default limit 10', async () => {
  const { tool, calls } = setup()
  const result = await tool.execute({ query: 'x', sources: ['alpha'] })
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'seek_search')
  assert.equal(result.items.length, 10)
  assert.deepEqual(result.hits, result.items)
  assert.equal(result.query, 'x')
  assert.equal(result.total, 10)
  assert.deepEqual(result.errors, [])
  assert.equal(result.page.limit, 10)
  assert.equal(result.page.offset, 0)
  assert.equal(result.page.returned, 10)
  assert.equal(result.page.hasMore, true)
  assert.equal(result.truncated, true)
  assert.equal(result.error, null)
  assert.equal(result.next[0].tool, 'seek_search')
  assert.deepEqual(result.next[0].args, { query: 'x', sources: ['alpha'], limit: 10, offset: 10 })
  assert.equal(calls[0].options.limit, 11)
})

test('seek_search pages with offset and caps limit at 50', async () => {
  const { tool } = setup()
  const first = await tool.execute({ query: 'x', sources: ['alpha'], limit: 500 })
  assert.equal(first.items.length, 50)
  assert.equal(first.page.limit, 50)
  assert.equal(first.page.hasMore, true)

  const second = await tool.execute({ query: 'x', sources: ['alpha'], limit: 50, offset: 50 })
  assert.equal(second.items.length, 10)
  assert.equal(second.page.offset, 50)
  assert.equal(second.page.hasMore, false)
  assert.equal(second.truncated, false)
  assert.equal(second.next[0].tool, 'seek_resolve')
  assert.equal(second.next[0].args.ref, second.items[0].ref)

  const tail = await tool.execute({ query: 'x', sources: ['alpha'], limit: 10, offset: 55 })
  assert.equal(tail.items.length, 5)
  assert.equal(tail.page.hasMore, false)
})

test('seek_search keeps its documented throwing codes and envelopes unexpected failures', async () => {
  const { service, tool } = setup()
  await assert.rejects(tool.execute({ query: '   ' }), error => error.code === 'invalid_query')
  await assert.rejects(tool.execute({ query: 'x', limit: 0 }), error => error.code === 'invalid_limit')
  await assert.rejects(tool.execute({ query: 'x' }, { signal: { aborted: false } }), error => error.code === 'invalid_signal')

  service.registerProvider({
    name: 'boom',
    async search() {
      return [{ get ref() { throw new Error('broken hit') } }]
    },
  })
  const result = await tool.execute({ query: 'x', sources: ['boom'] })
  assert.equal(result.schema, 'os.result/v1')
  assert.equal(result.ok, false)
  assert.equal(result.tool, 'seek_search')
  assert.equal(result.code, 'E_INTERNAL')
  assert.equal(result.error.code, 'E_INTERNAL')
  assert.equal(result.error.retryable, false)
  assert.equal(typeof result.error.remediation, 'string')
  assert.deepEqual(result.hits, [])
  assert.equal(result.total, 0)
  assert.equal(result.query, 'x')
  assert.deepEqual(result.errors, [])
  assert.equal(result.next[0].tool, 'seek_providers')
})
