/** Agent source: subscribes to the host `session/event` and `agent/*` feeds. */
import { createDedupe, fail } from './shared.js'

/** Session events projected into trigger events; everything else is filtered out. */
const SESSION_EVENTS = new Map([
  ['turn/end', 'session/turn-end'],
  ['approval/asked', 'session/approval-asked'],
  ['tool/result', 'session/tool-result'],
])

/** Metadata-only projection: never copies message bodies or tool output. */
function project(event) {
  const data = event.data ?? {}
  if (event.type === 'turn/end') return { turn: data.turn ?? null, reason: data.reason?.kind ?? null }
  if (event.type === 'approval/asked') {
    return { id: data.id ?? null, toolName: data.toolName ?? null, callId: data.callId ?? null }
  }
  const message = data.message ?? {}
  return {
    turn: data.turn ?? null,
    step: data.step ?? null,
    callId: message.callId ?? null,
    isError: message.isError === true,
    error: data.error?.code ?? null,
  }
}

export function createAgentSource(ctx, opts, emit) {
  if (typeof ctx.on !== 'function') throw fail('E_UNAVAILABLE', 'agent source needs a Cordis context with ctx.on')
  const sessionId = opts.sessionId === undefined || opts.sessionId === null ? null : String(opts.sessionId)
  const seen = createDedupe(opts.dedupeLimit)
  const stats = { emitted: 0, skipped: 0 }
  const disposers = []
  const match = candidate => sessionId === null || String(candidate ?? '') === sessionId
  let running = false

  const onSessionEvent = (session, event) => {
    const name = event === null || event === undefined ? undefined : SESSION_EVENTS.get(event.type)
    if (name === undefined) return
    const sid = String(session?.id ?? '')
    if (!match(sid)) return
    // `session/event` may be re-delivered (batch replay); seq is per session.
    if (!seen.add(`${sid}:${String(event.seq)}`)) {
      stats.skipped += 1
      return
    }
    stats.emitted += 1
    emit({ type: name, sessionId: sid, seq: event.seq, data: project(event) })
  }

  const onAgentError = payload => {
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!match(sid)) return
    const error = payload?.error
    stats.emitted += 1
    emit({
      type: 'agent/error',
      sessionId: sid,
      turn: payload?.turn ?? null,
      step: payload?.step ?? null,
      error: {
        name: error?.name ?? null,
        code: error?.code ?? null,
        message: String(error?.message ?? error ?? '').slice(0, 500),
      },
    })
  }

  const onAgentStatus = payload => {
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!match(sid)) return
    stats.emitted += 1
    emit({ type: 'agent/status', sessionId: sid, status: payload?.status ?? null })
  }

  return {
    async start() {
      if (running) return
      running = true
      disposers.push(
        ctx.on('session/event', onSessionEvent),
        ctx.on('agent/error', onAgentError),
        ctx.on('agent/status', onAgentStatus),
      )
    },
    async stop() {
      running = false
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {
          // The host fiber may already be torn down.
        }
      }
    },
    describe: () => ({ events: [...SESSION_EVENTS.values(), 'agent/error', 'agent/status'], sessionId, ...stats }),
  }
}
