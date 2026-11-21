/**
 * Agent gateway: six plain ToolDefinitions over the capability registry.
 * os_find / os_do / os_request / os_observe / os_help / os_status.
 */
import { RISKS } from './descriptor.js'
import { fingerprint } from './registry.js'
import { VERSION, RESULT_SCHEMA, ok as makeResult, err as failure, legacyOutcome } from './envelope.js'
import { createStateStore } from './state.js'
import { TaintRegistry, sha256 } from './taint.js'

export { VERSION, RESULT_SCHEMA }
export const TOOL_NAMES = Object.freeze(['os_find', 'os_do', 'os_request', 'os_observe', 'os_help', 'os_status'])
/**
 * Permission names are namespaced `cap:<descriptor.id>` on BOTH sides of the
 * Allow bridge: `os_request` asks for this exact string and `allowedByHost`
 * checks it. The prefix keeps kernel capability grants distinct from a
 * module's own grants (for example Act's `act:invoke:<action>`).
 */
export const CAPABILITY_PREFIX = 'cap:'
export const capabilityName = id => `${CAPABILITY_PREFIX}${id}`

const RISK_RANK = Object.freeze({ read: 0, write: 1, execute: 2, network: 2, approval: 2, secret: 3 })
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const textOf = value => typeof value === 'string' && value.trim() ? value.trim() : null
const subjectOf = exec => textOf(exec?.subject)
  ?? textOf(exec?.agent?.session?.id)
  ?? textOf(exec?.agent?.id)
const maxRisk = risk => Math.max(...risk.map(item => RISK_RANK[item] ?? 0))
const isRisky = descriptor =>
  descriptor.risk.some(risk => risk === 'write' || risk === 'execute') || descriptor.idempotency === 'destructive'

/** Capability ids whose tainted-write gate is enforced by the kernel. */
const TAINT_WRITE_IDS = new Set(['act.fs.write'])
const taintTarget = (id, args) => {
  if (TAINT_WRITE_IDS.has(id)) return id
  if (id === 'legacy.act_invoke' && isObject(args) && args.id === 'fs.write') return 'act.fs.write'
  return null
}
const taintedCapability = (id, args) => {
  const target = taintTarget(id, args)
  return `${capabilityName(target ?? id)}:tainted`
}

/** Exact write text plus the optional token carried in args or nested act args. */
function taintProbe(id, args) {
  const target = taintTarget(id, args)
  if (target === null || !isObject(args)) return null
  const nested = id === 'legacy.act_invoke' && isObject(args.args) ? args.args : args
  const pick = value => typeof value?.text === 'string' && value.text !== '' ? value.text
    : typeof value?.content === 'string' && value.content !== '' ? value.content : null
  const text = pick(nested) ?? (nested === args ? null : pick(args))
  if (text === null) return null
  const token = typeof args.taintToken === 'string' && args.taintToken !== '' ? args.taintToken
    : typeof nested.taintToken === 'string' && nested.taintToken !== '' ? nested.taintToken : null
  return { target, hash: sha256(text), token }
}

