import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseOptions } from './args.mjs'

// Human side of the Allow request protocol. Reads/writes the same v2 state file
// as dsh-allow. Standalone by design: no plugin dependency, no process, no shell.
const STATES = ['pending', 'approved', 'denied', 'expired']
const GRANT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_AUDIT_ENTRIES = 2000
const MAX_NAME_LENGTH = 128
const MAX_REASON_LENGTH = 280

export const APPROVALS_HELP = `dsh-os approvals - decide out-of-turn Allow requests

Usage:
  dsh-os approvals list [--state <file>] [--status <pending|approved|denied|expired>] [--subject <id>] [--json]
  dsh-os approvals approve <request-id> --by <name> [--state <file>]
  dsh-os approvals deny <request-id> --reason <text> [--by <name>] [--state <file>]

Options:
  --state     Allow stateFile JSON (default: $DSH_OS_ALLOW_STATE)
  --json      machine-readable list output
  -h, --help  show this help

Approval creates the Grant in the same state-file write and binds it to the
request hash. Approval scope always equals the requested scope; widening is
rejected. Only the given state file is written: no profile, session or shell.
`

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}
function name(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail('E_USAGE', `${field} must not be empty`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_NAME_LENGTH) fail('E_USAGE', `${field} must be at most ${MAX_NAME_LENGTH} characters`)
  return trimmed
}
function reason(value) {
  if (typeof value !== 'string') fail('E_USAGE', '--reason must be a string')
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!cleaned) fail('E_USAGE', '--reason must not be empty')
  if (cleaned.length > MAX_REASON_LENGTH) fail('E_USAGE', `--reason must be at most ${MAX_REASON_LENGTH} characters`)
  return cleaned
}
/** Must match `hashRequest` in packages/allow/index.js. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function hashRequest(request) {
  return createHash('sha256').update(canonical({
    subject: request.subject, capability: request.capability, scope: request.scope,
    ttlMs: request.ttlMs, reason: request.reason,
  })).digest('hex')
}
function usable(request) {
  if (!request || typeof request !== 'object') return false
  if (![request.id, request.subject, request.capability, request.requestHash].every(value => typeof value === 'string' && value !== '')) return false
  if (!STATES.includes(request.status) || typeof request.reason !== 'string') return false
  if (![request.createdAt, request.expiresAt, request.ttlMs].every(Number.isFinite)) return false
  return typeof request.scope === 'string'
    || (Array.isArray(request.scope) && request.scope.length > 0 && request.scope.every(item => typeof item === 'string'))
}
function countAudit(audit) {
  return audit.reduce((counts, entry) => {
    if (entry?.event === 'allowed' || entry?.event === 'denied') counts[entry.event] += 1
    else counts.security += 1
    return counts
  }, { allowed: 0, denied: 0, security: 0 })
}
function statePath(options, env) {
  const value = options.state ?? env.DSH_OS_ALLOW_STATE
  if (typeof value !== 'string' || !value.trim()) fail('E_USAGE', 'approvals requires --state <file> (or DSH_OS_ALLOW_STATE)')
  return resolve(value)
}
function load(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail('E_STATE', `cannot read Allow state file ${file}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`)
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.grants) || !Array.isArray(raw.audit)) fail('E_STATE', `invalid Allow state file ${file}`)
  if (raw.version !== 1 && raw.version !== 2) fail('E_STATE', `unsupported Allow state version ${String(raw.version)} in ${file}`)
  const counts = raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
    ? { allowed: Number(raw.counts.allowed) || 0, denied: Number(raw.counts.denied) || 0, security: Number(raw.counts.security) || 0 }
    : countAudit(raw.audit)
  return {
    version: 2, grants: raw.grants, counts,
    requests: (Array.isArray(raw.requests) ? raw.requests : []).filter(usable),
    audit: raw.audit,
  }
}
function save(file, state) {
  state.audit = state.audit.slice(-MAX_AUDIT_ENTRIES)
  const body = `${JSON.stringify({
    version: 2, counts: state.counts, grants: state.grants, requests: state.requests, audit: state.audit,
  }, null, 2)}\n`
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    mkdirSync(dirname(file), { recursive: true })
    fd = openSync(temp, 'wx', 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { unlinkSync(temp) } catch {}
    fail('E_STATE', `cannot write Allow state file ${file}: ${error.message}`)
  }
}
function event(state, at, name, extra) {
  const seq = state.audit.reduce((max, entry) => Math.max(max, Number(entry?.seq) || 0), 0) + 1
  state.audit.push({ seq, at, event: name, ...extra })
  state.counts.security += 1
}
function sweep(state, now) {
  let changed = false
  for (const request of state.requests) {
    if (request.status !== 'pending') continue
    if (request.expiresAt > now && now >= request.createdAt) continue
    request.status = 'expired'
    event(state, now, 'request-expired', {
      requestId: request.id, subject: request.subject, capability: request.capability,
      scope: request.scope, requestHash: request.requestHash,
    })
    changed = true
  }
  return changed
}
function find(state, id) {
  const request = state.requests.find(item => item.id === id)
  if (!request) fail('E_REQUEST_NOT_FOUND', `unknown request: ${id}`)
  if (hashRequest(request) !== request.requestHash) fail('E_REQUEST_HASH', `request ${id} does not match its requestHash`)
  return request
}
function alreadyApproved(state, request, changed, file) {
  const grant = state.grants.find(item => item?.id === request.grantId)
  if (!grant) fail('E_STATE', `approved request ${request.id} has no grant`)
  if (changed) save(file, state)
  return { request, grant }
}
export function approve(file, id, by, now = Date.now()) {
  const state = load(file)
  const changed = sweep(state, now)
  const request = find(state, id)
  if (request.status === 'approved') return alreadyApproved(state, request, changed, file)
  if (request.status === 'denied') fail('E_REQUEST_DENIED', `request ${id} was denied`)
  if (request.status === 'expired') {
    if (changed) save(file, state)
    fail('E_REQUEST_EXPIRED', `request ${id} expired`)
  }
  const grant = {
    id: `grant_${randomUUID()}`, subject: request.subject, capability: request.capability,
    scope: request.scope, status: 'active', createdAt: now, expiresAt: now + GRANT_TTL_MS,
    approver: by, requestId: request.id, requestHash: request.requestHash,
  }
  Object.assign(request, { status: 'approved', grantId: grant.id, decidedBy: by, decidedAt: now })
  state.grants.push(grant)
  event(state, now, 'request-approved', {
    requestId: request.id, subject: request.subject, capability: request.capability,
    scope: request.scope, by, requestHash: request.requestHash, grantId: grant.id,
  })
  event(state, now, 'issued', {
    grantId: grant.id, subject: grant.subject, capability: grant.capability,
    scope: grant.scope, approver: by, requestId: request.id, requestHash: grant.requestHash,
  })
  save(file, state)
  return { request, grant }
}
export function deny(file, id, by, why, now = Date.now()) {
  const state = load(file)
  const changed = sweep(state, now)
  const request = find(state, id)
  if (request.status === 'denied') {
    if (changed) save(file, state)
    return { request }
  }
  if (request.status === 'approved') fail('E_REQUEST_APPROVED', `request ${id} was already approved`)
  if (request.status === 'expired') {
    if (changed) save(file, state)
    fail('E_REQUEST_EXPIRED', `request ${id} expired`)
  }
  Object.assign(request, { status: 'denied', denyReason: why, decidedBy: by, decidedAt: now })
  event(state, now, 'request-denied', {
    requestId: request.id, subject: request.subject, capability: request.capability,
    scope: request.scope, by, reason: why,
  })
  save(file, state)
  return { request }
}
export function list(file, { status, subject } = {}, now = Date.now()) {
  if (status !== undefined && !STATES.includes(status)) fail('E_USAGE', `--status must be one of ${STATES.join(', ')}`)
  const state = load(file)
  if (sweep(state, now)) save(file, state)
  return state.requests.filter(request => (status === undefined || request.status === status)
    && (subject === undefined || request.subject === subject))
}
function table(requests) {
  if (requests.length === 0) return 'No requests.\n'
  const headers = ['ID', 'STATUS', 'SUBJECT', 'CAPABILITY', 'SCOPE', 'EXPIRES']
  const rows = requests.map(request => [
    request.id, request.status, request.subject, request.capability,
    Array.isArray(request.scope) ? request.scope.join(',') : request.scope,
    new Date(request.expiresAt).toISOString(),
  ])
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)))
  const render = row => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ').trimEnd()
  return `${[headers, ...rows].map(render).join('\n')}\n`
}
export function runApprovals(args, io) {
  const { stdout, env = process.env } = io
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
    stdout.write(APPROVALS_HELP)
    return 0
  }
  if (subcommand === 'list') {
    const { options, positional } = parseOptions(rest, { flags: ['json'], values: ['state', 'status', 'subject'] })
    if (options.help) { stdout.write(APPROVALS_HELP); return 0 }
    if (positional.length > 0) throw new Error('approvals list does not take positional arguments')
    const requests = list(statePath(options, env), { status: options.status, subject: options.subject })
    stdout.write(options.json ? `${JSON.stringify(requests, null, 2)}\n` : table(requests))
    return 0
  }
  if (subcommand === 'approve' || subcommand === 'deny') {
    const isApprove = subcommand === 'approve'
    const { options, positional } = parseOptions(rest, { values: ['state', 'by', 'reason'] })
    if (options.help) { stdout.write(APPROVALS_HELP); return 0 }
    if (positional.length !== 1) throw new Error(`approvals ${subcommand} requires exactly one request id`)
    const file = statePath(options, env)
    const result = isApprove
      ? approve(file, positional[0], name(options.by, 'approvals approve --by'))
      : deny(file, positional[0], name(options.by ?? 'cli', 'approvals deny --by'), reason(options.reason))
    stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  fail('E_USAGE', `unknown approvals subcommand "${subcommand}" (expected list, approve or deny)`)
}
