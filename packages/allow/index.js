/**
 * dsh-allow — Revocable capability grants and an audit-ready permission center
 * for DeepSeek Harness.
 *
 * This is a control plane, not a sandbox: it records and answers out-of-turn
 * authorization questions. It cannot stop same-process code from bypassing it.
 * @module dsh-allow
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-allow'

/** The bundle needs the host tool registry to expose its agent tools. */
export const inject = ['tools']

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_SUBJECT_LENGTH = 256, MAX_CAPABILITY_LENGTH = 256, MAX_SCOPE_LENGTH = 512, MAX_APPROVER_LENGTH = 128
export const MAX_AUDIT_ENTRIES = 2000
const STATE_VERSION = 1

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

function objectInput(value) {  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('E_INPUT', 'input must be an object')
  }
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

function resolveTtl(ttlMs) {
  if (ttlMs === undefined) return DEFAULT_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    fail('E_TTL', 'ttlMs must be a positive finite number of milliseconds')
  }
  if (ttlMs > MAX_TTL_MS) fail('E_TTL', `ttlMs must not exceed ${MAX_TTL_MS} ms (30 days)`)
  return ttlMs
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

/**
 * Durable-enough local state: an in-memory Map by default, or an atomically
 * written JSON file when `config.stateFile` is set.
 */
/** Reject persisted grants that cannot be interpreted safely (fail closed). */
function validGrant(grant) {
  if (!grant || typeof grant !== 'object') return false
  if (typeof grant.id !== 'string' || grant.id === '') return false
  if (typeof grant.subject !== 'string' || grant.subject === '') return false
  if (typeof grant.capability !== 'string' || grant.capability === '') return false
  if (!['active', 'revoked', 'expired'].includes(grant.status)) return false
  if (!Number.isFinite(grant.createdAt)) return false
  if (grant.expiresAt !== null && !Number.isFinite(grant.expiresAt)) return false
  const scopeOk = typeof grant.scope === 'string'
    || (Array.isArray(grant.scope) && grant.scope.length > 0 && grant.scope.every(scope => typeof scope === 'string'))
  if (!scopeOk) return false
  if (typeof grant.approver !== 'string' || grant.approver === '') return false
  return true
}

export class GrantStore {
  constructor(config = {}) {
    this.clock = typeof config.now === 'function' ? config.now : () => Date.now()
    this.stateFile = null
    if (config.stateFile !== undefined && config.stateFile !== null) {
      if (typeof config.stateFile !== 'string' || !config.stateFile.trim()) {
        fail('E_STATE', 'stateFile must be a non-empty path string')
      }
      this.stateFile = resolve(config.stateFile)
    }
    this.grants = new Map()
    this.auditLog = []
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
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.grants) || !Array.isArray(raw.audit)) {
      fail('E_STATE', `invalid state file ${this.stateFile}`)
    }
    if (raw.version !== STATE_VERSION) {
      fail('E_STATE', `unsupported state version ${String(raw.version)} in ${this.stateFile}`)
    }
    for (const grant of raw.grants) {
      // Unknown fields are tolerated; records that cannot be evaluated safely
      // are dropped so a corrupted file cannot create a permanent grant.
      if (validGrant(grant)) this.grants.set(grant.id, grant)
    }
    this.auditLog = raw.audit.slice(-MAX_AUDIT_ENTRIES)
    this.nextSeq = this.auditLog.reduce((max, entry) => Math.max(max, Number(entry?.seq) || 0), 0) + 1
  }

  save() {
    if (!this.stateFile) return
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const temp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    const body = JSON.stringify({
      version: STATE_VERSION,
      grants: [...this.grants.values()],
      audit: this.auditLog,
    }, null, 2) + '\n'
    try {
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.stateFile)
    } catch (error) {
      try { unlinkSync(temp) } catch {}
      fail('E_STATE', `cannot write state file ${this.stateFile}: ${error.message}`)
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
    this.auditLog.push(entry)
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog.splice(0, this.auditLog.length - MAX_AUDIT_ENTRIES)
    }
    return entry
  }
}

