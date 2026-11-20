/**
 * ntfy notification channel: POST one message to `https://ntfy.sh/<topic>` (or
 * a self-hosted `baseUrl`), with `Priority` and optional `Actions` headers.
 *
 * A topic is a bearer secret: the default is off, a topic must be URL-safe and
 * must not contain credential syntax or a password, and a `baseUrl` may not
 * embed a username/password. The URL is never echoed in errors or receipts.
 */
export const DEFAULT_BASE_URL = 'https://ntfy.sh'
export const DEFAULT_TIMEOUT_MS = 5000
export const MAX_TIMEOUT_MS = 2147483647
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const PRIORITY_HEADERS = Object.freeze({ low: '2', normal: '3', high: '4', urgent: '5' })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function readTopic(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('E_INPUT', 'ntfy.topic must be a non-empty string')
  const topic = value.trim()
  if (!TOPIC_PATTERN.test(topic)) {
    fail('E_INPUT', 'ntfy.topic must be 1-64 URL-safe characters and must not contain credentials or a password')
  }
  if (/password|passwd|pwd/i.test(topic)) fail('E_INPUT', 'ntfy.topic must not contain a password')
  return topic
}

function readBaseUrl(value) {
  const text = value === undefined ? DEFAULT_BASE_URL : value
  if (typeof text !== 'string' || text.trim() === '') fail('E_INPUT', 'ntfy.baseUrl must be a non-empty string')
  let url
  try {
    url = new URL(text.trim())
  } catch {
    fail('E_INPUT', 'ntfy.baseUrl must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('E_INPUT', 'ntfy.baseUrl must use http or https')
  if (url.username !== '' || url.password !== '') {
    fail('E_INPUT', 'ntfy.baseUrl must not embed credentials; use a private topic or self-hosting')
  }
  if (url.search !== '' || url.hash !== '') fail('E_INPUT', 'ntfy.baseUrl must not contain a query or fragment')
  return url.href.replace(/\/+$/, '')
}

function readPriority(value) {
  if (value === undefined) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) return String(value)
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (PRIORITY_HEADERS[key] !== undefined) return PRIORITY_HEADERS[key]
    if (/^[1-5]$/.test(key)) return key
  }
  fail('E_INPUT', 'ntfy.priority must be low, normal, high, urgent or an integer from 1 to 5')
}

function readActions(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') fail('E_INPUT', 'ntfy.actions must be a non-empty string')
  const text = value.trim()
  if (text.includes('\r') || text.includes('\n')) fail('E_INPUT', 'ntfy.actions must fit on one header line')
  if (text.length > 1024) fail('E_INPUT', 'ntfy.actions must be at most 1024 characters')
  return text
}

function readTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    fail('E_INPUT', `ntfy.timeoutMs must be a positive finite number of at most ${MAX_TIMEOUT_MS} ms`)
  }
  return value
}

/** Headers are ASCII; non-printable or non-ASCII text belongs in the body. */
const headerText = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '?').slice(0, 200)

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

/** Build an ntfy adapter. Throws `E_INPUT` for invalid configuration. */
export function createNtfyChannel(config) {
  if (typeof config === 'string') config = { topic: config }
  if (!isObject(config)) fail('E_INPUT', 'ntfy config must be an object or a topic string')
  const topic = readTopic(config.topic)
  const baseUrl = readBaseUrl(config.baseUrl)
  const fixedPriority = readPriority(config.priority)
  const actions = readActions(config.actions ?? config.action)
  const timeoutMs = readTimeout(config.timeoutMs)
  const url = `${baseUrl}/${encodeURIComponent(topic)}`

  return Object.freeze({
    name: 'ntfy',
    async send(message) {
      const fetchImpl = globalThis.fetch
      if (typeof fetchImpl !== 'function') fail('E_UNAVAILABLE', 'ntfy delivery requires global fetch')
      const priority = fixedPriority ?? PRIORITY_HEADERS[message.priority] ?? '3'
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'User-Agent': 'dsh-ring/0.2.0',
        Priority: priority,
      }
      const title = headerText(message.title)
      if (title !== '') headers.Title = title
      if (actions !== null) headers.Actions = actions
      const body = typeof message.body === 'string' && message.body !== '' ? message.body : title
      const signal = AbortSignal.timeout(timeoutMs)
      let response
      try {
        response = await fetchImpl(url, { method: 'POST', headers, body, signal })
      } catch {
        if (signal.aborted) fail('E_UNAVAILABLE', `ntfy delivery timed out after ${timeoutMs} ms`)
        fail('E_UNAVAILABLE', 'ntfy delivery failed')
      }
      if (!succeeded(response)) {
        const status = statusOf(response)
        await discard(response)
        fail('E_UNAVAILABLE', status === 0 ? 'ntfy delivery failed' : `ntfy delivery failed with HTTP ${status}`)
      }
      await discard(response)
      return { status: statusOf(response) }
    },
  })
}

export default createNtfyChannel
