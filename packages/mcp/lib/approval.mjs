import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export const TOKEN_TTL_MS = 5 * 60 * 1000
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_RECORDS = 128
const MAX_STORE_BYTES = 4 * 1024 * 1024
const sha256 = value => createHash('sha256').update(value).digest('hex')
export const newId = prefix => `${prefix}_${randomBytes(9).toString('hex')}`
export const argsHash = args => sha256(canonical(args ?? {}))
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** Constant-time comparison; empty or non-string secrets never match. */
export function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
}

/**
 * Pending approval store. Memory-backed by default; pass `file` to share
 * requests with the --approve CLI across processes. Tokens are stored only as
 * SHA-256 hashes and are consumed atomically.
 */
export function createApprovalStore({ file = null, now = () => Date.now() } = {}) {
  const load = () => {
    if (file === null || !existsSync(file)) return {}
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_STORE_BYTES) throw new Error(`request store ${file} must be a file under ${MAX_STORE_BYTES} bytes`)
    try {
      const requests = JSON.parse(readFileSync(file, 'utf8'))?.requests
      if (requests === null || typeof requests !== 'object' || Array.isArray(requests)) throw new Error('missing "requests" object')
      return requests
    } catch (error) { throw new Error(`invalid request store ${file}: ${error.message}`) }
  }
  let records = load()
  const refresh = () => { if (file !== null) records = load() }
  const persist = () => {
    if (file === null) return
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, requests: records }, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const expire = record => {
    if (record.status === 'pending' && now() > record.expiresAt) record.status = 'expired'
    if (record.status === 'approved' && record.tokenExpiresAt !== undefined && now() > record.tokenExpiresAt) record.status = 'expired'
    return record
  }
  const prune = () => {
    for (const id of Object.keys(records).sort((a, b) => records[a].createdAt - records[b].createdAt)) {
      if (Object.keys(records).length <= MAX_RECORDS) break
      delete records[id]
    }
  }
  const get = id => { refresh(); return records[id] === undefined ? null : expire(records[id]) }
  const list = () => { refresh(); return Object.values(records).map(expire) }
  const create = ({ capability, args, reason = '' }) => {
    refresh()
    const hash = argsHash(args)
    const existing = Object.values(records).find(record => record.capability === capability && record.argsHash === hash && (record.status === 'pending' || (record.status === 'approved' && record.tokenHash !== undefined && record.usedAt === undefined)))
    if (existing !== undefined && expire(existing).status !== 'expired') return { record: existing, created: false }
    const record = { id: newId('req'), capability, args, argsHash: hash, reason, status: 'pending', createdAt: now(), expiresAt: now() + PENDING_TTL_MS }
    records[record.id] = record
    prune()
    persist()
    return { record, created: true }
  }
  const approve = (id, approver = 'admin') => {
    const record = get(id)
    if (record !== null && record.status === 'pending') { record.status = 'approved'; record.approvedAt = now(); record.approver = approver; persist() }
    return record
  }
  const deny = (id, approver = 'admin') => {
    const record = get(id)
    if (record !== null && (record.status === 'pending' || record.status === 'approved')) { record.status = 'denied'; record.deniedAt = now(); record.approver = approver; delete record.tokenHash; delete record.tokenExpiresAt; persist() }
    return record
  }
  const issue = id => {
    const record = get(id)
    if (record === null) return null
    if (record.status !== 'approved' || record.tokenHash !== undefined) return { record, token: null }
    const token = `dshat_${randomBytes(24).toString('base64url')}`
    record.tokenHash = sha256(token)
    record.tokenIssuedAt = now()
    record.tokenExpiresAt = now() + TOKEN_TTL_MS
    persist()
    return { record, token }
  }
  const consume = (token, capability, hash) => {
    refresh()
    if (typeof token !== 'string' || !token.startsWith('dshat_')) return { ok: false, code: 'token_invalid' }
    const record = Object.values(records).find(candidate => candidate.tokenHash === sha256(token))
    if (record === undefined) return { ok: false, code: 'token_invalid' }
    expire(record)
    if (record.usedAt !== undefined) return { ok: false, code: 'token_used', requestId: record.id }
    if (record.status !== 'approved' || record.tokenExpiresAt === undefined || now() > record.tokenExpiresAt) return { ok: false, code: 'token_expired', requestId: record.id }
    if (record.capability !== capability || record.argsHash !== hash) return { ok: false, code: 'token_mismatch', requestId: record.id }
    record.status = 'used'
    record.usedAt = now()
    persist()
    return { ok: true, record }
  }
  const view = ({ id, capability, argsHash, reason, status, createdAt, expiresAt, approvedAt, approver, tokenExpiresAt, usedAt }) => ({ requestId: id, capability, argsHash, reason, status, createdAt, expiresAt, approvedAt, approver, tokenExpiresAt, usedAt })
  return { get, list, create, approve, deny, issue, consume, view, ttlMs: TOKEN_TTL_MS }
}
