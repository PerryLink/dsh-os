#!/usr/bin/env node
/** dsh-os AI-usability eval runner (P layer: scripted policy, no model/network).
 *  Mounts the real plugins through a fake Cordis ctx; success is external-state only. */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { summarize, compareReports, formatMetric } from './metrics.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const SCENARIOS = join(HERE, 'scenarios')
const REPORTS = join(HERE, 'reports')
/** Classic 17-package surface used by the 2026-11-21 workflow audit. */
const MODULES = ['allow', 'act', 'snip', 'check', 'ring', 'root', 'seek', 'trace',
  'trigger', 'stage', 'nest', 'backup', 'context', 'cost', 'notify', 'help', 'shell']

function makeCtx({ tools: extraTools = {}, services: extraServices = {} } = {}) {
  const tools = new Map(Object.entries(extraTools)), services = new Map(Object.entries(extraServices))
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)), get: name => tools.get(name), list: () => [...tools.values()] },
    provide(name, value) { services.set(name, value); return value },
    get: name => services.get(name), on() { return () => {} }, effect(fn) { const dispose = fn(); return () => dispose?.() },
    _tools: tools, _services: services,
  }
}

async function createSurface(configs, extra = {}) {
  const ctx = makeCtx(extra)
  const configOf = value => (typeof value === 'function' ? value(ctx) : value)
  for (const name of MODULES) {
    (await import(new URL(`../packages/${name}/index.js`, import.meta.url))).apply(ctx, configOf(configs[name] ?? {}))
  }
  // Extra modules stay opt-in so the classic-17 surface is unchanged for the
  // regression scenarios; a scenario may mount e.g. the experimental kernel.
  for (const mount of extra.mounts ?? []) {
    const name = typeof mount === 'string' ? mount : mount.name
    const config = typeof mount === 'string' ? {} : configOf(mount.config ?? {})
    ;(await import(new URL(`../packages/${name}/index.js`, import.meta.url))).apply(ctx, config)
  }
  return ctx
}

function gitInfo() {
  const run = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { commit: run(['rev-parse', '--short', 'HEAD']).stdout?.trim() || null, dirty: (run(['status', '--porcelain']).stdout ?? '').trim() !== '' }
}

