/**
 * dsh-check runner — spawn one real `dsh --profile <profile> --json` per task.
 *
 * The runner is deliberately thin: DSH emits NDJSON, the runner maps the four
 * diff dimensions (result, trajectory, cost, approvals) and returns failures as
 * values instead of throwing. It has no dependencies and never calls a model
 * itself. Timeout and cancellation are owned here because headless DSH has no
 * `--timeout`: SIGINT first, then SIGKILL after a grace period. The child
 * environment is allowlisted so host API keys are not inherited, and captured
 * stdout is capped at 2 MiB.
 * @module @perrylink/dsh-check/runner
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { resolve } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_KILL_GRACE_MS = 5_000
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const HARD_SETTLE_MS = 1_000
const MAX_STDERR_BYTES = 64 * 1024
/** Inherited env: `PATH`/`HOME` plus `DSH_*`/`NODE_*`; API keys are dropped. */
const ENV_KEEP = new Set(['PATH', 'HOME'])
const ENV_KEEP_PREFIXES = ['DSH_', 'NODE_']
const ENV_DROP = new Set(['NODE_OPTIONS'])
const APPROVAL_REJECTIONS = new Set(['SANDBOX_ESCALATION_REJECTED', 'APPROVAL_REJECTED'])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (object, key) => isObject(object) && Object.hasOwn(object, key)
const count = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
const invalid = (code, message) => Object.assign(new Error(message), { code })

/**
 * Build the child environment from an allowlist: `PATH`, `HOME`, `DSH_*` and
 * `NODE_*`. Provider keys such as `OPENAI_API_KEY` are not inherited. Also
 * drops `NODE_OPTIONS`, which can `--require` arbitrary code.
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>}
 */
export function sanitizeEnv(source = process.env) {
  const env = {}
  if (!isObject(source)) return env
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const key = name.toUpperCase()
    if (ENV_DROP.has(key)) continue
    if (ENV_KEEP.has(key) || ENV_KEEP_PREFIXES.some(prefix => key.startsWith(prefix))) env[name] = value
  }
  return env
}

/** Append a chunk to a byte-capped capture; `truncated` records lost output. */
function capture(state, chunk, max) {
  if (state.bytes >= max) {
    state.truncated = true
    return
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const room = max - state.bytes
  if (buffer.length > room) state.truncated = true
  state.text += buffer.subarray(0, room).toString('utf8')
  state.bytes += Math.min(buffer.length, room)
}

function defaultDshBin(cwd) {
  const fromEnv = typeof process.env.DSH_BIN === 'string' ? process.env.DSH_BIN.trim() : ''
  return fromEnv || resolve(cwd, 'node_modules', '.bin', 'dsh')
}

/** Optional dshBin allowlist; paths are resolved against the runner cwd. */
function binAllowlist(value, cwd) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw invalid('invalid_options', 'allowedDshBins must be an array of non-empty strings')
  }
  return value.map(item => resolve(cwd, item))
}

/** Map DSH token usage; `null` means the step has no usable usage fields. */
function usageTokens(usage) {
  if (!isObject(usage)) return null
  const total = usage.totalTokens
  if (typeof total === 'number' && Number.isFinite(total)) return count(total)
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (typeof input !== 'number' && typeof output !== 'number') return null
  return count(input) + count(output)
}

/** Parse a whole-JSON document or an NDJSON stream; bad lines are counted, not thrown. */
export function parseOutput(stdout) {
  const text = String(stdout ?? '').trim()
  const events = []
  let parseErrors = 0
  if (text) {
    try {
      const value = JSON.parse(text)
      if (isObject(value)) events.push(value)
    } catch {
      // Not one JSON document: fall through to NDJSON.
    }
    if (events.length === 0) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const value = JSON.parse(trimmed)
          if (isObject(value)) events.push(value)
          else parseErrors += 1
        } catch {
          parseErrors += 1
        }
      }
    }
  }
  return { events, parseErrors }
}

const emptySummary = () => ({
  sessionId: null,
  final: null,
  finalReason: null,
  result: { text: '' },
  trajectory: { steps: 0, toolCalls: 0, errors: 0 },
  cost: { tokens: 0, usd: 0 },
  approvals: { asked: 0, rejected: 0 },
  approvalsSource: 'none',
  usdSource: 'none',
  usageComplete: true,
})

