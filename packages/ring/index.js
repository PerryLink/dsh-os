/**
 * dsh-ring — approval SLA and escalation receipts for DeepSeek Harness.
 *
 * 0.2.0: `ctx.ring` is an in-memory approval-case ledger with a deterministic
 * SLA state machine advanced by `tick(now)`. No channel is enabled by default:
 * every step writes a local receipt, and only an explicit `configureChannels()`
 * lets a tick deliver through webhook, ntfy or console. Delivery is bounded,
 * best-effort and never approves anything. Plain ESM, no runtime dependencies.
 * @module dsh-ring
 */
import { randomUUID } from 'node:crypto'
import { buildChannels, buildMessage, providerForLabel } from './lib/channels/index.js'

export const name = 'dsh-ring'
export const inject = ['tools']

/** States; `resolved` and `expired` close a case for tick purposes. */
export const STATES = ['pending', 'notified', 'escalated', 'acked', 'resolved', 'expired']
export const RISKS = ['read', 'write', 'exec', 'danger']
export const DEFAULT_TTL_MS = 60 * 60 * 1000

/** Default SLA: t0 0s, t1 3m, t2 10m, t3 30m; case TTL is 60m. */
export const DEFAULT_ESCALATION_CHAIN = Object.freeze([
  { level: 0, afterMs: 0, channel: 'local' },
  { level: 1, afterMs: 3 * 60 * 1000, channel: 'local' },
  { level: 2, afterMs: 10 * 60 * 1000, channel: 'webhook' },
  { level: 3, afterMs: 30 * 60 * 1000, channel: 'voice' },
])

const MAX_TEXT = 128
const CHAIN_DEFAULT_CHANNEL = level => (level >= 3 ? 'voice' : level === 2 ? 'webhook' : 'local')
const clone = value => structuredClone(value)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function readText(value, field, code = 'E_INPUT', max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, `${field} must be a non-empty string`)
  const text = value.trim()
  if (text.length > max) fail(code, `${field} must be at most ${max} characters`)
  return text
}

const readId = value => readText(value, 'id')

function readTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('E_INPUT', `${label} must be a finite non-negative timestamp`)
  }
  return value
}

function readTtl(value) {
  if (value === undefined || value === null) return DEFAULT_TTL_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('E_TTL', 'ttlMs must be a positive finite number of milliseconds')
  }
  return value
}

/** Accept a full replacement chain: numbers, or `{ level?, afterMs, channel? }`. */
function normalizeChain(input) {
  if (input === undefined || input === null) return DEFAULT_ESCALATION_CHAIN.map(entry => ({ ...entry }))
  if (!Array.isArray(input) || input.length === 0) fail('E_CHAIN', 'escalationChain must be a non-empty array')
  const entries = input.map((item, index) => {
    let level = index
    let afterMs
    let channel
    if (typeof item === 'number') afterMs = item
    else if (isObject(item)) {
      afterMs = item.afterMs ?? item.after ?? item.at
      if (item.level !== undefined) level = item.level
      channel = item.channel
    } else fail('E_CHAIN', `escalationChain[${index}] must be a number or an object`)
    if (!Number.isInteger(level) || level < 0) fail('E_CHAIN', `escalationChain[${index}].level must be an integer >= 0`)
    if (typeof afterMs !== 'number' || !Number.isFinite(afterMs) || afterMs < 0) {
      fail('E_CHAIN', `escalationChain[${index}].afterMs must be a finite number >= 0`)
    }
    channel = channel === undefined ? CHAIN_DEFAULT_CHANNEL(level) : readText(channel, 'channel', 'E_CHAIN', 64)
    return { level, afterMs, channel }
  })
  if (!entries.some(entry => entry.level === 0)) entries.push({ level: 0, afterMs: 0, channel: 'local' })
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.level)) fail('E_CHAIN', `duplicate escalation level: ${entry.level}`)
    seen.add(entry.level)
  }
  return entries.sort((a, b) => a.afterMs - b.afterMs || a.level - b.level)
}

/** Host seam `ctx.ring`: an in-memory ledger with a deterministic SLA clock. */
export class RingService {
  #cases = new Map()
  #receipts = []
  #channels = new Map()

  constructor(ctx, config = {}) {
    this.ctx = ctx
    if (!isObject(config)) fail('E_INPUT', 'config must be an object')
    this.clock = typeof config.now === 'function' ? config.now : () => Date.now()
    readTimestamp(this.clock(), 'config.now()')
    if (config.channels !== undefined) this.configureChannels(config.channels)
  }

