/**
 * dsh-os-shell — optional UI shell contribution registry for dsh-os.
 *
 * This is a registry, not an application. Modules register view descriptors on
 * the Host seam `ctx.osShell`; the shell owns routing, shortcuts and theme. The
 * Host never imports module UI code: `ui/index.js` is a lazy client entry, and
 * a `mount` function is stored but never called here. No DOM, no framework, no
 * runtime dependencies.
 * @module dsh-os-shell
 */

import { registerBridge } from './bridge.js'
import { Oversight } from './oversight.js'

export const name = 'dsh-os-shell'

/** The optional shell still uses the host tool registry when it is present. */
export const inject = ['tools']

const ID_PATTERN = /^[a-z][a-z0-9_.-]+$/
const MODULE_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MAX_TITLE = 80
const MAX_MODULE = 214
const MAX_HISTORY = 50
const SNAPSHOT_LIMIT = 50
const VIEW_FIELDS = new Set(['id', 'title', 'module', 'mount'])

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = view => ({ ...view })

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail('E_INVALID_ARGUMENT', 'view id must match ^[a-z][a-z0-9_.-]+$')
  }
  return id
}

/** Validate one contribution and return the canonical stored shape. */
function normalizeView(input) {
  if (!isPlainObject(input)) fail('E_INVALID_ARGUMENT', 'view must be a plain object')
  for (const key of Object.keys(input)) {
    if (!VIEW_FIELDS.has(key)) fail('E_INVALID_ARGUMENT', `unknown view field "${key}"`)
  }
  const id = checkId(input.id)
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '' || title.length > MAX_TITLE) {
    fail('E_INVALID_ARGUMENT', `view title must be 1-${MAX_TITLE} characters`)
  }
  const module = typeof input.module === 'string' ? input.module.trim() : ''
  if (module === '' || module.length > MAX_MODULE || !MODULE_PATTERN.test(module)) {
    fail('E_INVALID_ARGUMENT', 'module must be a package name such as "dsh-act"')
  }
  if (input.mount !== undefined && typeof input.mount !== 'function') {
    fail('E_INVALID_ARGUMENT', 'mount must be a function when provided')
  }
  const view = { id, title, module }
  if (input.mount !== undefined) view.mount = input.mount
  return view
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(value).replace(/[&<>"']/g, character => entities[character])
}

/**
 * Render a `listViews()` result as a framework-free HTML fragment. The client
 * adapter may replace this markup; escaping is mandatory because titles are
 * module-supplied.
 */
export function render(views = []) {
  if (!Array.isArray(views)) fail('E_INVALID_ARGUMENT', 'render expects an array of views')
  if (views.length === 0) return '<ul class="dsh-os-views"></ul>'
  const items = views.map(view => '  <li data-view-id="' + escapeHtml(view.id)
    + '" data-module="' + escapeHtml(view.module) + '">'
    + escapeHtml(view.title) + '</li>')
  return ['<ul class="dsh-os-views">', ...items, '</ul>'].join('\n')
}

/** Strip a mount function before a contribution is handed to an agent tool. */
function publicView(view) {
  const { mount, ...rest } = view
  return { ...rest, mountable: typeof mount === 'function' }
}

/** JSON-safe action summary; execute/parameters never cross the HTTP boundary. */
function summarizeAction(action) {
  const summary = { id: action.id, title: action.title, risk: action.risk }
  if (typeof action.description === 'string') summary.description = action.description
  return summary
}

/** Map a check report verdict to the CLI exit code. */
function exitCodeOf(report) {
  if (!isPlainObject(report)) return null
  if (report.verdict === 'regression') return 1
  if (report.verdict === 'pass' || report.verdict === 'warning') return 0
  return null
}

/**
 * Host seam `ctx.osShell`: an in-memory view registry plus open/close history.
 *
 * One opening is recorded per `open()` call; history is trimmed to the most
 * recent {@link MAX_HISTORY} entries. `close()` is idempotent for registered
 * views so a late UI close cannot corrupt the registry.
 */
export class OsShellService {
  #views = new Map()
  #open = new Set()
  #history = []
  #now
  #getService
  #oversight

  constructor({ now = Date.now, getService = () => undefined } = {}) {
    if (typeof now !== 'function') fail('E_INVALID_ARGUMENT', 'now must be a function')
    if (typeof getService !== 'function') fail('E_INVALID_ARGUMENT', 'getService must be a function')
    this.#now = now
    this.#getService = getService
    this.#oversight = new Oversight(getService)
  }

  /** Read an optional peer service; a missing or throwing lookup is absent. */
  #service(name) {
    try {
      return this.#getService(name)
    } catch {
      return undefined
    }
  }

  registerView(input) {
    const view = normalizeView(input)
    if (this.#views.has(view.id)) fail('E_CONFLICT', `view "${view.id}" is already registered`)
    this.#views.set(view.id, view)
    return copy(view)
  }

  unregisterView(id) {
    checkId(id)
    const view = this.#views.get(id)
    if (view === undefined) fail('E_NOT_FOUND', `view "${id}" is not registered`)
    this.#views.delete(id)
    this.#open.delete(id)
    return copy(view)
  }

  listViews() {
    return [...this.#views.values()].map(copy)
  }

  /** The most recent opens, oldest first. Always a defensive copy. */
  get history() {
    return this.#history.map(entry => ({ ...entry }))
  }

  /** Ids of views currently open, for routing/highlighting by a client shell. */
  get openViews() {
    return [...this.#open]
  }

  open(id) {
    checkId(id)
    const view = this.#views.get(id)
    if (view === undefined) fail('E_NOT_FOUND', `view "${id}" is not registered`)
    this.#open.add(id)
    this.#history.push({ id, at: this.#now() })
    if (this.#history.length > MAX_HISTORY) {
      this.#history.splice(0, this.#history.length - MAX_HISTORY)
    }
    return { view: copy(view), state: 'opened' }
  }

  close(id) {
    checkId(id)
    const view = this.#views.get(id)
    if (view === undefined) fail('E_NOT_FOUND', `view "${id}" is not registered`)
    this.#open.delete(id)
    return { view: copy(view), state: 'closed' }
  }

  /** Convenience wrapper; the client may also call `render(service.listViews())`. */
  render() {
    return render(this.listViews())
  }

  /**
   * Aggregate the optional Act, Snip and Check services for the client page.
   * Each section is `{ available: false }` when its Host service is absent;
   * the shell itself never requires any of them.
   */
  async snapshot() {
    const act = this.#service('act')
    const snip = this.#service('snip')
    const sections = await Promise.all([this.#actSection(act), this.#snipSection(snip), this.checkLast()])
    return { act: sections[0], snip: sections[1], check: sections[2] }
  }

  async #actSection(act) {
    if (act === undefined || act === null || typeof act.list !== 'function') return { available: false }
    try {
      const actions = act.list()
      return {
        available: true,
        actions: Array.isArray(actions) ? actions.map(summarizeAction) : [],
      }
    } catch (error) {
      return { available: false, error: messageOf(error) }
    }
  }

  async #snipSection(snip) {
    if (snip === undefined || snip === null || typeof snip.list !== 'function') return { available: false }
    try {
      const entries = snip.list({ limit: SNAPSHOT_LIMIT })
      return {
        available: true,
        entries: Array.isArray(entries) ? entries.map(entry => ({ ...entry })) : [],
      }
    } catch (error) {
      return { available: false, error: messageOf(error) }
    }
  }

  /**
   * The most recent Check report, from `check.last()` when the 0.2 service
   * exposes it, otherwise a `last`/`lastReport` value; null when none exists.
   * Exit codes follow the CLI contract (regression 1, pass/warning 0).
   */
  async checkLast() {
    const check = this.#service('check')
    if (check === undefined || check === null) return { available: false }
    let value
    try {
      if (typeof check.last === 'function') value = await check.last()
      else value = check.last ?? check.lastReport ?? (Array.isArray(check.history) ? check.history.at(-1) ?? null : null)
    } catch (error) {
      return { available: true, last: null, exitCode: null, error: messageOf(error) }
    }
    if (value === undefined || value === null) return { available: true, last: null, exitCode: null }
    const envelope = isPlainObject(value) && isPlainObject(value.report)
    const report = envelope ? value.report : value
    const exitCode = envelope && Number.isInteger(value.exitCode) ? value.exitCode : exitCodeOf(report)
    return { available: true, last: report, exitCode }
  }

  /** Invoke an Act action as the fixed UI subject; `available: false` when absent. */
  async invokeAction(id, actionArgs) {
    const act = this.#service('act')
    if (act === undefined || act === null || typeof act.invoke !== 'function') return { available: false }
    const result = await act.invoke(id, actionArgs, { subject: 'ui:os-shell', origin: 'ui' })
    return { available: true, result }
  }

  /** Snip search (or newest-first list when empty) with full text for copying;
   * redacted entries only ever carry their `[redacted:*]` placeholder. */
  async searchSnips(query = '', limit = SNAPSHOT_LIMIT) {
    const snip = this.#service('snip')
    if (snip === undefined || snip === null
      || typeof snip.list !== 'function' || typeof snip.search !== 'function') {
      return { available: false }
    }
    const text = typeof query === 'string' ? query.trim() : ''
    const rows = text === '' ? snip.list({ limit }) : snip.search(text, { limit })
    const entries = (Array.isArray(rows) ? rows : []).map(entry => {
      if (typeof snip.get !== 'function') return { ...entry }
      try {
        const full = snip.get(entry.id)
        return typeof full?.text === 'string' ? { ...entry, text: full.text } : { ...entry }
      } catch {
        return { ...entry }
      }
    })
    return { available: true, entries }
  }

  /** Pending (or filtered) approval requests, projected for the inbox. */
  approvalList(status) {
    return this.#oversight.approvalList(status)
  }

  /** Approve once as a human; Allow validates the request hash and scope narrowing. */
  approve(id, input) {
    return this.#oversight.approve(id, input)
  }

  /** Deny once as a human; the requester cannot decide its own request. */
  deny(id, input) {
    return this.#oversight.deny(id, input)
  }

  /** Recent approval and action entries, newest first. */
  activity(limit) {
    return this.#oversight.activity(limit)
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const args = properties => ({ type: 'object', additionalProperties: false, properties })
const idArgs = { id: { type: 'string', pattern: '^[a-z][a-z0-9_.-]+$' } }

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  const views = () => service.listViews().map(publicView)
  return [
    {
      name: 'os_shell_views',
      description: 'List registered dsh-os shell views (id, title, module, mountable).',
      parameters: args({}),
      output: OUTPUT,
      async execute() {
        return { views: views() }
      },
    },
    {
      name: 'os_shell_open',
      description: 'Open a registered shell view by id and append it to open history.',
      parameters: { ...args(idArgs), required: ['id'] },
      output: OUTPUT,
      async execute(input) {
        const result = service.open(input?.id)
        return { view: publicView(result.view), state: result.state }
      },
    },
    {
      name: 'os_shell_close',
      description: 'Close a registered shell view by id. Closing a closed view is harmless.',
      parameters: { ...args(idArgs), required: ['id'] },
      output: OUTPUT,
      async execute(input) {
        const result = service.close(input?.id)
        return { view: publicView(result.view), state: result.state }
      },
    },
  ]
}

/**
 * Mount dsh-os-shell: provide `ctx.osShell`, register the three agent tools
 * when a tool registry exists, and expose the owner-only JSON routes when the
 * profile has a web server. The shell is optional; no other dsh-os module
 * depends on it, and no `ui/index.js` code is imported here.
 */
export function apply(ctx, config = {}) {
  const getService = name => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const service = new OsShellService({ ...config, getService })
  ctx.provide('osShell', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  // Do not read `ctx.webServer` directly: it is not in `inject` (the shell is
  // optional), and Cordis throws on an uninjected read. Resolve it via get().
  let webServer
  try { webServer = ctx.webServer } catch { /* not injected */ }
  if (!webServer) webServer = getService('webServer')
  if (webServer) {
    const register = () => registerBridge(webServer, service)
    if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-os-shell: routes')
    else register()
  } else if (typeof ctx.inject === 'function') {
    // Headless profiles never resolve this child; late Web servers still get routes.
    ctx.inject({ webServer: null }, child => child.effect(() => registerBridge(child.webServer, service)))
  }
  return service
}
