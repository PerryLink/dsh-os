/**
 * Minimal in-memory audit event. Nothing is written to disk or sent anywhere;
 * callers decide where to persist the returned record.
 * @module @perrylink/dsh-os-contract/lib/audit
 */
import { newId } from './ids.js'

/** Audit event schema id. */
export const AUDIT_SCHEMA = 'dsh.os.audit/v1'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Build a minimal audit event; ids are `aud_<ULID>` unless supplied. */
export function auditEvent(input = {}) {
  if (!isObject(input)) {
    throw Object.assign(new Error('auditEvent input must be an object'), { code: 'E_INVALID_ARGUMENT' })
  }
  return {
    schema: AUDIT_SCHEMA,
    id: typeof input.id === 'string' && input.id !== '' ? input.id : newId('aud_'),
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
    actor: input.actor ?? null,
    tool: input.tool ?? null,
    capability: input.capability ?? null,
    argsHash: input.argsHash ?? null,
    result: input.result ?? null,
    cost: input.cost ?? null,
  }
}