  /**
   * Replace the notification channels. Omitted entries are disabled; pass `{}`
   * to clear every channel. Configuring performs no network I/O by itself.
   */
  configureChannels(input = {}) {
    this.#channels = buildChannels(input)
    return { channels: this.channels() }
  }

  /** Configured provider names, in registry order. */
  channels() {
    return [...this.#channels.keys()]
  }

  /** Create a pending case. t0 is delivered by the next `tick` at/after createdAt. */
  raise(input) {
    if (!isObject(input)) fail('E_INPUT', 'raise input must be an object')
    const source = readText(input.source, 'source', 'E_INPUT', 64)
    const risk = input.risk === undefined ? 'write' : input.risk
    if (!RISKS.includes(risk)) fail('E_INPUT', `risk must be one of ${RISKS.join(', ')}`)
    const ttlMs = readTtl(input.ttlMs)
    const escalationChain = normalizeChain(input.escalationChain)
    const at = readTimestamp(this.clock(), 'clock')
    const kase = {
      id: randomUUID(),
      source,
      risk,
      state: 'pending',
      level: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at + ttlMs,
      escalationChain,
    }
    this.#cases.set(kase.id, kase)
    return clone(kase)
  }

  /** Return a case snapshot by id, or `undefined`. */
  get(id) {
    const kase = this.#cases.get(readId(id))
    return kase === undefined ? undefined : clone(kase)
  }

  /** List case snapshots in creation order, optionally filtered by status/statuses. */
  list(query = {}) {
    if (!isObject(query)) fail('E_INPUT', 'list query must be an object')
    let filter = null
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status]
      filter = new Set()
      for (const status of statuses) {
        if (!STATES.includes(status)) fail('E_INPUT', `status must be one of ${STATES.join(', ')}`)
        filter.add(status)
      }
    }
    return [...this.#cases.values()]
      .filter(kase => filter === null || filter.has(kase.state))
      .map(clone)
  }

  /** Acknowledge a case: claim responsibility and stop further escalation. */
  ack(id, options = {}) {
    const kase = this.#mustGet(id)
    if (!isObject(options)) fail('E_INPUT', 'ack options must be an object')
    const by = readText(options.by, 'by')
    if (!['pending', 'notified', 'escalated'].includes(kase.state)) fail('E_STATE', `cannot ack a case in state "${kase.state}"`)
    const at = readTimestamp(this.clock(), 'clock')
    kase.state = 'acked'
    kase.ackedAt = at
    kase.ackedBy = by
    kase.updatedAt = at
    this.#record(kase, 'ack', at, { by })
    return clone(kase)
  }

  /**
   * Move a case to `escalated`. `to` is a chain level (number or `t<N>`) or a
   * free-form target label; omit it to advance one level automatically.
   */
  escalate(id, options = {}) {
    const kase = this.#mustGet(id)
    if (!isObject(options)) fail('E_INPUT', 'escalate options must be an object')
    if (kase.state === 'resolved') fail('E_STATE', 'cannot escalate a resolved case')
    if (kase.state === 'acked') fail('E_STATE', 'cannot escalate an acked case; ack stops escalation')
    if (kase.state === 'expired' && options.to === undefined) fail('E_STATE', 'expired case needs an explicit target')
    const at = readTimestamp(this.clock(), 'clock')
    let level
    let target
    if (options.to === undefined) {
      const next = kase.escalationChain.find(entry => entry.level > kase.level)
      if (next === undefined) fail('E_STATE', `case is already at escalation level ${kase.level}`)
      level = next.level
      target = `t${level}`
    } else if (typeof options.to === 'number' || /^t?\d+$/i.test(String(options.to).trim())) {
      const requested = typeof options.to === 'number' ? options.to : Number(String(options.to).trim().replace(/^t/i, ''))
      const entry = kase.escalationChain.find(item => item.level === requested)
      if (!Number.isInteger(requested) || requested === 0 || entry === undefined) fail('E_INPUT', `unknown escalation target: ${String(options.to)}`)
      if (requested <= kase.level && kase.state !== 'expired') fail('E_INPUT', `escalation target t${requested} must be above level ${kase.level}`)
      level = Math.max(requested, kase.level)
      target = `t${requested}`
    } else {
      target = readText(options.to, 'to', 'E_INPUT', 64)
      const next = kase.escalationChain.find(entry => entry.level > kase.level)
      if (next === undefined) fail('E_STATE', `case is already at escalation level ${kase.level}`)
      level = next.level
    }
    const entry = kase.escalationChain.find(item => item.level === level)
    kase.state = 'escalated'
    kase.level = level
    kase.escalatedAt = at
    kase.updatedAt = at
    this.#record(kase, 'escalation', at, { channel: entry?.channel, to: target })
    return clone(kase)
  }

