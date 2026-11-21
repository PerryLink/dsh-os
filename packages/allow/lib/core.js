/**
 * dsh-allow core: constants, scope helpers, request hashing, the persisted
 * GrantStore and the plain ToolDefinitions. Kept out of index.js so the
 * security-critical service stays under the module size budget.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_SUBJECT_LENGTH = 256, MAX_CAPABILITY_LENGTH = 256, MAX_SCOPE_LENGTH = 512, MAX_APPROVER_LENGTH = 128
export const MAX_AUDIT_ENTRIES = 2000
/** `allowed`/`denied` are sampled so routine checks cannot flush the security trail. */
export const MAX_CHECK_AUDIT_ENTRIES = 200
/** Pending requests default to 10 minutes and never stay open longer than 30. */
export const REQUEST_TTL_MS = 10 * 60 * 1000
export const MAX_REQUEST_TTL_MS = 30 * 60 * 1000
/** Model-facing waits are aligned with a turn budget: 5s default, 25s hard cap. */
export const DEFAULT_WAIT_MS = 5 * 1000
export const MAX_WAIT_MS = 25 * 1000
export const MAX_REASON_LENGTH = 280
/** A request asks for one use by default; both request and approval cap at 100. */
export const DEFAULT_MAX_USES = 1
export const MAX_USES = 100
export const REQUEST_STATES = ['pending', 'approved', 'denied', 'expired']
export const GRANT_STATES = ['active', 'revoked', 'expired', 'used']
// On-disk version stays 2 so the approvals CLI keeps reading it; use counters are additive.
const STATE_VERSION = 2
/** The only fields a model may ask for; identity, state and hashes are derived. */
const REQUEST_FIELDS = new Set(['subject', 'capability', 'scope', 'ttlMs', 'reason', 'maxUses'])

