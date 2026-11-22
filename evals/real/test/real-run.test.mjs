import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  loadScenarios, parseNdjson, summarizeStream, readApprovals, preflight, runScenario, writeReports,
} from '../../real-run.mjs'
import { summarize } from '../../metrics.mjs'

function fakeSpawn(handler) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    child.pid = 4242
    child.killed = []
    let closed = false
    const close = (code, signal) => { if (closed) return; closed = true; child.emit('close', code, signal) }
    child.kill = signal => { child.killed.push(signal); setImmediate(() => close(null, signal)) }
    calls.push({ command, args, options })
    setImmediate(() => handler({ child, args, options, close }))
    return child
  }
  spawn.calls = calls
  return spawn
}

const emit = (child, event) => child.stdout.emit('data', `${JSON.stringify(event)}\n`)
const emitRaw = (child, text) => child.stdout.emit('data', text)
const base = {
  title: 'unit', goal: 'unit', timeoutMs: 2000, maxSteps: 5, dshBin: '/fake/dsh/bin.js', profile: 'headless',
}

test('scenario JSONs load and cover the required kinds', () => {
  const scenarios = loadScenarios()
  assert.equal(scenarios.length, 10)
  const ids = scenarios.map(scenario => scenario.id)
  for (const id of [
    'approval-recovery', 'cost-summary', 'fix-failing-test', 'kernel-discovery', 'regression-triage',
    'seek-evidence', 'snip-search', 'trace-recall', 'ring-lifecycle', 'root-profile',
  ]) assert.ok(ids.includes(id), id)
  for (const id of ['snip-search', 'trace-recall', 'ring-lifecycle', 'root-profile']) {
    const scenario = scenarios.find(item => item.id === id)
    assert.ok(scenario.maxSteps <= 15, `${id} maxSteps`)
    assert.ok(scenario.maxTokens <= 120000, `${id} maxTokens`)
    assert.ok(scenario.timeoutMs <= 120000, `${id} timeoutMs`)
  }
  for (const scenario of scenarios) {
    assert.ok(scenario.goal && scenario.prompt && scenario.initial.length > 0, scenario.id)
    assert.ok(scenario.checks.length > 0, scenario.id)
    assert.ok(scenario.checks.every(check => ['file', 'json', 'command', 'toolUsed', 'approvals', 'evidence', 'finalText'].includes(check.kind)), scenario.id)
  }
  assert.ok(scenarios.find(scenario => scenario.id === 'seek-evidence').checks.some(check => check.kind === 'toolUsed'))
})