  /** Record the human decision for a case. Ack is not approval; this is. */
  resolve(id, options = {}) {
    const kase = this.#mustGet(id)
    if (!isObject(options)) fail('E_INPUT', 'resolve options must be an object')
    const decision = readText(options.decision, 'decision', 'E_INPUT', 64)
    if (kase.state === 'resolved') fail('E_STATE', 'case is already resolved')
    if (kase.state === 'expired') {
      fail('E_STATE', 'cannot resolve an expired case; escalate it with an explicit target or raise a new case')
    }
    const at = readTimestamp(this.clock(), 'clock')
    const late = kase.expiredAt !== undefined || at > kase.expiresAt
    kase.state = 'resolved'
    kase.decision = decision
    kase.resolvedAt = at
    kase.updatedAt = at
    if (late) kase.late = true
    this.#record(kase, 'decision', at)
    return clone(kase)
  }

  /** Return all receipts for one case, in insertion order. */
  receipts(id) {
    const kase = this.#mustGet(id)
    return this.#receipts.filter(receipt => receipt.caseId === kase.id).map(clone)
  }

  /**
   * Deliver one notification for a known case through a configured channel.
   * Omit `channel` to use the case's current chain label (`local`, `webhook`,
   * `voice`, or a provider name). Resolves `{ delivery }`; a missing provider
   * or a failed request rejects with `E_UNAVAILABLE`.
   */
  async notify(caseOrId, options = {}) {
    const kase = this.#mustGet(typeof caseOrId === 'string' ? caseOrId : caseOrId?.id)
    if (!isObject(options)) fail('E_INPUT', 'notify options must be an object')
    const label = options.channel === undefined
      ? kase.escalationChain.find(entry => entry.level === kase.level)?.channel
      : readText(options.channel, 'channel', 'E_INPUT', 64)
    const provider = providerForLabel(label)
    const channel = provider === null ? undefined : this.#channels.get(provider)
    if (channel === undefined) {
      fail('E_UNAVAILABLE', `channel "${label ?? `t${kase.level}`}" is not configured for delivery`)
    }
    const at = readTimestamp(this.clock(), 'clock')
    try {
      const result = await channel.send(buildMessage(kase, label, at))
      const delivery = { caseId: kase.id, channel: provider, ok: true, error: null, at }
      if (result?.status !== undefined) delivery.status = result.status
      return { delivery }
    } catch (error) {
      const safe = error?.code === 'E_UNAVAILABLE' && typeof error?.message === 'string' && !error.message.includes('://')
      fail('E_UNAVAILABLE', safe ? error.message : `${provider} delivery failed`)
    }
  }

