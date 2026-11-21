import { loadCatalog } from './catalog.mjs'

export const SERVER_INFO = Object.freeze({ name: 'dsh-os-mcp', version: '0.1.0' })

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']
const MAX_ARGS_BYTES = 16 * 1024
const MAX_RESOURCE_BYTES = 64 * 1024
const OUTPUT_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }

const USAGE = `Usage: dsh-os-mcp [options]

Read-only stdio MCP server for the dsh-os capability catalog.

Options:
  --catalog <file>  Load capability cards from a JSON file
  --allow-write     List write cards (they still cannot execute)
  --max-bytes <n>   Maximum bytes per request line (default 1048576)
  -h, --help        Show this help
  -v, --version     Show the version`

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum })
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

const META_TOOLS = [
  {
    name: 'os_find',
    title: 'Find a dsh-os capability',
    description: 'Search the exposed read-only dsh-os capability catalog by intent. Returns the best matches with argument examples; use it before guessing a tool name.',
    readOnly: true,
    inputSchema: schema({
      intent: string('Natural-language intent, for example "search my clipboard".', { minLength: 1, maxLength: 2048 }),
      k: integer('Maximum number of matches to return.', 1, 5),
    }, ['intent']),
  },
  {
    name: 'os_help',
    title: 'Show dsh-os help',
    description: 'Show the read-only profile, examples, and documentation for this server or one verb.',
    readOnly: true,
    inputSchema: schema({
      topic: string('Optional topic text.', { maxLength: 512 }),
      verb: string('Optional verb name, for example "snip_search".', { maxLength: 64 }),
      lang: { type: 'string', enum: ['en', 'zh'], description: 'Documentation language hint.' },
    }, []),
  },
  {
    name: 'os_status',
    title: 'Report dsh-os MCP status',
    description: 'Report server mode, protocol version, catalog source and tool counts. Does not contact a DSH host.',
    readOnly: true,
    inputSchema: schema({}, []),
  },
]

const TYPES = {
  string: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  number: value => typeof value === 'number' && Number.isFinite(value),
  boolean: value => typeof value === 'boolean',
  array: value => Array.isArray(value),
  object: value => isPlainObject(value),
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code, message, data) {
  throw new RpcError(code, message, data)
}

function cardToTool(card) {
  const suffix = card.readOnly ? '\n\nRead-only capability.' : '\n\nWrite capability: requires the dsh-os approval protocol.'
  return { name: card.tool, title: card.title, description: `${card.description}${suffix}`, readOnly: card.readOnly, inputSchema: card.inputSchema, card }
}

function exampleArgs(inputSchema) {
  const example = {}
  for (const key of inputSchema.required ?? []) {
    const property = inputSchema.properties?.[key] ?? {}
    example[key] = property.enum?.[0] ?? (property.type === 'integer' || property.type === 'number' ? (property.minimum ?? 1) : (property.type === 'boolean' ? false : 'example'))
  }
  return example
}

function rankCard(intent, card) {
  const query = intent.toLowerCase()
  const hits = card.keywords.filter(keyword => query.includes(keyword.toLowerCase()))
  let score = hits.length * 4
  for (const token of query.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (card.tool.includes(token)) score += 3
    if (card.title.toLowerCase().includes(token)) score += 2
    if (card.description.toLowerCase().includes(token)) score += 1
  }
  return { score, hits }
}

function validateArgs(inputSchema, args) {
  if (!isPlainObject(args)) fail(-32602, 'arguments must be a JSON object', { code: 'E_INVALID_ARGUMENT' })
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) fail(-32602, `arguments exceed ${MAX_ARGS_BYTES} bytes`, { code: 'E_LIMIT', maxBytes: MAX_ARGS_BYTES })
  const properties = inputSchema.properties ?? {}
  for (const required of inputSchema.required ?? []) {
    if (!(required in args)) fail(-32602, `missing required argument "${required}"`, { code: 'E_INVALID_ARGUMENT', argument: required })
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]
    if (property === undefined) {
      if (inputSchema.additionalProperties === false) fail(-32602, `unexpected argument "${key}"`, { code: 'E_INVALID_ARGUMENT', argument: key })
      continue
    }
    const check = TYPES[property.type]
    if (check !== undefined && !check(value)) fail(-32602, `argument "${key}" must be ${property.type}`, { code: 'E_INVALID_ARGUMENT', argument: key })
    if (typeof value === 'string') {
      if (property.minLength !== undefined && value.length < property.minLength) fail(-32602, `argument "${key}" is too short`, { code: 'E_INVALID_ARGUMENT', argument: key })
      if (property.maxLength !== undefined && value.length > property.maxLength) fail(-32602, `argument "${key}" is too long`, { code: 'E_INVALID_ARGUMENT', argument: key })
    }
    if (typeof value === 'number') {
      if (property.minimum !== undefined && value < property.minimum) fail(-32602, `argument "${key}" is below the minimum`, { code: 'E_INVALID_ARGUMENT', argument: key })
      if (property.maximum !== undefined && value > property.maximum) fail(-32602, `argument "${key}" is above the maximum`, { code: 'E_INVALID_ARGUMENT', argument: key })
    }
    if (property.enum !== undefined && !property.enum.includes(value)) fail(-32602, `argument "${key}" must be one of ${property.enum.join(', ')}`, { code: 'E_INVALID_ARGUMENT', argument: key })
  }
}

