import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CheckRunner } from '../lib/runner.js'

const ndjson = (...events) => `${events.map(event => JSON.stringify(event)).join('\n')}\n`

function fakeSpawn(behavior = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kills = []
    child.kill = signal => {
      child.kills.push(signal)
      behavior.onKill?.(signal, child)
      return true
    }
    calls.push({ command, args, options, child })
    setImmediate(() => behavior.run?.(child, { command, args, options }))
    return child
  }
  return { spawn, calls }
}

function emit(child, { stdout = '', stderr = '', code = 0, signal = null } = {}) {
  if (stdout) child.stdout.emit('data', stdout)
  if (stderr) child.stderr.emit('data', stderr)
  child.emit('close', code, signal)
}

const SUCCESS = ndjson(
  { type: 'session', sessionId: 'session-1', cwd: '/work' },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  { type: 'tool_call', callId: 'call-1', tool: 'read' },
  { type: 'tool_result', callId: 'call-1', status: 'completed' },
  { type: 'final', sessionId: 'session-1', reason: { kind: 'completed' }, text: 'pong' },
)

test('spawns headless --json and maps result, trajectory, cost, approvals and raw', async () => {
  const fake = fakeSpawn({ run: child => emit(child, { stdout: SUCCESS }) })
  const runner = new CheckRunner({
    dshBin: '/opt/dsh/bin.js',
    cwd: '/repo',
    env: { CHECK_TOKEN: 'set-by-host' },
    spawn: fake.spawn,
  })
  const record = await runner.run({ id: 'pong', prompt: 'Reply with exactly: pong' })

  assert.equal(record.ok, true)
  assert.equal(record.code, null)
  assert.equal(record.taskId, 'pong')
  assert.deepEqual(record.result, { text: 'pong' })
  assert.deepEqual(record.trajectory, { steps: 1, toolCalls: 1, errors: 0 })
  assert.deepEqual(record.cost, { tokens: 7, usd: 0 })
  assert.deepEqual(record.approvals, { asked: 0, rejected: 0 })
  assert.equal(record.exitCode, 0)
  assert.equal(record.raw.sessionId, 'session-1')
  assert.equal(record.raw.finalReason.kind, 'completed')
  assert.equal(record.raw.events, 5)
  assert.equal(record.raw.usdSource, 'none')
  assert.equal(record.raw.usageComplete, true)

  const call = fake.calls[0]
  assert.equal(call.command, 'node')
  assert.deepEqual(call.args, ['/opt/dsh/bin.js', '--profile', 'headless', '--json', 'Reply with exactly: pong'])
  assert.equal(call.options.cwd, '/repo')
  assert.equal(call.options.env.CHECK_TOKEN, 'set-by-host')
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
})

test('honors a custom profile and task cwd/env', async () => {
  const fake = fakeSpawn({ run: child => emit(child, { stdout: SUCCESS }) })
  const runner = new CheckRunner({ dshBin: '/dsh.js', cwd: '/repo', profile: 'ci', env: { BASE: '1' }, spawn: fake.spawn })
  const record = await runner.run({ id: 'x', prompt: 'hi', cwd: 'worktree', env: { TASK: '2' } })

  assert.equal(record.ok, true)
  assert.deepEqual(fake.calls[0].args.slice(0, 4), ['/dsh.js', '--profile', 'ci', '--json'])
  assert.equal(fake.calls[0].options.cwd, '/repo/worktree')
  assert.equal(fake.calls[0].options.env.BASE, '1')
  assert.equal(fake.calls[0].options.env.TASK, '2')
})

test('a non-zero exit returns ok:false with exit_nonzero and the final reason', async () => {
  const fake = fakeSpawn({
    run: child => emit(child, {
      stdout: ndjson(
        { type: 'session', sessionId: 'session-2' },
        { type: 'final', sessionId: 'session-2', reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } }, text: '' },
      ),
      stderr: 'dsh: MISSING_CREDENTIAL\n',
      code: 1,
    }),
  })
  const runner = new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn })
  const record = await runner.run({ id: 'missing-key', prompt: 'hi' })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'exit_nonzero')
  assert.equal(record.exitCode, 1)
  assert.equal(record.raw.finalReason.error.code, 'MISSING_CREDENTIAL')
  assert.match(record.raw.stderr, /MISSING_CREDENTIAL/)
})

test('bad JSON returns ok:false with invalid_json instead of throwing', async () => {
  const fake = fakeSpawn({ run: child => emit(child, { stdout: '<html>not json</html>\n' }) })
  const runner = new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn })
  const record = await runner.run({ id: 'bad', prompt: 'hi' })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'invalid_json')
  assert.equal(record.raw.parseErrors, 1)
  assert.equal(record.raw.events, 0)
})

test('valid events without a final event return no_final', async () => {
  const fake = fakeSpawn({ run: child => emit(child, { stdout: ndjson({ type: 'session', sessionId: 's' }) }) })
  const runner = new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn })
  const record = await runner.run({ id: 'no-final', prompt: 'hi' })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'no_final')
})

test('timeout sends SIGINT then SIGKILL and reports timedOut', async () => {
  const fake = fakeSpawn({
    onKill: (signal, child) => {
      if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'))
    },
  })
  const runner = new CheckRunner({ dshBin: '/dsh.js', timeoutMs: 10, killGraceMs: 10, spawn: fake.spawn })
  const record = await runner.run({ id: 'hang', prompt: 'loop forever' })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'timeout')
  assert.equal(record.raw.timedOut, true)
  assert.equal(record.exitCode, null)
  assert.deepEqual(fake.calls[0].child.kills, ['SIGINT', 'SIGKILL'])
})

test('an already-aborted signal does not spawn', async () => {
  const fake = fakeSpawn()
  const runner = new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn })
  const controller = new AbortController()
  controller.abort()
  const record = await runner.run({ id: 'aborted', prompt: 'hi' }, { signal: controller.signal })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'aborted')
  assert.equal(fake.calls.length, 0)
})

test('spawn errors become spawn_error values', async () => {
  const fake = fakeSpawn({ run: child => child.emit('error', new Error('spawn ENOENT')) })
  const runner = new CheckRunner({ dshBin: '/missing/dsh.js', spawn: fake.spawn })
  const record = await runner.run({ id: 'boom', prompt: 'hi' })

  assert.equal(record.ok, false)
  assert.equal(record.code, 'spawn_error')
  assert.match(record.raw.spawnError, /ENOENT/)
})

test('invalid tasks return invalid_task without spawning', async () => {
  const fake = fakeSpawn()
  const runner = new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn })
  for (const task of [null, {}, { prompt: '' }, { prompt: 42 }]) {
    const record = await runner.run(task)
    assert.equal(record.ok, false)
    assert.equal(record.code, 'invalid_task')
  }
  assert.equal(fake.calls.length, 0)
})

test('dshBin defaults to DSH_BIN, then node_modules/.bin/dsh', () => {
  const previous = process.env.DSH_BIN
  try {
    process.env.DSH_BIN = '/custom/dsh.js'
    assert.equal(new CheckRunner().dshBin, '/custom/dsh.js')
    delete process.env.DSH_BIN
    assert.equal(new CheckRunner({ cwd: '/repo/pkg' }).dshBin, '/repo/pkg/node_modules/.bin/dsh')
  } finally {
    if (previous === undefined) delete process.env.DSH_BIN
    else process.env.DSH_BIN = previous
  }
})
