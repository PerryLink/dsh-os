/**
 * dsh-allow — Revocable capability grants and an audit-ready permission center
 * for DeepSeek Harness.
 *
 * This is a control plane, not a sandbox: it records and answers out-of-turn
 * authorization questions. It cannot stop same-process code from bypassing it.
 * @module dsh-allow
 */

import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  DEFAULT_TTL_MS, MAX_TTL_MS, MAX_SUBJECT_LENGTH, MAX_CAPABILITY_LENGTH,
  MAX_SCOPE_LENGTH, MAX_APPROVER_LENGTH, MAX_AUDIT_ENTRIES,
  MAX_CHECK_AUDIT_ENTRIES, REQUEST_TTL_MS, MAX_REQUEST_TTL_MS,
  DEFAULT_WAIT_MS, MAX_WAIT_MS, MAX_REASON_LENGTH, REQUEST_STATES,
  GrantStore, createTools, fail, text, objectInput, normalizeScope,
  scopeCovers, narrowScope, resolveTtl, resolveRequestTtl, resolveWait,
  cleanReason, canonical, hashRequest, validRequest, clone, cloneEvidence,
  validGrant, loadCounts, isCheck, REQUEST_FIELDS,
} from './lib/core.js'

export {
  DEFAULT_TTL_MS, MAX_TTL_MS, MAX_SUBJECT_LENGTH, MAX_CAPABILITY_LENGTH,
  MAX_SCOPE_LENGTH, MAX_APPROVER_LENGTH, MAX_AUDIT_ENTRIES,
  MAX_CHECK_AUDIT_ENTRIES, REQUEST_TTL_MS, MAX_REQUEST_TTL_MS,
  DEFAULT_WAIT_MS, MAX_WAIT_MS, MAX_REASON_LENGTH, REQUEST_STATES,
  GrantStore, createTools, isCheck, REQUEST_FIELDS,
} from './lib/core.js'

/** Cordis plugin name. */
export const name = 'dsh-allow'

/** The bundle needs the host tool registry to expose its agent tools. */
export const inject = ['tools']


