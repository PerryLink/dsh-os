#!/usr/bin/env node
/** dsh-os real-agent eval runner (A layer): spawn DSH headless per scenario JSON, parse NDJSON,
 *  grade external state only. No model call here; without DSH_BIN + a model key the CLI exits 2. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { summarize } from './metrics.mjs'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const SCENARIOS = join(HERE, 'real', 'scenarios')
const REPORTS = join(HERE, 'real', 'reports')
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const KEY_VARS = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DSH_REAL_API_KEY']
const NEED_MESSAGE = '需要 DSH checkout + profile + 模型 key'
const CHECK_KINDS = new Set(['file', 'json', 'command', 'toolUsed', 'approvals', 'evidence', 'finalText'])
const toArray = value => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const truncate = (text, size = 800) => (typeof text === 'string' && text.length > size ? `${text.slice(0, size)}…` : text)
const getPath = (value, path) => String(path).split('.').reduce((c, key) => c == null ? undefined : Array.isArray(c) ? c[Number(key)] : c[key], value)
function safeJoin(root, relativePath) {
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`setup path escapes the sandbox: ${relativePath}`)
  return target
}
function walkFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name)
      return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : []
    })
  } catch { return [] }
}
function safeRemove(dir) {
  const target = resolve(dir), base = resolve(tmpdir())
  if (!target.startsWith(base + sep) || !basename(target).startsWith('dsh-real-')) return
  try { rmSync(target, { recursive: true, force: true }) } catch {}
}
function setupSandbox(scenario, sandbox) {
  for (const item of scenario.setup ?? []) {
    const target = safeJoin(sandbox, item.path)
    if (item.dir === true) mkdirSync(target, { recursive: true })
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, item.content ?? '') }
  }
}
export function loadScenarios(dir = SCENARIOS) {
  return readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => {
    const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    if (typeof scenario.id !== 'string' || !scenario.id || typeof scenario.prompt !== 'string' || !scenario.prompt.trim()) throw new Error(`${file}: missing id/prompt`)
    if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) throw new Error(`${file}: missing checks`)
    for (const check of scenario.checks) if (!CHECK_KINDS.has(check.kind)) throw new Error(`${file}: unknown check kind ${check.kind}`)
    return scenario
  })
}
export function parseNdjson(stdout) {
  const events = [], badLines = []
  for (const line of String(stdout).split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    try {
      const event = JSON.parse(text)
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event)
      else badLines.push(truncate(text, 120))
    } catch { badLines.push(truncate(text, 120)) }
  }
  return { events, parseErrors: badLines.length, badLines: badLines.slice(0, 5) }
}
export function summarizeStream(events) {
  const steps = [], byCall = new Map(), texts = []
  let session = null, final = null, stepStarts = 0, stepEnds = 0, tokens = 0, usageComplete = true, errorEvents = 0
  for (const event of events) {
    switch (event.type) {
      case 'session': session = event; break
      case 'status':
        if (event.phase === 'step_start') stepStarts += 1
        if (event.phase === 'step_end') {
          stepEnds += 1
          const usage = event.usage
          if (usage && [usage.totalTokens, usage.inputTokens, usage.outputTokens].some(n => typeof n === 'number')) {
            tokens += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
          } else usageComplete = false
        }
        break
      case 'tool_call': {
        const step = { n: steps.length + 1, tool: event.tool, args: event.input ?? {}, callId: event.callId, ok: true, code: null, invalid: null }
        steps.push(step)
        if (event.callId !== undefined) byCall.set(event.callId, step)
        break
      }
      case 'tool_result': {
        const step = byCall.get(event.callId)
        if (step) {
          step.ok = event.status !== 'error'
          step.code = step.ok ? null : (event.error?.code ?? event.error?.name ?? 'TOOL_ERROR')
        }
        break
      }
      case 'text': if (typeof event.text === 'string') texts.push(event.text); break
      case 'error': errorEvents += 1; break
      case 'final': final = event; break
      default: break
    }
  }
  return { session, final, texts, steps, stepStarts, stepEnds, tokens, usageComplete, errorEvents }
}
function markInvalid(steps) {
  let failedKey = null
  for (const step of steps) {
    const key = `${step.tool}:${JSON.stringify(step.args)}`
    if (step.ok) { failedKey = null; continue }
    step.invalid = /INVALID|SCHEMA|ARGUMENT|UNKNOWN_TOOL|TOOL_NOT_REGISTERED/i.test(step.code ?? '') ? 'schema' : failedKey === key ? 'retry' : null
    failedKey = key
  }
}
/** Count approval/asked|decided audit events in an isolated DSH_HOME session log. */
export function readApprovals(dshHome) {
  const files = existsSync(dshHome) ? walkFiles(dshHome) : []
  let asked = 0, decided = 0, rejected = 0, parsed = 0
  const outcomes = {}
  for (const file of files) {
    let text
    try {
      const buffer = readFileSync(file)
      text = file.endsWith('.zstd') || file.endsWith('.zst') ? zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
    } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      parsed += 1
      const data = event.data ?? event.event?.data ?? {}
      const type = event.type ?? event.event?.type ?? event.kind
      if (type === 'approval/asked') asked += 1
      if (type === 'approval/decided') {
        decided += 1
        const outcome = event.outcome ?? event.event?.outcome ?? data.outcome ?? 'unknown'
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
        if (outcome === 'rejected' || outcome === 'unavailable' || outcome === 'cancelled') rejected += 1
      }
    }
  }
  return { asked, decided, rejected, outcomes, parsed, files: files.length, source: parsed > 0 ? 'log' : 'none' }
}
function inferApprovals(steps) {
  const hits = steps.filter(step => !step.ok && /APPROVAL|SANDBOX_ESCALATION/i.test(step.code ?? ''))
  if (hits.length === 0) return { asked: 0, decided: 0, rejected: 0, outcomes: {}, parsed: 0, files: 0, source: 'none' }
  return { asked: hits.length, decided: hits.length, rejected: hits.length, outcomes: { rejected: hits.length }, parsed: 0, files: 0, source: 'inferred' }
}
function refTarget(ref, cwd) {
  const inside = target => target === cwd || target.startsWith(cwd + sep)
  if (ref.startsWith('dsh://locator/')) {
    let id
    try { id = decodeURIComponent(ref.slice('dsh://locator/'.length)) } catch { return null }
    id = id.replace(/^\/+/, '')
    if (id.split('/').includes('..')) return null
    const target = resolve(cwd, id)
    return inside(target) ? target : null
  }
  if (ref.startsWith('ref://file?')) {
    try {
      const path = new URL(ref).searchParams.get('path')
      const target = path && (isAbsolute(path) ? path : resolve(cwd, path))
      return target && inside(target) ? target : null
    } catch { return null }
  }
  if (ref.startsWith('dsh://')) return null
  const target = isAbsolute(ref) ? ref : resolve(cwd, ref)
  return inside(target) ? target : null
}
function checkFile(check, ctx) {
  const target = resolve(ctx.cwd, check.path)
  if (check.missing === true) return { id: check.id, ok: !existsSync(target), detail: `${check.path} ${existsSync(target) ? '存在（不应存在）' : '不存在（符合预期）'}` }
  if (!existsSync(target)) return { id: check.id, ok: false, detail: `${check.path} 不存在` }
  const text = readFileSync(target, 'utf8'), problems = []
  if (check.equals !== undefined && text !== check.equals) problems.push('内容不等于期望')
  for (const needle of toArray(check.contains)) if (!text.includes(needle)) problems.push(`缺少 "${needle}"`)
  for (const needle of toArray(check.notContains)) if (text.includes(needle)) problems.push(`不应包含 "${needle}"`)
  return { id: check.id, ok: problems.length === 0, detail: problems.join('；') || `${check.path} 符合期望` }
}
function checkJson(check, ctx) {
  const target = resolve(ctx.cwd, check.path)
  if (!existsSync(target)) return { id: check.id, ok: false, detail: `${check.path} 不存在` }
  let doc
  try { doc = JSON.parse(readFileSync(target, 'utf8')) } catch (error) { return { id: check.id, ok: false, detail: `坏 JSON：${error.message}` } }
  const problems = []
  const compare = (field, expected) => {
    const actual = getPath(doc, field)
    if (!same(actual, expected)) problems.push(`${field}=${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`)
  }
  if (check.expect && typeof check.expect === 'object' && !Array.isArray(check.expect)) {
    for (const [field, expected] of Object.entries(check.expect)) compare(field, expected)
  } else {
    const field = check.field ?? ''
    const actual = field ? getPath(doc, field) : doc
    if (check.equals !== undefined && !same(actual, check.equals)) problems.push(`${field || '(root)'} ≠ ${JSON.stringify(check.equals)}`)
    if (check.notEquals !== undefined && same(actual, check.notEquals)) problems.push(`${field || '(root)'} 不应等于 ${JSON.stringify(check.notEquals)}`)
  }
  return { id: check.id, ok: problems.length === 0, detail: problems.join('；') || `${check.path} 字段符合期望` }
}
function checkCommand(check, ctx) {
  const argv = toArray(check.args)
  if (argv.length === 0) return { id: check.id, ok: false, detail: 'args 为空' }
  const result = spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), {
    cwd: ctx.cwd, encoding: 'utf8', timeout: check.timeoutMs ?? 60_000,
  })
  const expect = check.expect ?? {}, problems = []
  if (expect.exitCode !== undefined && result.status !== expect.exitCode) problems.push(`exit ${result.status} ≠ ${expect.exitCode}`)
  for (const needle of toArray(expect.stdoutContains)) if (!(result.stdout ?? '').includes(needle)) problems.push(`stdout 缺少 "${needle}"`)
  if (expect.stdoutTrimEquals !== undefined && (result.stdout ?? '').trim() !== expect.stdoutTrimEquals) problems.push(`stdout=${JSON.stringify(truncate((result.stdout ?? '').trim(), 80))}`)
  return { id: check.id, ok: problems.length === 0, detail: problems.join('；') || `exit ${result.status}，stdout 符合期望` }
}
function checkEvidence(check, ctx) {
  const target = resolve(ctx.cwd, check.path)
  if (!existsSync(target)) return { id: check.id, ok: false, detail: `${check.path} 不存在` }
  let doc
  try { doc = JSON.parse(readFileSync(target, 'utf8')) } catch (error) { return { id: check.id, ok: false, detail: `坏 JSON：${error.message}` } }
  const claims = getPath(doc, check.claims ?? 'claims'), refs = [], problems = []
  if (!Array.isArray(claims)) problems.push('claims 不是数组')
  else if (claims.length < (check.minClaims ?? 1)) problems.push(`claims=${claims.length} < ${check.minClaims ?? 1}`)
  for (const [index, claim] of (Array.isArray(claims) ? claims : []).entries()) {
    const ref = claim?.[check.refField ?? 'ref']
    if (typeof ref !== 'string' || !ref.trim()) { problems.push(`claims[${index}].ref 缺失`); continue }
    refs.push(ref)
    const file = refTarget(ref, ctx.cwd)
    if (!file) problems.push(`claims[${index}] ref 不可解析：${ref}`)
    else if (!existsSync(file)) problems.push(`claims[${index}] 目标不存在：${ref}`)
  }
  for (const needle of toArray(check.mustCite)) if (!refs.some(ref => ref.includes(needle))) problems.push(`未引用 ${needle}`)
  for (const pattern of toArray(check.forbidRef)) if (refs.some(ref => new RegExp(pattern).test(ref))) problems.push(`引用了禁止 ref /${pattern}/`)
  return { id: check.id, ok: problems.length === 0, detail: problems.join('；') || `${refs.length} 条可解析证据` }
}
export function evaluateChecks(scenario, ctx) {
  return (scenario.checks ?? []).map(check => {
    try {
      switch (check.kind) {
        case 'file': return checkFile(check, ctx)
        case 'json': return checkJson(check, ctx)
        case 'command': return checkCommand(check, ctx)
        case 'toolUsed': {
          const count = ctx.steps.filter(step => step.tool === check.name).length
          return { id: check.id, ok: count >= (check.min ?? 1), detail: `${check.name} 调用 ${count} 次（至少 ${check.min ?? 1}）` }
        }
        case 'approvals': {
          const problems = []
          if (check.minAsked !== undefined && ctx.approvals.asked < check.minAsked) problems.push(`asked=${ctx.approvals.asked} < ${check.minAsked}`)
          if (check.minDecided !== undefined && ctx.approvals.decided < check.minDecided) problems.push(`decided=${ctx.approvals.decided} < ${check.minDecided}`)
          return { id: check.id, ok: problems.length === 0, detail: problems.join('；') || `approval asked=${ctx.approvals.asked}（${ctx.approvals.source}）` }
        }
        case 'evidence': return checkEvidence(check, ctx)
        case 'finalText': {
          const problems = toArray(check.contains).filter(needle => !ctx.finalText.includes(needle))
          return { id: check.id, ok: problems.length === 0, detail: problems.length ? `final 缺少 "${problems.join('", "')}"` : 'final 文本符合期望' }
        }
        default: return { id: check.id, ok: false, detail: `unknown kind ${check.kind}` }
      }
    } catch (error) { return { id: check.id ?? check.kind, ok: false, detail: error.message } }
  })
}
function hasModelKey(env = process.env) {
  return KEY_VARS.find(name => typeof env[name] === 'string' && env[name].trim() !== '') ?? null
}
/** Preflight: a checkout bin, a profile, and (unless explicitly waived) a model key. */
export function preflight({ dshBin, profile, keyPresent } = {}) {
  const bin = dshBin === undefined ? process.env.DSH_BIN : dshBin
  if (!bin) return { ok: false, exitCode: 2, message: `${NEED_MESSAGE}：未设置 DSH_BIN（例如 <checkout>/apps/cli/lib/bin.js）。` }
  const resolved = isAbsolute(bin) ? bin : resolve(process.cwd(), bin)
  if (!existsSync(resolved)) return { ok: false, exitCode: 2, message: `${NEED_MESSAGE}：DSH_BIN 不存在：${resolved}` }
  const key = keyPresent ?? (hasModelKey() !== null || process.env.DSH_REAL_ALLOW_NO_KEY === '1')
  if (!key) return { ok: false, exitCode: 2, message: `未运行：${NEED_MESSAGE}。未检测到模型 key（${KEY_VARS.join('/')}）；设置 key 或 DSH_REAL_ALLOW_NO_KEY=1（仅用于接线测试）。` }
  return { ok: true, dshBin: resolved, profile: profile ?? process.env.DSH_PROFILE ?? 'headless', keyVar: keyPresent === true ? 'test' : hasModelKey() }
}
function spawnWithLimits({ dshBin, profile, scenario, cwd, env, timeoutMs, maxSteps, killGraceMs, spawnImpl }) {
  const args = [dshBin, '--profile', profile, '--json', ...(scenario.args ?? []), scenario.prompt]
  return new Promise(done => {
    let child, stdout = '', stderr = '', stepStarts = 0, finished = false, terminating = false
    let timedOut = false, stepLimitHit = false, outputLimitHit = false
    const started = Date.now(), timers = []
    const finish = (exitCode, signal, spawnError = null) => {
      if (finished) return
      finished = true
      for (const timer of timers) clearTimeout(timer)
      done({ args, cwd, env, stdout, stderr, exitCode, signal, spawnError, timedOut, stepLimitHit, outputLimitHit, durationMs: Date.now() - started })
    }
    const send = signal => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { try { child.kill(signal) } catch {} }
    }
    const terminate = reason => {
      if (finished) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'steps') stepLimitHit = true
      if (reason === 'output') outputLimitHit = true
      if (terminating) return
      terminating = true
      send('SIGINT')
      const kill = setTimeout(() => {
        if (finished) return
        send('SIGKILL')
        timers.push(setTimeout(() => finish(null, 'SIGKILL'), 1000))
      }, killGraceMs ?? 5_000)
      timers.push(kill)
    }
    try {
      child = spawnImpl(process.execPath, args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) { finish(null, null, error); return }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
      stepStarts += (String(chunk).match(/"phase"\s*:\s*"step_start"/g) ?? []).length
      if (maxSteps && stepStarts > maxSteps) terminate('steps')
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) terminate('output')
    })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish(null, null, error))
    child.on('close', (exitCode, signal) => finish(exitCode, signal))
    timers.push(setTimeout(() => terminate('timeout'), timeoutMs ?? DEFAULT_TIMEOUT_MS))
  })
}
export async function runScenario(scenario, options = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), `dsh-real-${scenario.id.replace(/[^a-z0-9-]/gi, '-')}-`))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-real-home-'))
  const profile = options.profile ?? process.env.DSH_PROFILE ?? 'headless'
  const dshBin = options.dshBin ?? process.env.DSH_BIN
  // A prepared profile can be shared read-only via DSH_REAL_HOME; sessions stay
  // in the per-run temp DSH_HOME so approval logs cannot leak between scenarios.
  const sourceHome = process.env.DSH_REAL_HOME ? resolve(process.env.DSH_REAL_HOME) : null
  if (sourceHome) {
    const sourceProfile = join(sourceHome, 'profiles', profile)
    if (!existsSync(sourceProfile)) throw Object.assign(new Error(`profile "${profile}" not found under DSH_REAL_HOME/profiles`), { code: 'E_NO_PROFILE' })
    mkdirSync(join(dshHome, 'profiles'), { recursive: true })
    symlinkSync(sourceProfile, join(dshHome, 'profiles', profile), 'dir')
  }
  let run
  try {
    setupSandbox(scenario, sandbox)
    if (!dshBin) throw Object.assign(new Error('DSH_BIN is required'), { code: 'E_NO_DSH_BIN' })
    const env = { ...process.env, DSH_HOME: dshHome, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1', ...(scenario.env ?? {}) }
    for (const key of ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL']) delete env[key]
    const exec = await spawnWithLimits({
      dshBin: isAbsolute(dshBin) ? dshBin : resolve(process.cwd(), dshBin), profile, scenario, cwd: sandbox, env,
      timeoutMs: options.timeoutMs ?? scenario.timeoutMs, maxSteps: options.maxSteps ?? scenario.maxSteps,
      killGraceMs: options.killGraceMs, spawnImpl: options.spawn ?? nodeSpawn,
    })
    const parsed = parseNdjson(exec.stdout)
    const stream = summarizeStream(parsed.events)
    markInvalid(stream.steps)
    let approvals = readApprovals(dshHome)
    if (approvals.asked === 0) {
      const inferred = inferApprovals(stream.steps)
      if (inferred.asked > 0) approvals = inferred
    }
    const checks = evaluateChecks(scenario, {
      cwd: sandbox, steps: stream.steps, approvals,
      finalText: stream.final?.text ?? stream.texts.join('\n'), stderr: exec.stderr,
    })
    const failures = stream.steps.filter(step => !step.ok)
    const heuristicTokens = stream.steps.reduce((sum, step) => sum + 40 + Math.ceil(JSON.stringify(step.args ?? {}).length / 4), 0)
    const tokensEstimate = stream.tokens > 0 && stream.usageComplete ? stream.tokens : heuristicTokens
    const outcomeKeys = Object.keys(approvals.outcomes)
    const interventions = Array.from({ length: approvals.asked }, (_, index) => ({
      kind: 'approval.asked', outcome: outcomeKeys[index % Math.max(outcomeKeys.length, 1)] ?? 'unknown',
    }))
    const expectedFirst = scenario.expectedFirstTool === undefined ? [] : toArray(scenario.expectedFirstTool)
    const firstTool = stream.steps[0]?.tool ?? null
    const success = !exec.timedOut && !exec.stepLimitHit && !exec.spawnError
      && checks.length > 0 && checks.every(check => check.ok)
    run = {
      id: scenario.id, title: scenario.title, goal: scenario.goal, initial: scenario.initial ?? [], prompt: scenario.prompt,
      success, strictSuccess: success, deferredChecks: 0,
      toolCalls: stream.steps.length, invalidCalls: stream.steps.filter(step => step.invalid).length,
      tokensEstimate, interventions, firstTool, expectedFirstTool: expectedFirst,
      firstStepCorrect: expectedFirst.length > 0 ? expectedFirst.includes(firstTool) : null,
      steps: stream.steps.map(step => ({
        n: step.n, tool: step.tool, args: truncate(JSON.stringify(step.args), 800), ok: step.ok,
        code: step.code, invalid: step.invalid, callId: step.callId,
      })),
      checks, failures: failures.map(step => ({ n: step.n, tool: step.tool, code: step.code, invalid: step.invalid })),
      approvals, finalReason: stream.final?.reason ?? null, finalText: truncate(stream.final?.text ?? '', 2000),
      sessionId: stream.session?.sessionId ?? null, exitCode: exec.exitCode, timedOut: exec.timedOut,
      stepLimitHit: exec.stepLimitHit, outputLimitHit: exec.outputLimitHit,
      protocolOk: exec.exitCode === 0 && stream.final?.reason?.kind === 'completed',
      parseErrors: parsed.parseErrors, badLines: parsed.badLines, usageComplete: stream.usageComplete,
      tokensSource: tokensEstimate === stream.tokens && stream.tokens > 0 ? 'usage' : 'heuristic',
      durationMs: exec.durationMs, stdoutBytes: Buffer.byteLength(exec.stdout),
      stderr: truncate(exec.stderr, 2000), profile, dshBin,
      error: exec.spawnError ? { code: exec.spawnError.code ?? 'E_SPAWN', message: exec.spawnError.message } : null,
    }
  } catch (error) {
    run = {
      id: scenario.id, title: scenario.title, goal: scenario.goal, initial: scenario.initial ?? [], prompt: scenario.prompt,
      success: false, strictSuccess: false, deferredChecks: 0, toolCalls: 0, invalidCalls: 0, tokensEstimate: 0,
      interventions: [], firstTool: null, expectedFirstTool: toArray(scenario.expectedFirstTool), firstStepCorrect: false,
      steps: [], checks: [{ id: 'runner-error', ok: false, detail: error.message }], failures: [], approvals: { asked: 0, decided: 0, rejected: 0, outcomes: {}, source: 'none' },
      finalReason: null, finalText: '', sessionId: null, exitCode: null, timedOut: false, stepLimitHit: false,
      outputLimitHit: false, protocolOk: false, parseErrors: 0, badLines: [], usageComplete: false, tokensSource: 'heuristic',
      durationMs: 0, stdoutBytes: 0, stderr: '', profile, dshBin: dshBin ?? null,
      error: { code: error.code ?? 'E_RUNNER', message: error.message },
    }
  } finally {
    if (!options.keepTemps) { safeRemove(sandbox); safeRemove(dshHome) }
  }
  return run
}
function gitInfo() {
  const run = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { commit: run(['rev-parse', '--short', 'HEAD']).stdout?.trim() || null, dirty: (run(['status', '--porcelain']).stdout ?? '').trim() !== '' }
}
export async function runAll(options = {}) {
  let scenarios = loadScenarios(options.scenarioDir ?? SCENARIOS)
  if (options.ids?.length) {
    scenarios = scenarios.filter(scenario => options.ids.includes(scenario.id))
    if (scenarios.length === 0) throw new Error(`no scenario matched: ${options.ids.join(', ')}`)
  }
  const runs = []
  for (const scenario of scenarios) runs.push(await runScenario(scenario, options))
  return {
    schema: 'dsh-os.eval-real/v1',
    layer: 'A-real (DSH headless; real model calls; external-state grading)',
    generatedAt: new Date().toISOString(),
    env: {
      node: process.version, platform: process.platform,
      dshBin: options.dshBin ?? process.env.DSH_BIN ?? null,
      profile: options.profile ?? process.env.DSH_PROFILE ?? 'headless',
      keyVar: hasModelKey(), ...gitInfo(),
    },
    scenarios: runs, metrics: summarize(runs),
  }
}
const pct = value => `${(value * 100).toFixed(1)}%`
export function renderMarkdown(report) {
  const m = report.metrics
  const lines = [
    '# dsh-os 真模型评测报告（A 层）', '',
    `- 生成：${report.generatedAt}`, `- 层：${report.layer}`,
    `- 命令模板：\`node <DSH_BIN> --profile <DSH_PROFILE> --json "<prompt>"\``,
    `- 环境：Node ${report.env.node} · ${report.env.platform} · profile \`${report.env.profile}\` · commit ${report.env.commit ?? 'unknown'}${report.env.dirty ? '（工作树有未提交改动）' : ''}`,
    `- 模型 key：${report.env.keyVar ? `已提供（${report.env.keyVar}，值不记录）` : '未检测到'}`, '',
    '## 总览', '', '| 指标 | 值 |', '|---|---|',
    `| 成功率 | ${m.successes}/${m.scenarios}（${pct(m.successRate)}） |`,
    `| 严格成功率（0 延后判据） | ${m.strictSuccesses}/${m.scenarios}（${pct(m.strictSuccessRate)}） |`,
    `| 首步选择准确率 | ${pct(m.firstStepAccuracy)} |`,
    `| 恢复率 | ${pct(m.recoveryRate)}（${m.recoveredScenarios}/${m.scenariosWithFailures} 个有失败调用的场景最终通过） |`,
    `| 无效调用率（推断） | ${pct(m.invalidCallRate)}（${m.invalidCalls}/${m.toolCalls}） |`,
    `| 平均步数 | ${m.avgSteps.toFixed(1)} |`,
    `| tokens | 总 ${m.tokensEstimate} · 均 ${m.avgTokens.toFixed(0)} |`,
    `| 审批介入（approval/asked） | ${m.interventions} 次（自主成功 ${m.autonomousSuccesses}，有介入成功 ${m.assistedSuccesses}） |`,
    '', '## 场景', '',
    '| 场景 | 成功 | 步数 | 无效 | 审批 | tokens | 首步 | 超时 |', '|---|---:|---:|---:|---:|---:|---|---:|',
    ...report.scenarios.map(run => `| ${run.id} ${run.title} | ${run.success ? '✅' : '❌'} | ${run.toolCalls} | ${run.invalidCalls} | ${run.approvals.asked} | ${run.tokensEstimate} | \`${run.firstTool ?? '—'}\` | ${run.timedOut ? '是' : '—'} |`),
    '', '## 判据与失败点', '',
  ]
  for (const run of report.scenarios) {
    const failed = run.checks.filter(check => !check.ok)
    const verdict = failed.length ? failed.map(check => `\`${check.id}\`: ${check.detail}`).join('；') : '全部判据通过'
    lines.push(`- **${run.id}** ${run.success ? '✅' : '❌'} · exit ${run.exitCode ?? '—'} · ${run.durationMs}ms · final \`${run.finalReason?.kind ?? '—'}\` · 审批 ${run.approvals.asked}（${run.approvals.source}） · ${verdict}`)
    if (run.approvals.asked > 0) lines.push(`  - approval outcomes：${JSON.stringify(run.approvals.outcomes)}`)
    if (run.parseErrors > 0) lines.push(`  - 坏 NDJSON 行 ${run.parseErrors} 条（已跳过，未中断）`)
    if (run.error) lines.push(`  - 运行错误：\`${run.error.code}\` ${run.error.message}`)
  }
  lines.push('', '> 真实模型运行：判分只读外部状态（文件、JSON 字段、命令退出码、工具调用、审批审计），模型自述不计分。')
  lines.push('> 指标与 `evals/run.mjs` 的 P 层脚本基线同名但不可横比：P 层是固定策略，本层是模型行为；温度不可控，重跑可能不同。', '')
  return lines.join('\n')
}
export function writeReports(report, dir = REPORTS) {
  mkdirSync(dir, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const json = join(dir, `${stamp}.json`), md = join(dir, `${stamp}.md`)
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  writeFileSync(md, `${renderMarkdown(report)}\n`, { flag: 'wx' })
  return { json, md }
}
function usage() {
  return ['usage: node evals/real-run.mjs [--scenario=<id>]... [--dsh-bin=<path>] [--profile=<name>] [--timeout-ms=<n>] [--keep] [--list] [--allow-no-key]',
    'env:   DSH_BIN=<checkout>/apps/cli/lib/bin.js  DSH_PROFILE=headless  DEEPSEEK_API_KEY=...',
    'note:  without DSH_BIN or a model key the runner prints "需要 DSH checkout + profile + 模型 key" and exits 2.'].join('\n')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); process.exit(0) }
  if (argv.includes('--list')) {
    for (const scenario of loadScenarios()) console.log(`${scenario.id}\t${scenario.title}\t${scenario.checks.length} checks`)
    process.exit(0)
  }
  const value = prefix => argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  const check = preflight({
    dshBin: value('--dsh-bin='), profile: value('--profile='),
    keyPresent: argv.includes('--allow-no-key') ? true : undefined,
  })
  if (!check.ok) { console.error(check.message); process.exit(check.exitCode) }
  try {
    const report = await runAll({
      dshBin: check.dshBin, profile: check.profile, keepTemps: argv.includes('--keep'),
      timeoutMs: Number(value('--timeout-ms=')) || undefined,
      ids: argv.filter(arg => arg.startsWith('--scenario=')).map(arg => arg.slice('--scenario='.length)),
    })
    const reportDir = process.env.DSH_REAL_REPORT_DIR ? resolve(process.env.DSH_REAL_REPORT_DIR) : REPORTS
    const paths = writeReports(report, reportDir)
    console.log(renderMarkdown(report))
    console.log(`JSON: ${paths.json}\nMarkdown: ${paths.md}`)
  } catch (error) {
    console.error(`real eval failed: ${error.message}`)
    process.exit(1)
  }
}