test('preflight refuses without DSH_BIN or a model key', () => {
  const noBin = preflight({ dshBin: '', keyPresent: true })
  assert.equal(noBin.ok, false)
  assert.equal(noBin.exitCode, 2)
  assert.match(noBin.message, /需要 DSH checkout \+ profile \+ 模型 key/)
  const noKey = preflight({ dshBin: process.execPath, keyPresent: false })
  assert.equal(noKey.ok, false)
  assert.match(noKey.message, /未运行/)
  const ok = preflight({ dshBin: process.execPath, profile: 'headless', keyPresent: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.profile, 'headless')
})

test('mock spawn success: parses NDJSON, grades external state, records tokens', async () => {
  const spawn = fakeSpawn(({ child, options, close }) => {
    writeFileSync(join(options.cwd, 'out.txt'), 'hello')
    emit(child, { type: 'session', sessionId: 's1', cwd: options.cwd })
    emit(child, { type: 'status', phase: 'step_start' })
    emit(child, { type: 'tool_call', callId: 'c1', tool: 'write', input: { path: 'out.txt' } })
    emit(child, { type: 'tool_result', callId: 'c1', status: 'completed' })
    emit(child, { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    emit(child, { type: 'text', text: 'done' })
    emit(child, { type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'done' })
    close(0, null)
  })
  const scenario = {
    ...base, id: 'unit-success', prompt: 'write out.txt',
    expectedFirstTool: ['write'],
    setup: [{ path: 'seed.txt', content: 'seed' }],
    checks: [
      { id: 'out', kind: 'file', path: 'out.txt', equals: 'hello' },
      { id: 'exit', kind: 'command', args: ['node', '-e', 'process.exit(0)'], expect: { exitCode: 0 } },
    ],
  }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless' })
  assert.equal(run.success, true)
  assert.equal(run.toolCalls, 1)
  assert.equal(run.firstTool, 'write')
  assert.equal(run.firstStepCorrect, true)
  assert.equal(run.tokensEstimate, 15)
  assert.equal(run.tokensSource, 'usage')
  assert.equal(run.protocolOk, true)
  assert.equal(run.exitCode, 0)
  assert.equal(run.checks.every(check => check.ok), true)
  const call = spawn.calls[0]
  assert.equal(call.args[0], base.dshBin)
  assert.deepEqual(call.args.slice(1, 4), ['--profile', 'headless', '--json'])
  assert.equal(call.args.at(-1), scenario.prompt)
  assert.notEqual(call.options.env.DSH_HOME, process.env.DSH_HOME)
  assert.equal(call.options.env.DSH_PERMISSION_MODE, 'workspace-write')
})

test('mock spawn failure: tool error and failed checks do not pass', async () => {
  const spawn = fakeSpawn(({ child, close }) => {
    emit(child, { type: 'status', phase: 'step_start' })
    emit(child, { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'false' } })
    emit(child, { type: 'tool_result', callId: 'c1', status: 'error', error: { code: 'EXIT_1' } })
    emit(child, { type: 'final', sessionId: 's1', reason: { kind: 'error' }, text: '' })
    close(1, null)
  })
  const scenario = {
    ...base, id: 'unit-failure', prompt: 'fail', checks: [{ id: 'missing', kind: 'file', path: 'out.txt', equals: 'hello' }],
  }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless' })
  assert.equal(run.success, false)
  assert.equal(run.exitCode, 1)
  assert.equal(run.protocolOk, false)
  assert.equal(run.failures.length, 1)
  assert.equal(run.invalidCalls, 0)
  assert.equal(run.checks[0].ok, false)
  assert.equal(run.finalReason.kind, 'error')
})

test('mock spawn timeout: SIGINT, timedOut, no success', async () => {
  const spawn = fakeSpawn(() => {})
  const scenario = { ...base, id: 'unit-timeout', prompt: 'hang', timeoutMs: 25, checks: [{ id: 'never', kind: 'file', path: 'out.txt' }] }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless', timeoutMs: 25, killGraceMs: 20 })
  assert.equal(run.timedOut, true)
  assert.equal(run.success, false)
  assert.equal(run.exitCode, null)
  assert.equal(spawn.calls.length, 1)
})

test('bad NDJSON lines are counted and skipped, not fatal', async () => {
  const spawn = fakeSpawn(({ child, options, close }) => {
    writeFileSync(join(options.cwd, 'out.txt'), 'hello')
    emitRaw(child, 'not-json\n{"type":"session","sessionId":"s1"}\n{broken\n')
    emit(child, { type: 'status', phase: 'step_end', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })
    emit(child, { type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'ok' })
    close(0, null)
  })
  const scenario = { ...base, id: 'unit-bad-json', prompt: 'x', setup: [], checks: [{ id: 'out', kind: 'file', path: 'out.txt', equals: 'hello' }] }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless' })
  assert.equal(run.parseErrors, 2)
  assert.equal(run.badLines.length, 2)
  assert.equal(run.success, true)
  assert.equal(run.tokensEstimate, 3)
})

test('approval audit is read from an isolated zstd session log', async () => {
  const spawn = fakeSpawn(({ child, options, close }) => {
    const dir = join(options.env.DSH_HOME, 'sessions', 's1')
    mkdirSync(dir, { recursive: true })
    const log = [
      JSON.stringify({ type: 'session', version: 4, id: 's1' }),
      JSON.stringify({ type: 'approval/asked', seq: 5, data: { id: 'a1', toolName: 'write', reason: 'outside workspace' } }),
      JSON.stringify({ type: 'approval/decided', seq: 6, data: { id: 'a1', outcome: 'unavailable' } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(log)))
    writeFileSync(join(options.cwd, 'report.json'), '{"blocked":true}')
    emit(child, { type: 'status', phase: 'step_start' })
    emit(child, { type: 'tool_call', callId: 'c1', tool: 'write', input: { path: '../outside.txt' } })
    emit(child, { type: 'tool_result', callId: 'c1', status: 'error', error: { code: 'SANDBOX_ESCALATION_UNAVAILABLE' } })
    emit(child, { type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'blocked' })
    close(0, null)
  })
  const scenario = {
    ...base, id: 'unit-approval', prompt: 'ask approval', checks: [
      { id: 'audit', kind: 'approvals', minAsked: 1, minDecided: 1 },
      { id: 'report', kind: 'json', path: 'report.json', expect: { blocked: true } },
    ],
  }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless' })
  assert.equal(run.approvals.source, 'log')
  assert.equal(run.approvals.asked, 1)
  assert.equal(run.approvals.decided, 1)
  assert.equal(run.approvals.rejected, 1)
  assert.equal(run.interventions.length, 1)
  assert.equal(run.success, true)
})

test('parse/summarize helpers stay pure', () => {
  const parsed = parseNdjson('{"type":"tool_call","tool":"read"}\nnope\n')
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.parseErrors, 1)
  const stream = summarizeStream([
    { type: 'status', phase: 'step_end', usage: { inputTokens: 2, outputTokens: 3 } },
    { type: 'tool_call', callId: 'c', tool: 'read', input: {} },
    { type: 'tool_result', callId: 'c', status: 'error', error: { code: 'E_TOOL' } },
  ])
  assert.equal(stream.tokens, 5)
  assert.equal(stream.steps[0].ok, false)
  assert.equal(stream.steps[0].code, 'E_TOOL')
  assert.equal(readApprovals('/nonexistent-dsh-home').source, 'none')
})

test('approval inference fallback is marked inferred, not audit', async () => {
  const spawn = fakeSpawn(({ child, close }) => {
    emit(child, { type: 'tool_call', callId: 'c1', tool: 'write', input: {} })
    emit(child, { type: 'tool_result', callId: 'c1', status: 'error', error: { code: 'SANDBOX_ESCALATION_UNAVAILABLE' } })
    emit(child, { type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'blocked' })
    close(0, null)
  })
  const scenario = { ...base, id: 'unit-inferred', prompt: 'x', checks: [{ id: 'audit', kind: 'approvals', minAsked: 1 }] }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless' })
  assert.equal(run.approvals.source, 'inferred')
  assert.equal(run.approvals.asked, 1)
  assert.equal(run.checks[0].ok, true)
})

test('reports are timestamped JSON + Markdown and never overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-real-reports-'))
  try {
    const report = {
      generatedAt: '2026-11-21T00:00:00.000Z', layer: 'A-real', scenarios: [], metrics: summarize([]),
      env: { node: process.version, platform: 'test', profile: 'headless', commit: null, dirty: false, keyVar: 'test' },
    }
    const paths = writeReports(report, dir)
    assert.match(paths.json, /2026-11-21T00-00-00-000Z\.json$/)
    assert.equal(JSON.parse(readFileSync(paths.json, 'utf8')).layer, 'A-real')
    assert.match(readFileSync(paths.md, 'utf8'), /真模型评测报告/)
    assert.throws(() => writeReports(report, dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mock token budget terminates the run before it burns more tokens', async () => {
  const spawn = fakeSpawn(({ child }) => {
    emit(child, { type: 'status', phase: 'step_start' })
    emit(child, { type: 'status', phase: 'step_end', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } })
    emit(child, { type: 'status', phase: 'step_start' })
  })
  const scenario = { ...base, id: 'tokens', prompt: 'x', checks: [{ id: 'ok', kind: 'file', path: 'nope', exists: false }] }
  const run = await runScenario(scenario, { spawn, dshBin: base.dshBin, profile: 'headless', maxTokens: 50, killGraceMs: 20 })
  assert.equal(run.tokenLimitHit, true)
  assert.equal(run.success, false)
  assert.ok(run.tokensUsed >= 60)
})
