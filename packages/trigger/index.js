/**
 * dsh-trigger — in-memory event-to-action trigger fabric for DeepSeek Harness.
 *
 * 0.4.0 marks runs from the real agent/fs/webhook sources as tainted (run row
 * and stored payload); `fire()` accepts `{ tainted, taintSource }` for hosts.
 * 0.3.0: `ctx.triggers`, a small condition DSL, per-trigger cooldown, an
 * in-memory run ledger with a redacted 2 KiB payload, seven tools and sources.
 * @module dsh-trigger
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createAgentSource } from './lib/sources/agent.js'
import { createFsSource } from './lib/sources/fs.js'
import { createWebhookSource } from './lib/sources/webhook.js'
import { makeSourceTools } from './lib/source-tools.js'
import { runFields } from './lib/payload.js'

/** Cordis plugin name. */
export const name = 'dsh-trigger'

/** The registry works without tools; the agent tools need the tool registry. */
export const inject = ['tools']

const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const FIELD = /^(?:payload\.)?[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*$/
const DEFAULT_MAX_RUNS = 1000

/** The real event sources shipped by 0.2.0, keyed by `startSource` type. */
const SOURCE_FACTORIES = Object.freeze({
  agent: createAgentSource,
  fs: createFsSource,
  webhook: createWebhookSource,
})

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const fail = (code, message) => Object.assign(new Error(message), { code })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/** Declarative operators. `found` is false when the field path is missing. */
const OPERATORS = {
  eq: (actual, expected, found) => found && isDeepStrictEqual(actual, expected),
  neq: (actual, expected, found) => !found || !isDeepStrictEqual(actual, expected),
  in: (actual, expected, found) => found && expected.some(item => isDeepStrictEqual(item, actual)),
  nin: (actual, expected, found) => !found || !expected.some(item => isDeepStrictEqual(item, actual)),
  exists: (_actual, _expected, found) => found,
  gt: (actual, expected, found) => found && actual > expected,
  gte: (actual, expected, found) => found && actual >= expected,
  lt: (actual, expected, found) => found && actual < expected,
  lte: (actual, expected, found) => found && actual <= expected,
  contains: (actual, expected, found) => found && (typeof actual === 'string'
    ? actual.includes(expected)
    : Array.isArray(actual) && actual.some(item => isDeepStrictEqual(item, expected))),
  startsWith: (actual, expected, found) => found && typeof actual === 'string' && actual.startsWith(expected),
}
const LIST_OPERATORS = new Set(['in', 'nin'])

/** Resolve a dotted payload path. A leading `payload.` is accepted for symmetry. */
function lookup(payload, field) {
  const path = field.startsWith('payload.') ? field.slice('payload.'.length) : field
  let value = payload
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !own(value, key)) {
      return { found: false, value: undefined }
    }
    value = value[key]
  }
  return { found: true, value }
}

/** Compile a condition function or a `{ field, op, value }` DSL node. */
function compileCondition(condition) {
  if (condition === undefined || condition === null) return () => true
  if (typeof condition === 'function') return condition
  if (!plain(condition)) throw fail('invalid_condition', 'condition must be a function or a { field, op, value } object')
  const { field, op } = condition
  if (typeof field !== 'string' || !FIELD.test(field)) throw fail('invalid_condition', `invalid condition field: ${String(field)}`)
  if (typeof op !== 'string' || !own(OPERATORS, op)) throw fail('invalid_condition', `unknown condition op: ${String(op)}`)
  if (LIST_OPERATORS.has(op) && !Array.isArray(condition.value)) throw fail('invalid_condition', `condition op "${op}" requires an array value`)
  if (op !== 'exists' && !own(condition, 'value')) throw fail('invalid_condition', `condition op "${op}" requires a value`)
  const expected = condition.value
  const test = OPERATORS[op]
  return payload => {
    const { found, value } = lookup(payload, field)
    return Boolean(test(value, expected, found))
  }
}

