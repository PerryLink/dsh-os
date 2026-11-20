/**
 * Webhook notification channel: one JSON POST, optional HMAC-SHA256 signature.
 *
 * The URL and the signing secret are captured in this closure and are never
 * echoed in errors, receipts or logs. Failures are surfaced as `E_UNAVAILABLE`
 * with a status-only message so a URL that carries a token cannot leak.
 */
import { createHmac } from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 5000
export const MAX_TIMEOUT_MS = 2147483647
const MAX_URL = 4096
const MAX_SECRET = 512

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function readUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('E_INPUT', 'webhook.url must be a non-empty string')
  const text = value.trim()
  if (text.length > MAX_URL) fail('E_INPUT', `webhook.url must be at most ${MAX_URL} characters`)
  let url
  try {
    url = new URL(text)
  } catch {
    fail('E_INPUT', 'webhook.url must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('E_INPUT', 'webhook.url must use http or https')
  if (url.username !== '' || url.password !== '') {
    fail('E_INPUT', 'webhook.url must not embed credentials; use the secret field for signing')
  }
  return text
}

function readSecret(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || value === '') fail('E_INPUT', 'webhook.secret must be a non-empty string')
  if (value.length > MAX_SECRET) fail('E_INPUT', `webhook.secret must be at most ${MAX_SECRET} characters`)
  return value
}

function readTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    fail('E_INPUT', `webhook.timeoutMs must be a positive finite number of at most ${MAX_TIMEOUT_MS} ms`)
  }
  return value
}

const statusOf = response => (typeof response?.status === 'number' ? response.status : 0)
const succeeded = response => {
  const status = statusOf(response)
  return status === 0 ? response?.ok === true : status >= 200 && status < 300
}

async function discard(response) {
  try {
    await response?.body?.cancel()
  } catch {
    // The status is the only thing this channel needs from the response.
  }
}

/** Build a webhook adapter. Throws `E_INPUT` for invalid configuration. */
export function createWebhookChannel(config) {
  if (typeof config === 'string') config = { url: config }
  if (!isObject(config)) fail('E_INPUT', 'webhook config must be an object or a URL string')
  const url = readUrl(config.url)
  const secret = readSecret(config.secret ?? config.hmacSecret)
  const timeoutMs = readTimeout(config.timeoutMs)

  return Object.freeze({
    name: 'webhook',
    async send(message) {
      const fetchImpl = globalThis.fetch
      if (typeof fetchImpl !== 'function') fail('E_UNAVAILABLE', 'webhook delivery requires global fetch')
      const body = JSON.stringify(message)
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'dsh-ring/0.2.0',
      }
      if (secret !== null) {
        const digest = createHmac('sha256', secret).update(body).digest('hex')
        headers['X-Ring-Signature'] = `sha256=${digest}`
      }
      const signal = AbortSignal.timeout(timeoutMs)
      let response
      try {
        response = await fetchImpl(url, { method: 'POST', headers, body, signal })
      } catch {
        if (signal.aborted) fail('E_UNAVAILABLE', `webhook delivery timed out after ${timeoutMs} ms`)
        fail('E_UNAVAILABLE', 'webhook delivery failed')
      }
      if (!succeeded(response)) {
        const status = statusOf(response)
        await discard(response)
        fail('E_UNAVAILABLE', status === 0 ? 'webhook delivery failed' : `webhook delivery failed with HTTP ${status}`)
      }
      await discard(response)
      return { status: statusOf(response) }
    },
  })
}

export default createWebhookChannel
