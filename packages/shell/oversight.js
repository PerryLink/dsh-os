/**
 * Human oversight projections for the shell: the approval inbox and a merged
 * activity feed. Allow owns every decision and every narrowing rule; the shell
 * only validates human input, rejects machine identities and projects service
 * data for the owner-only bridge. Zero dependencies, no DOM.
 * @module @perrylink/dsh-os-shell/oversight
 */

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const MACHINE_BY = /^(agent|session|tool|plugin|ui):/i
const MAX_BY = 128
const MAX_REASON = 512
const MAX_SCOPE = 512
const MAX_SCOPE_ITEMS = 32
const DEFAULT_ACTIVITY = 50
const MAX_ACTIVITY = 100

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function text(value, field, code, max) {
  if (typeof value !== 'string') fail(code, `${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) fail(code, `${field} must not be empty`)
  if (trimmed.length > max) fail(code, `${field} must be at most ${max} characters`)
  return trimmed
}

function checkRequestId(id) {
  if (typeof id !== 'string' || !REQUEST_ID.test(id.trim())) {
    fail('E_INVALID_ARGUMENT', 'request id must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')
  }
  return id.trim()
}

/** Accept an array or an envelope such as `{ items }` / `{ requests }`. */
function listOf(value) {
  if (Array.isArray(value)) return value
  if (!isPlainObject(value)) return []
  if (Array.isArray(value.items)) return value.items
  if (Array.isArray(value.requests)) return value.requests
  return []
}

function subjectText(subject) {
  if (typeof subject === 'string') return subject
  if (!isPlainObject(subject)) return null
  if (Array.isArray(subject.chain) && subject.chain.length > 0) {
    const chain = subject.chain
      .map(item => (typeof item === 'string' ? item : item?.id))
      .filter(value => typeof value === 'string' && value !== '')
    if (chain.length > 0) return chain.join(' › ')
  }
  return typeof subject.id === 'string' ? subject.id : null
}

/** Every identity the request belongs to, lower-cased, for the self-check. */
function subjectNames(subject) {
  const names = []
  const add = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    names.push(value)
    const colon = value.indexOf(':')
    if (colon > 0) names.push(value.slice(colon + 1))
  }
  if (typeof subject === 'string') add(subject)
  else if (isPlainObject(subject)) {
    add(subject.id)
    if (typeof subject.kind === 'string' && typeof subject.id === 'string') add(`${subject.kind}:${subject.id}`)
    if (Array.isArray(subject.chain)) {
      for (const item of subject.chain) {
        if (typeof item === 'string') { add(item); continue }
        if (!isPlainObject(item)) continue
        add(item.id)
        if (typeof item.kind === 'string' && typeof item.id === 'string') add(`${item.kind}:${item.id}`)
      }
    }
  }
  return names.map(name => name.trim().toLowerCase())
}

/** The exact card shape; unknown request fields never cross the bridge. */
function projectApproval(request) {
  return {
    id: typeof request?.id === 'string' ? request.id : null,
    subject: subjectText(request?.subject),
    capability: typeof request?.capability === 'string' ? request.capability : null,
    scope: request?.scope ?? null,
    reason: typeof request?.reason === 'string' ? request.reason
      : typeof request?.claim?.reason === 'string' ? request.claim.reason : null,
    createdAt: Number.isFinite(request?.createdAt) ? request.createdAt : null,
    expiresAt: Number.isFinite(request?.expiresAt) ? request.expiresAt : null,
    risk: typeof request?.risk === 'string' ? request.risk : null,
  }
}

/** Type-check only: whether a scope narrows the request is Allow's verdict. */
function checkScope(scope) {
  if (scope === undefined) return undefined
  const values = Array.isArray(scope) ? scope : [scope]
  if (values.length === 0 || values.length > MAX_SCOPE_ITEMS) {
    fail('E_SCOPE', `scope must contain 1-${MAX_SCOPE_ITEMS} values`)
  }
  const normalized = values.map(value => text(value, 'scope', 'E_SCOPE', MAX_SCOPE))
  return Array.isArray(scope) ? normalized : normalized[0]
}

function timeOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

/** Host-side projection behind the owner-only approval/activity bridge. */
export class Oversight {
  #getService

  constructor(getService) {
    if (typeof getService !== 'function') fail('E_INVALID_ARGUMENT', 'getService must be a function')
    this.#getService = getService
  }

  #service(name) {
    try {
      return this.#getService(name)
    } catch {
      return undefined
    }
  }

  #allow() {
    const allow = this.#service('allow')
    return allow !== null && typeof allow === 'object' ? allow : undefined
  }

  async approvalList(status = 'pending') {
    const allow = this.#allow()
    if (allow === undefined || typeof allow.requests !== 'function') return { available: false }
    const value = typeof status === 'string' && status.trim() !== '' ? status.trim() : 'pending'
    if (!STATUS_PATTERN.test(value)) fail('E_INVALID_ARGUMENT', 'status must be a short lower-case token')
    return { available: true, items: listOf(await allow.requests({ status: value })).map(projectApproval) }
  }

  approve(id, input = {}) {
    return this.#decide('approve', id, input)
  }

  deny(id, input = {}) {
    return this.#decide('deny', id, input)
  }

  async #decide(decision, id, input) {
    const allow = this.#allow()
    if (allow === undefined || typeof allow[decision] !== 'function') return { available: false }
    const requestId = checkRequestId(id)
    if (!isPlainObject(input)) fail('E_INVALID_ARGUMENT', 'decision body must be a JSON object')
    const by = text(input.by, 'by', 'E_BY_REQUIRED', MAX_BY)
    if (MACHINE_BY.test(by)) {
      fail('E_HUMAN_REQUIRED', 'agent, session, tool, plugin and ui identities cannot decide')
    }
    if (decision === 'approve') await this.#assertNotRequester(allow, requestId, by)
    // Allow's human API takes one object: { id, by, scope? } / { id, by, reason }.
    const decisionInput = { id: requestId, by }
    if (decision === 'approve' && input.scope !== undefined) decisionInput.scope = checkScope(input.scope)
    if (decision === 'deny') decisionInput.reason = text(input.reason, 'reason', 'E_REASON', MAX_REASON)
    return { available: true, approval: (await allow[decision](decisionInput)) ?? null }
  }

  /** Best-effort requester check; Allow stays the authority when it cannot answer. */
  async #assertNotRequester(allow, id, by) {
    if (typeof allow.requests !== 'function') return
    let request
    try {
      request = listOf(await allow.requests({ status: 'pending' })).find(item => item?.id === id)
    } catch {
      return
    }
    if (request !== undefined && subjectNames(request.subject).includes(by.toLowerCase())) {
      fail('E_SELF_APPROVAL', 'the requester cannot approve its own request')
    }
  }

  async activity(limit = DEFAULT_ACTIVITY) {
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_ACTIVITY) : DEFAULT_ACTIVITY
    const [approvals, actions] = await Promise.all([this.#approvalActivity(size), this.#actionActivity(size)])
    const entries = [...approvals.entries, ...actions.entries]
      .sort((left, right) => timeOf(right.at) - timeOf(left.at))
      .slice(0, size)
    return { entries, sources: { approvals: approvals.available, actions: actions.available } }
  }

  async #approvalActivity(size) {
    const allow = this.#allow()
    if (allow === undefined) return { available: false, entries: [] }
    if (typeof allow.audit === 'function') {
      const rows = listOf(await allow.audit(size))
      return {
        available: true,
        entries: rows.map(entry => ({
          kind: 'approval',
          id: entry?.grantId ?? entry?.id ?? null,
          title: entry?.event ?? 'approval',
          event: entry?.event ?? null,
          at: Number.isFinite(entry?.at) ? entry.at : null,
          status: entry?.event ?? null,
          subject: entry?.subject ?? null,
          capability: entry?.capability ?? null,
          scope: entry?.scope ?? null,
          reason: entry?.reason ?? null,
          risk: null,
        })),
      }
    }
    if (typeof allow.requests === 'function') {
      const rows = listOf(await allow.requests({}))
      return {
        available: true,
        entries: rows.map(request => ({
          ...projectApproval(request),
          kind: 'approval',
          title: 'approval request',
          event: null,
          at: Number.isFinite(request?.createdAt) ? request.createdAt : null,
          status: typeof request?.status === 'string' ? request.status : null,
        })),
      }
    }
    return { available: false, entries: [] }
  }

  async #actionActivity(size) {
    const act = this.#service('act')
    if (act === undefined || act === null) return { available: false, entries: [] }
    if (typeof act.audit === 'function') {
      const rows = listOf(await act.audit(size))
      return {
        available: true,
        entries: rows.map(entry => ({
          kind: 'action',
          id: entry?.id ?? entry?.actionId ?? null,
          title: entry?.title ?? entry?.event ?? entry?.actionId ?? 'action',
          at: Number.isFinite(entry?.at) ? entry.at
            : Number.isFinite(entry?.createdAt) ? entry.createdAt : null,
          status: entry?.status ?? entry?.event ?? null,
          subject: entry?.subject ?? null,
          capability: entry?.capability ?? entry?.actionId ?? null,
          scope: entry?.scope ?? null,
          reason: entry?.reason ?? null,
          risk: typeof entry?.risk === 'string' ? entry.risk : null,
        })),
      }
    }
    if (typeof act.list === 'function') {
      const actions = await act.list()
      return {
        available: true,
        entries: (Array.isArray(actions) ? actions : []).map(action => ({
          kind: 'action',
          id: action?.id ?? null,
          title: action?.title ?? 'action',
          at: null,
          status: 'registered',
          subject: null,
          capability: null,
          scope: null,
          reason: action?.description ?? null,
          risk: action?.risk ?? null,
        })),
      }
    }
    return { available: false, entries: [] }
  }
}