/** Host seam `ctx.allow`: issue, check, revoke, list and audit grants. */
export class AllowService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.store = new GrantStore(config)
  }

  /** Mark elapsed grants as expired and write one audit event per transition. */
  sweep() {
    const now = this.store.now()
    let changed = false
    for (const grant of this.store.grants.values()) {
      if (grant.status !== 'active') continue
      const elapsed = typeof grant.expiresAt === 'number' && grant.expiresAt <= now
      const clockRollback = typeof grant.createdAt === 'number' && now < grant.createdAt
      if (!elapsed && !clockRollback) continue
      grant.status = 'expired'
      this.store.record('expired', grant)
      changed = true
    }
    if (changed) this.store.save()
    return now
  }

  issue(input = {}) {
    const args = objectInput(input)
    const subject = text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    const capability = text(args.capability, 'capability', 'E_CAPABILITY', MAX_CAPABILITY_LENGTH)
    const scope = normalizeScope(args.scope)
    const approver = args.approver === undefined
      ? 'user'
      : text(args.approver, 'approver', 'E_APPROVER', MAX_APPROVER_LENGTH)
    const ttlMs = resolveTtl(args.ttlMs)
    const evidence = cloneEvidence(args.evidence)
    const now = this.store.now()
    const grant = {
      id: `grant_${randomUUID()}`,
      subject,
      capability,
      scope,
      status: 'active',
      createdAt: now,
      expiresAt: now + ttlMs,
      approver,
    }
    if (evidence !== undefined) grant.evidence = evidence
    this.store.grants.set(grant.id, grant)
    this.store.record('issued', grant, { approver, expiresAt: grant.expiresAt })
    try {
      this.store.save()
    } catch (error) {
      this.store.grants.delete(grant.id)
      throw error
    }
    return clone(grant)
  }

  check(input = {}) {
    const args = objectInput(input)
    const subject = text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    const capability = text(args.capability, 'capability', 'E_CAPABILITY', MAX_CAPABILITY_LENGTH)
    const requestedScope = args.scope === undefined ? null : normalizeScope(args.scope)
    const requested = requestedScope === null ? null : (Array.isArray(requestedScope) ? requestedScope : [requestedScope])
    const now = this.sweep()
    const candidates = [...this.store.grants.values()]
      .filter(grant => grant.subject === subject && grant.capability === capability)
    const active = candidates.filter(grant => grant.status === 'active')
    const matched = active.find(grant => requested === null
      || requested.every(scope => scopeCovers(grant.scope, scope)))

    if (matched) {
      matched.usedAt = now
      this.store.record('allowed', matched)
      return { allowed: true, grant: clone(matched), reason: 'allowed' }
    }

    const expired = candidates.find(grant => grant.status === 'expired')
    const revoked = candidates.find(grant => grant.status === 'revoked')
    let reason = 'no-grant'
    let grant
    if (active.length > 0) {
      reason = 'scope-mismatch'
      grant = active[0]
    } else if (expired) {
      reason = 'expired'
      grant = expired
    } else if (revoked) {
      reason = 'revoked'
      grant = revoked
    }
    this.store.record('denied', null, {
      subject,
      capability,
      scope: requested === null ? '*' : clone(requestedScope),
      reason,
      ...(grant ? { grantId: grant.id } : {}),
    })
    return grant
      ? { allowed: false, grant: clone(grant), reason }
      : { allowed: false, reason }
  }

  revoke(id) {
    const grantId = text(id, 'grant id', 'E_ID', 128)
    const grant = this.store.grants.get(grantId)
    if (!grant) fail('E_GRANT_NOT_FOUND', `unknown grant: ${grantId}`)
    this.sweep()
    if (grant.status !== 'active') return clone(grant)
    const previous = grant.status
    grant.status = 'revoked'
    this.store.record('revoked', grant)
    try {
      this.store.save()
    } catch (error) {
      grant.status = previous
      throw error
    }
    return clone(grant)
  }

  list(filter = {}) {
    if (filter === undefined || filter === null) filter = {}
    if (typeof filter !== 'object' || Array.isArray(filter)) fail('E_FILTER', 'filter must be an object')
    this.sweep()
    const results = []
    for (const grant of this.store.grants.values()) {
      if (filter.subject !== undefined && grant.subject !== filter.subject) continue
      if (filter.capability !== undefined && grant.capability !== filter.capability) continue
      if (filter.status !== undefined && grant.status !== filter.status) continue
      if (filter.approver !== undefined && grant.approver !== filter.approver) continue
      results.push(clone(grant))
    }
    return results
  }

  /** Newest-first audit events, capped by `limit` (default 100). */
  audit(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) fail('E_LIMIT', 'limit must be a positive integer')
    return this.store.auditLog.slice(-limit).reverse().map(entry => clone(entry))
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

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service, options = {}) {
  const tools = [
    {
      name: 'allow_issue',
      description: 'Issue a revocable capability grant and return it. Grants expire (default 24h, max 30 days).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string', description: 'Who receives the grant, e.g. "agent:planner" or "plugin:dsh-act".' },
          capability: { type: 'string', description: 'Capability name, e.g. "fs.write" or "tool.invoke".' },
          scope: SCOPE_SCHEMA,
          ttlMs: { type: 'number', minimum: 1, maximum: MAX_TTL_MS, description: 'Lifetime in milliseconds (default 24h, max 30 days).' },
          approver: { type: 'string', description: 'Who approved it (default "user").' },
        },
        required: ['subject', 'capability'],
      },
      output: OUTPUT,
      async execute(args) {
        return service.issue(args)
      },
    },
    {
      name: 'allow_check',
      description: 'Check whether an active grant covers subject + capability + scope. Does not throw when denied.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          capability: { type: 'string' },
          scope: SCOPE_SCHEMA,
        },
        required: ['subject', 'capability', 'scope'],
      },
      output: OUTPUT,
      async execute(args) {
        return service.check(args)
      },
    },
    {
      name: 'allow_revoke',
      description: 'Revoke a grant by id. Idempotent for grants that are already revoked or expired.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Grant id returned by allow_issue.' },
        },
        required: ['id'],
      },
      output: OUTPUT,
      async execute(args) {
        return service.revoke(args.id)
      },
    },
    {
      name: 'allow_list',
      description: 'List grants, optionally filtered by exact subject, capability, status or approver.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          capability: { type: 'string' },
          status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
          approver: { type: 'string' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        return { grants: service.list(args) }
      },
    },
  ]
  // Issuing, revoking and listing every subject are human-facing operations.
  // Exposing them to the model would let an agent mint its own Grant and
  // bypass Act's write gate, so they stay off unless a human-facing client
  // explicitly opts in.
  return options.exposeAdminTools === true
    ? tools
    : tools.filter(tool => tool.name === 'allow_check')
}

/** Mount the service at `ctx.allow`; only the read-only check tool is public. */
export function apply(ctx, config = {}) {
  const service = new AllowService(ctx, config)
  ctx.provide('allow', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service, { exposeAdminTools: config.exposeAdminTools === true })) {
      ctx.tools.register(tool)
    }
  }
  return service
}
