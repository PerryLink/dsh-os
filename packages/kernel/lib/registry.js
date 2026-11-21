/** Capability registry: Map + filters, lazy handlers, conflicts and invoke. */
import { normalizeDescriptor } from './descriptor.js'

const CODES = new Set(['E_INVALID_ARGUMENT', 'E_DENIED', 'E_NOT_FOUND', 'E_CONFLICT', 'E_UNAVAILABLE', 'E_LIMIT', 'E_STATE', 'E_TIMEOUT', 'E_INTERNAL'])
const META_KEYS = ['id', 'title', 'summary', 'whenToUse', 'whenNotToUse', 'risk', 'tags', 'cost']
const META_HANDLER = async () => { throw new Error('meta handler must never run') }
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function conflict(message) {
  const error = new Error(message)
  error.code = 'E_CONFLICT'
  throw error
}
function canonical(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(',')}]`
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`
}
function fnv(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(16)
}
const fingerprint = (value, handler) => fnv(`${handler ? Function.prototype.toString.call(handler) : ''}\n${canonical(value)}`)
const pickMeta = descriptor => Object.fromEntries(META_KEYS.map(key => [key, descriptor[key]]))
const sameMeta = (left, right) => canonical(pickMeta(left)) === canonical(pickMeta(right))
const summaryOf = descriptor => typeof descriptor.toJSON === 'function' ? descriptor.toJSON() : { ...descriptor }

function normalizeMeta(raw) {
  if (!obj(raw)) conflict('lazy capability needs a meta object')
  return summaryOf(normalizeDescriptor({ ...raw, whenToUse: raw.whenToUse ?? [], whenNotToUse: raw.whenNotToUse ?? [], handler: META_HANDLER }))
}
function compareVersion(left, right) {
  const a = String(left).split('-')[0].split('.').map(Number)
  const b = String(right).split('-')[0].split('.').map(Number)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}
function checkInput(schema, value) {
  if (!obj(schema) || schema.type === undefined) return null
  if (schema.type === 'object') {
    if (!obj(value)) return 'must be an object'
    for (const key of schema.required ?? []) if (value[key] === undefined) return `missing required property "${key}"`
    const properties = obj(schema.properties) ? schema.properties : {}
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) return `unknown property "${key}"`
        continue
      }
      const error = checkInput(properties[key], value[key])
      if (error) return `${key}: ${error}`
    }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return 'must be an array'
    if (schema.minItems !== undefined && value.length < schema.minItems) return 'has too few items'
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return 'has too many items'
    for (const item of value) { const error = checkInput(schema.items, item); if (error) return error }
    return null
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'must be a string'
    if (schema.minLength !== undefined && value.length < schema.minLength) return 'is too short'
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return 'is too long'
  } else if (schema.type === 'integer') { if (!Number.isInteger(value)) return 'must be an integer' }
  else if (schema.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number' }
  else if (schema.type === 'boolean') { if (typeof value !== 'boolean') return 'must be a boolean' }
  if (schema.enum !== undefined && !schema.enum.includes(value)) return 'is not an allowed value'
  if (schema.minimum !== undefined && value < schema.minimum) return `must be >= ${schema.minimum}`
  if (schema.maximum !== undefined && value > schema.maximum) return `must be <= ${schema.maximum}`
  return null
}
function score(descriptor, word) {
  if (!word) return 0
  const fields = [
    [String(descriptor.id).toLowerCase(), 5], [String(descriptor.title).toLowerCase(), 3],
    [String(descriptor.summary).toLowerCase(), 2], [descriptor.tags.join(' ').toLowerCase(), 2],
    [(descriptor.whenToUse ?? []).join(' ').toLowerCase(), 1],
  ]
  let total = 0
  for (const [text, weight] of fields) {
    if (!text) continue
    if (text === word) total += weight * 2
    else if (text.includes(word)) total += weight
  }
  return total
}

/** Ordered capability map with filters, lazy entries and normalized invoke results. */
export class CapabilityRegistry {
  constructor({ authorize, ctx = null, strict = false, allowDowngrade = false, override = false } = {}) {
    this.authorize = typeof authorize === 'function' ? authorize : null
    this.ctx = ctx
    this.strict = strict === true
    this.allowDowngrade = allowDowngrade === true
    this.override = override === true
    this.entries = new Map()
    this.aliases = new Map()
  }

