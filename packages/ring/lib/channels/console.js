/**
 * Console notification channel: append one plain-text line to stdout.
 *
 * This is a local, dependency-free channel for tests and self-hosted setups.
 * It is never enabled by default, writes no configuration or URLs, and an
 * injected `write` function keeps tests off the real stdout stream.
 */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function readWriter(value) {
  if (value === undefined) return line => process.stdout.write(`${line}\n`)
  if (typeof value !== 'function') fail('E_INPUT', 'console.write must be a function')
  return value
}

const oneLine = value => value.replace(/[\r\n]+/g, ' ')

function format(message) {
  const at = typeof message.at === 'number' && Number.isFinite(message.at) ? new Date(message.at).toISOString() : 'unknown-time'
  const title = oneLine(typeof message.title === 'string' ? message.title : 'ring notification')
  const body = oneLine(typeof message.body === 'string' ? message.body : '')
  return `[dsh-ring] ${at} ${title}${body === '' ? '' : ` :: ${body}`}`
}

/** Build a console adapter. `true` uses the process stdout writer. */
export function createConsoleChannel(config = {}) {
  if (config === true) config = {}
  if (!isObject(config)) fail('E_INPUT', 'console config must be an object or true')
  const write = readWriter(config.write)
  return Object.freeze({
    name: 'console',
    async send(message) {
      try {
        await write(format(message))
      } catch {
        fail('E_UNAVAILABLE', 'console delivery failed')
      }
      return {}
    },
  })
}

export default createConsoleChannel