/** Map DSH NDJSON events (or an already-shaped record) to the four dimensions. */
export function summarizeEvents(events, parseErrors = 0) {
  const summary = emptySummary()
  summary.parseErrors = parseErrors
  summary.events = events.length
  const only = events.length === 1 ? events[0] : null
  if (only && !only.type
    && (has(only, 'result') || has(only, 'trajectory') || has(only, 'cost') || has(only, 'approvals'))) {
    const reason = only.finalReason ?? { kind: only.ok === false || only.error ? 'error' : 'completed' }
    summary.sessionId = typeof only.sessionId === 'string' ? only.sessionId : null
    summary.final = { type: 'final', reason }
    summary.finalReason = reason
    summary.result = isObject(only.result) ? only.result : { text: typeof only.result === 'string' ? only.result : '' }
    summary.trajectory = {
      steps: count(only.trajectory?.steps),
      toolCalls: count(only.trajectory?.toolCalls),
      errors: count(only.trajectory?.errors),
    }
    summary.cost = { tokens: count(only.cost?.tokens), usd: count(only.cost?.usd) }
    summary.approvals = {
      asked: count(only.approvals?.asked),
      rejected: count(only.approvals?.rejected),
    }
    summary.approvalsSource = 'record'
    summary.usdSource = summary.cost.usd > 0 ? 'record' : 'none'
    return summary
  }

  let final = null
  let steps = 0
  let usageSteps = 0
  let usageComplete = true
  let tokens = 0
  let toolCalls = 0
  let errors = 0
  for (const event of events) {
    const type = event.type
    if (type === 'session') {
      if (typeof event.sessionId === 'string') summary.sessionId = event.sessionId
    } else if (type === 'final') {
      final = event
      if (typeof event.sessionId === 'string') summary.sessionId = event.sessionId
    } else if (type === 'status' && event.phase === 'step_end') {
      steps += 1
      const stepTokens = usageTokens(event.usage)
      if (stepTokens === null) usageComplete = false
      else {
        tokens += stepTokens
        usageSteps += 1
      }
    } else if (type === 'tool_call') {
      toolCalls += 1
    } else if (type === 'tool_result') {
      if (event.status === 'error') errors += 1
      const approval = event.error?.code
      if (APPROVAL_REJECTIONS.has(approval)) {
        summary.approvals.rejected += 1
        summary.approvalsSource = 'inferred'
      }
    } else if (type === 'error') {
      errors += 1
    }
    if (type === 'approval/asked') {
      summary.approvals.asked += 1
      summary.approvalsSource = 'stream'
    } else if (type === 'approval/decided') {
      if (event.outcome === 'rejected' || event.decision === 'rejected') summary.approvals.rejected += 1
      summary.approvalsSource = 'stream'
    }
  }
  if (final?.reason?.kind === 'error') errors += 1
  summary.final = final
  summary.finalReason = final?.reason ?? null
  summary.result = { text: typeof final?.text === 'string' ? final.text : '' }
  summary.trajectory = { steps, toolCalls, errors }
  summary.cost = { tokens, usd: 0 }
  summary.usageComplete = usageComplete && steps === usageSteps
  return summary
}

function earlyFailure(code, taskId, raw = {}) {
  const record = emptySummary()
  return {
    ok: false,
    code,
    taskId: typeof taskId === 'string' && taskId ? taskId : null,
    result: record.result,
    trajectory: record.trajectory,
    cost: record.cost,
    approvals: record.approvals,
    exitCode: null,
    raw: {
      ok: false,
      sessionId: null,
      finalReason: null,
      events: 0,
      parseErrors: 0,
      stdoutBytes: 0,
      stdoutTruncated: false,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 0,
      exitCode: null,
      signal: null,
      sessionLogPath: null,
      approvalsSource: 'none',
      usdSource: 'none',
      usageComplete: true,
      ...raw,
    },
  }
}

/**
 * Run tasks through the real DSH headless CLI. `spawn` is injectable for tests.
 * Failures are returned as `{ ok: false, code, ... }`; `run` never throws.
 */
export class CheckRunner {
  constructor(options = {}) {
    if (!isObject(options)) throw invalid('invalid_options', 'CheckRunner options must be an object')
    if (options.cwd !== undefined && typeof options.cwd !== 'string') {
      throw invalid('invalid_options', 'cwd must be a string')
    }
    this.cwd = resolve(options.cwd ?? process.cwd())
    this.profile = options.profile ?? 'headless'
    if (typeof this.profile !== 'string' || this.profile.trim() === '') {
      throw invalid('invalid_options', 'profile must be a non-empty string')
    }
    this.dshBin = options.dshBin ?? defaultDshBin(this.cwd)
    if (typeof this.dshBin !== 'string' || this.dshBin.trim() === '') {
      throw invalid('invalid_options', 'dshBin must be a non-empty string')
    }
    this.allowedDshBins = binAllowlist(options.allowedDshBins, this.cwd)
    if (this.allowedDshBins !== null && !this.allowedDshBins.includes(resolve(this.cwd, this.dshBin))) {
      throw invalid('E_DENIED', `dshBin "${this.dshBin}" is not in allowedDshBins`)
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof this.timeoutMs !== 'number' || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw invalid('invalid_options', 'timeoutMs must be a positive finite number')
    }
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    if (typeof this.killGraceMs !== 'number' || !Number.isFinite(this.killGraceMs) || this.killGraceMs < 0) {
      throw invalid('invalid_options', 'killGraceMs must be a non-negative finite number')
    }
    this.spawn = options.spawn ?? nodeSpawn
    if (typeof this.spawn !== 'function') throw invalid('invalid_options', 'spawn must be a function')
    this.env = isObject(options.env) ? options.env : {}
  }

