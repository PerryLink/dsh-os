/**
 * Ring's egress grant gate: one capability, one Allow decision adapter and the
 * structured refusal used when `ring:notify` has not been granted.
 * @module dsh-ring/lib/grant
 */
export const CAP_RING_NOTIFY = 'ring:notify'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Recipient-side view of an Allow `check()` decision. Fail closed. */
export function granted(decision) {
  if (decision === true || decision === 'allow') return true
  return isObject(decision) && ([decision.granted, decision.allowed, decision.allow, decision.permitted].includes(true)
    || decision.decision === 'allow' || decision.status === 'allow')
}

/**
 * Ask Allow for `ring:notify` on `subject` at scope `*`. A missing service, a
 * missing subject or a throwing check denies: no egress without a Grant.
 */
export async function authorize(allow, subject) {
  if (typeof subject !== 'string' || subject === '') return false
  if (allow === null || allow === undefined || typeof allow.check !== 'function') return false
  try {
    return granted(await allow.check({ subject, capability: CAP_RING_NOTIFY, scope: '*' }))
  } catch {
    return false
  }
}

/** `E_DENIED`/`grant_required` refusal with an `allow_request` recovery hint. */
export function grantDenied(subject) {
  const nextTools = [{
    tool: 'allow_request',
    args: {
      subject,
      capability: CAP_RING_NOTIFY,
      reason: 'Send one Ring notification (egress through a configured webhook, ntfy or console channel).',
    },
    why: `request a Grant for ${CAP_RING_NOTIFY}, then retry after a human decision`,
  }]
  return Object.assign(new Error(`Ring notify requires a Grant for capability "${CAP_RING_NOTIFY}".`), {
    code: 'E_DENIED',
    subcode: 'grant_required',
    capability: CAP_RING_NOTIFY,
    nextTools,
    hint: `Call allow_request for capability "${CAP_RING_NOTIFY}", then retry.`,
  })
}
