/** Capability descriptor validation and normalization (architecture §2). Pure ESM. */
export const RISKS = Object.freeze(['read', 'write', 'execute', 'network', 'secret', 'approval'])
export const IDEMPOTENCY = Object.freeze(['pure', 'idempotent', 'non-idempotent', 'destructive'])
export const AUDIENCES = Object.freeze(['agent', 'human', 'cli'])

const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const KEYS = new Set(['id', 'title', 'summary', 'whenToUse', 'whenNotToUse', 'inputSchema', 'outputSchema',
  'risk', 'permissions', 'cost', 'idempotency', 'examples', 'returns', 'errors', 'version', 'tags',
  'handler', 'ui', 'aliases', 'deprecated', 'audience', 'legacy', 'owner'])
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message) {
  const error = new TypeError(message)
  error.code = 'E_INVALID_ARGUMENT'
  throw error
}
const str = (value, field, max) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string`)
  if (max !== undefined && value.length > max) fail(`${field} must be at most ${max} characters`)
}
const strings = (value, field) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) fail(`${field} must be an array of non-empty strings`)
}
const optionalStrings = (value, field) => { if (value !== undefined) strings(value, field) }

/** Validate a descriptor without mutating it; returns the same object. */
export function validateDescriptor(descriptor) {
  if (!obj(descriptor)) fail('descriptor must be a plain object')
  for (const key of Object.keys(descriptor)) {
    if (!KEYS.has(key) && !key.startsWith('x-')) fail(`unknown descriptor field: ${key}`)
  }
  if (!ID.test(String(descriptor.id))) fail('id must look like "namespace.verb"')
  str(descriptor.title, 'title', 40)
  str(descriptor.summary, 'summary', 120)
  for (const field of ['whenToUse', 'whenNotToUse', 'permissions', 'tags', 'aliases', 'audience']) optionalStrings(descriptor[field], field)
  for (const field of ['inputSchema', 'outputSchema']) if (descriptor[field] !== undefined && !obj(descriptor[field])) fail(`${field} must be an object`)
  const risks = Array.isArray(descriptor.risk) ? descriptor.risk : [descriptor.risk]
  if (risks.length === 0 || risks.some(risk => !RISKS.includes(risk))) fail(`risk must contain only ${RISKS.join(', ')}`)
  if (descriptor.idempotency !== undefined && !IDEMPOTENCY.includes(descriptor.idempotency)) fail(`idempotency must be one of ${IDEMPOTENCY.join(', ')}`)
  if (descriptor.version !== undefined && !SEMVER.test(descriptor.version)) fail('version must be semver')
  if (descriptor.cost !== undefined) {
    if (!obj(descriptor.cost)) fail('cost must be an object')
    for (const field of ['tokens', 'latencyMs', 'moneyUsd']) {
      const value = descriptor.cost[field]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail(`cost.${field} must be a non-negative number`)
    }
  }
  if (descriptor.examples !== undefined && !Array.isArray(descriptor.examples)) fail('examples must be an array')
  if (descriptor.errors !== undefined) {
    if (!Array.isArray(descriptor.errors)) fail('errors must be an array')
    for (const item of descriptor.errors) if (!obj(item) || typeof item.code !== 'string' || !item.code) fail('errors[] needs a string code')
  }
  if (descriptor.ui !== undefined && descriptor.ui !== null && !obj(descriptor.ui)) fail('ui must be an object or null')
  if (descriptor.deprecated !== undefined && descriptor.deprecated !== null && !obj(descriptor.deprecated)) fail('deprecated must be an object or null')
  if (descriptor.audience !== undefined) for (const item of descriptor.audience) if (!AUDIENCES.includes(item)) fail(`audience must contain only ${AUDIENCES.join(', ')}`)
  if (typeof descriptor.handler !== 'function') fail('handler must be a function')
  return descriptor
}

const freeze = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value)) freeze(value[key], seen)
  return Object.freeze(value)
}
const copy = value => Array.isArray(value) ? value.map(copy)
  : obj(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value

/** Validate, fill defaults, detach and freeze. `toJSON()` strips the handler. */
export function normalizeDescriptor(descriptor) {
  validateDescriptor(descriptor)
  const out = copy(descriptor)
  out.risk = [...new Set(Array.isArray(descriptor.risk) ? descriptor.risk : [descriptor.risk])]
  out.whenToUse = [...(descriptor.whenToUse ?? [])]
  out.whenNotToUse = [...(descriptor.whenNotToUse ?? [])]
  out.inputSchema = copy(descriptor.inputSchema ?? { type: 'object', additionalProperties: true })
  out.outputSchema = copy(descriptor.outputSchema ?? { type: 'object', additionalProperties: true })
  out.permissions = [...(descriptor.permissions ?? [])]
  const cost = descriptor.cost ?? {}
  out.cost = { tokens: cost.tokens ?? 0, latencyMs: cost.latencyMs ?? 0, moneyUsd: cost.moneyUsd ?? cost.money ?? 0 }
  out.idempotency = descriptor.idempotency ?? 'pure'
  out.examples = copy(descriptor.examples ?? [])
  out.returns = descriptor.returns ?? descriptor.summary
  out.errors = copy(descriptor.errors ?? [])
  out.version = descriptor.version ?? '1.0.0'
  out.tags = [...(descriptor.tags ?? [])]
  out.ui = copy(descriptor.ui ?? null)
  out.aliases = [...(descriptor.aliases ?? [])]
  out.deprecated = copy(descriptor.deprecated ?? null)
  out.audience = [...(descriptor.audience ?? AUDIENCES)]
  if (descriptor.legacy === true) out.legacy = true
  Object.defineProperty(out, 'toJSON', { enumerable: false, value() { const plain = { ...this }; delete plain.handler; return plain } })
  return freeze(out)
}