  /**
   * Run one task. Returns `{ ok, code, taskId, result, trajectory, cost,
   * approvals, exitCode, raw }`; `code` is null only on success.
   * @param {{id?: string, prompt: string, cwd?: string, env?: object, timeoutMs?: number}} task
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   */
  async run(task, options = {}) {
    const started = Date.now()
    const taskId = typeof task?.id === 'string' && task.id ? task.id : null
    if (!isObject(task) || typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      return earlyFailure('invalid_task', taskId)
    }
    const signal = options?.signal
    if (signal?.aborted) return earlyFailure('aborted', taskId)
    const timeoutMs = typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.timeoutMs
    const cwd = typeof task.cwd === 'string' && task.cwd ? resolve(this.cwd, task.cwd) : this.cwd
    // Inherited variables are allowlisted; `env`/`task.env` are explicit host
    // config (never model input) and are merged last.
    const env = { ...sanitizeEnv(process.env), ...this.env, ...(isObject(task.env) ? task.env : {}) }

    let child
    try {
      child = this.spawn('node', [this.dshBin, '--profile', this.profile, '--json', task.prompt], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return earlyFailure('spawn_error', taskId, { spawnError: error.message })
    }
    if (!child || typeof child.on !== 'function') {
      return earlyFailure('spawn_error', taskId, { spawnError: 'spawn did not return a ChildProcess' })
    }

    return await new Promise(resolvePromise => {
      const out = { text: '', bytes: 0, truncated: false }
      const err = { text: '', bytes: 0, truncated: false }
      let settled = false
      let timedOut = false
      let aborted = false
      let interrupted = false
      let timeoutTimer = null
      let killTimer = null
      let hardTimer = null

      const clearTimers = () => {
        clearTimeout(timeoutTimer)
        clearTimeout(killTimer)
        clearTimeout(hardTimer)
      }
      const onAbort = () => interrupt('aborted')
      const kill = name => {
        try {
          if (typeof child.kill === 'function') child.kill(name)
        } catch {
          // The process may already be gone; the exit code still tells the story.
        }
      }
      const interrupt = reason => {
        if (settled || interrupted) return
        interrupted = true
        if (reason === 'timeout') timedOut = true
        else aborted = true
        kill('SIGINT')
        killTimer = setTimeout(() => {
          kill('SIGKILL')
          hardTimer = setTimeout(() => done(null, null, null), HARD_SETTLE_MS)
        }, this.killGraceMs)
      }
      const done = (exitCode, signalName, spawnError) => {
        if (settled) return
        settled = true
        clearTimers()
        signal?.removeEventListener?.('abort', onAbort)
        const code = typeof exitCode === 'number' ? exitCode : null
        const parsed = parseOutput(out.text)
        const summary = summarizeEvents(parsed.events, parsed.parseErrors)
        let failure = null
        if (timedOut) failure = 'timeout'
        else if (aborted) failure = 'aborted'
        else if (spawnError) failure = 'spawn_error'
        else if (code !== 0) failure = code === null ? 'signaled' : 'exit_nonzero'
        else if (!summary.final) {
          failure = summary.events === 0 && summary.parseErrors > 0 ? 'invalid_json' : 'no_final'
        } else if (summary.final.reason?.kind !== 'completed') failure = 'not_completed'
        const ok = failure === null
        const raw = {
          ok,
          sessionId: summary.sessionId,
          finalReason: summary.finalReason,
          events: summary.events,
          parseErrors: summary.parseErrors,
          stdoutBytes: out.bytes,
          stdoutTruncated: out.truncated,
          stderr: err.text,
          timedOut,
          aborted,
          durationMs: Date.now() - started,
          exitCode: code,
          signal: signalName ?? null,
          sessionLogPath: null,
          approvalsSource: summary.approvalsSource,
          usdSource: summary.usdSource,
          usageComplete: summary.usageComplete,
        }
        if (spawnError) raw.spawnError = spawnError.message
        resolvePromise({
          ok,
          code: failure,
          taskId,
          result: summary.result,
          trajectory: summary.trajectory,
          cost: summary.cost,
          approvals: summary.approvals,
          exitCode: code,
          raw,
        })
      }

      child.stdout?.on?.('data', chunk => capture(out, chunk, MAX_OUTPUT_BYTES))
      child.stderr?.on?.('data', chunk => capture(err, chunk, MAX_STDERR_BYTES))
      child.on('error', error => done(null, null, error))
      child.on('close', (code, signalName) => done(code, signalName, null))
      timeoutTimer = setTimeout(() => interrupt('timeout'), timeoutMs)
      if (signal?.addEventListener) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })
  }
}
