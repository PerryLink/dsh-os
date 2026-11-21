/**
 * Agent gateway: six plain ToolDefinitions over the capability registry.
 * os_find / os_do / os_request / os_observe / os_help / os_status.
 */
import { RISKS } from './descriptor.js'
import { fingerprint } from './registry.js'

export const VERSION = '0.1.0'
export const RESULT_SCHEMA = 'os.result/v1'
export const TOOL_NAMES = Object.freeze(['os_find', 'os_do', 'os_request', 'os_observe', 'os_help', 'os_status'])

const CODES = new Set([
  'E_INVALID_ARGUMENT', 'E_DENIED', 'E_NOT_FOUND', 'E_CONFLICT', 'E_UNAVAILABLE',
  'E_LIMIT', 'E_STATE', 'E_TIMEOUT', 'E_INTERNAL',
])
const RISK_RANK = Object.freeze({ read: 0, write: 1, execute: 2, network: 2, approval: 2, secret: 3 })
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const textOf = value => typeof value === 'string' && value.trim() ? value.trim() : null
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const uid = kind => `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const mapCode = code => CODES.has(code) ? code : 'E_UNAVAILABLE'
const maxRisk = risk => Math.max(...risk.map(item => RISK_RANK[item] ?? 0))
const isRisky = descriptor =>
  descriptor.risk.some(risk => risk === 'write' || risk === 'execute') || descriptor.idempotency === 'destructive'

function failure(code, message, options = {}) {
  return {
    ok: false,
    error: {
      code,
      subcode: options.subcode ?? null,
      message: clip(message, 240),
      retryable: options.retryable === true,
      retryAfterMs: options.retryable === true ? (options.retryAfterMs ?? 0) : null,
      remediation: options.remediation ?? 'Report the requestId to the maintainer.',
      nextTools: (options.nextTools ?? []).slice(0, 3),
      requestId: options.requestId ?? uid('req'),
      auditId: options.auditId ?? null,
      details: options.details ?? {},
      cause: null,
    },
  }
}

const notFound = (id, requestId) => failure('E_NOT_FOUND', `No capability named "${id}".`, {
  subcode: 'unknown_capability',
  remediation: 'Call os_find with a short intent to discover the right capability, then retry os_do.',
  nextTools: [{ tool: 'os_find', args: { intent: id }, why: 'find the closest capability id' }],
  requestId,
  details: { id },
})

const isGrant = grant => {
  if (!grant) return false
  if (typeof grant === 'string') return grant.length > 0
  if (typeof grant !== 'object') return false
  if (grant.revoked === true) return false
  if (typeof grant.status === 'string' && !['active', 'granted', 'issued', 'approved'].includes(grant.status)) return false
  if (typeof grant.expiresAt === 'number' && grant.expiresAt <= Date.now()) return false
  return true
}

function card(descriptor) {
  return {
    id: descriptor.id,
    title: descriptor.title,
    summary: descriptor.summary,
    risk: [...descriptor.risk],
    permissions: [...descriptor.permissions],
    cost: { ...descriptor.cost },
    example: descriptor.examples?.[0] ?? null,
  }
}

/**
 * Build a gateway over one registry.
 * @param {any} registry
 * @param {{ctx?: any, version?: string}} [options]
 */
export function createGateway(registry, options = {}) {
  if (!registry || typeof registry.resolve !== 'function') throw new TypeError('createGateway needs a registry')
  const ctx = options.ctx ?? null
  const requests = new Map()
  const jobs = new Map()
  const handles = new Map()
  const idempotency = new Map()

  function remember(value) {
    if (!isObject(value)) return
    const job = value.job ?? value.data?.job
    if (job && typeof job.id === 'string') jobs.set(job.id, job)
    for (const handle of value.handles ?? []) if (handle?.ref) handles.set(handle.ref, handle)
    for (const handle of value.data?.handles ?? []) if (handle?.ref) handles.set(handle.ref, handle)
    const ref = value.handle ?? value.data?.handle
    if (typeof ref === 'string' && ref.startsWith('dsh://')) handles.set(ref, { ref })
  }

  function makeResult(tool, value, opts = {}) {
    const items = Array.isArray(value) ? value.slice(0, 20) : Array.isArray(value?.items) ? value.items.slice(0, 20) : []
    const total = Array.isArray(value) ? value.length : Number.isInteger(value?.total) ? value.total : items.length
    const data = value === undefined || Array.isArray(value) ? undefined : value
    const summary = clip(opts.summary ?? (typeof value?.summary === 'string' ? value.summary
      : Array.isArray(value) ? `Returned ${items.length} item(s) from ${tool}.` : `${tool} completed.`), 200)
    const page = { limit: items.length || 0, returned: items.length, total, totalKnown: true, hasMore: total > items.length, nextCursor: null, sort: 'none' }
    const payload = { items, page, data }
    const result = {
      schema: RESULT_SCHEMA,
      ok: true,
      tool,
      requestId: opts.requestId ?? uid('req'),
      auditId: null,
      summary,
      items,
      page,
      handles: Array.isArray(value?.handles) ? value.handles.slice(0, 5) : [],
      truncated: false,
      warnings: Array.isArray(value?.warnings) ? value.warnings.slice(0, 20) : [],
      cost: { tokens: Math.ceil(JSON.stringify(payload).length / 4), tokensEstimated: true, latencyMs: opts.latencyMs ?? 0, money: { usd: 0, estimated: false } },
      next: Array.isArray(opts.next) ? opts.next.slice(0, 3) : Array.isArray(value?.next) ? value.next.slice(0, 3) : [],
      provenance: { source: 'kernel', sourceVersion: VERSION, observedAt: Date.now(), freshness: 'live', hash: `fnv1a:${fingerprint(payload)}`, hashScope: 'items+page+data' },
    }
    if (data !== undefined) result.data = data
    if (isObject(value?.job)) result.job = value.job
    return result
  }

  async function find(input = {}) {
    const intent = textOf(input.intent)
    if (!intent) return failure('E_INVALID_ARGUMENT', 'intent must be a non-empty string.', {
      remediation: 'Pass a short task intent, for example "search clipboard history".',
      nextTools: [{ tool: 'os_help', args: { task: intent ?? 'discover capabilities' }, why: 'get task-level guidance' }],
    })
    const limit = Math.min(Math.max(Number.isInteger(input.limit) ? input.limit : 5, 1), 10)
    const riskMax = input.riskMax === undefined ? null : RISKS.includes(input.riskMax) ? input.riskMax : undefined
    if (riskMax === undefined) return failure('E_INVALID_ARGUMENT', `riskMax must be one of ${RISKS.join(', ')}.`)
    let matches = registry.search(intent, { limit: 200 })
    if (riskMax) matches = matches.filter(descriptor => maxRisk(descriptor.risk) <= RISK_RANK[riskMax])
    return { ok: true, intent, items: matches.slice(0, limit).map(card), total: matches.length, truncated: matches.length > limit }
  }

  async function allowedByHost(exec, descriptor) {
    if (!ctx?.allow || typeof ctx.allow.check !== 'function') return false
    try {
      const decision = await ctx.allow.check({ subject: exec?.subject ?? 'agent', capability: `cap:${descriptor.id}`, scope: '*' })
      return decision?.allowed === true
    } catch {
      return false
    }
  }

  const denied = (descriptor, args, exec) => failure('E_DENIED',
    `Capability "${descriptor.id}" needs a grant for ${descriptor.risk.join('/')} access.`, {
      subcode: 'grant_required',
      remediation: 'Call os_request with the same id and args, then retry os_do after a human approves it.',
      nextTools: [
        { tool: 'os_request', args: { id: descriptor.id, args, reason: `Grant ${descriptor.risk.join('/')} access to ${descriptor.id}.` }, why: 'create the pending approval' },
        { tool: 'os_find', args: { intent: descriptor.id }, why: 'read the capability card and its risk' },
      ],
      requestId: exec?.requestId,
      details: { capability: descriptor.id, risk: descriptor.risk, permissions: descriptor.permissions },
    })

  async function execute(input = {}, exec = {}) {
    const id = textOf(input.id)
    if (!id) return failure('E_INVALID_ARGUMENT', 'id must be a non-empty capability id.', {
      remediation: 'Call os_find first; pass the id from a returned card.',
      nextTools: [{ tool: 'os_find', args: { intent: 'capabilities' }, why: 'discover capability ids' }],
      requestId: exec?.requestId,
    })
    let args = input.args === undefined ? {} : input.args
    const grant = input.grant ?? exec?.grant ?? (isObject(args) ? args.grant : undefined)
    if (grant && isObject(args) && Object.prototype.hasOwnProperty.call(args, 'grant')) {
      const { grant: _ignored, ...rest } = args
      args = rest
    }
    if (!isObject(args)) return failure('E_INVALID_ARGUMENT', 'args must be an object.', {
      remediation: 'Pass args as a JSON object matching the capability inputSchema.',
      requestId: exec?.requestId,
    })
    const descriptor = await registry.resolve(id)
    if (!descriptor) return notFound(id, exec?.requestId)
    const gated = isRisky(descriptor)
    if (gated && !isGrant(grant) && !(await allowedByHost(exec, descriptor))) return denied(descriptor, args, exec)
    if (input.preview === true) {
      return makeResult(descriptor.id, { preview: true, id: descriptor.id, args, risk: descriptor.risk, gated }, {
        summary: `Preview only: ${descriptor.id} was not executed.`,
        requestId: exec?.requestId,
        next: gated ? [{ tool: 'os_request', args: { id: descriptor.id, args }, why: 'request approval before executing' }] : [],
      })
    }
    const key = textOf(input.idempotencyKey)
    const slot = key ? `${descriptor.id}\0${key}` : null
    if (slot && idempotency.has(slot)) {
      const previous = idempotency.get(slot)
      if (previous.argsHash !== fingerprint(args)) {
        return failure('E_CONFLICT', 'This idempotencyKey was used with different args.', {
          subcode: 'idempotency_reuse',
          remediation: 'Retry with a fresh idempotencyKey, or replay the original args.',
          requestId: exec?.requestId,
          details: { capability: descriptor.id },
        })
      }
      return previous.result
    }
    const started = Date.now()
    let outcome
    try {
      outcome = await registry.invoke(descriptor.id, args, {
        ctx, subject: exec?.subject, signal: exec?.signal, grant, requestId: exec?.requestId,
      })
    } catch (error) {
      return failure('E_INTERNAL', error?.message ?? String(error), {
        remediation: 'Report requestId to the maintainer; do not retry blindly.',
        requestId: exec?.requestId,
        details: { capability: descriptor.id },
      })
    }
    if (!outcome.ok) {
      return failure(mapCode(outcome.code), outcome.message ?? `Capability ${descriptor.id} failed.`, {
        subcode: outcome.code === 'E_DENIED' ? 'grant_required' : null,
        remediation: outcome.code === 'E_DENIED'
          ? 'Call os_request with the same id and args, then retry os_do after approval.'
          : 'Call os_find to inspect the capability card, fix the args if needed, then retry.',
        nextTools: outcome.code === 'E_DENIED'
          ? [{ tool: 'os_request', args: { id: descriptor.id, args }, why: 'request a grant' }]
          : [{ tool: 'os_find', args: { intent: descriptor.id }, why: 'inspect the capability card' }],
        requestId: exec?.requestId,
        details: { capability: descriptor.id, legacyCode: outcome.legacyCode ?? null },
      })
    }
    const result = makeResult(descriptor.id, outcome.value, { requestId: exec?.requestId, latencyMs: Date.now() - started })
    remember(outcome.value)
    if (slot) idempotency.set(slot, { argsHash: fingerprint(args), result })
    return result
  }

  async function request(input = {}, exec = {}) {
    const id = textOf(input.id)
    if (!id) return failure('E_INVALID_ARGUMENT', 'id must be a non-empty capability id.', {
      remediation: 'Call os_find first; pass the id from a returned card.',
      nextTools: [{ tool: 'os_find', args: { intent: 'capabilities' }, why: 'discover capability ids' }],
      requestId: exec?.requestId,
    })
    const reason = textOf(input.reason)
    if (!reason) return failure('E_INVALID_ARGUMENT', 'reason must be a non-empty string.', {
      remediation: 'Describe why this action is needed in one short sentence.',
      requestId: exec?.requestId,
    })
    const args = input.args === undefined ? {} : input.args
    if (!isObject(args)) return failure('E_INVALID_ARGUMENT', 'args must be an object.', { requestId: exec?.requestId })
    const descriptor = await registry.resolve(id)
    if (!descriptor) return notFound(id, exec?.requestId)
    const allow = ctx?.allow ?? (typeof ctx?.get === 'function' ? ctx.get('allow') : null)
    if (!allow || typeof allow.request !== 'function') {
      return failure('E_UNAVAILABLE', 'No Allow request service is available, so nothing can be approved.', {
        subcode: 'dependency_missing',
        remediation: 'Install/enable dsh-allow (ctx.allow.request) and retry os_request.',
        nextTools: [{ tool: 'os_status', why: 'check installed modules and health' }],
        requestId: exec?.requestId,
        details: { service: 'allow.request' },
      })
    }
    let response
    try {
      response = await allow.request({
        capability: id, operationId: id, id, args, reason, subject: exec?.subject, purposeCode: descriptor.id,
      })
    } catch (error) {
      return failure(mapCode(error?.code), error?.message ?? String(error), {
        remediation: 'Fix the request args, or inspect Allow with os_status, then retry os_request.',
        requestId: exec?.requestId,
      })
    }
    const requestId = typeof response === 'string' ? response : response?.requestId ?? response?.id ?? response?.request?.id
    if (typeof requestId !== 'string' || requestId === '') {
      return failure('E_INTERNAL', 'Allow returned no requestId.', {
        remediation: 'Report this to the maintainer; do not retry automatically.',
        requestId: exec?.requestId,
      })
    }
    const status = response?.status ?? response?.state ?? 'pending'
    const hint = response?.hint ?? response?.approvalHint ?? 'A human must decide; then retry os_do with the same id and args.'
    requests.set(requestId, { requestId, capability: id, args, reason, status, createdAt: Date.now(), response })
    return { ok: true, requestId, status, hint, capability: id }
  }

  async function observe(input = {}, exec = {}) {
    const requestId = textOf(input.requestId)
    const jobId = textOf(input.jobId)
    const handle = textOf(input.handle)
    if (!requestId && !jobId && !handle) {
      return failure('E_INVALID_ARGUMENT', 'Pass one of requestId, jobId or handle.', {
        remediation: 'Use the requestId from os_request, a jobId from a job result, or a dsh:// handle.',
        requestId: exec?.requestId,
      })
    }
    if (requestId) {
      const local = requests.get(requestId)
      let remote = null
      if (ctx?.allow) {
        for (const method of ['get', 'status', 'observe']) {
          if (typeof ctx.allow[method] !== 'function') continue
          try { remote = await ctx.allow[method](requestId); if (remote) break } catch { /* keep local state */ }
        }
      }
      if (!local && !remote) return failure('E_NOT_FOUND', `No request named "${requestId}".`, {
        subcode: 'request_not_found',
        remediation: 'Call os_request to create a pending request, then observe its requestId.',
        requestId: exec?.requestId,
      })
      const state = remote?.state ?? remote?.status ?? local?.status ?? 'pending'
      return {
        ok: true, kind: 'request', requestId, state, status: state,
        request: { ...(local ?? {}), ...(isObject(remote) ? remote : {}) },
        result: remote?.grant ?? remote?.result ?? null,
      }
    }
    if (jobId) {
      let job = jobs.get(jobId)
      if (!job && typeof ctx?.jobs?.get === 'function') {
        try { job = await ctx.jobs.get(jobId) } catch { /* not found */ }
      }
      if (!job) return failure('E_NOT_FOUND', `No job named "${jobId}".`, {
        subcode: 'job_not_found',
        remediation: 'Use the jobId returned in an OsResult job field; jobs expire with the session.',
        requestId: exec?.requestId,
      })
      const state = job.state ?? job.status ?? 'unknown'
      return { ok: true, kind: 'job', jobId, state, job, progress: job.progress ?? null, result: job.result ?? null }
    }
    let entry = handles.get(handle)
    if (!entry && typeof ctx?.handles?.resolve === 'function') {
      try { entry = await ctx.handles.resolve(handle) } catch { /* not found */ }
    }
    if (!entry && typeof ctx?.handles?.get === 'function') {
      try { entry = await ctx.handles.get(handle) } catch { /* not found */ }
    }
    if (!entry) return failure('E_NOT_FOUND', `No handle named "${handle}".`, {
      subcode: 'handle_not_found',
      remediation: 'Handles expire; rerun the capability that produced the handle.',
      requestId: exec?.requestId,
    })
    return { ok: true, kind: 'handle', handle, state: 'available', result: entry }
  }

  async function help(input = {}) {
    const task = textOf(input.task)
    if (!task) return failure('E_INVALID_ARGUMENT', 'task must be a non-empty string.', {
      remediation: 'Pass the user task in one short sentence.',
    })
    const matches = registry.search(task, { limit: 5 })
    const steps = [
      `Call os_find with intent "${task}" to see the top matching capability cards.`,
      'Call os_do with the chosen id and args. Read ok before using any other field.',
      'If os_do returns E_DENIED, call os_request with the same id and args, then wait for a human decision.',
      'Retry os_do after approval; use os_observe for a jobId or dsh:// handle returned by the result.',
    ]
    return {
      ok: true,
      task,
      steps,
      capabilities: matches.map(descriptor => ({ id: descriptor.id, title: descriptor.title, risk: [...descriptor.risk] })),
      risks: [...new Set(matches.flatMap(descriptor => descriptor.risk))],
      example: matches[0]?.examples?.[0] ?? null,
    }
  }

  async function status() {
    const all = registry.list({ includeDeprecated: true, limit: 200 })
    const modules = [...new Set(all.map(descriptor => descriptor.id.split('.')[0]))].sort()
    return {
      ok: true,
      version: VERSION,
      modules,
      capabilities: all.length,
      health: { status: 'ok', capabilities: all.length, namespaces: modules.length, deprecated: all.filter(descriptor => descriptor.deprecated).length },
      tools: [...TOOL_NAMES],
    }
  }

  const defineTool = (name, description, properties, required, run) => ({
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
    output: OUTPUT,
    execute: run,
  })

  const tools = [
    defineTool('os_find', 'Find the top matching dsh-os capabilities for an intent; returns compact capability cards. Read-only.', {
      intent: { type: 'string', description: 'What the user wants to do, in natural language.' },
      riskMax: { type: 'string', enum: [...RISKS], description: 'Only return capabilities at or below this risk.' },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum cards (default 5).' },
    }, ['intent'], find),
    defineTool('os_do', 'Execute a resolved capability. Returns an OsResult; write/execute capabilities need a grant.', {
      id: { type: 'string', description: 'Capability id from os_find, for example "snip.search".' },
      args: { type: 'object', additionalProperties: true, description: 'Capability input matching its inputSchema.' },
      preview: { type: 'boolean', description: 'Validate and preview without running the handler.' },
      idempotencyKey: { type: 'string', description: 'Reuse on retries so a write happens at most once.' },
      grant: { description: 'Grant object or id returned by the approval flow; required for write/execute.' },
    }, ['id'], execute),
    defineTool('os_request', 'Create a pending approval request for a capability; never approves it. Needs ctx.allow.request.', {
      id: { type: 'string', description: 'Capability id that needs approval.' },
      args: { type: 'object', additionalProperties: true, description: 'Exact args that will be executed later.' },
      reason: { type: 'string', description: 'One-sentence reason shown to the human approver.' },
    }, ['id', 'args', 'reason'], request),
    defineTool('os_observe', 'Observe a pending request, a job or a dsh:// handle; returns state and any result.', {
      requestId: { type: 'string', description: 'requestId returned by os_request.' },
      jobId: { type: 'string', description: 'jobId returned in an OsResult job field.' },
      handle: { type: 'string', description: 'dsh:// handle from an OsResult.' },
    }, [], observe),
    defineTool('os_help', 'Get a 3-5 step task plan plus candidate capabilities and their risks. Read-only.', {
      task: { type: 'string', description: 'The user task to plan for.' },
    }, ['task'], help),
    defineTool('os_status', 'Report installed kernel modules, capability count, gateway version and health. Read-only.', {}, [], status),
  ]

  return { tools, find, do: execute, request, observe, help, status, state: { requests, jobs, handles, idempotency } }
}

/** Six plain ToolDefinitions bound to `registry`. */
export const createTools = (registry, options) => createGateway(registry, options).tools
export const gatewayTools = createTools
export default createGateway
