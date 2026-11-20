/**
 * @perrylink/dsh-notify — channel registry, routing and delivery ledger for
 * DeepSeek Harness.
 *
 * 0.1.0 is routing + ledger only: callers register a channel, `send()` routes
 * to it and every attempt is recorded locally. The module ships no IM, desktop
 * or phone adapter and never touches the network; those channels land in
 * 0.2.0. Ring can use `send()` for escalation notifications once a channel is
 * registered.
 *
 * Plain ESM, no runtime dependencies. @module @perrylink/dsh-notify
 */
import { randomUUID } from 'node:crypto'

export const name = '@perrylink/dsh-notify'
export const inject = ['tools']

export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent'])
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000
export const DEFAULT_HISTORY_LIMIT = 50
export const MAX_HISTORY_LIMIT = 1000

const MAX_CHANNEL_NAME = 64
const MAX_TITLE = 200
const MAX_BODY = 4000
const MAX_DEDUPE_KEY = 128

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => structuredClone(value)

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function readText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('E_INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  const text = value.trim()
  if (text.length > max) fail('E_INVALID_ARGUMENT', `${field} must be at most ${max} characters`)
  return text
}

function readBody(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('E_INVALID_ARGUMENT', 'body must be a string')
  if (value.length > MAX_BODY) fail('E_INVALID_ARGUMENT', `body must be at most ${MAX_BODY} characters`)
  return value
}

function readTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('E_INVALID_ARGUMENT', `${label} must be a finite non-negative timestamp`)
  }
  return value
}

function readWindow(value) {
  if (value === undefined) return DEFAULT_DEDUPE_WINDOW_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('E_INVALID_ARGUMENT', 'dedupeWindowMs must be a positive finite number')
  }
  return value
}

function readLimit(value) {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    fail('E_INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`)
  }
  return value
}

/** Host seam `ctx.notify`: channel registry, router and in-memory ledger. */
export class NotifyService {
  #channels = new Map()
  #deliveries = []
  #dedupe = new Map()

  constructor(ctx, config = {}) {
    this.ctx = ctx
    if (!isObject(config)) fail('E_INVALID_ARGUMENT', 'config must be an object')
    this.clock = typeof config.now === 'function' ? config.now : () => Date.now()
    readTimestamp(this.clock(), 'config.now()')
    this.dedupeWindowMs = readWindow(config.dedupeWindowMs)
  }

  /** Register one channel adapter. Returns `{ name }`; duplicate names conflict. */
  registerChannel(input) {
    if (!isObject(input)) fail('E_INVALID_ARGUMENT', 'registerChannel input must be an object')
    const channelName = readText(input.name, 'name', MAX_CHANNEL_NAME)
    if (typeof input.send !== 'function') fail('E_INVALID_ARGUMENT', 'channel.send must be a function')
    if (this.#channels.has(channelName)) fail('E_CONFLICT', `channel "${channelName}" is already registered`)
    this.#channels.set(channelName, Object.freeze({ name: channelName, send: input.send }))
    return { name: channelName }
  }

  /** Channel names in registration order. */
  channels() {
    return [...this.#channels.keys()]
  }

  /**
   * Route one notification. Unknown channels reject with `E_UNAVAILABLE` and
   * are not recorded. A channel `send()` rejection is recorded as `ok: false`
   * and resolves instead of throwing. A live `dedupeKey` returns the original
   * delivery with `deduped: true` and does not call the channel again.
   */
  async send(input) {
    if (!isObject(input)) fail('E_INVALID_ARGUMENT', 'send input must be an object')
    const channelName = readText(input.channel, 'channel', MAX_CHANNEL_NAME)
    const channel = this.#channels.get(channelName)
    if (channel === undefined) fail('E_UNAVAILABLE', `channel "${channelName}" is not registered`)
    const title = readText(input.title, 'title', MAX_TITLE)
    const body = readBody(input.body)
    const priority = input.priority === undefined ? 'normal' : input.priority
    if (!PRIORITIES.includes(priority)) {
      fail('E_INVALID_ARGUMENT', `priority must be one of ${PRIORITIES.join(', ')}`)
    }
    const dedupeKey = input.dedupeKey === undefined
      ? undefined
      : readText(input.dedupeKey, 'dedupeKey', MAX_DEDUPE_KEY)

    const at = readTimestamp(this.clock(), 'clock')
    this.#pruneDedupe(at)
    if (dedupeKey !== undefined) {
      const prior = this.#dedupe.get(dedupeKey)
      if (prior !== undefined) return { delivery: clone(await prior.done), deduped: true }
    }

    const record = { id: randomUUID(), channel: channelName, ok: false, error: null, at }
    let settle
    const done = new Promise(resolve => { settle = resolve })
    if (dedupeKey !== undefined) this.#dedupe.set(dedupeKey, { at, done })
    try {
      await channel.send(Object.freeze({ id: record.id, channel: channelName, title, body, priority }))
      record.ok = true
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
    }
    const frozen = Object.freeze(record)
    this.#deliveries.push(frozen)
    settle(frozen)
    return { delivery: clone(frozen), deduped: false }
  }

  /** Delivery records, newest first, at most `limit` (default 50). */
  history(limit = DEFAULT_HISTORY_LIMIT) {
    return this.#deliveries.slice(-readLimit(limit)).reverse().map(clone)
  }

  /** Drop the ledger and dedupe memory; registered channels stay mounted. */
  clear() {
    const cleared = this.#deliveries.length
    this.#deliveries = []
    this.#dedupe.clear()
    return { cleared }
  }

  #pruneDedupe(at) {
    for (const [key, entry] of this.#dedupe) {
      if (at - entry.at >= this.dedupeWindowMs) this.#dedupe.delete(key)
    }
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const argsSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
})
const tool = (name, description, parameters, execute) => ({ name, description, parameters, output: OUTPUT, execute })

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    tool(
      'notify_send',
      'Route a notification to a registered channel. Unknown channels fail with E_UNAVAILABLE; channel failures are recorded with ok:false. dedupeKey suppresses repeats inside the dedupe window.',
      argsSchema({
        channel: { type: 'string', description: 'Registered channel name.' },
        title: { type: 'string', description: 'Short notification title.' },
        body: { type: 'string', description: 'Optional notification body.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Defaults to normal.' },
        dedupeKey: { type: 'string', description: 'Repeat-suppression key; one delivery per window.' },
      }, ['channel', 'title']),
      async args => service.send(args ?? {}),
    ),
    tool(
      'notify_channels',
      'List registered notification channel names in registration order.',
      argsSchema({}),
      async () => ({ channels: service.channels() }),
    ),
    tool(
      'notify_history',
      'Read the delivery ledger, newest first. Each record is { id, channel, ok, error, at }.',
      argsSchema({
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_HISTORY_LIMIT,
          description: `Newest records to return (default ${DEFAULT_HISTORY_LIMIT}).`,
        },
      }),
      async args => ({ history: service.history(args?.limit) }),
    ),
  ]
}

/** Mount the plugin at `ctx.notify` and register the three agent tools. */
export function apply(ctx, config = {}) {
  const service = new NotifyService(ctx, config)
  ctx.provide('notify', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
