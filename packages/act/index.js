/**
 * dsh-act — typed action registry and agent-facing action bus for DeepSeek Harness.
 * 0.5.0 adds a minimal tainted-write gate: when the caller marks meta.tainted
 * or supplies a taintToken, a write action also needs the
 * `act:invoke:<id>:tainted` capability in addition to its normal Grant. The
 * caller/host supplies the taint flag; Act does not track data flow.
 * 0.4.0 adds an `os.result/v1` envelope to `act_list` (`schema`/`ok`/`items`/
 * `summary`/`page`/`truncated`/`next`/`error`) while keeping `actions` intact.
 * 0.3.0 adds real filesystem actions (`fs.read` / `fs.write` / `fs.list` /
 * `fs.undo`) with a workdir allowlist, read caps, atomic writes, previews and
 * undo tokens. Plain ESM, no runtime dependencies.
 * @module dsh-act
 */
import { filesystem, fsActions } from './fs-actions.js'
import { failEnvelope, okEnvelope, pageOf, step } from './lib/result.js'

export const name = 'dsh-act'
export const inject = ['tools']

const ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const RISKS = ['read', 'write', 'danger']
const RISK_RANK = { read: 0, write: 1, danger: 2 }
const TAINT_SUFFIX = ':tainted'
const schema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, ...(required === undefined ? {} : { required }) })
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function invalid(actionId, message) {
  return Object.assign(new Error(message), { code: 'invalid_action', actionId })
}

/** Validate the descriptor fields this release relies on. */
function validate(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw invalid(undefined, 'action descriptor must be an object')
  }
  if (typeof descriptor.id !== 'string' || !ID_PATTERN.test(descriptor.id)) {
    throw invalid(descriptor.id, `invalid action id: ${String(descriptor.id)}`)
  }
  if (typeof descriptor.title !== 'string' || descriptor.title.trim() === '') {
    throw invalid(descriptor.id, `action "${descriptor.id}" requires a non-empty title`)
  }
  if (!RISKS.includes(descriptor.risk)) throw invalid(descriptor.id, `action "${descriptor.id}" requires risk read, write or danger`)
  if (typeof descriptor.execute !== 'function') throw invalid(descriptor.id, `action "${descriptor.id}" requires an execute function`)
  for (const [field, type] of [['description', 'string'], ['preview', 'function'], ['authorize', 'boolean'], ['undo', 'function']]) {
    if (descriptor[field] !== undefined && typeof descriptor[field] !== type) {
      throw invalid(descriptor.id, `action "${descriptor.id}" ${field} must be a ${type}`)
    }
  }
  if (descriptor.parameters !== undefined && (descriptor.parameters === null || typeof descriptor.parameters !== 'object' || Array.isArray(descriptor.parameters))) {
    throw invalid(descriptor.id, `action "${descriptor.id}" parameters must be a JSON Schema object`)
  }
}

function matches(action, text) {
  const haystack = [action.id, action.title, action.description ?? '']
  return haystack.some(field => field.toLowerCase().includes(text))
}

/** Lossless-JSON view of a descriptor (functions are omitted). */
export function summarize(action) {
  const summary = { id: action.id, title: action.title, risk: action.risk }
  if (action.description !== undefined) summary.description = action.description
  return summary
}

/** The three 0.1 built-ins plus the 0.3 filesystem actions. */
function builtins(service, fs) {
  return [
    {
      id: 'echo', title: 'Echo', description: 'Echo the supplied text.', risk: 'read',
      parameters: schema({ text: { type: 'string', description: 'Text to echo.' } }, ['text']),
      execute: args => ({ text: typeof args?.text === 'string' ? args.text : '' }),
    },
    {
      id: 'now', title: 'Current time', risk: 'read', parameters: schema({}),
      description: 'Return the current time as an ISO 8601 string.',
      execute: () => ({ now: new Date().toISOString() }),
    },
    {
      id: 'list', title: 'List actions', description: 'List registered actions.', risk: 'read',
      parameters: schema({ query: { type: 'string', description: 'Optional text filter.' } }),
      execute: args => ({ actions: service.list(args?.query).map(summarize) }),
    },
    ...fsActions(fs),
  ]
}

/** Recipient-side view of an Allow `check()` decision. Fail closed. */
function granted(decision) {
  if (decision === true || decision === 'allow') return true
  if (decision === null || typeof decision !== 'object') return false
  return [decision.granted, decision.allowed, decision.allow, decision.permitted].includes(true)
    || decision.decision === 'allow' || decision.status === 'allow'
}

