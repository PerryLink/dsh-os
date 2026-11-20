/**
 * dsh-os-shell Host JSON bridge: four exact owner-only routes for the client.
 * `registerBridge` is a no-op without `ctx.webServer`; handlers answer JSON.
 * @module @perrylink/dsh-os-shell/bridge
 */
const SNAPSHOT_LIMIT = 50
const MAX_BODY = 64 * 1024
const API = Object.freeze({
  snapshot: '/api/os-shell/snapshot',
  actInvoke: '/api/os-shell/act/invoke',
  snipSearch: '/api/os-shell/snip/search',
  checkLast: '/api/os-shell/check/last',
})
const messageOf = error => (error instanceof Error ? error.message : String(error))
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function limitOf(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.min(Math.floor(number), SNAPSHOT_LIMIT) : SNAPSHOT_LIMIT
}
/** Write one JSON response; a non-serializable payload becomes a clean 500. */
function send(res, status, payload) {
  let body
  try { body = JSON.stringify(payload) } catch { status = 500; body = '{"ok":false,"code":"serialization_failed"}' }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
/** Read a bounded JSON request body; rejects with a stable `code`. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 'request_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('request body must be JSON'), { code: 'invalid_json' }))
      }
    })
    req.on('error', reject)
  })
}
function allow(req, res, method) {
  if (String(req.method ?? 'GET').toUpperCase() === method) return true
  res.setHeader('allow', method)
  send(res, 405, { ok: false, code: 'method_not_allowed' })
  return false
}
function snapshotHandler(service) {
  return async (req, res) => {
    if (!allow(req, res, 'GET')) return
    try {
      send(res, 200, { ok: true, snapshot: await service.snapshot() })
    } catch (error) {
      send(res, 500, { ok: false, code: 'internal_error', message: messageOf(error) })
    }
  }
}
function actInvokeHandler(service) {
  return async (req, res) => {
    if (!allow(req, res, 'POST')) return
    let input
    try { input = await readJson(req) } catch (error) {
      send(res, error.code === 'request_too_large' ? 413 : 400, {
        ok: false, code: error.code ?? 'invalid_json',
      })
      return
    }
    if (!isPlainObject(input) || typeof input.id !== 'string' || input.id === '') {
      send(res, 400, { ok: false, code: 'invalid_argument', message: 'id must be a non-empty string' })
      return
    }
    try {
      const outcome = await service.invokeAction(input.id, input.args)
      if (!outcome.available) {
        send(res, 503, { ok: false, code: 'service_unavailable', service: 'act' })
        return
      }
      send(res, 200, outcome.result)
    } catch (error) {
      send(res, 500, { ok: false, code: 'internal_error', message: messageOf(error) })
    }
  }
}
function snipSearchHandler(service) {
  return async (req, res) => {
    if (!allow(req, res, 'GET')) return
    let query = ''; let limit = SNAPSHOT_LIMIT
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      query = url.searchParams.get('q') ?? ''
      limit = limitOf(url.searchParams.get('limit'))
    } catch {
      // A malformed URL falls back to the newest-first list.
    }
    try {
      const outcome = await service.searchSnips(query, limit)
      if (!outcome.available) {
        send(res, 503, { ok: false, code: 'service_unavailable', service: 'snip' })
        return
      }
      send(res, 200, { ok: true, entries: outcome.entries })
    } catch (error) {
      const status = String(error?.code ?? '').startsWith('SNIP_') ? 400 : 500
      send(res, status, { ok: false, code: error?.code ?? 'internal_error', message: messageOf(error) })
    }
  }
}
function checkLastHandler(service) {
  return async (req, res) => {
    if (!allow(req, res, 'GET')) return
    try {
      send(res, 200, { ok: true, ...await service.checkLast() })
    } catch (error) {
      send(res, 500, { ok: false, code: 'internal_error', message: messageOf(error) })
    }
  }
}
/** Exact routes for `ctx.webServer`; usable with any compatible fake. */
export function createBridge(service) {
  return [
    { kind: 'exact', path: API.snapshot, handler: snapshotHandler(service) },
    { kind: 'exact', path: API.actInvoke, handler: actInvokeHandler(service) },
    { kind: 'exact', path: API.snipSearch, handler: snipSearchHandler(service) },
    { kind: 'exact', path: API.checkLast, handler: checkLastHandler(service) },
  ]
}
/** Register the four JSON routes when a webserver exists, else do nothing. */
export function registerBridge(webServer, service) {
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return []
  return createBridge(service).map(route => webServer.register(route))
}
