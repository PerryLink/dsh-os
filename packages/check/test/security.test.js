import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CheckRunner, MAX_OUTPUT_BYTES } from '../lib/runner.js'
import { apply } from '../index.js'

const EXEC = { agent: { session: { id: 'agent:test' } } }
const NDJSON = `${JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: 'ok' })}\n`
const record = (taskId = 'task', usd = 0) => ({ ok: true, code: null, taskId, result: { text: 'ok' },
  trajectory: { steps: 1, toolCalls: 0, errors: 0 }, cost: { tokens: 10, usd }, approvals: { asked: 0, rejected: 0 },
  exitCode: 0, raw: { durationMs: 12 } })
function context(allow) {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => (name === 'allow' ? allow : services.get(name)),
    _tools: tools,
  }
}
function spawner(behavior = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kills = []
    child.kill = signal => (child.kills.push(signal), behavior.onKill?.(signal, child), true)
    calls.push({ command, args, options, child })
    setImmediate(() => behavior.run?.(child))
    return child
  }
  return { spawn, calls }
}
const succeed = child => { child.stdout.emit('data', NDJSON); child.emit('close', 0, null) }
test('check_run without a Grant returns E_DENIED and an allow_request hint', async () => {
  let runs = 0
  const ctx = context(undefined)
  apply(ctx, { runner: { run: async () => (runs += 1, record()) } })
  const denied = await ctx._tools.get('check_run').execute({ prompt: 'do not run me' }, EXEC)
  assert.equal(denied.code, 'E_DENIED')
  assert.equal(denied.error.subcode, 'grant_required')
  assert.equal(denied.error.nextTools[0].tool, 'allow_request')
  assert.deepEqual(denied.error.nextTools[0].args, {
    subject: 'agent:test', capability: 'check:run',
    reason: 'Run one headless DSH check task (spawns a model-backed child process).',
  })
  assert.equal(runs, 0)
  const deny = context({ check: async () => ({ allowed: false, reason: 'no-grant' }) })
  apply(deny, { runner: { run: async () => (runs += 1, record()) } })
  assert.equal((await deny._tools.get('check_run').execute({ prompt: 'x' }, EXEC)).code, 'E_DENIED')
})
test('a check:run Grant allows the run and records a prompt-free audit entry', async () => {
  const checks = []
  const allow = { check: async input => (checks.push(input), { allowed: input.capability === 'check:run' }) }
  const ctx = context(allow)
  const check = apply(ctx, { runner: { profile: 'headless', run: async task => record(task.id, 0.25) } })
  const ran = await ctx._tools.get('check_run').execute({ prompt: 'never log this prompt', id: 'task-1' }, EXEC)
  assert.deepEqual(checks[0], { subject: 'agent:test', capability: 'check:run' })
  const [entry] = check.audit()
  assert.match(ran.runId, /^run_/)
  assert.deepEqual([entry.taskId, entry.profile, entry.exitCode, entry.costUsd], ['task-1', 'headless', 0, 0.25])
  assert.equal(JSON.stringify(entry).includes('never log this prompt'), false)
})
test('maxRunsPerHour rejects the next run with E_LIMIT before spawning', async () => {
  let runs = 0
  const ctx = context({ check: async () => ({ allowed: true }) })
  apply(ctx, { maxRunsPerHour: 1, runner: { run: async () => (runs += 1, record()) } })
  const tool = ctx._tools.get('check_run')
  assert.equal((await tool.execute({ prompt: 'one' }, EXEC)).ok, true)
  const limited = await tool.execute({ prompt: 'two' }, EXEC)
  assert.equal(limited.code, 'E_LIMIT')
  assert.equal(limited.error.subcode, 'quota_exceeded')
  assert.equal(limited.error.details.reason, 'maxRunsPerHour')
  assert.ok(limited.error.retryAfterMs > 0)
  assert.equal(runs, 1)
})
test('maxCostUsd rejects at the cap; without a meter only the count applies', async () => {
  let runs = 0
  const allowed = { check: async () => ({ allowed: true }) }
  const meter = context(allowed)
  meter.provide('costMeter', { summary: async () => ({ spentUsd: 0.75 }) })
  apply(meter, { maxCostUsd: 0.5, runner: { run: async () => (runs += 1, record()) } })
  const limited = await meter._tools.get('check_run').execute({ prompt: 'costly' }, EXEC)
  assert.equal(limited.code, 'E_LIMIT')
  assert.equal(limited.error.details.reason, 'maxCostUsd')
  const noMeter = context(allowed)
  apply(noMeter, { maxCostUsd: 0.001, runner: { run: async () => (runs += 1, record()) } })
  assert.equal((await noMeter._tools.get('check_run').execute({ prompt: 'no meter' }, EXEC)).ok, true)
  assert.equal(runs, 1)
})
test('child env is allowlisted and allowedDshBins pins the executable', async () => {
  const fake = spawner({ run: succeed })
  const previous = {}
  const polluted = {
    OPENAI_API_KEY: 'sk-openai', DEEPSEEK_API_KEY: 'sk-deepseek', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require /tmp/evil.js', NODE_ENV: 'test', DSH_HOME: '/tmp/dsh-home', HOST_ONLY_SECRET: 'nope',
  }
  for (const [key, value] of Object.entries(polluted)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    const runner = new CheckRunner({
      dshBin: '/opt/dsh.js', allowedDshBins: ['/opt/dsh.js'], env: { CHECK_TOKEN: 'explicit' }, spawn: fake.spawn,
    })
    assert.equal((await runner.run({ id: 'env', prompt: 'x', env: { TASK_ONLY: 'yes' } })).ok, true)
    const env = fake.calls[0].options.env
    for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'HOST_ONLY_SECRET']) {
      assert.equal(env[key], undefined, `${key} must not be inherited`)
    }
    assert.deepEqual([env.NODE_ENV, env.DSH_HOME, env.PATH, env.CHECK_TOKEN, env.TASK_ONLY],
      ['test', '/tmp/dsh-home', process.env.PATH, 'explicit', 'yes'])
    if (process.env.HOME !== undefined) assert.equal(env.HOME, process.env.HOME)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assert.throws(() => new CheckRunner({ dshBin: '/etc/evil.js', allowedDshBins: ['/opt/dsh.js'], spawn: fake.spawn }), { code: 'E_DENIED' })
})
test('stdout capture stops at 2 MiB and reports truncation', async () => {
  const fake = spawner({
    run: child => {
      child.stdout.emit('data', 'x'.repeat(MAX_OUTPUT_BYTES + 1024))
      child.emit('close', 0, null)
    },
  })
  const record = await new CheckRunner({ dshBin: '/dsh.js', spawn: fake.spawn }).run({ id: 'big', prompt: 'x' })
  assert.equal(record.raw.stdoutTruncated, true)
  assert.equal(record.raw.stdoutBytes, MAX_OUTPUT_BYTES)
  assert.equal(record.code, 'invalid_json')
})
test('AbortSignal forwards SIGINT then SIGKILL mid-run', async () => {
  const controller = new AbortController()
  const fake = spawner({
    run: () => setTimeout(() => controller.abort(), 1),
    onKill: (signal, child) => {
      if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'))
    },
  })
  const runner = new CheckRunner({ dshBin: '/dsh.js', killGraceMs: 5, spawn: fake.spawn })
  const record = await runner.run({ id: 'abort', prompt: 'x' }, { signal: controller.signal })
  assert.equal(record.code, 'aborted')
  assert.deepEqual(fake.calls[0].child.kills, ['SIGINT', 'SIGKILL'])
})
