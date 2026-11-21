import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as mountAllow } from '../index.js'
import { apply as mountAct } from '../../act/index.js'

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
  }
}

// Integration with the sibling Act package: this is the exact gate the
// approval-recovery scenario exercises (act_invoke -> allow.check).
test('one approval writes once; replaying act_invoke is denied', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-allow-act-once-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'config.json')
  writeFileSync(target, '{"timeout":10}\n')

  const ctx = fakeContext()
  const allow = mountAllow(ctx, {})
  mountAct(ctx, { workdir: dir })
  const invoke = ctx._tools.get('act_invoke')
  const exec = { agent: { session: { id: 'agent:model' } } }
  const args = { id: 'fs.write', args: { path: target, text: '{"timeout":30}\n' } }

  const denied = await invoke.execute(args, exec)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'grant_required')
  assert.equal(denied.capability, 'act:invoke:fs.write')

  const request = await ctx._tools.get('allow_request').execute({
    subject: 'agent:model', capability: denied.capability, scope: '*', reason: 'one edit',
  })
  assert.equal(request.maxUses, 1)
  allow.approve({ id: request.requestId, by: 'alice' })

  const written = await invoke.execute(args, exec)
  assert.equal(written.ok, true)
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).timeout, 30)

  const replay = await invoke.execute(args, exec)
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'grant_required')
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).timeout, 30)
  assert.equal(allow.list()[0].status, 'used')
})
