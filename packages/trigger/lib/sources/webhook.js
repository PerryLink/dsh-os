/** Webhook source: loopback-only `POST /os-trigger/<token>` with optional HMAC. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createDedupe, fail } from './shared.js'

const TOKEN = /^[A-Za-z0-9_-]{8,128}$/
const DEFAULT_MAX_BODY = 262_144
const DEFAULT_WINDOW_MS = 300_000

const isLoopback = address => {
  const value = String(address ?? '').replace(/^::ffff:/, '')
  return value === 'localhost' || value === '::1' || value.startsWith('127.')
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** Collect at most `limit` bytes; `null` means the sender exceeded it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) finish(null)
      else chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => reject(fail('E_UNAVAILABLE', 'webhook request aborted')))
  })
}

export function createWebhookSource(ctx, opts, emit) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    throw fail('E_UNAVAILABLE', 'webhook source needs ctx.webServer; this profile has no web server')
  }
  const token = opts.token === undefined ? randomBytes(16).toString('hex') : String(opts.token)
  if (!TOKEN.test(token)) throw fail('invalid_source', 'webhook token must be 8-128 chars of [A-Za-z0-9_-]')
  const path = `/os-trigger/${token}`
  const maxBodyBytes = Number.isSafeInteger(opts.maxBodyBytes) && opts.maxBodyBytes > 0
    ? opts.maxBodyBytes : DEFAULT_MAX_BODY
  const replayWindowMs = Number.isSafeInteger(opts.replayWindowMs) && opts.replayWindowMs > 0
    ? opts.replayWindowMs : DEFAULT_WINDOW_MS
  const loopbackOnly = opts.allowNonLoopback !== true
  if (loopbackOnly && !isLoopback(webServer.host)) {
    throw fail('E_UNAVAILABLE', `webhook source needs a loopback ctx.webServer.host (got ${String(webServer.host)})`)
  }
  const secret = typeof opts.secret === 'string' && opts.secret !== ''
    ? opts.secret
    : typeof opts.secretEnv === 'string' && process.env[opts.secretEnv]
      ? process.env[opts.secretEnv]
      : null
  const seen = createDedupe(opts.dedupeLimit)
  const stats = { emitted: 0, skipped: 0, rejected: 0 }
  let dispose = null
  let running = false
  const reject = (res, status, reason) => {
    stats.rejected += 1
    send(res, status, { ok: false, error: reason })
  }

  async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method' }, { allow: 'POST' })
        return
      }
      if (!running) return reject(res, 503, 'stopped')
      const remote = req.socket?.remoteAddress
      if (loopbackOnly && !isLoopback(remote)) return reject(res, 403, 'loopback')
      const headers = req.headers ?? {}
      const declared = Number(headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBodyBytes) return reject(res, 413, 'body-too-large')
      const raw = await readBody(req, maxBodyBytes)
      if (raw === null) {
        stats.rejected += 1
        send(res, 413, { ok: false, error: 'body-too-large' }, { connection: 'close' })
        return
      }
      if (secret !== null) {
        const stamp = String(headers['x-dsh-trigger-timestamp'] ?? '')
        const timestamp = Number(stamp)
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp * 1000) > replayWindowMs) {
          return reject(res, 401, 'timestamp')
        }
        const digest = createHmac('sha256', secret).update(`${stamp}.`).update(raw).digest()
        const claimed = String(headers['x-dsh-trigger-signature-256'] ?? '')
        const provided = claimed.startsWith('sha256=') ? Buffer.from(claimed.slice(7), 'hex') : Buffer.alloc(0)
        if (provided.length !== digest.length || !timingSafeEqual(provided, digest)) return reject(res, 401, 'signature')
      }
      let body
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return reject(res, 400, 'json')
      }
      const deliveryId = String(
        headers['x-github-delivery'] ?? createHash('sha256').update(raw).digest('hex'),
      )
      if (!seen.add(deliveryId)) {
        stats.skipped += 1
        send(res, 202, { ok: true, duplicate: true }, { 'x-dsh-trigger-duplicate': '1' })
        return
      }
      stats.emitted += 1
      emit({
        type: 'webhook/received',
        deliveryId,
        event: headers['x-github-event'] ?? null,
        body,
        remote: String(remote ?? ''),
      })
      send(res, 202, { ok: true, deliveryId })
    } catch {
      stats.rejected += 1
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal' })
    }
  }

  return {
    async start() {
      if (running) return
      try {
        dispose = webServer.register({ kind: 'exact', path, auth: 'anonymous', handler })
      } catch (error) {
        dispose = null
        throw fail('E_UNAVAILABLE', `webhook route ${path} is already registered: ${String(error?.message ?? error)}`)
      }
      running = true
    },
    async stop() {
      running = false
      const remove = dispose
      dispose = null
      if (remove !== null) remove()
    },
    describe: () => ({
      path, method: 'POST', signed: secret !== null, loopbackOnly, maxBodyBytes, replayWindowMs, ...stats,
    }),
  }
}
