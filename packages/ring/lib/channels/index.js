/**
 * Notification channel registry and message builder for Ring.
 *
 * Nothing is configured by default: `buildChannels({})` returns an empty map,
 * so a tick only writes receipts until a human explicitly configures a
 * channel. Abstract escalation labels map to providers as
 * `local -> console`, `webhook -> webhook`, `voice -> ntfy`.
 */
import { createConsoleChannel } from './console.js'
import { createNtfyChannel } from './ntfy.js'
import { createWebhookChannel } from './webhook.js'

export const CHANNEL_NAMES = Object.freeze(['webhook', 'ntfy', 'console'])

const LABELS = Object.freeze({
  webhook: 'webhook',
  ntfy: 'ntfy',
  voice: 'ntfy',
  console: 'console',
  local: 'console',
})

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const enabled = value => value !== undefined && value !== null && value !== false

/** Map an escalation-chain label or provider name to a configured provider. */
export function providerForLabel(label) {
  return typeof label === 'string' ? LABELS[label.trim().toLowerCase()] ?? null : null
}

/**
 * Build a fresh provider map from `{ webhook, ntfy, console }`. Omitted or
 * `null`/`false` entries stay disabled; passing `{}` clears every channel.
 */
export function buildChannels(input = {}) {
  if (!isObject(input)) fail('E_INPUT', 'channels must be an object')
  for (const key of Object.keys(input)) {
    if (!CHANNEL_NAMES.includes(key)) fail('E_INPUT', `unknown channel "${key}"; expected webhook, ntfy or console`)
  }
  const channels = new Map()
  if (enabled(input.webhook)) channels.set('webhook', createWebhookChannel(input.webhook))
  if (enabled(input.ntfy)) channels.set('ntfy', createNtfyChannel(input.ntfy))
  if (enabled(input.console)) channels.set('console', createConsoleChannel(input.console))
  return channels
}

/** Build the JSON-safe payload shared by every provider. No URL or secret. */
export function buildMessage(kase, channel, at) {
  const level = `t${kase.level}`
  return {
    event: 'ring.notification',
    caseId: kase.id,
    source: kase.source,
    risk: kase.risk,
    state: kase.state,
    level: kase.level,
    channel,
    title: `Ring ${level}: ${kase.risk} approval ${kase.state}`,
    body: `${kase.source} case ${kase.id.slice(0, 8)} is ${kase.state} at ${level} (${new Date(at).toISOString()}). Ack is not approval; decide in the approval seam.`,
    priority: kase.level >= 3 ? 'urgent' : kase.level >= 2 ? 'high' : 'normal',
    at,
  }
}