/** Run one scenario: setup, scripted policy, external checks, cleanup. */
export async function runScenario(scenario) {
  const temps = [], state = {}, consoleLines = [], steps = [], interventions = []
  let changeSeq = 0, setupError = null, policyError = null, checks = []
  const env = {
    cwd: ROOT, subject: `sess:${scenario.id}`, state, consoleLines, steps, ctx: null,
    temp(prefix = 'dsh-eval-') { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir },
    path(rel) { return resolve(env.cwd, rel) },
    write(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) },
    read: file => readFileSync(file, 'utf8'),
    hash: file => createHash('sha256').update(readFileSync(file)).digest('hex'),
    node: (cwd, args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' }),
    testRunner(sub, file = 'math.test.mjs') {
      return { async run(task) {
        const r = env.node(join(env.cwd, sub), ['--test', '--test-reporter=tap', file])
        return {
          ok: r.status === 0, code: r.status === 0 ? null : 'exit_nonzero', taskId: task.id,
          result: { passed: r.status === 0, exitCode: r.status, detail: r.stdout?.slice(0, 2000) ?? '' },
          trajectory: { steps: 1, toolCalls: 1, errors: r.status === 0 ? 0 : 1 },
          cost: { usd: 0, tokens: 0 }, approvals: { asked: 0, rejected: 0 }, exitCode: r.status,
        }
      } }
    },
    registerFsAction() {
      const act = env.ctx.get('act')
      if (act.get('fs.write')) return
      act.register({ id: 'fs.write', title: 'Write a workspace file', risk: 'write',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
        execute(args) { env.write(resolve(env.cwd, args.path), args.content); return { path: args.path, bytes: Buffer.byteLength(args.content) } } })
    },
    async mount(configs = {}, extra = {}) {
      env.ctx = await createSurface({ act: { workdir: env.cwd }, ...configs }, extra)
      return env.ctx
    },
  }
  const exec = () => ({ subject: env.subject, agent: { id: `agent:${env.subject}`, session: { id: env.subject, header: { cwd: env.cwd, agentPreset: 'web' } } } })

  async function call(tool, args = {}) {
    if (steps.length >= scenario.maxSteps) throw Object.assign(new Error(`step budget exhausted (${scenario.maxSteps})`), { code: 'EVAL_STEP_LIMIT' })
    const definition = env.ctx?._tools.get(tool), started = Date.now(), missing = definition === undefined
    let result, thrown = null
    if (!missing) try { result = await definition.execute(args, exec()) } catch (error) { thrown = error }
    const raw = missing ? { ok: false, error: { code: 'TOOL_NOT_REGISTERED' } }
      : thrown ? { ok: false, error: { code: thrown.code ?? 'E_TOOL', message: thrown.message } } : result
    const ok = !missing && thrown === null && !(result && result.ok === false)
    const code = missing ? 'TOOL_NOT_REGISTERED' : thrown ? thrown.code ?? 'E_TOOL'
      : result?.ok === false ? (result.error?.code ?? result.code ?? 'TOOL_FAILED') : null
    let invalid = missing ? 'missing'
      : thrown && /invalid|schema|argument|required|must|path/i.test(`${thrown.code ?? ''} ${thrown.message ?? ''}`) ? 'schema' : null
    if (invalid === null && Array.isArray(scenario.allowedTools) && !scenario.allowedTools.includes(tool)) invalid = 'off-route'
    const key = `${tool}:${JSON.stringify(args)}`, prior = [...steps].reverse().find(step => step.key === key)
    if (invalid === null && prior && !prior.ok && prior.changeSeq === changeSeq) invalid = 'retry'
    const size = (JSON.stringify(args)?.length ?? 0) + (JSON.stringify(raw)?.length ?? 0)
    steps.push({ n: steps.length + 1, tool, args, ok, code, invalid, tokens: 40 + Math.ceil(size / 4), ms: Date.now() - started, changeSeq, key })
    return raw
  }

  async function intervene(kind) {
    if (!scenario.allowedInterventions?.includes(kind)) throw new Error(`intervention not allowed: ${kind}`)
    if (kind !== 'human.approve' && interventions.some(item => item.kind === kind)) throw new Error(`intervention already used: ${kind}`)
    const allow = () => env.ctx.get('allow')
    const implementations = {
      'human.approve': () => {
        const pending = allow().requests({ subject: env.subject }).filter(request => request.status === 'pending')
        const request = pending.find(item => item.id === env.state.requestId) ?? pending.at(-1)
        if (!request) throw new Error('no pending request')
        env.state.requestId = request.id
        allow().approve({ id: request.id, by: 'user' })
        // The kernel's os_observe does not refresh from Allow, so the harness
        // (playing the host approval seam) hands back the real Grant object.
        env.state.approvedGrant = allow().list({ subject: env.subject, capability: request.capability, status: 'active' }).at(-1)
      },
      'human.grant': () => allow().issue({ subject: env.subject, capability: env.state.pendingCapability, scope: '*', approver: 'user', ttlMs: 300000 }),
      'host.registerAction': () => env.registerFsAction(),
      'host.configureChannel': () => env.ctx.get('ring').configureChannels({ console: { write: line => consoleLines.push(line) } }),
    }
    changeSeq += 1
    const record = { kind, afterStep: steps.length, ok: true }
    try { await implementations[kind]() } catch (error) { record.ok = false; record.detail = error.message }
    interventions.push(record)
    return record
  }

  const ai = {
    env, state, subject: env.subject, get ctx() { return env.ctx }, call, intervene,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    async world(label, fn) { changeSeq += 1; return fn() },
    writeArgs(path, text) { const action = env.ctx.get('act')?.get('fs.write'); const field = action?.parameters?.required?.includes('text') ? 'text' : 'content'; return { id: 'fs.write', args: { path, [field]: text } } },
    async approval(capability, reason = '') { env.state.pendingCapability = capability; if (env.ctx._tools.has('allow_request')) { const request = await call('allow_request', { subject: env.subject, capability, scope: '*', reason }); env.state.requestId = request?.requestId; await call('allow_wait', { requestId: env.state.requestId, timeoutMs: 0, subject: env.subject }); await intervene('human.approve'); await call('allow_wait', { requestId: env.state.requestId, timeoutMs: 0, subject: env.subject }) } else { await call('allow_check', { subject: env.subject, capability, scope: '*' }); await intervene('human.grant') } },
    async write(path, text, reason = '') { if (!env.ctx.get('act')?.get('fs.write')) await intervene('host.registerAction'); let result = await call('act_invoke', ai.writeArgs(path, text)); if (result?.code === 'grant_required') { await ai.approval(result.capability, reason); result = await call('act_invoke', ai.writeArgs(path, text)) } return result },
  }

  try { await scenario.setup(env) } catch (error) { setupError = error }
  if (!setupError) {
    try { await scenario.policy(ai) } catch (error) { policyError = { code: error.code ?? 'E_EVAL', message: error.message } }
    try { checks = await scenario.check(env) } catch (error) { checks = [{ id: 'checker-error', ok: false, detail: error.message }] }
  } else {
    checks = [{ id: 'setup-error', ok: false, detail: setupError.message }]
  }
  checks = (Array.isArray(checks) ? checks : []).map(check => ({
    ...check, ok: check.ok === true, deferred: check.deferred === true,
  }))
  // A deferred check is a criterion the current API cannot satisfy. It stays in
  // the report as an explicit gap and never counts as a pass (ok must be false
  // or it is simply a normal check); it also does not gate scenario success.
  const gating = checks.filter(check => check.deferred !== true)
  const failures = steps.filter(step => !step.ok)
  const success = !setupError && !policyError && interventions.every(item => item.ok)
    && gating.length > 0 && gating.every(check => check.ok)
  const deferredChecks = checks.filter(check => check.deferred === true).length
  const run = {
    id: scenario.id, title: scenario.title, goal: scenario.goal, maxSteps: scenario.maxSteps,
    initial: scenario.initial, allowedInterventions: scenario.allowedInterventions, successCriteria: scenario.success,
    success, strictSuccess: success && deferredChecks === 0, deferredChecks, toolCount: env.ctx?._tools.size ?? 0,
    firstTool: steps[0]?.tool ?? null, expectedFirstTool: scenario.expectedFirstTool, firstStepCorrect: steps[0]?.tool === scenario.expectedFirstTool,
    steps, toolCalls: steps.length, invalidCalls: steps.filter(step => step.invalid).length,
    tokensEstimate: steps.reduce((sum, step) => sum + step.tokens, 0), interventions, checks,
    failures: failures.map(step => ({ n: step.n, tool: step.tool, code: step.code, invalid: step.invalid })),
    error: setupError ? { code: 'E_SETUP', message: setupError.message } : policyError,
    recovered: success && failures.length > 0,
  }
  try { await env.ctx?.get('triggers')?.dispose?.() } catch {}
  try { env.ctx?.get('snip')?.stopWatch?.() } catch {}
  for (const dir of temps) try { rmSync(dir, { recursive: true, force: true }) } catch {}
  return run
}

