import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as mountKernel } from '../index.js'

function mount(stateFile, handler) {
  const tools = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
  }
  mountKernel(ctx, {
    stateFile,
    capabilities: [{
      id: 'act.fs.write', title: 'Write a workspace file', summary: 'Write one file.',
      inputSchema: { type: 'object', additionalProperties: true }, risk: 'write', handler,
    }],
  })
  return { tool: name => tools.get(name) }
}

test('idempotencyKey survives a restart through stateFile without storing args', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'idempotency.json')
  const args = { path: 'src/a.ts', contents: 'secret-contents-xyz' }
  let writes = 0
  const first = mount(stateFile, async () => { writes += 1; return { written: true } })
  const original = await first.tool('os_do').execute({
    id: 'act.fs.write', args, grant: { id: 'g1', status: 'active' }, idempotencyKey: 'k1',
  })
  assert.equal(original.ok, true)
  assert.equal(writes, 1)

  const journal = readFileSync(stateFile, 'utf8')
  assert.match(journal, /"argsHash"/)
  assert.equal(journal.includes('secret-contents-xyz'), false, 'args are never persisted')
  assert.equal(/"args"\s*:/.test(journal), false)

  // Fresh mount, same file, no injected grant: replay returns the original
  // result and does not run the handler.
  let replayedExecutions = 0
  const second = mount(stateFile, async () => { replayedExecutions += 1; return { written: true } })
  const replayed = await second.tool('os_do').execute({ id: 'act.fs.write', args, idempotencyKey: 'k1' })
  assert.deepEqual(replayed, original)
  assert.equal(replayedExecutions, 0)
  const conflict = await second.tool('os_do').execute({
    id: 'act.fs.write', args: { ...args, contents: 'different' }, idempotencyKey: 'k1',
  })
  assert.equal(conflict.error.code, 'E_CONFLICT')
  assert.equal(replayedExecutions, 0)
})

test('without stateFile idempotency remains in memory only', async () => {
  let writes = 0
  const h = mount(undefined, async () => { writes += 1; return { written: true } })
  const input = { id: 'act.fs.write', args: { path: 'a' }, grant: { id: 'g1', status: 'active' }, idempotencyKey: 'k1' }
  const first = await h.tool('os_do').execute(input)
  assert.equal(first.ok, true)
  assert.deepEqual(await h.tool('os_do').execute(input), first)
  assert.equal(writes, 1)
})