/** Validate a registration and freeze the runtime trigger record. */
function buildTrigger(spec, actions) {
  if (!plain(spec)) throw fail('invalid_trigger', 'trigger must be an object')
  const { id, event } = spec
  if (typeof id !== 'string' || !TRIGGER_ID.test(id)) throw fail('invalid_trigger', `invalid trigger id: ${String(id)}`)
  if (typeof event !== 'string' || event.trim() === '' || event.includes('\0')) throw fail('invalid_trigger', `trigger "${id}" requires a non-empty event name`)
  const cooldownMs = spec.cooldownMs ?? 0
  if (typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw fail('invalid_trigger', `trigger "${id}" cooldownMs must be a non-negative number`)
  }
  let action = spec.action
  let actionId
  if (typeof action === 'string') {
    actionId = action
    action = actions.get(action)
    if (action === undefined) throw fail('unknown_action', `unknown built-in action: ${actionId}`)
  }
  if (typeof action !== 'function') throw fail('invalid_trigger', `trigger "${id}" requires an action function or a built-in action id`)
  return Object.freeze({
    id,
    event,
    cooldownMs,
    action,
    actionId,
    condition: spec.condition ?? undefined,
    matches: compileCondition(spec.condition),
  })
}

/** JSON-safe trigger view for tools and `list()` consumers. */
export function summarize({ id, event, cooldownMs, actionId, condition }) {
  return {
    id,
    event,
    cooldownMs,
    action: actionId ?? 'function',
    condition: condition === undefined ? null : typeof condition === 'function'
      ? { kind: 'function' }
      : { field: condition.field, op: condition.op, value: condition.value },
  }
}

/** JSON-safe source view; `info` is adapter-specific and never contains secrets. */
export function summarizeSource({ id, type, startedAt, lastEventAt, events, dropped, info }) {
  return { id, type, startedAt, lastEventAt, events, dropped, info: info ?? null }
}

/**
 * In-memory trigger registry exposed to other plugins as `ctx.triggers`.
 * Actions may be functions or one of the built-in demo ids `record` / `echo`.
 */
export class TriggerService {
  #triggers = new Map()
  #runs = []
  #sources = new Map()
  #lastFired = new Map()
  #actions = new Map()
  #ctx
  #now
  #maxRuns

