/**
 * @perrylink/dsh-os-shell — optional UI shell contribution registry for dsh-os.
 *
 * This is a registry, not an application. Modules register view descriptors on
 * the Host seam `ctx.osShell`; the shell owns routing, shortcuts and theme. The
 * Host never imports module UI code: `ui/index.js` is a lazy client entry, and
 * a `mount` function is stored but never called here. No DOM, no framework, no
 * runtime dependencies.
 * @module @perrylink/dsh-os-shell
 */

export const name = 'dsh-os-shell'

/** The optional shell still uses the host tool registry when it is present. */
export const inject = ['tools']

const ID_PATTERN = /^[a-z][a-z0-9_.-]+$/
const MODULE_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MAX_TITLE = 80
const MAX_MODULE = 214
const MAX_HISTORY = 50
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

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') fail('E_INVALID_ARGUMENT', 'now must be a function')
    this.#now = now
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
 * Mount dsh-os-shell: provide `ctx.osShell` and, when available, register the
 * three agent tools. The shell is optional; no other dsh-os module depends on
 * it, and no `ui/index.js` code is imported here.
 */
export function apply(ctx, config = {}) {
  const service = new OsShellService(config)
  ctx.provide('osShell', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const tool of createTools(service)) ctx.tools.register(tool)
  }
  return service
}