  /** Register one descriptor, an array, or `{ id, meta, load }`; returns unregister(). */
  register(input, options = {}) {
    if (Array.isArray(input)) { const undo = input.map(item => this.register(item, options)); return () => { for (const fn of undo) fn() } }
    if (!obj(input)) throw Object.assign(new TypeError('descriptor must be an object'), { code: 'E_INVALID_ARGUMENT' })
    return typeof input.load === 'function' && input.meta ? this.#lazy(input, options) : this.#descriptor(input, options)
  }

  #aliases(descriptor) {
    if (new Set(descriptor.aliases).size !== descriptor.aliases.length) conflict(`duplicate aliases on ${descriptor.id}`)
    for (const alias of descriptor.aliases) {
      if (alias !== descriptor.id && (this.entries.has(alias) || (this.aliases.has(alias) && this.aliases.get(alias) !== descriptor.id))) {
        conflict(`alias "${alias}" of ${descriptor.id} collides with an existing entry`)
      }
    }
  }

  #store(entry, descriptor) {
    this.entries.set(descriptor.id, entry)
    for (const alias of descriptor.aliases) if (alias !== descriptor.id) this.aliases.set(alias, descriptor.id)
    return () => this.entries.get(entry.id) === entry ? this.unregister(entry.id, entry.owner) : false
  }

  #descriptor(raw, options) {
    const descriptor = normalizeDescriptor(raw)
    this.#aliases(descriptor)
    const owner = options.owner ?? descriptor.owner ?? 'default'
    const existing = this.entries.get(descriptor.id)
    if (existing && !(this.override || options.override)) {
      if (existing.owner !== owner) conflict(`${descriptor.id} is owned by ${existing.owner}`)
      const order = compareVersion(descriptor.version, existing.version)
      if (order === 0) {
        if (existing.fingerprint !== fingerprint(descriptor, descriptor.handler)) conflict(`${descriptor.id}@${descriptor.version} is already registered with a different handler`)
        return () => false
      }
      if (order < 0 && !(this.allowDowngrade || options.allowDowngrade)) conflict(`${descriptor.id}@${descriptor.version} would downgrade ${existing.version}`)
    }
    if (existing) for (const [alias, target] of this.aliases) if (target === descriptor.id) this.aliases.delete(alias)
    const entry = { id: descriptor.id, owner, version: descriptor.version, descriptor, fingerprint: fingerprint(descriptor, descriptor.handler), lazy: false }
    return this.#store(entry, descriptor)
  }

  #lazy(input, options) {
    const meta = normalizeMeta(input.meta)
    const owner = options.owner ?? meta.owner ?? 'default'
    const existing = this.entries.get(meta.id)
    if (existing && !(this.override || options.override)) {
      if (existing.owner !== owner) conflict(`${meta.id} is owned by ${existing.owner}`)
      if (existing.version === meta.version && existing.fingerprint === fingerprint(meta)) return () => false
      if (compareVersion(meta.version, existing.version) < 0 && !this.allowDowngrade) conflict(`${meta.id} would downgrade ${existing.version}`)
      if (existing.version === meta.version) conflict(`${meta.id}@${meta.version} is already registered with different metadata`)
    }
    const entry = { id: meta.id, owner, version: meta.version, meta, load: input.load, descriptor: null, promise: null, fingerprint: fingerprint(meta), lazy: true }
    this.entries.set(meta.id, entry)
    return () => this.entries.get(entry.id) === entry ? this.unregister(entry.id, owner) : false
  }

  /** Remove by id; only the owner may remove it. */
  unregister(id, owner) {
    const entry = this.entries.get(id)
    if (!entry || (owner !== undefined && entry.owner !== owner)) return false
    this.entries.delete(id)
    for (const [alias, target] of this.aliases) if (target === id) this.aliases.delete(alias)
    return true
  }

  /** Resolve an id or alias: descriptor, Promise for a lazy entry, or null. */
  resolve(idOrAlias) {
    const entry = this.entries.get(this.aliases.get(idOrAlias) ?? idOrAlias)
    if (!entry) return null
    return entry.descriptor ?? this.#load(entry)
  }

  async #load(entry) {
    if (entry.descriptor) return entry.descriptor
    if (!entry.promise) {
      entry.promise = Promise.resolve().then(entry.load).then(raw => {
        const descriptor = normalizeDescriptor(raw)
        if (!sameMeta(descriptor, entry.meta)) conflict(`${entry.id} loaded descriptor does not match its metadata`)
        entry.descriptor = descriptor
        entry.promise = null
        return descriptor
      }).catch(error => { entry.promise = null; throw error })
    }
    return entry.promise
  }

  /** Filtered, id-sorted summaries. Namespace/risk/tag/q plus limit and offset cursor. */
  list(filter = {}) {
    const limit = Math.min(Math.max(Number.isInteger(filter.limit) ? filter.limit : 50, 1), 200)
    const offset = Math.max(Number.isInteger(filter.cursor) ? filter.cursor : Number(filter.cursor) || 0, 0)
    const caps = filter.capability === undefined ? null : Array.isArray(filter.capability) ? filter.capability : [filter.capability]
    const risks = filter.risk === undefined ? null : Array.isArray(filter.risk) ? filter.risk : [filter.risk]
    const tagFilter = filter.tag ?? filter.tags
    const tags = tagFilter === undefined ? null : Array.isArray(tagFilter) ? tagFilter : [tagFilter]
    const items = []
    for (const entry of this.entries.values()) {
      const descriptor = entry.descriptor ?? entry.meta
      if (filter.includeDeprecated !== true && descriptor.deprecated) continue
      if (caps && !caps.includes(descriptor.id.split('.')[0])) continue
      if (risks && !descriptor.risk.some(risk => risks.includes(risk))) continue
      if (tags && !tags.every(tag => descriptor.tags.includes(tag))) continue
      if (filter.q && score(descriptor, filter.q) === 0) continue
      items.push(descriptor)
    }
    return items.sort((left, right) => left.id.localeCompare(right.id)).slice(offset, offset + limit).map(summaryOf)
  }

  /** Weighted substring search over id/title/summary/tags/whenToUse. */
  search(query, { limit = 5 } = {}) {
    const text = String(query ?? '').trim().toLowerCase()
    if (!text) return []
    const scored = []
    for (const entry of this.entries.values()) {
      const descriptor = entry.descriptor ?? entry.meta
      const value = text.split(/\s+/).reduce((total, word) => total + score(descriptor, word), 0)
      if (value > 0) scored.push({ descriptor, value: value + (score(descriptor, text) > 0 ? 2 : 0) })
    }
    return scored.sort((left, right) => right.value - left.value || left.descriptor.id.localeCompare(right.descriptor.id))
      .slice(0, Math.min(Math.max(limit, 1), 200)).map(item => summaryOf(item.descriptor))
  }

  /** Sorted ids (aliases excluded). */
  names() { return [...this.entries.keys()].sort() }

  /** Resolve, validate, authorize, run, and normalize errors. */
  async invoke(id, input = {}, options = {}) {
    const descriptor = await this.resolve(id)
    if (!descriptor) return { ok: false, code: 'E_NOT_FOUND', message: `no capability named "${id}"` }
    if (!obj(input)) return { ok: false, code: 'E_INVALID_ARGUMENT', message: 'input must be an object' }
    const invalid = checkInput(descriptor.inputSchema, input)
    if (invalid) return { ok: false, code: 'E_INVALID_ARGUMENT', message: `invalid input: ${invalid}` }
    if (this.authorize) {
      try {
        const decision = await this.authorize(descriptor, { ...options, input })
        if (decision === false || decision?.allowed === false) return { ok: false, code: 'E_DENIED', message: `not authorized to invoke ${descriptor.id}` }
      } catch (error) { return { ok: false, code: typeof error?.code === 'string' ? error.code : 'E_INTERNAL', message: error?.message ?? String(error) } }
    }
    const exec = { subject: options.subject ?? null, agent: options.agent ?? null, signal: options.signal, requestId: options.requestId, grant: options.grant, ctx: options.ctx ?? this.ctx }
    try {
      const value = await descriptor.handler(input, exec.ctx, exec)
      if (value === undefined) return { ok: false, code: 'E_STATE', message: `${descriptor.id} handler returned undefined` }
      if (this.strict) {
        const bad = checkInput(descriptor.outputSchema, value)
        if (bad) return { ok: false, code: 'E_STATE', message: `output does not match outputSchema: ${bad}` }
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, code: CODES.has(error?.code) ? error.code : 'E_UNAVAILABLE', message: error?.message ?? String(error), legacyCode: error?.code }
    }
  }
}

export { fingerprint, canonical, checkInput as validateInput }
export const createRegistry = options => new CapabilityRegistry(options)