  constructor(options = {}) {
    this.#ctx = options.ctx ?? null
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    this.#maxRuns = Number.isSafeInteger(options.maxRuns) && options.maxRuns > 0
      ? options.maxRuns
      : DEFAULT_MAX_RUNS
    this.#actions.set('record', (payload, context) => ({
      recorded: true,
      runId: context.run.id,
      event: context.event,
      payload,
    }))
    this.#actions.set('echo', payload => payload)
  }

  /** Register a trigger. Throws for invalid specs; returns the frozen record. */
  register(spec) {
    const trigger = buildTrigger(spec, this.#actions)
    if (this.#triggers.has(trigger.id)) {
      throw fail('trigger_exists', `trigger "${trigger.id}" is already registered`)
    }
    this.#triggers.set(trigger.id, trigger)
    return trigger
  }

  /** Remove a trigger (and its cooldown state); returns whether it existed. */
  unregister(id) {
    this.#lastFired.delete(id)
    return this.#triggers.delete(id)
  }

  /** Every registered trigger in insertion order. */
  list() {
    return [...this.#triggers.values()]
  }

  /** Recent runs, newest first; `limit` caps the page. */
  runs(limit) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw fail('invalid_limit', 'limit must be a non-negative integer')
    }
    const start = limit === undefined ? 0 : Math.max(0, this.#runs.length - limit)
    return this.#runs.slice(start).reverse()
  }

  /**
   * Start a real event source and feed its events into `fire()`. The emitted
   * payload carries its trigger event name in `type`. Throws `E_UNAVAILABLE`
   * when the profile lacks the host service the source needs.
   * @param {'agent'|'fs'|'webhook'} type - source kind.
   * @param {object} [opts] - source options; `id` overrides the generated id.
   * @returns {Promise<object>} the JSON-safe source summary.
   */
  async startSource(type, opts = {}) {
    const create = own(SOURCE_FACTORIES, type) ? SOURCE_FACTORIES[type] : undefined
    if (create === undefined) throw fail('invalid_source', `unknown source type: ${String(type)}`)
    if (!plain(opts)) throw fail('invalid_source', 'source options must be an object')
    if (this.#ctx === null) throw fail('E_UNAVAILABLE', 'source adapters need the plugin context')
    const id = typeof opts.id === 'string' && opts.id !== '' ? opts.id : `src_${randomUUID()}`
    if (this.#sources.has(id)) throw fail('source_exists', `source "${id}" is already running`)
    const record = {
      id, type, startedAt: this.#now(), lastEventAt: null, events: 0, dropped: 0, adapter: null, info: null,
    }
    // Register before start(): a source may emit while connecting (fs catch-up).
    this.#sources.set(id, record)
    try {
      record.adapter = create(this.#ctx, opts, payload => this.#receive(id, payload))
      await record.adapter.start()
      record.info = record.adapter.describe()
      return summarizeSource(record)
    } catch (error) {
      this.#sources.delete(id)
      try {
        await record.adapter?.stop()
      } catch {
        // The adapter never finished starting.
      }
      throw error
    }
  }

  /** Stop one source by id; returns false when no such source is running. */
  async stopSource(id) {
    if (typeof id !== 'string' || id === '') throw fail('invalid_source', 'source id must be a non-empty string')
    const record = this.#sources.get(id)
    if (record === undefined) return false
    this.#sources.delete(id)
    try {
      await record.adapter?.stop()
    } catch {
      // Releasing an already-broken watcher or route is not a caller error.
    }
    return true
  }

  /** Every running source, in start order. */
  sources() {
    return [...this.#sources.values()].map(summarizeSource)
  }

  /** Stop every source (plugin unload). */
  async dispose() {
    await Promise.all([...this.#sources.keys()].map(id => this.stopSource(id)))
  }

  /** Fire one source event without letting a failure escape into the host. */
  #receive(id, payload) {
    const record = this.#sources.get(id)
    if (record === undefined) return
    if (!plain(payload) || typeof payload.type !== 'string' || payload.type === '') {
      record.dropped += 1
      return
    }
    record.events += 1
    record.lastEventAt = this.#now()
    this.fire(payload.type, payload, { tainted: true, taintSource: record.type }).catch(() => {
      record.dropped += 1
    })
  }

  /**
   * Fire an event: run every matching trigger subject to its condition and
   * cooldown, record one run per execution and never throw for action failure.
   * Source-driven runs are marked tainted; hosts may pass options.tainted/taintSource.
   * @returns {Promise<{event: string, runs: object[], skipped: object[], results: object[]}>}
   */
  async fire(event, payload = {}, options = {}) {
    if (typeof event !== 'string' || event.trim() === '') {
      throw fail('invalid_event', 'event must be a non-empty string')
    }
    const runs = []
    const skipped = []
    const results = []
    const taintSource = options?.tainted === true ? (typeof options.taintSource === 'string' && options.taintSource !== '' ? options.taintSource : 'external') : undefined
    const observed = runFields(payload, taintSource)

    for (const trigger of [...this.#triggers.values()]) {
      if (trigger.event !== event) continue

      let matched
      try {
        matched = Boolean(trigger.matches(payload))
      } catch {
        skipped.push({ triggerId: trigger.id, reason: 'condition-error' })
        continue
      }
      if (!matched) {
        skipped.push({ triggerId: trigger.id, reason: 'condition' })
        continue
      }

      const startedAt = this.#now()
      const previous = this.#lastFired.get(trigger.id)
      if (trigger.cooldownMs > 0 && previous !== undefined
        && startedAt - previous < trigger.cooldownMs) {
        skipped.push({ triggerId: trigger.id, reason: 'cooldown' })
        continue
      }
      this.#lastFired.set(trigger.id, startedAt)

      const run = {
        id: `run_${randomUUID()}`,
        triggerId: trigger.id,
        event,
        payload: observed.payload,
        path: observed.path,
        ...(observed.tainted === true ? { tainted: true, taintSource: observed.taintSource } : {}),
        ok: true,
        error: null,
        startedAt,
        durationMs: 0,
      }
      try {
        const result = await trigger.action(payload, { event, trigger, run })
        results.push({ triggerId: trigger.id, runId: run.id, result })
      } catch (error) {
        run.ok = false
        run.error = error instanceof Error ? error.message : String(error)
      }
      run.durationMs = Math.max(0, this.#now() - startedAt)

      const settled = Object.freeze(run)
      this.#runs.push(settled)
      if (this.#runs.length > this.#maxRuns) {
        this.#runs.splice(0, this.#runs.length - this.#maxRuns)
      }
      runs.push(settled)
    }

    return { event, runs, skipped, results }
  }
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args) {
      return execute(args ?? {})
    },
  }
}

function requiredString(args, key, toolName) {
  if (typeof args[key] !== 'string' || args[key] === '') throw fail('invalid_arguments', `${toolName} requires a non-empty ${key}`)
  return args[key]
}

/** Plain-object ToolDefinitions; no `@deepseek-ai/dsh-tools` dependency. */
export function makeTools(service) {
  return [
    tool(
      'trigger_register',
      'Register an in-memory Trigger: when `event` is fired, run the built-in '
        + 'action (`record` writes a run, `echo` returns the payload). '
        + 'Registrations live until the host process exits.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Unique trigger id, e.g. "tg_ping".' },
          event: { type: 'string', description: 'Exact event name to match, e.g. "demo/ping".' },
          actionId: { type: 'string', enum: ['record', 'echo'], description: 'Built-in demo action id.' },
        },
        required: ['id', 'event', 'actionId'],
      },
      args => ({
        trigger: summarize(service.register({
          id: requiredString(args, 'id', 'trigger_register'),
          event: requiredString(args, 'event', 'trigger_register'),
          action: requiredString(args, 'actionId', 'trigger_register'),
        })),
      }),
    ),
    tool(
      'trigger_list',
      'List registered Triggers with their event, action and condition.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => ({ triggers: service.list().map(summarize) }),
    ),
    tool(
      'trigger_fire',
      'Fire an event synchronously: every matching Trigger runs subject to its '
        + 'condition and cooldown. Action failures are recorded in the run, not thrown.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          event: { type: 'string', description: 'Event name to fire.' },
          payload: {
            type: 'object',
            additionalProperties: true,
            description: 'Payload passed to conditions and actions.',
          },
        },
        required: ['event'],
      },
      args => service.fire(
        requiredString(args, 'event', 'trigger_fire'),
        args.payload ?? {},
      ),
    ),
    tool(
      'trigger_runs',
      'List recorded Trigger runs, newest first.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Maximum number of runs to return.',
          },
        },
      },
      args => ({ runs: service.runs(args.limit) }),
    ),
    ...makeSourceTools(service),
  ]
}

/**
 * Mount dsh-trigger: provide `ctx.triggers` and register the seven tools.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - `{ now?, maxRuns? }`, mainly for tests.
 */
export function apply(ctx, config = {}) {
  const service = new TriggerService({ ...config, ctx })
  ctx.provide('triggers', service)
  if (ctx.tools?.register) for (const definition of makeTools(service)) ctx.tools.register(definition)
  ctx.effect?.(() => () => service.dispose())
  return service
}