/** Load all scenarios in filename order and run them sequentially. */
export async function runAll() {
  const files = readdirSync(SCENARIOS).filter(file => file.endsWith('.mjs')).sort()
  const runs = []
  for (const file of files) runs.push(await runScenario((await import(pathToFileURL(join(SCENARIOS, file)).href)).default))
  return {
    schema: 'dsh-os.eval/v1', layer: 'P-scripted (fixed policy; no model, no network)',
    generatedAt: new Date().toISOString(), env: { node: process.version, ...gitInfo() },
    scenarios: runs, metrics: summarize(runs),
  }
}

const pct = value => `${(value * 100).toFixed(1)}%`

export function renderMarkdown(report) {
  const m = report.metrics
  const lines = [
    '# dsh-os AI 可用性评测报告', '', `- 生成：${report.generatedAt}`, `- 层：${report.layer}`,
    `- 环境：Node ${report.env.node} · commit ${report.env.commit ?? 'unknown'}${report.env.dirty ? '（工作树有未提交改动）' : ''}`,
    '', '## 总览', '', '| 指标 | 值 |', '|---|---|',
    `| 成功率 | ${m.successes}/${m.scenarios}（${pct(m.successRate)}） |`,
    `| 严格成功率（0 延后判据） | ${m.strictSuccesses}/${m.scenarios}（${pct(m.strictSuccessRate)}） |`,
    `| 延后判据 | ${m.deferredChecks} 条，覆盖 ${m.deferredScenarios} 个场景（不计为通过，详见下文） |`,
    `| 首步选择准确率 | ${pct(m.firstStepAccuracy)} |`,
    `| 恢复率 | ${pct(m.recoveryRate)}（${m.recoveredScenarios}/${m.scenariosWithFailures} 个有失败场景最终通过） |`,
    `| 无效调用率 | ${pct(m.invalidCallRate)}（${m.invalidCalls}/${m.toolCalls}） |`,
    `| 平均步数 | ${m.avgSteps.toFixed(1)} |`,
    `| tokens 估算 | 总 ${m.tokensEstimate} · 均 ${m.avgTokens.toFixed(0)} |`,
    `| 人类介入 | ${m.interventions} 次（自主成功 ${m.autonomousSuccesses}，辅助成功 ${m.assistedSuccesses}） |`,
    '', '## 场景', '', '| 场景 | 成功 | 步数 | 无效 | 介入 | 延后 | tokens | 首个失败判据 |', '|---|---:|---:|---:|---:|---:|---:|---|',
    ...report.scenarios.map(run => {
      const failed = run.checks.find(check => !check.ok && check.deferred !== true)
      return `| ${run.id} ${run.title} | ${run.success ? '✅' : '❌'} | ${run.toolCalls} | ${run.invalidCalls} | ${run.interventions.length} | ${run.deferredChecks ?? 0} | ${run.tokensEstimate} | ${failed ? failed.id : '—'} |`
    }),
    '', '## 判据与失败点', '',
  ]
  for (const run of report.scenarios) {
    const failed = run.checks.filter(check => !check.ok && check.deferred !== true)
    const deferred = run.checks.filter(check => check.deferred === true)
    const verdict = failed.length ? failed.map(check => `\`${check.id}\`: ${check.detail}`).join('；') : '全部有效判据通过'
    lines.push(`- **${run.id}** ${run.success ? '✅' : '❌'} · 首步 \`${run.firstTool ?? '—'}\` · 介入 ${run.interventions.length} · ${verdict}${deferred.length ? ` · ${deferred.length} 条延后` : ''}`)
    for (const check of deferred) lines.push(`  - ⏸ \`${check.id}\`（延后，不计通过）：${check.detail}`)
    if (run.error) lines.push(`  - 策略错误：\`${run.error.code}\` ${run.error.message}`)
  }
  lines.push('', '> P 层脚本策略，不是真实模型的 AUS；成功只读外部状态，模型自述不计分。')
  lines.push('> ⏸ 延后判据 = 当前 packages API 无法满足、但未伪造通过的判据；它们仍计入 `successCriteria` 并在每次报告中保留。', '')
  return lines.join('\n')
}