export class AllowService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.store = new GrantStore(config)
  }

  /** Mark elapsed grants and pending requests as expired, one audit event each. */
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
    for (const request of this.store.requests.values()) {
      if (request.status !== 'pending') continue
      const elapsed = request.expiresAt <= now
      const clockRollback = now < request.createdAt
      if (!elapsed && !clockRollback) continue
      request.status = 'expired'
      this.store.record('request-expired', null, {
        requestId: request.id, subject: request.subject, capability: request.capability,
        scope: clone(request.scope), requestHash: request.requestHash,
      })
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

  /** Model-callable: create a pending Request. It never issues a Grant itself. */
  request(input = {}) {
    const args = objectInput(input)
    for (const key of Object.keys(args)) {
      if (!REQUEST_FIELDS.has(key)) fail('E_PRIVILEGED', `${key} is assigned by the server and cannot be requested`)
    }
    const subject = text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    const capability = text(args.capability, 'capability', 'E_CAPABILITY', MAX_CAPABILITY_LENGTH)
    const scope = normalizeScope(args.scope)
    const ttlMs = resolveRequestTtl(args.ttlMs)
    const reason = cleanReason(args.reason)
    const now = this.store.now()
    const request = {
      id: `req_${randomUUID()}`, subject, capability, scope, ttlMs, reason,
      status: 'pending', createdAt: now, expiresAt: now + ttlMs, requestHash: '',
    }
    request.requestHash = hashRequest(request)
    this.store.requests.set(request.id, request)
    this.store.record('requested', null, {
      requestId: request.id, subject, capability, scope: clone(scope),
      requestHash: request.requestHash, expiresAt: request.expiresAt,
    })
    try {
      this.store.save()
    } catch (error) {
      this.store.requests.delete(request.id)
      throw error
    }
    return clone(request)
  }
  #request(id, subject = null) {
    const request = this.store.requests.get(id)
    if (!request || (subject !== null && request.subject !== subject)) fail('E_REQUEST_NOT_FOUND', `unknown request: ${id}`)
    return request
  }

  #verified(request) {
    if (hashRequest(request) !== request.requestHash) fail('E_REQUEST_HASH', 'request content does not match its requestHash')
    return request
  }
  /** Human-only: approve and create the Grant in the same save. Idempotent. */
  approve(input = {}) {
    const args = objectInput(input)
    for (const key of Object.keys(args)) {
      if (key !== 'id' && key !== 'by' && key !== 'scope') fail('E_INPUT', `unknown approve field: ${key}`)
    }
    const id = text(args.id, 'request id', 'E_ID', 128)
    const by = text(args.by, 'by', 'E_APPROVER', MAX_APPROVER_LENGTH)
    this.sweep()
    const request = this.#verified(this.#request(id))
    if (request.status === 'approved') {
      const grant = this.store.grants.get(request.grantId)
      if (!grant) fail('E_STATE', 'approved request has no grant')
      return { request: clone(request), grant: clone(grant) }
    }
    if (request.status === 'denied') fail('E_REQUEST_DENIED', 'request was denied')
    if (request.status === 'expired') fail('E_REQUEST_EXPIRED', 'request expired')
    const now = this.store.now()
    const scope = args.scope === undefined ? clone(request.scope) : narrowScope(request.scope, args.scope)
    const grant = {
      id: `grant_${randomUUID()}`, subject: request.subject, capability: request.capability,
      scope, status: 'active', createdAt: now, expiresAt: now + DEFAULT_TTL_MS,
      approver: by, requestId: request.id, requestHash: request.requestHash,
    }
    const before = clone(request)
    Object.assign(request, { status: 'approved', grantId: grant.id, decidedBy: by, decidedAt: now })
    this.store.grants.set(grant.id, grant)
    this.store.record('request-approved', grant, { requestId: request.id, by, requestHash: request.requestHash })
    this.store.record('issued', grant, { approver: by, requestId: request.id, requestHash: request.requestHash })
    try {
      this.store.save()
    } catch (error) {
      this.store.grants.delete(grant.id)
      this.store.requests.set(request.id, before)
      throw error
    }
    return { request: clone(request), grant: clone(grant) }
  }

  /** Human-only: deny a pending request. Denial is terminal and idempotent. */
  deny(input = {}) {
    const args = objectInput(input)
    for (const key of Object.keys(args)) {
      if (key !== 'id' && key !== 'by' && key !== 'reason') fail('E_INPUT', `unknown deny field: ${key}`)
    }
    const id = text(args.id, 'request id', 'E_ID', 128)
    const by = text(args.by, 'by', 'E_APPROVER', MAX_APPROVER_LENGTH)
    const reason = cleanReason(args.reason)
    if (!reason) fail('E_REASON', 'reason must not be empty')
    this.sweep()
    const request = this.#verified(this.#request(id))
    if (request.status === 'denied') return { request: clone(request) }
    if (request.status === 'approved') fail('E_REQUEST_APPROVED', 'request was already approved')
    if (request.status === 'expired') fail('E_REQUEST_EXPIRED', 'request expired')
    const now = this.store.now()
    const before = clone(request)
    Object.assign(request, { status: 'denied', denyReason: reason, decidedBy: by, decidedAt: now })
    this.store.record('request-denied', null, {
      requestId: request.id, subject: request.subject, capability: request.capability,
      scope: clone(request.scope), by, reason,
    })
    try {
      this.store.save()
    } catch (error) {
      this.store.requests.set(request.id, before)
      throw error
    }
    return { request: clone(request) }
  }

  /** Newest-last request snapshots, optionally filtered by exact status/subject. */
  requests(filter = {}) {
    if (filter === undefined || filter === null) filter = {}
    if (typeof filter !== 'object' || Array.isArray(filter)) fail('E_FILTER', 'filter must be an object')
    if (filter.status !== undefined && !REQUEST_STATES.includes(filter.status)) fail('E_STATUS', `status must be one of ${REQUEST_STATES.join(', ')}`)
    const subject = filter.subject === undefined ? null : text(filter.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    this.sweep()
    return [...this.store.requests.values()]
      .filter(request => (filter.status === undefined || request.status === filter.status)
        && (subject === null || request.subject === subject))
      .map(request => clone(request))
  }

  /** Poll one request until decided or `timeoutMs` elapses; never blocks forever. */
  async wait(id, options = {}) {
    const requestId = text(id, 'request id', 'E_ID', 128)
    const args = objectInput(options)
    const timeoutMs = resolveWait(args.timeoutMs)
    const subject = args.subject === undefined ? null : text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.store.reload()
      this.sweep()
      const request = this.#request(requestId, subject)
      if (request.status !== 'pending' || Date.now() >= deadline) return clone(request)
      await delay(Math.max(1, Math.min(50, deadline - Date.now())))
    }
  }

  check(input = {}) {
    const args = objectInput(input)
    const subject = text(args.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    const capability = text(args.capability, 'capability', 'E_CAPABILITY', MAX_CAPABILITY_LENGTH)
    const requestedScope = args.scope === undefined ? null : normalizeScope(args.scope)
    const requested = requestedScope === null ? null : (Array.isArray(requestedScope) ? requestedScope : [requestedScope])
    const now = this.sweep()
    const candidates = [...this.store.grants.values()].filter(grant => grant.subject === subject && grant.capability === capability)
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

  /**
   * Revoke a grant by id. `options.subject` is optional for trusted service
   * callers; when given it must match the grant owner.
   */
  revoke(id, options = {}) {
    const grantId = text(id, 'grant id', 'E_ID', 128)
    const grant = this.store.grants.get(grantId)
    if (!grant) fail('E_GRANT_NOT_FOUND', `unknown grant: ${grantId}`)
    const subject = options?.subject === undefined
      ? null
      : text(options.subject, 'subject', 'E_SUBJECT', MAX_SUBJECT_LENGTH)
    if (subject !== null && grant.subject !== subject) {
      fail('E_SUBJECT_MISMATCH', 'grant does not belong to this subject')
    }
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

  /** Cumulative event totals plus what the retained log still holds. */
  auditStats() {
    const retained = { allowed: 0, denied: 0, security: 0 }
    for (const entry of this.store.auditLog) {
      if (isCheck(entry?.event)) retained[entry.event] += 1
      else retained.security += 1
    }
    return { totals: { ...this.store.counts }, retained: { ...retained, entries: this.store.auditLog.length },
      limits: { entries: MAX_AUDIT_ENTRIES, checkEntries: MAX_CHECK_AUDIT_ENTRIES } }
  }
}

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
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