/**
 * Build an MCP server over a normalized catalog. It never performs OS actions:
 * meta tools inspect the catalog and capability tools return card samples or
 * E_UNAVAILABLE. Write cards are filtered unless allowWrite is true, and even
 * then calls fail with E_DENIED until the approval protocol exists.
 */
export function createServer({ cards = [], source = 'builtin', allowWrite = false, maxBytes = 1024 * 1024, log = () => {} } = {}) {
  const state = { protocolVersion: PROTOCOL_VERSIONS[0] }
  const exposed = cards.filter(card => card.readOnly || allowWrite)
  const tools = [...META_TOOLS, ...exposed.map(cardToTool)]
  const toolMap = new Map(tools.map(tool => [tool.name, tool]))

  function renderTool(tool) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(state.protocolVersion === PROTOCOL_VERSIONS[0] ? { outputSchema: OUTPUT_SCHEMA } : {}),
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, idempotentHint: true, openWorldHint: false },
    }
  }

  function findCapabilities(args) {
    const ranked = exposed.map(card => ({ card, ...rankCard(args.intent, card) })).sort((left, right) => right.score - left.score)
    const best = ranked[0]?.score ?? 0
    return {
      ok: true,
      intent: args.intent,
      matches: ranked.slice(0, args.k ?? 5).map(({ card, hits }) => ({
        verb: card.tool,
        module: 'example',
        why: hits.length > 0 ? `matched ${hits.join(', ')}` : 'catalog fallback (no keyword match)',
        argsExample: exampleArgs(card.inputSchema),
        risk: card.risk,
        approval: card.readOnly ? 'none' : 'grant_required',
        returns: card.title,
      })),
      avoid: [],
      confidence: best > 0 ? Math.min(0.95, Number((0.4 + best / 20).toFixed(2))) : 0.1,
      truncated: false,
      note: 'Catalog-only match. No dsh-os host was contacted.',
    }
  }

  function help(args) {
    if (args.verb !== undefined) {
      const tool = toolMap.get(args.verb)
      if (tool === undefined) fail(-32602, `Unknown verb: ${args.verb}`, { code: 'E_NOT_FOUND', verb: args.verb })
      return {
        doc: `${tool.name}: ${tool.description}`,
        examples: [{ tool: tool.name, arguments: exampleArgs(tool.inputSchema) }],
        related: tools.filter(candidate => candidate.name !== tool.name).slice(0, 4).map(candidate => candidate.name),
        version: SERVER_INFO.version,
      }
    }
    const prefix = args.topic ? `No topic-specific entry for "${args.topic}". ` : ''
    return {
      ok: true,
      doc: `${prefix}Read-only dsh-os MCP prototype. Use os_find to search capabilities, then call the returned verb. Capability calls return sample data or E_UNAVAILABLE because no DSH host is connected.`,
      examples: [{ tool: 'os_status', arguments: {} }, { tool: 'os_find', arguments: { intent: 'search clipboard' } }],
      related: tools.map(tool => tool.name),
      version: SERVER_INFO.version,
    }
  }

  function status() {
    return {
      ok: true,
      degraded: false,
      connected: false,
      mode: allowWrite ? 'write-preview' : 'read-only',
      protocolVersion: state.protocolVersion,
      source,
      counts: { meta: META_TOOLS.length, capabilities: exposed.length, tools: tools.length },
      installed: tools.map(tool => tool.name),
      missing: [],
      warnings: [
        'No dsh-os host adapter is connected; capability calls use catalog samples or fail with E_UNAVAILABLE.',
        allowWrite ? 'Write cards are listed but cannot execute: the approval protocol is not implemented.' : 'Write cards are hidden because allowWrite is false.',
      ],
    }
  }

  function callCapability(card, args) {
    if (!card.readOnly) {
      fail(-32003, `Write capability ${card.tool} requires the dsh-os approval protocol.`, { code: 'E_DENIED', subcode: 'grant_required', tool: card.tool })
    }
    if (card.sample === null) {
      fail(-32001, `Capability ${card.tool} has no host backend and no sample.`, { code: 'E_UNAVAILABLE', tool: card.tool, retryable: false })
    }
    const data = structuredClone(card.sample)
    if (typeof args.query === 'string' && data.query === undefined) data.query = args.query
    return {
      ok: true,
      data,
      sample: true,
      connected: false,
      summary: `${card.tool}: ${Array.isArray(data.items) ? data.items.length : 0} sample row(s); no dsh-os host connected.`,
      truncated: false,
      warnings: ['Sample data from a capability card. Connect a dsh-os host adapter for live results.'],
      auditRef: `mcp-sample:${card.tool}`,
    }
  }

  function initialize(params) {
    const requested = isPlainObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : null
    state.protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
    const client = isPlainObject(params?.clientInfo) ? `${params.clientInfo.name ?? 'client'}/${params.clientInfo.version ?? '?'}` : 'unknown'
    log(`initialize from ${client}: requested ${requested ?? 'none'}, negotiated ${state.protocolVersion}`)
    return {
      protocolVersion: state.protocolVersion,
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Read-only dsh-os prototype. Call os_find before guessing capability names. No dsh-os host is connected; capability calls return sample data or E_UNAVAILABLE. Write capabilities are hidden and never execute.',
    }
  }

  function callTool(params) {
    if (!isPlainObject(params)) fail(-32602, 'tools/call requires a params object', { code: 'E_INVALID_ARGUMENT' })
    const tool = toolMap.get(params.name)
    if (tool === undefined) {
      fail(-32602, `Unknown tool: ${String(params.name)}`, { code: 'E_NOT_FOUND', hint: allowWrite ? undefined : 'Write tools are hidden while allowWrite is false.' })
    }
    const args = params.arguments ?? {}
    validateArgs(tool.inputSchema, args)
    let envelope
    if (tool.name === 'os_find') envelope = findCapabilities(args)
    else if (tool.name === 'os_help') envelope = help(args)
    else if (tool.name === 'os_status') envelope = status()
    else envelope = callCapability(tool.card, args)
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      ...(state.protocolVersion === PROTOCOL_VERSIONS[0] ? { structuredContent: envelope } : {}),
      isError: false,
    }
  }

  function readResource(params) {
    if (!isPlainObject(params) || typeof params.uri !== 'string' || params.uri === '') {
      fail(-32602, 'resources/read requires a uri string', { code: 'E_INVALID_ARGUMENT' })
    }
    const resource = resourceMap.get(params.uri)
    if (resource === undefined) fail(-32002, `Resource not found: ${params.uri}`, { code: 'E_NOT_FOUND', uri: params.uri })
    let text = resource.text()
    if (Buffer.byteLength(text) > MAX_RESOURCE_BYTES) text = `${text.slice(0, MAX_RESOURCE_BYTES)}\n[truncated at ${MAX_RESOURCE_BYTES} bytes]`
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] }
  }

  function dispatch(method, params) {
    if (method === 'initialize') return initialize(params)
    if (method === 'ping') return {}
    if (method === 'tools/list') return { tools: tools.map(renderTool) }
    if (method === 'tools/call') return callTool(params)
    if (method === 'resources/list') return { resources: resourceDefs.map(({ text, ...meta }) => meta) }
    if (method === 'resources/read') return readResource(params)
    return fail(-32601, `Method not found: ${method}`)
  }

  function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  function writeError(id, code, message, data) {
    write({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } })
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      writeError(null, -32700, 'Parse error')
      return
    }
    if (!isPlainObject(message)) {
      writeError(null, -32600, 'Invalid Request: expected a JSON object')
      return
    }
    const hasId = message.id !== undefined
    if (message.jsonrpc !== '2.0') {
      if (hasId) writeError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"')
      return
    }
    if (typeof message.method !== 'string') {
      if (hasId) writeError(message.id, -32600, 'Invalid Request: method must be a string')
      return
    }
    if (!hasId) return
    try {
      write({ jsonrpc: '2.0', id: message.id, result: dispatch(message.method, message.params) })
    } catch (error) {
      if (error instanceof RpcError) writeError(message.id, error.code, error.message, error.data)
      else {
        log(`internal error: ${error.stack ?? error}`)
        writeError(message.id, -32603, 'Internal error')
      }
    }
  }

  function readmeText() {
    return `# ${SERVER_INFO.name} ${SERVER_INFO.version}\n\nRead-only stdio MCP server prototype for dsh-os capability cards. It does not connect to DSH and performs no OS actions.\n\n## Tools\n\n${tools.map(tool => `- \`${tool.name}\` — ${tool.title}`).join('\n')}\n\n## Protocol\n\nJSON-RPC 2.0 over stdio, one JSON message per line. Negotiated MCP version: ${state.protocolVersion}. Methods: initialize, tools/list, tools/call, resources/list, resources/read, ping.\n\n## Safety\n\n- Read-only by default; write cards are hidden and never execute.\n- Every stdout line is a JSON-RPC message; logs go to stderr.\n- Request lines are limited to ${maxBytes} bytes; arguments to ${MAX_ARGS_BYTES} bytes.\n- No network, no DSH connection, no writes to user files.\n- Capability data is sample data from a capability card until a host adapter exists.\n`
  }

  function catalogText() {
    return JSON.stringify({
      server: SERVER_INFO,
      protocolVersion: state.protocolVersion,
      source,
      allowWrite,
      capabilities: exposed.map(card => ({ tool: card.tool, title: card.title, readOnly: card.readOnly, risk: card.risk, keywords: card.keywords })),
    }, null, 2)
  }

  function approvalText() {
    return `# Write path: pending approval protocol\n\nThis prototype is read-only. Cards with \`readOnly:false\` are filtered from \`tools/list\` while \`allowWrite\` is false.\n\nIf \`--allow-write\` is set, write cards are listed for discovery but \`tools/call\` always fails with JSON-RPC error \`-32003\`:\n\n\`\`\`json\n{ "code": "E_DENIED", "subcode": "grant_required", "tool": "<name>" }\n\`\`\`\n\nNo requestId, approvalUrl or grant is issued. A host-bound server must implement the dsh-os approval flow: create a pending request, obtain human approval in the DSH inbox, issue a single-use grant bound to args/scope/expiry, then re-authorize before execution. Accepting a prompt is not a grant.\n`
  }

  const resourceDefs = [
    { uri: 'dsh-os://readme', name: 'readme', title: 'Server overview', description: 'Read-only profile, tools, protocol and safety limits.', mimeType: 'text/markdown', text: readmeText },
    { uri: 'dsh-os://catalog', name: 'catalog', title: 'Capability catalog', description: 'Static snapshot of the exposed capability cards.', mimeType: 'application/json', text: catalogText },
    { uri: 'dsh-os://approval', name: 'approval', title: 'Write approval contract', description: 'Why writes are hidden and what the approval protocol must provide.', mimeType: 'text/markdown', text: approvalText },
  ]
  const resourceMap = new Map(resourceDefs.map(resource => [resource.uri, resource]))

  return { maxBytes, tools, cards: exposed, handleLine, writeError, log, get protocolVersion() { return state.protocolVersion } }
}