export function writeReports(report) {
  mkdirSync(REPORTS, { recursive: true })
  const json = join(REPORTS, 'latest.json'), md = join(REPORTS, 'latest.md')
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(md, `${renderMarkdown(report)}\n`)
  return { json, md }
}

function renderCompare({ rows, scenarios }) {
  return [
    '| 指标 | 基线 | 最新 | Δ |', '|---|---:|---:|---:|',
    ...rows.map(row => `| ${row.label} | ${formatMetric(row.rate, row.base)} | ${formatMetric(row.rate, row.head)} | ${row.delta >= 0 ? '+' : ''}${row.rate ? pct(row.delta) : row.delta.toFixed(1)} |`),
    '', '| 场景 | 基线 | 最新 |', '|---|---:|---:|',
    ...scenarios.map(row => `| ${row.id} | ${row.baseline === null ? '—' : row.baseline ? '✅' : '❌'} | ${row.latest ? '✅' : '❌'} |`),
  ].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'compare') {
    if (args.length < 2) { console.error('usage: node evals/run.mjs compare <base.json> <head.json>'); process.exit(2) }
    const base = JSON.parse(readFileSync(resolve(ROOT, args[0]), 'utf8'))
    const head = JSON.parse(readFileSync(resolve(ROOT, args[1]), 'utf8'))
    console.log(renderCompare(compareReports(base, head)))
  } else {
    const report = await runAll(), paths = writeReports(report)
    console.log(renderMarkdown(report))
    console.log(`\nJSON: ${relative(ROOT, paths.json)}\nMarkdown: ${relative(ROOT, paths.md)}`)
  }
}
