import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../lib/server.mjs'

const BIN = fileURLToPath(new URL('../bin/dsh-os-a2a.js', import.meta.url))
const IDS = ['act', 'allow', 'snip', 'check', 'nest', 'trigger', 'seek', 'trace', 'stage', 'ring', 'root', 'kernel']
const ids = () => {
  let n = 0
  return prefix => `${prefix}_${++n}`
}
const make = (options = {}) => createServer({ newId: ids(), ...options })

async function call(server, method, params = {}) {
  return server.handle({ jsonrpc: '2.0', id: 1, method, params })
}
async function ok(server, method, params) {
  const response = await call(server, method, params)
  assert.equal(response.error, undefined)
  return response.result
}
async function err(server, method, params) {
  const response = await call(server, method, params)
  assert.ok(response.error, `expected ${method} to fail`)
  return response.error
}
function send(server, text, metadata = {}) {
  return ok(server, 'message/send', { message: { messageId: 'm1', role: 'user', parts: [{ kind: 'text', text }] }, metadata })
}

test('agent/card exposes the 12 dsh-os skills with required fields', async () => {
  const card = await ok(make(), 'agent/card')
  assert.equal(card.name, 'dsh-os')
  assert.equal(card.version, '0.1.0')
  assert.equal(card.url, 'http://127.0.0.1:8787/a2a')
  assert.equal(card.capabilities.streaming, false)
  assert.deepEqual(card.skills.map(skill => skill.id), IDS)
  assert.equal(card.skills.length, 12)
  for (const skill of card.skills) {
    assert.ok(skill.name && skill.description)
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0)
    assert.ok(Array.isArray(skill.examples) && skill.examples.length > 0)
  }
})

test('message/send completes, tasks/get and tasks/list return the task', async () => {
  const server = make()
  const task = await send(server, 'hello', { skill: 'act' })
  assert.equal(task.kind, 'task')
  assert.equal(task.status.state, 'completed')
  assert.equal(task.metadata.skill, 'act')
  assert.deepEqual(task.artifacts[0].parts[0].data, { echo: 'hello', skill: 'act' })
  assert.deepEqual(await ok(server, 'tasks/get', { id: task.id }), task)
  const listed = await ok(server, 'tasks/list', {})
  assert.equal(listed.total, 1)
  assert.equal(listed.tasks[0].id, task.id)
  assert.equal((await ok(server, 'tasks/list', { state: 'completed' })).total, 1)
  assert.equal((await ok(server, 'tasks/list', { state: 'canceled' })).total, 0)
})

test('tasks/cancel cancels a pending task and rejects a terminal one', async () => {
  const server = make()
  const pending = await send(server, 'needs approval', { skill: 'allow', requiresApproval: true })
  assert.equal(pending.status.state, 'input-required')
  const canceled = await ok(server, 'tasks/cancel', { id: pending.id })
  assert.equal(canceled.status.state, 'canceled')
  assert.equal(canceled.approvalRequest.state, 'canceled')
  assert.equal((await err(server, 'tasks/cancel', { id: pending.id })).code, -32002)
})

test('approval flow: input-required, approve resumes, deny cancels', async () => {
  const server = make()
  const pending = await send(server, 'delete temp', { skill: 'act', requiresApproval: true, reason: 'writes a file' })
  assert.equal(pending.status.state, 'input-required')
  assert.equal(pending.approvalRequest.state, 'pending')
  assert.equal(pending.approvalRequest.reason, 'writes a file')
  assert.equal(pending.artifacts.length, 0)
  const approved = await ok(server, 'tasks/approve', { id: pending.id })
  assert.equal(approved.status.state, 'completed')
  assert.equal(approved.approvalRequest.state, 'approved')
  assert.deepEqual(approved.artifacts[0].parts[0].data, { echo: 'delete temp', skill: 'act' })

  const second = await send(server, 'another write', { skill: 'ring', requiresApproval: true })
  const denied = await ok(server, 'tasks/deny', { id: second.id, reason: 'no' })
  assert.equal(denied.status.state, 'canceled')
  assert.equal(denied.approvalRequest.state, 'denied')
  assert.equal(denied.approvalRequest.reason, 'no')
  assert.equal((await err(server, 'tasks/approve', { id: approved.id })).code, -32010)
})

test('unknown task, method, skill and params return JSON-RPC errors', async () => {
  const server = make()
  const missing = await err(server, 'tasks/get', { id: 'task_nope' })
  assert.equal(missing.code, -32001)
  assert.equal(missing.data.taskId, 'task_nope')
  assert.equal((await err(server, 'tasks/nope', {})).code, -32601)
  assert.equal((await err(server, 'message/send', { message: { parts: [{ kind: 'text', text: 'x' }] }, metadata: { skill: 'nope' } })).code, -32602)
  assert.equal((await err(server, 'tasks/get', {})).code, -32602)
})

test('an injected executor replaces the simulated {echo, skill} result', async () => {
  const seen = []
  const server = make({
    executor: async ({ skill, text, approval }) => {
      seen.push({ skill, text, approval: approval?.state ?? null })
      return { data: { echo: text.toUpperCase(), skill }, text: 'custom output' }
    },
  })
  const task = await send(server, 'hi', { skill: 'kernel' })
  assert.deepEqual(seen, [{ skill: 'kernel', text: 'hi', approval: null }])
  assert.deepEqual(task.artifacts[0].parts[0], { kind: 'text', text: 'custom output' })
  assert.deepEqual(task.artifacts[0].parts[1].data, { echo: 'HI', skill: 'kernel' })
})

test('bin speaks newline-delimited JSON-RPC 2.0 over stdio', () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'agent/card' },
    { jsonrpc: '2.0', id: 2, method: 'message/send', params: { message: { messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'ping' }] }, metadata: { skill: 'check' } } },
  ]
  const result = spawnSync(process.execPath, [BIN], { input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].result.skills.length, 12)
  assert.equal(lines[1].result.status.state, 'completed')
  assert.deepEqual(lines[1].result.artifacts[0].parts[0].data, { echo: 'ping', skill: 'check' })
})
