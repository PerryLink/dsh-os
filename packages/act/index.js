/**
 * dsh-act — typed action registry and agent-facing action bus for DeepSeek Harness.
 *
 * 0.1.0 MVP: Host service `ctx.act` with descriptor validation, optional Allow
 * grant checks for write/danger actions, three read-only built-ins and the
 * `act_list` / `act_invoke` agent tools. Plain ESM, no runtime dependencies.
 * @module dsh-act
 */

/** Cordis plugin name. */
export const name = 'dsh-act'

/** The service is usable without tools; the agent tools need the tool registry. */
export const inject = ['tools']

const ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const RISKS = ['read', 'write', 'danger']
const RISK_RANK = { read: 0, write: 1, danger: 2 }

function invalid(actionId, message) {
  return Object.assign(new Error(message), { code: 'invalid_action', actionId })
}

/** Validate the descriptor fields this MVP relies on. */
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
  if (!RISKS.includes(descriptor.risk)) {
    throw invalid(descriptor.id, `action "${descriptor.id}" requires risk read, write or danger`)
  }
  if (typeof descriptor.execute !== 'function') {
    throw invalid(descriptor.id, `action "${descriptor.id}" requires an execute function`)
  }
  if (descriptor.description !== undefined && typeof descriptor.description !== 'string') {
    throw invalid(descriptor.id, `action "${descriptor.id}" description must be a string`)
  }
  if (descriptor.parameters !== undefined
    && (descriptor.parameters === null || typeof descriptor.parameters !== 'object'
      || Array.isArray(descriptor.parameters))) {
    throw invalid(descriptor.id, `action "${descriptor.id}" parameters must be a JSON Schema object`)
  }
  if (descriptor.undo !== undefined && typeof descriptor.undo !== 'function') {
    throw invalid(descriptor.id, `action "${descriptor.id}" undo must be a function`)
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

/** The built-in read-only actions. */
function builtins(service) {
  return [
    {
      id: 'echo',
      title: 'Echo',
      description: 'Echo the supplied text.',
      risk: 'read',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', description: 'Text to echo.' } },
        required: ['text'],
      },
      execute(args) {
        return { text: typeof args?.text === 'string' ? args.text : '' }
      },
    },
    {
      id: 'now',
      title: 'Current time',
      description: 'Return the current time as an ISO 8601 string.',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute() {
        return { now: new Date().toISOString() }
      },
    },
    {
      id: 'list',
      title: 'List actions',
      description: 'List registered actions.',
      risk: 'read',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string', description: 'Optional text filter.' } },
      },
      execute(args) {
        return { actions: service.list(args?.query).map(summarize) }
      },
    },
  ]
}

/** Recipient-side view of an Allow `check()` decision. Fail closed. */
function granted(decision) {
  if (decision === true || decision === 'allow') return true
  if (decision === null || typeof decision !== 'object') return false
  return decision.granted === true
    || decision.allowed === true
    || decision.allow === true
    || decision.permitted === true
    || decision.decision === 'allow'
    || decision.status === 'allow'
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
    if (typeof query.text === 'string' && query.text.trim() !== '') {
      const text = query.text.trim().toLowerCase()
      actions = actions.filter(action => matches(action, text))
    }
    if (query.riskMax !== undefined) {
      const max = RISK_RANK[query.riskMax]
      if (max === undefined) throw invalid(undefined, `invalid riskMax: ${String(query.riskMax)}`)
      actions = actions.filter(action => RISK_RANK[action.risk] <= max)
    }
    return actions
  }

  /**
   * Invoke an action. `read` runs directly; `write`/`danger` require an
   * explicit Allow grant. Never throws for action, grant or execution failure.
   */
  async invoke(id, args, meta) {
    const action = this.#actions.get(id)
    if (action === undefined) return { ok: false, code: 'action_not_found', actionId: id }

    const capability = `act:invoke:${action.id}`
    if (action.risk !== 'read' && !(await this.#authorized(capability, meta))) {
      return { ok: false, code: 'grant_required', actionId: action.id, capability }
    }

    try {
      return { ok: true, actionId: action.id, result: await action.execute(args, meta) }
    } catch (error) {
      return {
        ok: false,
        code: 'action_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async #authorized(capability, meta) {
    const allow = typeof this.#ctx?.get === 'function' ? this.#ctx.get('allow') : undefined
    if (allow === undefined || allow === null || typeof allow.check !== 'function') return false
    // A missing subject must fail closed: a shared 'anonymous' identity would
    // let one grant authorize every background/plugin call.
    const subject = meta?.subject ?? meta?.sessionId
    if (typeof subject !== 'string' || subject === '') return false
    try {
      return granted(await allow.check({ subject, capability }))
    } catch {
      return false
    }
  }
}

/** `act_list` tool: read-only action discovery. */
function listTool(service) {
  return {
    name: 'act_list',
    description: 'List registered Act actions with their id, title and risk.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: 'Optional id/title/description filter.' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { actions: service.list(args?.query).map(summarize) }
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
      + 'capability "act:invoke:<id>" for the caller.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Registered action id, e.g. "echo".' },
        args: { type: 'object', additionalProperties: true, description: 'Action arguments.' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (typeof args?.id !== 'string' || args.id === '') {
        throw Object.assign(new Error('act_invoke requires a non-empty string id'), {
          code: 'invalid_arguments',
        })
      }
      const meta = { origin: 'tool' }
      const subject = exec?.agent?.session?.id ?? exec?.agent?.id
      if (subject !== undefined) meta.subject = subject
      return service.invoke(args.id, args.args, meta)
    },
  }
}

/**
 * Mount dsh-act: provide `ctx.act`, register built-ins and the two agent tools.
 * @param {object} ctx - Cordis context.
 * @param {object} [_config] - Reserved for 0.2.0; unused by the MVP.
 */
export function apply(ctx, _config = {}) {
  const service = new ActService(ctx)
  for (const descriptor of builtins(service)) service.register(descriptor)
  ctx.provide('act', service)
  ctx.tools.register(listTool(service))
  ctx.tools.register(invokeTool(service))
  return service
}
