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
    _tools: tools,
  }
  const service = apply(ctx)
  return { ctx, service }
}

function provider(name, hits) {
  return { name, async search() { return hits } }
}

test('every seek hit is tainted and names its provider as the source', async () => {
  const { service } = setup()
  service.registerProvider(provider('locator', [
    { ref: 'dsh://locator/src/a.ts', title: 'A', snippet: 'file body' },
  ]))
  service.registerProvider(provider('memento', [
    { ref: 'dsh://memento/m1', title: 'M', snippet: 'remembered', tainted: false },
  ]))

  const result = await service.search('x')
  const bySource = Object.fromEntries(result.hits.map(hit => [hit.source, hit]))
  assert.equal(bySource.locator.tainted, true)
  assert.equal(bySource.locator.taintSource, 'locator')
  assert.equal(bySource.memento.tainted, true, 'a provider cannot opt a hit out of taint')
  assert.equal(bySource.memento.taintSource, 'memento')
})

test('seek_search items and legacy hits keep the taint metadata', async () => {
  const { ctx, service } = setup()
  service.registerProvider(provider('alpha', [
    { ref: 'dsh://alpha/a', title: 'A', snippet: 'S', score: 1 },
  ]))

  const result = await ctx._tools.get('seek_search').execute({ query: 'x' })
  assert.equal(result.items[0].tainted, true)
  assert.equal(result.items[0].taintSource, 'alpha')
  assert.deepEqual(result.hits, result.items)
  assert.equal(result.hits[0].tainted, true)
})