const CHECK_EVENTS = new Set(['allowed', 'denied'])
const isCheck = event => CHECK_EVENTS.has(event)

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function text(value, field, code, max) {
  if (typeof value !== 'string') fail(code, `${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) fail(code, `${field} must not be empty`)
  if (trimmed.length > max) fail(code, `${field} must be at most ${max} characters`)
  return trimmed
}

function objectInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('E_INPUT', 'input must be an object')
  return value
}

/** `*` and `foo:*` are grant-side patterns; strings and arrays are accepted. */
function normalizeScope(scope) {
  if (scope === undefined) return '*'
  if (Array.isArray(scope)) {
    if (scope.length === 0) fail('E_SCOPE', 'scope must not be an empty array')
    return scope.map(value => text(value, 'scope', 'E_SCOPE', MAX_SCOPE_LENGTH))
  }
  return text(scope, 'scope', 'E_SCOPE', MAX_SCOPE_LENGTH)
}

function scopeCovers(pattern, requested) {
  if (Array.isArray(pattern)) return pattern.some(value => scopeCovers(value, requested))
  if (pattern === '*') return true
  if (typeof pattern !== 'string' || typeof requested !== 'string') return false
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1)
    return requested === prefix || requested.startsWith(prefix)
  }
  return pattern === requested
}

/** Approval may only narrow the requested scope; widening fails closed. */
function narrowScope(requested, narrowed) {
  const candidate = normalizeScope(narrowed)
  for (const item of Array.isArray(candidate) ? candidate : [candidate]) {
    if (!scopeCovers(requested, item)) fail('E_SCOPE_NARROW', `scope "${item}" is not covered by the requested scope`)
  }
  return candidate
}

function resolveTtl(ttlMs) {
  if (ttlMs === undefined) return DEFAULT_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) fail('E_TTL', 'ttlMs must be a positive finite number of milliseconds')
  if (ttlMs > MAX_TTL_MS) fail('E_TTL', `ttlMs must not exceed ${MAX_TTL_MS} ms (30 days)`)
  return ttlMs
}

function resolveRequestTtl(ttlMs) {
  if (ttlMs === undefined) return REQUEST_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) fail('E_TTL', 'ttlMs must be a positive finite number of milliseconds')
  if (ttlMs > MAX_REQUEST_TTL_MS) fail('E_TTL', `request ttlMs must not exceed ${MAX_REQUEST_TTL_MS} ms (30 minutes)`)
  return ttlMs
}

function resolveWait(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_WAIT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) fail('E_WAIT', 'timeoutMs must be a non-negative finite number of milliseconds')
  return Math.min(timeoutMs, MAX_WAIT_MS)
}

/** Server-side use budget: an integer in 1..100; `fallback` is used when omitted. */
function resolveMaxUses(value, fallback = DEFAULT_MAX_USES) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_USES) {
    fail('E_MAX_USES', `maxUses must be an integer between 1 and ${MAX_USES}`)
  }
  return value
}

function cleanReason(value) {
  if (value === undefined) return ''
  if (typeof value !== 'string') fail('E_REASON', 'reason must be a string')
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (cleaned.length > MAX_REASON_LENGTH) fail('E_REASON', `reason must be at most ${MAX_REASON_LENGTH} characters`)
  return cleaned
}

/** RFC 8785-style canonical JSON (sorted object keys, no whitespace). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Binds an approval to the exact ask: scope, capability, subject, TTL and reason.
 * `maxUses` is bound only when it differs from the default one; this keeps 0.3
 * request hashes (and the standalone approvals CLI, which hashes the same five
 * fields) able to verify a default ask, while a raised budget cannot be edited
 * unnoticed.
 */
function hashRequest(request) {
  const ask = {
    subject: request.subject,
    capability: request.capability,
    scope: request.scope,
    ttlMs: request.ttlMs,
    reason: request.reason,
  }
  if (request.maxUses !== undefined && request.maxUses !== DEFAULT_MAX_USES) ask.maxUses = request.maxUses
  return createHash('sha256').update(canonical(ask)).digest('hex')
}

function validRequest(request) {
  if (!request || typeof request !== 'object') return false
  if (![request.id, request.subject, request.capability, request.requestHash].every(value => typeof value === 'string' && value !== '')) return false
  if (typeof request.reason !== 'string' || request.reason.length > MAX_REASON_LENGTH) return false
  if (!REQUEST_STATES.includes(request.status)) return false
  if (![request.createdAt, request.expiresAt, request.ttlMs].every(Number.isFinite) || request.ttlMs <= 0) return false
  if (!(typeof request.scope === 'string'
    || (Array.isArray(request.scope) && request.scope.length > 0 && request.scope.every(item => typeof item === 'string')))) return false
  if (request.maxUses !== undefined && (!Number.isInteger(request.maxUses) || request.maxUses < 1 || request.maxUses > MAX_USES)) return false
  if (request.grantId !== undefined && (typeof request.grantId !== 'string' || request.grantId === '')) return false
  return true
}

const clone = value => structuredClone(value)

function cloneEvidence(evidence) {
  if (evidence === undefined || evidence === null) return undefined
  try {
    return structuredClone(evidence)
  } catch {
    fail('E_EVIDENCE', 'evidence must be structured-cloneable')
  }
}

/** Reject persisted grants that cannot be interpreted safely (fail closed). */
function validGrant(grant) {
  if (!grant || typeof grant !== 'object') return false
  if (![grant.id, grant.subject, grant.capability, grant.approver].every(value => typeof value === 'string' && value !== '')) return false
  if (!GRANT_STATES.includes(grant.status)) return false
  if (!Number.isFinite(grant.createdAt) || (grant.expiresAt !== null && !Number.isFinite(grant.expiresAt))) return false
  if (grant.maxUses !== undefined && grant.maxUses !== null
    && (!Number.isInteger(grant.maxUses) || grant.maxUses < 1 || grant.maxUses > MAX_USES)) return false
  if (grant.uses !== undefined && (!Number.isInteger(grant.uses) || grant.uses < 0)) return false
  if (grant.lastUsedAt !== undefined && grant.lastUsedAt !== null && !Number.isFinite(grant.lastUsedAt)) return false
  return typeof grant.scope === 'string'
    || (Array.isArray(grant.scope) && grant.scope.length > 0 && grant.scope.every(scope => typeof scope === 'string'))
}

/**
 * Add the 0.4 use counters to a validated grant. A missing `maxUses` means the
 * grant was written by 0.3 (or by the standalone approvals CLI), when grants
 * were unlimited; Infinity preserves that behavior instead of retroactively
 * making it one-shot. `null` is the JSON form of Infinity.
 */
function normalizeGrant(grant) {
  if (grant.uses === undefined) grant.uses = 0
  if (grant.maxUses === undefined || grant.maxUses === null) grant.maxUses = Infinity
  if (grant.lastUsedAt === undefined) grant.lastUsedAt = grant.usedAt ?? null
  if (grant.maxUses !== Infinity && grant.status === 'active' && grant.uses >= grant.maxUses) grant.status = 'used'
  return grant
}

/** Persisted counters are advisory; when absent or malformed, derive them from the log. */
function loadCounts(value, audit) {
  const count = number => (Number.isSafeInteger(number) && number >= 0 ? number : 0)
  if (value && typeof value === 'object' && !Array.isArray(value)) return { allowed: count(value.allowed), denied: count(value.denied), security: count(value.security) }
  return audit.reduce((counts, entry) => {
    if (isCheck(entry?.event)) counts[entry.event] += 1
    else counts.security += 1
    return counts
  }, { allowed: 0, denied: 0, security: 0 })
}

/**
 * Durable-enough local state: an in-memory Map by default, or an atomically
 * written JSON file when `config.stateFile` is set.
 */
export class GrantStore {
  constructor(config = {}) {
    this.clock = typeof config.now === 'function' ? config.now : () => Date.now()
    this.stateFile = null
    if (config.stateFile !== undefined && config.stateFile !== null) {
      if (typeof config.stateFile !== 'string' || !config.stateFile.trim()) fail('E_STATE', 'stateFile must be a non-empty path string')
      this.stateFile = resolve(config.stateFile)
    }
    this.grants = new Map()
    this.requests = new Map()
    this.auditLog = []
    this.counts = { allowed: 0, denied: 0, security: 0 }
    this.nextSeq = 1
    if (this.stateFile) this.load()
  }

  now() {
    return this.clock()
  }

  load() {
    let raw
    try {
      raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      fail('E_STATE', `cannot read state file ${this.stateFile}: ${error.message}`)
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.grants) || !Array.isArray(raw.audit)) fail('E_STATE', `invalid state file ${this.stateFile}`)
    if (raw.version !== 1 && raw.version !== STATE_VERSION) fail('E_STATE', `unsupported state version ${String(raw.version)} in ${this.stateFile}`)
    // Unknown fields are tolerated; records that cannot be evaluated safely are
    // dropped so a corrupted file cannot create a permanent grant.
    for (const grant of raw.grants) if (validGrant(grant)) this.grants.set(grant.id, normalizeGrant(grant))
    for (const request of Array.isArray(raw.requests) ? raw.requests : []) {
      if (!validRequest(request) || hashRequest(request) !== request.requestHash) continue
      if (request.status === 'approved' && !this.grants.has(request.grantId)) continue
      this.requests.set(request.id, request)
    }
    // The standalone approvals CLI copies no maxUses onto its Grant. Adopt the
    // finite budget of the originating request so a one-use ask stays one-use
    // no matter which approver wrote the file; 0.3 requests have no maxUses and
    // therefore keep the legacy unlimited default.
    for (const grant of this.grants.values()) {
      if (grant.maxUses !== Infinity || typeof grant.requestId !== 'string') continue
      const request = this.requests.get(grant.requestId)
      if (request && Number.isInteger(request.maxUses)) {
        grant.maxUses = request.maxUses
        normalizeGrant(grant)
      }
    }
    this.auditLog = raw.audit.slice(-MAX_AUDIT_ENTRIES)
    this.counts = loadCounts(raw.counts, this.auditLog)
    this.trimAudit()
    this.nextSeq = this.auditLog.reduce((max, entry) => Math.max(max, Number(entry?.seq) || 0), 0) + 1
  }

  /** Re-read the state file so waits can observe an approval written by the CLI. */
  reload() {
    if (!this.stateFile) return
    this.grants.clear()
    this.requests.clear()
    this.load()
  }

  save() {
    if (!this.stateFile) return
    const body = JSON.stringify({
      version: STATE_VERSION,
      counts: this.counts,
      // JSON has no Infinity; null is the persisted form of "unlimited".
      grants: [...this.grants.values()].map(grant => (grant.maxUses === Infinity ? { ...grant, maxUses: null } : grant)),
      requests: [...this.requests.values()],
      audit: this.auditLog,
    }, null, 2) + '\n'
    const temp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    let fd
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      fd = openSync(temp, 'wx', 0o600)
      writeSync(fd, body)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, this.stateFile)
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      try { unlinkSync(temp) } catch {}
      fail('E_STATE', `cannot write state file ${this.stateFile}: ${error.message}`)
    }
  }

  /** Keep the newest check events, then evict check events before security events. */
  trimAudit() {
    let checks = this.auditLog.filter(entry => isCheck(entry?.event)).length
    while (checks > MAX_CHECK_AUDIT_ENTRIES) {
      this.auditLog.splice(this.auditLog.findIndex(entry => isCheck(entry?.event)), 1)
      checks -= 1
    }
    while (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      const at = this.auditLog.findIndex(entry => isCheck(entry?.event))
      this.auditLog.splice(at < 0 ? 0 : at, 1)
    }
  }

  record(event, grant, extra = {}) {
    const entry = { seq: this.nextSeq++, at: this.now(), event }
    if (grant) {
      entry.grantId = grant.id
      entry.subject = grant.subject
      entry.capability = grant.capability
      entry.scope = clone(grant.scope)
    }
    Object.assign(entry, extra)
    if (isCheck(event)) this.counts[event] += 1
    else this.counts.security += 1
    this.auditLog.push(entry)
    this.trimAudit()
    return entry
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const SCOPE_SCHEMA = {
  description: 'Granted scope: "*", an exact string, a "prefix:*" pattern, or an array of these.',
  anyOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' }, minItems: 1 },
  ],
}

function defineTool(name, description, properties, required, execute) {
  return { name, description, parameters: { type: 'object', additionalProperties: false, properties, required }, output: OUTPUT, execute }
}

/** Host seam `ctx.allow`: issue, check, revoke, list and audit grants. */
export function createTools(service, options = {}) {
  const tools = [
    defineTool('allow_issue',
      'Issue a revocable capability grant and return it. Grants expire (default 24h, max 30 days) and are unlimited by default.',
      {
        subject: { type: 'string', description: 'Who receives the grant, e.g. "agent:planner" or "plugin:dsh-act".' },
        capability: { type: 'string', description: 'Capability name, e.g. "fs.write" or "tool.invoke".' },
        scope: SCOPE_SCHEMA,
        ttlMs: { type: 'number', minimum: 1, maximum: MAX_TTL_MS, description: 'Lifetime in milliseconds (default 24h, max 30 days).' },
        maxUses: { type: 'integer', minimum: 1, maximum: MAX_USES, description: 'Successful checks allowed (1-100). Omit for the legacy unlimited grant.' },
        approver: { type: 'string', description: 'Who approved it (default "user").' },
      },
      ['subject', 'capability'],
      async args => service.issue(args)),
    defineTool('allow_check',
      'Check whether an active grant covers subject + capability + scope and consume one use. Does not throw when denied.',
      {
        subject: { type: 'string' },
        capability: { type: 'string' },
        scope: SCOPE_SCHEMA,
      },
      ['subject', 'capability', 'scope'],
      async args => service.check(args)),
    defineTool('allow_request',
      'Request a capability for a human to approve. Creates a pending request; it never grants anything.',
      {
        subject: { type: 'string', description: 'Who needs the capability, e.g. "agent:planner".' },
        capability: { type: 'string', description: 'Capability name, e.g. "fs.write".' },
        scope: SCOPE_SCHEMA,
        ttlMs: { type: 'number', minimum: 1, maximum: MAX_REQUEST_TTL_MS, description: 'How long the request stays pending (default 10m, max 30m).' },
        maxUses: { type: 'integer', minimum: 1, maximum: MAX_USES, description: 'Successful uses requested (default 1, max 100).' },
        reason: { type: 'string', maxLength: MAX_REASON_LENGTH, description: 'Why you need it; untrusted self-report, never used for a decision.' },
      },
      ['subject', 'capability'],
      async args => {
        const request = service.request(args)
        return {
          requestId: request.id, status: request.status, expiresAt: request.expiresAt,
          maxUses: request.maxUses, reason: request.reason,
          hint: `Ask a human to run: dsh-os approvals approve ${request.id} --by <name> --state <file>`,
        }
      }),
    defineTool('allow_wait',
      'Poll one request until it is decided or the timeout elapses; returns the current request state.',
      {
        requestId: { type: 'string', description: 'Request id returned by allow_request.' },
        timeoutMs: { type: 'number', minimum: 0, maximum: MAX_WAIT_MS, description: 'Maximum wait (default 5s, max 25s).' },
        subject: { type: 'string', description: 'Optional owner guard; another subject is reported as not found.' },
      },
      ['requestId'],
      async args => service.wait(args.requestId, { timeoutMs: args.timeoutMs, subject: args.subject })),
    defineTool('allow_requests',
      'List only the given subject\'s pending requests; there is no fleet-wide listing.',
      { subject: { type: 'string', description: 'Exact subject whose pending requests are returned.' } },
      ['subject'],
      async args => ({
        requests: service.requests({
          subject: text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH),
          status: 'pending',
        }),
      })),
    defineTool('allow_revoke',
      'Revoke one of the subject\'s grants by id; the subject must own the grant.',
      {
        id: { type: 'string', description: 'Grant id returned by allow_issue.' },
        subject: { type: 'string', description: 'Owner of the grant; must match the stored subject.' },
      },
      ['id', 'subject'],
      async args => service.revoke(args.id, {
        subject: text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH),
      })),
    defineTool('allow_list',
      'List one subject\'s grants. Subject is required so the tool cannot enumerate other subjects.',
      {
        subject: { type: 'string', description: 'Exact subject whose grants are returned.' },
        capability: { type: 'string' },
        status: { type: 'string', enum: ['active', 'revoked', 'expired', 'used'] },
        approver: { type: 'string' },
      },
      ['subject'],
      async args => ({
        grants: service.list({ ...args, subject: text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH) }),
      })),
    defineTool('allow_approve',
      'Human-only: approve a pending request and create its Grant in the same transaction. Scope may only narrow the request; maxUses defaults to 1 and may not exceed the request.',
      {
        id: { type: 'string', description: 'Request id returned by allow_request.' },
        by: { type: 'string', description: 'Human approver name recorded on the Grant.' },
        scope: SCOPE_SCHEMA,
        maxUses: { type: 'integer', minimum: 1, maximum: MAX_USES, description: 'Uses to grant (default 1; may not exceed the request maxUses).' },
      },
      ['id', 'by'],
      async args => service.approve(args)),
    defineTool('allow_deny',
      'Human-only: deny a pending request. Denial is terminal and idempotent.',
      {
        id: { type: 'string', description: 'Request id returned by allow_request.' },
        by: { type: 'string', description: 'Human approver name recorded on the decision.' },
        reason: { type: 'string', maxLength: MAX_REASON_LENGTH, description: 'Why the request was denied.' },
      },
      ['id', 'by', 'reason'],
      async args => service.deny(args)),
  ]
  // Issuing, approving, denying and listing every subject are human-facing
  // operations. Exposing them to the model would let an agent mint its own
  // Grant, so they stay off unless a human-facing client opts in.
  const publicTools = new Set(['allow_check', 'allow_request', 'allow_wait', 'allow_requests'])
  return options.exposeAdminTools === true
    ? tools
    : tools.filter(tool => publicTools.has(tool.name))
}

/** Mount the service at `ctx.allow`; model tools can only request and check. */

export {
  fail, text, objectInput, normalizeScope, scopeCovers, narrowScope,
  resolveTtl, resolveRequestTtl, resolveWait, resolveMaxUses, cleanReason, canonical,
  hashRequest, validRequest, clone, cloneEvidence, validGrant, normalizeGrant, loadCounts, isCheck, REQUEST_FIELDS,
}