/** Drop taint evidence before invoking; the kernel has already evaluated it. */
function withoutTaint(id, args) {
  const copy = { ...args }
  delete copy.tainted
  delete copy.taintToken
  if (id === 'legacy.act_invoke' && isObject(copy.args)) {
    const nested = { ...copy.args }
    delete nested.tainted
    delete nested.taintToken
    copy.args = nested
  }
  return copy
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
  if (typeof grant.uses === 'number' && Number.isFinite(grant.maxUses) && grant.uses >= grant.maxUses) return false
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
 * @param {{ctx?: any, stateFile?: string, gatewayOnly?: boolean, taint?: any}} [options]
 */
export function createGateway(registry, options = {}) {
  if (!registry || typeof registry.resolve !== 'function') throw new TypeError('createGateway needs a registry')
  const ctx = options.ctx ?? null
  const stateFile = options.stateFile
  const requests = new Map()
  const jobs = new Map()
  const handles = new Map()
  const idempotency = new Map()
  const autoGrants = new Map()
  const taint = options.taint instanceof TaintRegistry ? options.taint : new TaintRegistry(options.taint)
  let idempotencyStore = null
  try {
    idempotencyStore = createStateStore(stateFile)
  } catch (error) {
    throw new TypeError(error?.message ?? String(error))
  }

  /** Resolve the Allow service once per call; a throwing getter fails closed. */
  function allowService() {
    // Prefer the injected getter; the direct property is a test/host fallback.
    // Cordis throws on an uninjected read, so it stays inside try/catch.
    try { if (ctx?.allow) return ctx.allow } catch { /* not injected */ }
    if (typeof ctx?.get !== 'function') return null
    try { return ctx.get('allow') ?? null } catch { return null }
  }

  /** Pull the newest request snapshot from the host Allow service. */
  async function latestRequest(requestId, subject) {
    const allow = allowService()
    if (!allow) return null
    if (typeof allow.requests === 'function') {
      for (const filter of subject ? [{ subject }] : [{}]) {
        try {
          const list = await allow.requests(filter)
          const items = Array.isArray(list) ? list : Array.isArray(list?.requests) ? list.requests : []
          const found = items.find(item => item?.id === requestId || item?.requestId === requestId)
          if (found) return found
        } catch { /* try the next seam */ }
      }
    }
    if (typeof allow.wait === 'function') {
      try { return await allow.wait(requestId, { timeoutMs: 0, ...(subject ? { subject } : {}) }) } catch { /* not visible */ }
    }
    for (const method of ['get', 'status', 'observe']) {
      if (typeof allow[method] !== 'function') continue
      try { const found = await allow[method](requestId); if (found) return found } catch { /* keep local */ }
    }
    return null
  }

  /**
   * Consume one approved Grant exactly once and remember it for the matching
   * `os_do` call. The Allow check is the atomic use(), and it deliberately
   * omits scope so an approval narrowed by the human still authorizes.
   */
  async function cacheAutoGrant(requestId, local) {
    const existing = autoGrants.get(requestId)
    if (existing) return { grant: existing.grant, reason: null }
    const allow = allowService()
    if (!allow || typeof allow.check !== 'function') return { grant: null, reason: 'check_unavailable' }
    try {
      const decision = await allow.check({ subject: local.subject, capability: local.capability })
      if (decision?.allowed !== true) return { grant: null, reason: decision?.reason ?? 'no-grant' }
      const grant = decision.grant ?? { id: `grant_auto_${requestId}`, status: 'active' }
      autoGrants.set(requestId, {
        requestId, id: local.capabilityId, argsHash: local.argsHash, subject: local.subject,
        capability: local.capability, grant, at: Date.now(),
      })
      return { grant, reason: null }
    } catch (error) {
      return { grant: null, reason: error?.code ?? 'check_failed' }
    }
  }

  /** Peek at a cached approval bound to this subject/id/args/capability. */
  function findAutoGrant(subject, id, argsHash, capability) {
    if (!subject || !argsHash) return null
    for (const item of autoGrants.values()) {
      if (item.id === id && item.subject === subject && item.argsHash === argsHash
        && (capability === undefined || item.capability === capability)) return item
    }
    return null
  }

  /** Take (and thus consume) the cached approval found by `findAutoGrant`. */
  function takeAutoGrant(item) {
    if (!item) return null
    return autoGrants.get(item.requestId) === item ? (autoGrants.delete(item.requestId), item) : null
  }

  function remember(value) {
    if (!isObject(value)) return
    const job = value.job ?? value.data?.job
    if (job && typeof job.id === 'string') jobs.set(job.id, job)
    for (const handle of value.handles ?? []) if (handle?.ref) handles.set(handle.ref, handle)
    for (const handle of value.data?.handles ?? []) if (handle?.ref) handles.set(handle.ref, handle)
    const ref = value.handle ?? value.data?.handle
    if (typeof ref === 'string' && ref.startsWith('dsh://')) handles.set(ref, { ref })
  }

  // Lazy legacy bridge: the first os_find/os_status adapts the host tools that
  // are visible to the calling agent. Hosts without schemas/get are skipped.
  let legacyReady = false
  const refreshLegacy = typeof registry.refreshLegacy === 'function' ? registry.refreshLegacy.bind(registry) : null
  async function ensureLegacy(exec) {
    if (legacyReady || !refreshLegacy) return
    const tools = ctx?.tools
    if (!tools || typeof tools.schemas !== 'function' || typeof tools.get !== 'function') return
    // gatewayOnly restricts the agent's *tool* view; the kernel still needs the
    // global view so those tools remain reachable as os_find/os_do capabilities.
    const scope = options.gatewayOnly === true ? undefined : exec?.agent
    try { await refreshLegacy({ scope }) } catch { return }
    legacyReady = true
  }

  async function find(input = {}, exec = {}) {
    await ensureLegacy(exec)
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
    const subject = subjectOf(exec)
    const allow = allowService()
    if (!subject || !allow || typeof allow.check !== 'function') return false
    try {
      const decision = await allow.check({ subject, capability: capabilityName(descriptor.id) })
      return decision?.allowed === true
    } catch {
      return false
    }
  }

  const denied = (descriptor, args, exec) => failure('E_DENIED',
    `Capability "${descriptor.id}" needs a grant for ${descriptor.risk.join('/')} access.`, {
      subcode: 'grant_required',
      remediation: 'Call os_request with the same id and args, then call os_observe to refresh and consume the approved grant.',
      nextTools: [
        { tool: 'os_request', args: { id: descriptor.id, args, reason: `Grant ${descriptor.risk.join('/')} access to ${descriptor.id}.` }, why: 'create the pending approval' },
        { tool: 'os_find', args: { intent: descriptor.id }, why: 'read the capability card and its risk' },
      ],
      requestId: exec?.requestId,
      details: { capability: descriptor.id, permission: capabilityName(descriptor.id), risk: descriptor.risk, permissions: descriptor.permissions },
    })

  /** Ask Allow for a tainted-write capability without consuming a cached grant. */
  async function taintedAllowed(exec, capability) {
    const subject = subjectOf(exec)
    const allow = allowService()
    if (!subject || !allow || typeof allow.check !== 'function') return false
    try {
      return (await allow.check({ subject, capability }))?.allowed === true
    } catch {
      return false
    }
  }

  const taintDenied = (descriptor, args, probe, record, exec) => failure('E_DENIED',
    `Writing content from a tainted source to "${probe.target}" needs a separate tainted Grant.`, {
      subcode: 'grant_required',
      remediation: 'Call os_request with tainted:true and the same id and args, then os_observe; or pass a fresh taintToken from the read.',
      nextTools: [
        { tool: 'os_request', args: { id: descriptor.id, args, reason: `Grant tainted-write access to ${probe.target}.`, tainted: true }, why: 'create the pending tainted-write approval' },
        { tool: 'os_find', args: { intent: probe.target }, why: 'read the capability card and its tainted permission' },
      ],
      requestId: exec?.requestId,
      details: {
        capability: descriptor.id,
        permission: `${capabilityName(probe.target)}:tainted`,
        tainted: true,
        taintSource: record?.source ?? null,
        reason: probe.token ? 'invalid_taint_token' : 'taint_required',
      },
    })

  async function execute(input = {}, exec = {}) {
    const id = textOf(input.id)
    if (!id) return failure('E_INVALID_ARGUMENT', 'id must be a non-empty capability id.', {
      remediation: 'Call os_find first; pass the id from a returned card.',
      nextTools: [{ tool: 'os_find', args: { intent: 'capabilities' }, why: 'discover capability ids' }],
      requestId: exec?.requestId,
    })
    let args = input.args === undefined ? {} : input.args
    const providedGrant = input.grant ?? exec?.grant ?? (isObject(args) ? args.grant : undefined)
    if (providedGrant && isObject(args) && Object.prototype.hasOwnProperty.call(args, 'grant')) {
      const { grant: _ignored, ...rest } = args
      args = rest
    }
    if (!isObject(args)) return failure('E_INVALID_ARGUMENT', 'args must be an object.', {
      remediation: 'Pass args as a JSON object matching the capability inputSchema.',
      requestId: exec?.requestId,
    })
    if (id.startsWith('legacy.')) await ensureLegacy(exec)
    const descriptor = await registry.resolve(id)
    if (!descriptor) return notFound(id, exec?.requestId)
    const gated = isRisky(descriptor)
    const argsHash = fingerprint(args)
    const subject = subjectOf(exec)
    // A grant cached by os_observe is bound to the exact subject/id/args triple.
    const auto = gated && !isGrant(providedGrant)
      ? findAutoGrant(subject, descriptor.id, argsHash, capabilityName(descriptor.id)) : null
    const grant = providedGrant ?? auto?.grant ?? undefined
    const authorized = !gated || Boolean(auto) || isGrant(grant)
    if (input.preview === true) {
      if (!authorized && !(await allowedByHost(exec, descriptor))) return denied(descriptor, args, exec)
      return makeResult(descriptor.id, { preview: true, id: descriptor.id, args, risk: descriptor.risk, gated }, {
        summary: `Preview only: ${descriptor.id} was not executed.`,
        requestId: exec?.requestId,
        next: gated ? [{ tool: 'os_request', args: { id: descriptor.id, args }, why: 'request approval before executing' }] : [],
      })
    }
    const key = textOf(input.idempotencyKey)
    const slot = key ? `${subject ?? ''}\0${descriptor.id}\0${key}` : null
    if (slot) {
      const previous = idempotency.get(slot) ?? idempotencyStore?.get(slot)
      if (previous) {
        if (previous.argsHash !== argsHash) {
          return failure('E_CONFLICT', 'This idempotencyKey was used with different args.', {
            subcode: 'idempotency_reuse',
            remediation: 'Retry with a fresh idempotencyKey, or replay the original args.',
            requestId: exec?.requestId,
            details: { capability: descriptor.id },
          })
        }
        return previous.result
      }
    }
    if (!authorized && !(await allowedByHost(exec, descriptor))) return denied(descriptor, args, exec)
    // Content-hash taint gate: the model no longer decides by writing
    // `tainted:true`; a digest registered from snip_get/seek_resolve/
    // trigger_runs (or any result carrying a taintToken) forces the extra
    // :tainted Grant. A fresh, hash-bound token is the one-time alternative.
    let callArgs = args
    let taintAuto = null
    const probe = taintProbe(descriptor.id, args)
    if (probe) {
      const record = taint.lookup(probe.hash)
      if (record !== undefined || probe.token !== null) {
        let cleared = record !== undefined && probe.token !== null && taint.consume(probe.hash, probe.token)
        if (!cleared) {
          const capability = taintedCapability(descriptor.id, args)
          const cached = findAutoGrant(subject, descriptor.id, argsHash, capability)
          if (cached) {
            taintAuto = cached
            cleared = true
          } else {
            cleared = await taintedAllowed(exec, capability)
          }
        }
        if (!cleared) return taintDenied(descriptor, args, probe, record, exec)
        callArgs = withoutTaint(descriptor.id, args)
      }
    }
    // Consume only after every check and after the idempotency replay path, so
    // a replayed call never burns a fresh approval and an approval is used once.
    if (auto) takeAutoGrant(auto)
    if (taintAuto) takeAutoGrant(taintAuto)
    const callRequestId = auto?.requestId ?? taintAuto?.requestId ?? exec?.requestId
    const started = Date.now()
    let outcome
    try {
      outcome = await registry.invoke(descriptor.id, callArgs, {
        ctx, subject: subjectOf(exec), agent: exec?.agent, signal: exec?.signal, grant, requestId: callRequestId,
      })
    } catch (error) {
      return failure('E_INTERNAL', error?.message ?? String(error), {
        remediation: 'Report requestId to the maintainer; do not retry blindly.',
        requestId: callRequestId,
        details: { capability: descriptor.id },
      })
    }
    if (!outcome.ok) {
      return failure(outcome.legacyCode ?? outcome.code, outcome.message ?? `Capability ${descriptor.id} failed.`, {
        subcode: outcome.code === 'E_DENIED' ? 'grant_required' : null,
        remediation: outcome.code === 'E_DENIED'
          ? 'Call os_request with the same id and args, then call os_observe to refresh the approval.'
          : 'Call os_find to inspect the capability card, fix the args if needed, then retry.',
        nextTools: outcome.code === 'E_DENIED'
          ? [{ tool: 'os_request', args: { id: descriptor.id, args }, why: 'request a grant' }]
          : [{ tool: 'os_find', args: { intent: descriptor.id }, why: 'inspect the capability card' }],
        requestId: callRequestId,
        details: { capability: descriptor.id },
      })
    }
    // Legacy tools often return their own `{ ok, error }` envelope; normalize it
    // through the kernel's err()/ok() pair instead of nesting it as data.
    const normalized = descriptor.legacy === true ? legacyOutcome(outcome.value) : null
    if (normalized?.ok === false) {
      const legacy = normalized.error
      const code = legacy.code ?? 'E_INTERNAL'
      const denied = code === 'E_DENIED' || code === 'grant_required'
      return failure(code, legacy.message ?? `Legacy capability ${descriptor.id} failed.`, {
        subcode: legacy.subcode ?? (denied ? 'grant_required' : null),
        retryable: legacy.retryable,
        retryAfterMs: legacy.retryAfterMs,
        remediation: legacy.remediation ?? (denied
          ? 'Call os_request with the same id and args, then call os_observe to refresh the approval.'
          : undefined),
        nextTools: Array.isArray(legacy.nextTools) ? legacy.nextTools : denied
          ? [{ tool: 'os_request', args: { id: descriptor.id, args }, why: 'request a grant' }]
          : undefined,
        requestId: callRequestId,
        details: { capability: descriptor.id, ...(isObject(legacy.details) ? legacy.details : {}) },
      })
    }
    const value = normalized?.ok === true ? normalized.value : outcome.value
    const result = makeResult(descriptor.id, value, { requestId: callRequestId, latencyMs: Date.now() - started })
    remember(value)
    taint.observe(descriptor.id, value)
    if (slot) {
      const entry = { argsHash, result }
      idempotency.set(slot, entry)
      if (idempotencyStore) {
        try {
          idempotencyStore.set(slot, entry)
        } catch (error) {
          result.warnings.push(`idempotency result was not persisted: ${error?.message ?? String(error)}`)
        }
      }
    }
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
    const allow = allowService()
    if (!allow || typeof allow.request !== 'function') {
      return failure('E_UNAVAILABLE', 'No Allow request service is available, so nothing can be approved.', {
        subcode: 'dependency_missing',
        remediation: 'Install/enable dsh-allow (ctx.allow.request) and retry os_request.',
        nextTools: [{ tool: 'os_status', why: 'check installed modules and health' }],
        requestId: exec?.requestId,
        details: { service: 'allow.request' },
      })
    }
    // os_do treats an `args.grant` shortcut as a grant, not capability input,
    // so the approval fingerprint must use the same normalized args.
    const requestArgs = isObject(args) && Object.prototype.hasOwnProperty.call(args, 'grant')
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'grant')) : args
    // `tainted:true` asks for `<target>:tainted` instead of the base capability;
    // legacy.act_invoke maps to act.fs.write so both verbs share one approval.
    const capability = input.tainted === true
      ? taintedCapability(descriptor.id, requestArgs)
      : capabilityName(descriptor.id)
    const subject = subjectOf(exec)
    if (!subject) {
      return failure('E_INVALID_ARGUMENT', 'os_request needs an executing subject.', {
        remediation: 'Call os_request from an agent turn; the host supplies exec.subject or exec.agent.session.id.',
        requestId: exec?.requestId,
      })
    }
    let response
    try {
      response = await allow.request({
        subject, capability, scope: '*', maxUses: 1, reason,
      })
    } catch (error) {
      return failure(error?.code, error?.message ?? String(error), {
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
    const hint = response?.hint ?? response?.approvalHint
      ?? 'A human must decide; then call os_observe with this requestId and retry os_do with the same id and args.'
    requests.set(requestId, {
      requestId, capabilityId: descriptor.id, capability, argsHash: fingerprint(requestArgs), subject,
      reason, status, scope: '*', createdAt: Date.now(), response,
    })
    return { ok: true, requestId, status, hint, id: descriptor.id, capability }
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
      if (local && subjectOf(exec) && local.subject !== subjectOf(exec)) {
        return failure('E_NOT_FOUND', `No request named "${requestId}".`, {
          subcode: 'request_not_found', requestId: exec?.requestId,
        })
      }
      const remote = await latestRequest(requestId, local?.subject ?? subjectOf(exec))
      if (!local && !remote) return failure('E_NOT_FOUND', `No request named "${requestId}".`, {
        subcode: 'request_not_found',
        remediation: 'Call os_request to create a pending request, then observe its requestId.',
        requestId: exec?.requestId,
      })
      const state = remote?.state ?? remote?.status ?? local?.status ?? 'pending'
      let grant = null
      let grantReason = null
      if (state === 'approved') {
        if (local) ({ grant, reason: grantReason } = await cacheAutoGrant(requestId, local))
        else grantReason = 'request_not_created_by_kernel'
      } else {
        autoGrants.delete(requestId)
      }
      if (local) local.status = state
      return {
        ok: true, kind: 'request', requestId, state, status: state,
        id: local?.capabilityId ?? null,
        capability: local?.capability ?? remote?.capability ?? null,
        request: { ...(local ?? {}), ...(isObject(remote) ? remote : {}) },
        result: grant ?? remote?.grant ?? remote?.result ?? null,
        grantAvailable: Boolean(grant),
        ...(grantReason ? { grantReason } : {}),
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
      'Call os_observe with the requestId; once approved it consumes the Grant and os_do can run without an injected grant.',
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

  async function status(_input = {}, exec = {}) {
    await ensureLegacy(exec)
    const all = registry.list({ includeDeprecated: true, limit: 200 })
    const legacy = all.filter(descriptor => descriptor.legacy === true).length
    const counts = typeof registry.stats === 'function' ? registry.stats() : { legacy, capabilities: all.length - legacy, total: all.length }
    const modules = [...new Set(all.filter(descriptor => descriptor.legacy !== true).map(descriptor => descriptor.id.split('.')[0]))].sort()
    return {
      ok: true,
      version: VERSION,
      modules,
      ...counts,
      health: {
        status: 'ok', ...counts,
        namespaces: modules.length, deprecated: all.filter(descriptor => descriptor.deprecated).length,
      },
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
    defineTool('os_do', 'Execute a resolved capability. Returns an OsResult; write/execute capabilities need a grant. After os_observe reports the request approved, retry with the same id and args and the cached grant is consumed automatically. Writing text previously returned by snip_get/seek_resolve/trigger_runs also needs the `<id>:tainted` Grant, or a fresh taintToken bound to that text.', {
      id: { type: 'string', description: 'Capability id from os_find, for example "snip.search".' },
      args: { type: 'object', additionalProperties: true, description: 'Capability input matching its inputSchema. For act.fs.write/legacy.act_invoke, text/content is hashed against the taint registry.' },
      preview: { type: 'boolean', description: 'Validate and preview without running the handler.' },
      idempotencyKey: { type: 'string', description: 'Reuse on retries so a write happens at most once; with config.stateFile it survives a restart.' },
      grant: { description: 'Optional grant object or id; normally omitted because os_observe caches the approved one.' },
    }, ['id'], execute),
    defineTool('os_request', 'Create a pending approval request for capability "cap:<id>"; never approves it. Needs ctx.allow.request. Pass tainted:true to request the extra tainted-write Grant.', {
      id: { type: 'string', description: 'Capability id that needs approval.' },
      args: { type: 'object', additionalProperties: true, description: 'Exact args that will be executed later.' },
      reason: { type: 'string', description: 'One-sentence reason shown to the human approver.' },
      tainted: { type: 'boolean', description: 'Request "cap:<id>:tainted" for content from a taint source.' },
    }, ['id', 'args', 'reason'], request),
    defineTool('os_observe', 'Observe a request, job or dsh:// handle. For a request it refreshes state from Allow, consumes grantAvailable and lets the next matching os_do run.', {
      requestId: { type: 'string', description: 'requestId returned by os_request.' },
      jobId: { type: 'string', description: 'jobId returned in an OsResult job field.' },
      handle: { type: 'string', description: 'dsh:// handle from an OsResult.' },
    }, [], observe),
    defineTool('os_help', 'Get a 3-5 step task plan plus candidate capabilities and their risks. Read-only.', {
      task: { type: 'string', description: 'The user task to plan for.' },
    }, ['task'], help),
    defineTool('os_status', 'Report installed kernel modules, capability count, gateway version and health. Read-only.', {}, [], status),
  ]

  return { tools, find, do: execute, request, observe, help, status, state: { requests, jobs, handles, idempotency, autoGrants, taint } }
}

/** Six plain ToolDefinitions bound to `registry`. */
export const createTools = (registry, options) => createGateway(registry, options).tools
export const gatewayTools = createTools
export default createGateway