  /**
   * Advance open cases to `now`: expire, deliver t0, then at most one
   * escalation. Configured channels are called best-effort; failures are
   * returned in `deliveries` and never roll back the state machine.
   */
  async tick(now = this.clock()) {
    const at = readTimestamp(now, 'now')
    const start = this.#receipts.length
    const receipts = []
    const deliveries = []
    const changed = new Set()
    for (const kase of this.#cases.values()) {
      if (kase.state === 'resolved' || kase.state === 'expired' || kase.expiredAt !== undefined) continue
      if (at >= kase.expiresAt) {
        kase.state = 'expired'
        kase.expiredAt = at
        kase.updatedAt = at
        receipts.push(this.#record(kase, 'expiry', at))
        changed.add(kase.id)
        continue
      }
      if (kase.state === 'pending') {
        const t0 = kase.escalationChain.find(entry => entry.level === 0 && at >= kase.createdAt + entry.afterMs)
        if (t0 === undefined) continue
        kase.state = 'notified'
        kase.notifiedAt = at
        kase.updatedAt = at
        receipts.push(this.#record(kase, 'delivery', at, { channel: t0.channel, to: 't0' }))
        changed.add(kase.id)
        await this.#deliver(kase, t0.channel, at, deliveries)
      }
      if (!['notified', 'escalated'].includes(kase.state)) continue
      const due = kase.escalationChain
        .filter(entry => entry.level > kase.level && at >= kase.createdAt + entry.afterMs)
        .sort((a, b) => a.level - b.level)
      const next = due.at(-1)
      if (next === undefined) continue
      kase.state = 'escalated'
      kase.level = next.level
      kase.escalatedAt = at
      kase.updatedAt = at
      receipts.push(this.#record(kase, 'escalation', at, { channel: next.channel, to: `t${next.level}` }))
      changed.add(kase.id)
      await this.#deliver(kase, next.channel, at, deliveries)
    }
    return {
      now: at,
      receipts: this.#receipts.slice(start).map(clone),
      cases: [...changed].map(id => clone(this.#cases.get(id))),
      deliveries,
    }
  }

  async #deliver(kase, label, at, deliveries) {
    const provider = providerForLabel(label)
    if (provider === null || !this.#channels.has(provider)) return
    try {
      deliveries.push((await this.notify(kase, { channel: label })).delivery)
    } catch {
      deliveries.push({ caseId: kase.id, channel: provider, ok: false, error: 'E_UNAVAILABLE', at })
    }
  }

  #mustGet(id) {
    const key = readId(id)
    const kase = this.#cases.get(key)
    if (kase === undefined) fail('E_NOT_FOUND', `ring case "${key}" is not registered`)
    return kase
  }

  #record(kase, kind, at, extra = {}) {
    // Receipts are append-only evidence: freeze the stored entry so no later
    // code path can rewrite history, and hand callers a mutable copy.
    const receipt = Object.freeze({ id: randomUUID(), caseId: kase.id, kind, at, ...extra })
    this.#receipts.push(receipt)
    return clone(receipt)
  }
}

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const argsSchema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, ...(required === undefined ? {} : { required }) })

const CHAIN_SCHEMA = {
  type: 'array',
  description: 'Full SLA chain; omit for t0 0s, t1 3m, t2 10m, t3 30m.',
  items: {
    anyOf: [
      { type: 'number', minimum: 0 },
      { type: 'object', additionalProperties: false, properties: { level: { type: 'integer', minimum: 0 }, afterMs: { type: 'number', minimum: 0 }, channel: { type: 'string' } } },
    ],
  },
}

const tool = (name, description, parameters, execute) => ({ name, description, parameters, output: OUTPUT, execute })

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    tool('ring_raise', 'Raise a pending approval case with an SLA escalation chain. Delivery only happens when a channel is explicitly configured.',
      argsSchema({
        source: { type: 'string', description: 'Origin, e.g. approval, hook, act or manual.' },
        risk: { type: 'string', enum: RISKS, description: 'Defaults to write.' },
        ttlMs: { type: 'number', minimum: 1, description: 'Case lifetime in ms; defaults to 60 minutes.' },
        escalationChain: CHAIN_SCHEMA,
      }, ['source']),
      async args => ({ case: service.raise(args ?? {}) })),
    tool('ring_ack', 'Acknowledge and claim a case. Ack stops escalation but is not approval.',
      argsSchema({
        id: { type: 'string' },
        by: { type: 'string', description: 'Principal acknowledging the case.' },
      }, ['id', 'by']),
      async args => ({ case: service.ack(args?.id, { by: args?.by }) })),
    tool('ring_escalate', 'Escalate a case to a chain level (number or t1..t3) or target label; omit to target the next level.',
      argsSchema({
        id: { type: 'string' },
        to: { type: ['integer', 'string'], description: 'Escalation level or target label.' },
      }, ['id']),
      async args => ({ case: service.escalate(args?.id, args?.to === undefined ? {} : { to: args.to }) })),
    tool('ring_list', 'List approval cases, optionally filtered by status.',
      argsSchema({
        status: { type: 'string', enum: STATES },
      }),
      async args => ({ cases: service.list(args?.status === undefined ? {} : { status: args.status }) })),
    tool('ring_receipts', 'List the audit receipts for one case (delivery, escalation, ack, decision or expiry).',
      argsSchema({ id: { type: 'string' } }, ['id']),
      async args => ({ receipts: service.receipts(args?.id) })),
    tool('ring_channels', 'List configured notification channels. No network is used unless a channel is explicitly configured.',
      argsSchema({}),
      async () => ({ channels: service.channels() })),
    tool('ring_notify', 'Send one notification for a case through a configured channel; omit channel to use the current chain label.',
      argsSchema({
        id: { type: 'string' },
        channel: { type: 'string', description: 'webhook, ntfy, console, local or voice.' },
      }, ['id']),
      async args => service.notify(args?.id, args?.channel === undefined ? {} : { channel: args.channel })),
  ]
}

/** Mount the plugin at `ctx.ring` and register the seven agent tools. */
export function apply(ctx, config = {}) {
  const service = new RingService(ctx, config)
  ctx.provide('ring', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
