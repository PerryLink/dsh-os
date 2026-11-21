import { readFileSync, statSync } from 'node:fs'

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/
const RESERVED = new Set(['os_find', 'os_help', 'os_status'])
const MAX_CARDS = 64
const MAX_FILE_BYTES = 256 * 1024
const MAX_SCHEMA_BYTES = 8 * 1024
const MAX_SAMPLE_BYTES = 16 * 1024

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum })
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

/**
 * Three read-only sample cards used when no --catalog file is supplied.
 * They exist to demonstrate the projection; they are not a DSH connection and
 * every call is labelled `sample: true`.
 */
export const BUILTIN_CARDS = [
  {
    tool: 'snip_search',
    title: 'Search clipboard captures',
    description: 'Search local clipboard captures and snippets by query. Read-only example capability; returns built-in sample rows until a dsh-os host adapter is connected.',
    readOnly: true,
    keywords: ['clipboard', 'clip', 'snippet', 'capture', 'snip', '剪贴板', '粘贴', '搜索'],
    inputSchema: objectSchema({
      query: string('Text to search for in clipboard captures.', { minLength: 1, maxLength: 512 }),
      limit: integer('Maximum number of captures to return.', 1, 20),
    }, ['query']),
    sample: {
      items: [{ id: 'snip_sample_1', text: 'pnpm run check — read-only MCP prototype', source: 'window', capturedAt: '2026-11-21T00:00:00.000Z' }],
      total: 1,
    },
  },
  {
    tool: 'seek_search',
    title: 'Search evidence references',
    description: 'Search verifiable evidence references with freshness metadata. Read-only example capability; returns built-in sample rows until a host adapter is connected.',
    readOnly: true,
    keywords: ['evidence', 'source', 'citation', 'proof', 'seek', '证据', '来源', '取证', '检索'],
    inputSchema: objectSchema({
      query: string('Text to search for in evidence references.', { minLength: 1, maxLength: 512 }),
      limit: integer('Maximum number of references to return.', 1, 20),
    }, ['query']),
    sample: {
      items: [{ ref: 'file:///dsh-os/README.md', title: 'dsh-os README', score: 0.91, fresh: true }],
      total: 1,
    },
  },
  {
    tool: 'trace_search',
    title: 'Search durable memory',
    description: 'Search decisions and remembered facts with provenance. Read-only example capability; returns built-in sample rows until a host adapter is connected.',
    readOnly: true,
    keywords: ['memory', 'remember', 'decision', 'trace', '记忆', '回忆', '决定', '记忆治理'],
    inputSchema: objectSchema({
      query: string('Text to search for in remembered decisions.', { minLength: 1, maxLength: 512 }),
      limit: integer('Maximum number of records to return.', 1, 20),
    }, ['query']),
    sample: {
      items: [{ id: 'trace_sample_1', summary: 'Use pnpm, not npm (recorded decision).', durability: 'process', recordedAt: '2026-11-20T00:00:00.000Z' }],
      total: 1,
    },
  },
]

function normalizeCard(card, index) {
  const where = `capabilities[${index}]`
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error(`${where} must be an object`)
  }
  const tool = card.tool ?? card.name
  if (typeof tool !== 'string' || !NAME_PATTERN.test(tool)) {
    throw new Error(`${where}.tool must match ${NAME_PATTERN}`)
  }
  if (RESERVED.has(tool)) throw new Error(`${where}.tool "${tool}" is reserved by the server`)
  if (typeof card.description !== 'string' || card.description.trim() === '' || card.description.length > 1024) {
    throw new Error(`${where}.description must be a non-empty string of at most 1024 characters`)
  }
  const inputSchema = card.inputSchema ?? { type: 'object', properties: {} }
  if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') {
    throw new Error(`${where}.inputSchema must be a JSON Schema object with type "object"`)
  }
  if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) {
    throw new Error(`${where}.inputSchema exceeds ${MAX_SCHEMA_BYTES} bytes`)
  }
  if (card.sample !== undefined) {
    if (card.sample === null || typeof card.sample !== 'object' || Array.isArray(card.sample)) {
      throw new Error(`${where}.sample must be an object`)
    }
    if (JSON.stringify(card.sample).length > MAX_SAMPLE_BYTES) {
      throw new Error(`${where}.sample exceeds ${MAX_SAMPLE_BYTES} bytes`)
    }
  }
  const readOnly = card.readOnly === true
  return {
    tool,
    title: typeof card.title === 'string' && card.title.trim() !== '' ? card.title.slice(0, 120) : tool,
    description: card.description,
    inputSchema,
    readOnly,
    risk: readOnly ? 'read' : 'write',
    keywords: Array.isArray(card.keywords) ? card.keywords.filter(keyword => typeof keyword === 'string' && keyword.trim() !== '').slice(0, 16) : [],
    sample: card.sample ?? null,
  }
}

/**
 * Load capability cards from a JSON file, or the built-in samples when the
 * path is null. Accepts a bare array or `{ "capabilities": [...] }`.
 */
export function loadCatalog(file) {
  if (file === null || file === undefined) {
    return { source: 'builtin', cards: BUILTIN_CARDS.map((card, index) => normalizeCard(card, index)) }
  }
  let stats
  try {
    stats = statSync(file)
  } catch (error) {
    throw new Error(`cannot read catalog ${file}: ${error.message}`)
  }
  if (!stats.isFile()) throw new Error(`catalog ${file} is not a regular file`)
  if (stats.size > MAX_FILE_BYTES) throw new Error(`catalog ${file} exceeds ${MAX_FILE_BYTES} bytes`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`)
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.capabilities
  if (!Array.isArray(list)) throw new Error(`${file} must be a JSON array or {"capabilities":[...]}`)
  if (list.length === 0) throw new Error(`${file} contains no capabilities`)
  if (list.length > MAX_CARDS) throw new Error(`${file} exceeds ${MAX_CARDS} capabilities`)
  const cards = list.map((card, index) => normalizeCard(card, index))
  const names = new Set()
  for (const card of cards) {
    if (names.has(card.tool)) throw new Error(`duplicate capability tool "${card.tool}"`)
    names.add(card.tool)
  }
  return { source: file, cards }
}