function attachStdin(server) {
  let buffer = ''
  let skipping = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    if (skipping) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        buffer = ''
        return
      }
      buffer = buffer.slice(newline + 1)
      skipping = false
    }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() === '') continue
      if (Buffer.byteLength(line) > server.maxBytes) {
        server.writeError(null, -32600, `Request exceeds ${server.maxBytes} bytes`, { code: 'E_LIMIT' })
        continue
      }
      server.handleLine(line)
    }
    if (Buffer.byteLength(buffer) > server.maxBytes) {
      skipping = true
      buffer = ''
      server.writeError(null, -32600, `Request exceeds ${server.maxBytes} bytes`, { code: 'E_LIMIT' })
    }
  })
}

export function parseArgs(argv) {
  const options = { catalog: null, allowWrite: false, maxBytes: 1024 * 1024, help: false, version: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--catalog') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error('--catalog requires a file path')
      options.catalog = value
    } else if (arg === '--allow-write') options.allowWrite = true
    else if (arg === '--max-bytes') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 256) throw new Error('--max-bytes requires an integer >= 256')
      options.maxBytes = value
    } else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version' || arg === '-v') options.version = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${SERVER_INFO.name}: ${error.message}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${SERVER_INFO.version}\n`)
    return 0
  }
  let catalog
  try {
    catalog = loadCatalog(options.catalog)
  } catch (error) {
    process.stderr.write(`${SERVER_INFO.name}: ${error.message}\n`)
    return 2
  }
  const server = createServer({
    ...catalog,
    allowWrite: options.allowWrite,
    maxBytes: options.maxBytes,
    log: message => process.stderr.write(`[${SERVER_INFO.name}] ${message}\n`),
  })
  attachStdin(server)
  return 0
}