/** A caller/host-supplied taint claim. Act never infers it from action args. */
function isTainted(meta) {
  return meta?.tainted === true
    || (typeof meta?.taintToken === 'string' && meta.taintToken !== '')
}

/** Structured action failure; `reason` preserves the machine-readable code. */
function failure(error) {
  const result = { code: 'action_failed', ok: false, message: error instanceof Error ? error.message : String(error) }
  if (typeof error?.code === 'string' && error.code !== 'invalid_action') result.reason = error.code
  return result
}

/** Typed action registry exposed to other plugins as `ctx.act`. */
export class ActService {
  #actions = new Map()
  #ctx

  constructor(ctx) {
    this.#ctx = ctx
  }

  /**
   * Register an action descriptor. Returns a disposer that unregisters it.
   * @throws {Error} `invalid_action` or `action_exists`.
   */
  register(descriptor) {
    validate(descriptor)
    if (this.#actions.has(descriptor.id)) {
      throw Object.assign(new Error(`action "${descriptor.id}" is already registered`), {
        code: 'action_exists',
        actionId: descriptor.id,
      })
    }
    const action = Object.freeze({ ...descriptor })
    this.#actions.set(action.id, action)
    return () => (this.#actions.get(action.id) === action ? this.#actions.delete(action.id) : false)
  }

  /** Remove an action; returns whether it was registered. */
  unregister(id) {
    return this.#actions.delete(id)
  }

  /** Look up one action descriptor. */
  get(id) {
    return this.#actions.get(id)
  }

  /**
   * List actions, optionally filtered by a text substring (string query) or
   * `{ text, riskMax }`. Insertion order is preserved.
   */
  list(query) {
    let actions = [...this.#actions.values()]
    if (typeof query === 'string') {
      const text = query.trim().toLowerCase()
      return text === '' ? actions : actions.filter(action => matches(action, text))
    }
    if (query === null || typeof query !== 'object') return actions
    const text = typeof query.text === 'string' ? query.text.trim().toLowerCase() : ''
    if (text !== '') actions = actions.filter(action => matches(action, text))
    if (query.riskMax === undefined) return actions
    const max = RISK_RANK[query.riskMax]
    if (max === undefined) throw invalid(undefined, `invalid riskMax: ${String(query.riskMax)}`)
    return actions.filter(action => RISK_RANK[action.risk] <= max)
  }

  /**
   * Invoke an action. `meta.preview` runs a side-effect-free preview when the
   * descriptor provides one. `read` runs directly; `write`/`danger` require an
   * explicit Allow grant (unless the descriptor opts into token authorization).
   * Never throws for action, grant or execution failure.
   */
  async invoke(id, args, meta) {
    const action = this.#actions.get(id)
    if (action === undefined) return { ok: false, code: 'action_not_found', actionId: id }

    if (meta?.preview === true && typeof action.preview === 'function') {
      try {
        return { ok: true, preview: await action.preview(args, meta) }
      } catch (error) {
        return failure(error)
      }
    }

    const capability = `act:invoke:${action.id}`
    // The kernel projects actions as `act.<id>` and asks Allow for
    // `cap:act.<id>`; accept either name so one human approval is enough.
    const alternate = `cap:act.${action.id}`
    const gated = action.risk !== 'read' && action.authorize !== false
    if (gated && !(await this.#authorized(capability, meta, alternate))) {
      return this.#grantRequired(action, capability)
    }
    // Minimal taint gate: a caller/host claim raises the bar for writes and
    // danger actions. It never lowers it; Act does not verify the token.
    const taintedCapability = `${capability}${TAINT_SUFFIX}`
    const taintedAlternate = `${alternate}${TAINT_SUFFIX}`
    if (gated && isTainted(meta) && !(await this.#authorized(taintedCapability, meta, taintedAlternate))) {
      return this.#grantRequired(action, taintedCapability, true)
    }

    try {
      return { ok: true, actionId: action.id, result: await action.execute(args, meta) }
    } catch (error) {
      return failure(error)
    }
  }

  /** Fail-closed grant result; tainted denials always point at allow_request. */
  #grantRequired(action, capability, tainted = false) {
    const result = { ok: false, code: 'grant_required', actionId: action.id, capability }
    if (tainted) result.tainted = true
    if (tainted || typeof this.#allow()?.request === 'function') {
      result.hint = `Call allow_request for capability "${capability}" with the target scope, then retry.`
    }
    return result
  }

  /** Resolve the optional Allow service through `ctx.get('allow')` or `ctx.allow`. */
  #allow() {
    const ctx = this.#ctx
    if (ctx === undefined || ctx === null) return undefined
    if (typeof ctx.get === 'function') {
      const service = ctx.get('allow')
      if (service !== undefined && service !== null) return service
    }
    return ctx.allow
  }

  async #authorized(capability, meta, alternate) {
    const allow = this.#allow()
    if (allow === null || typeof allow?.check !== 'function') return false
    // A missing subject must fail closed: a shared 'anonymous' identity would
    // let one grant authorize every background/plugin call.
    const subject = meta?.subject ?? meta?.sessionId
    if (typeof subject !== 'string' || subject === '') return false
    for (const name of [capability, alternate].filter(Boolean)) {
      try {
        if (granted(await allow.check({ subject, capability: name }))) return true
      } catch { /* try the other name */ }
    }
    return false
  }
}

/** `act_list` tool: read-only action discovery, including each action's risk. */
function listTool(service) {
  return {
    name: 'act_list',
    description: 'List registered Act actions with their id, title and risk.',
    parameters: schema({ query: { type: 'string', description: 'Optional id/title/description filter.' } }),
    output,
    async execute(args) {
      try {
        const actions = service.list(args?.query).map(summarize)
        const next = []
        if (actions.length > 0) {
          next.push(step('act_invoke', { id: actions[0].id }, 'Invoke one of the listed actions by id.'))
        }
        const gated = actions.find(action => action.risk !== 'read')
        if (gated !== undefined) {
          next.push(step(
            'allow_request',
            { capability: `act:invoke:${gated.id}` },
            `Request a Grant before invoking the ${gated.risk} action "${gated.id}".`,
          ))
        }
        if (actions.length === 0) {
          next.push(step('act_list', {}, 'No actions matched; call act_list without a query.'))
        }
        return okEnvelope('act_list', {
          items: actions,
          summary: `${actions.length} actions`,
          page: pageOf({ limit: actions.length, returned: actions.length, total: actions.length }),
          next,
          legacy: { actions },
        })
      } catch (error) {
        return failEnvelope('act_list', error, {
          remediation: 'Retry act_list with no query or with a plain text filter.',
          nextTools: [step('act_list', {}, 'Retry without a filter.')],
          legacy: { actions: [] },
        })
      }
    },
  }
}

/**
 * `act_invoke` tool. It has no static risk of its own: ActService.invoke applies
 * the target descriptor's risk, so write/danger actions still need a grant.
 */
function invokeTool(service) {
  return {
    name: 'act_invoke',
    description: 'Invoke a registered Act action by id. '
      + 'write and danger actions return grant_required until the Allow service grants '
      + 'capability "act:invoke:<id>" for the caller. If the arguments are tainted '
      + '(tainted:true or a taintToken from snip_get/seek/trigger), the write also needs '
      + '"act:invoke:<id>:tainted". Pass preview:true to preview a write without touching disk.',
    parameters: schema({
      id: { type: 'string', description: 'Registered action id, e.g. "fs.read".' },
      args: { type: 'object', additionalProperties: true, description: 'Action arguments.' },
      preview: { type: 'boolean', description: 'Preview without executing (write actions).' },
      tainted: { type: 'boolean', description: 'Set when args came from untrusted external content; requires the extra :tainted Grant.' },
      taintToken: { type: 'string', description: 'Opaque token from snip_get/seek/trigger; treated as taint evidence and requires the extra :tainted Grant.' },
    }, ['id']),
    output,
    async execute(args, exec) {
      if (typeof args?.id !== 'string' || args.id === '') {
        throw Object.assign(new Error('act_invoke requires a non-empty string id'), {
          code: 'invalid_arguments',
        })
      }
      const meta = { origin: 'tool' }
      const subject = exec?.agent?.session?.id ?? exec?.agent?.id
      if (subject !== undefined) meta.subject = subject
      if (args.preview === true) meta.preview = true
      if (args.tainted === true) meta.tainted = true
      if (typeof args.taintToken === 'string' && args.taintToken !== '') meta.taintToken = args.taintToken
      return service.invoke(args.id, args.args, meta)
    },
  }
}

/**
 * Mount dsh-act: provide `ctx.act`, register built-ins and the two agent tools.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - `{ workdir?, maxReadBytes?, maxWriteBytes? }`.
 */
export function apply(ctx, config = {}) {
  const service = new ActService(ctx)
  const fs = filesystem(config ?? {})
  for (const descriptor of builtins(service, fs)) service.register(descriptor)
  ctx.provide('act', service)
  ctx.tools.register(listTool(service))
  ctx.tools.register(invokeTool(service))
  return service
}
