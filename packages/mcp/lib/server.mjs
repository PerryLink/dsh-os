import { loadCatalog } from './catalog.mjs'
import { argsHash, createApprovalStore, sameSecret } from './approval.mjs'

export const SERVER_INFO = Object.freeze({ name: 'dsh-os-mcp', version: '0.2.0' })
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']
const MAX_ARGS_BYTES = 16 * 1024
const MAX_RESOURCE_BYTES = 32 * 1024
const OUTPUT_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }
const USAGE = `Usage: dsh-os-mcp [options]

Stdio MCP server for the dsh-os capability catalog. Read-only by default.

Options:
  --catalog <file>       Load capability cards from a JSON file
  --allow-write          Expose os_do, os_request and write cards
  --admin-token <token>  Expose os_approve (requires --allow-write)
  --request-store <file> Share pending requests with the --approve CLI
  --approve <id>         Approve one pending request and exit
  --max-bytes <n>        Maximum bytes per request line (default 1048576)
  -h, --help             Show this help
  -v, --version          Show the version`

const S = (description, extra = {}) => ({ type: 'string', description, ...extra })
const I = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum })
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
const TOOLS = [
  {
    name: 'os_find', title: 'Find a dsh-os capability', readOnly: true,
    description: 'Search the exposed dsh-os capability catalog by intent. Returns the best matches with argument examples; use it before guessing a tool name.',
    inputSchema: obj({ intent: S('Natural-language intent, for example "search my clipboard".', { minLength: 1, maxLength: 2048 }), k: I('Maximum number of matches to return.', 1, 5) }, ['intent']),
  },
  {
    name: 'os_help', title: 'Show dsh-os help', readOnly: true,
    description: 'Show the profile, examples and documentation for this server or one verb.',
    inputSchema: obj({ topic: S('Optional topic text.', { maxLength: 512 }), verb: S('Optional verb name, for example "snip_search".', { maxLength: 64 }), lang: { type: 'string', enum: ['en', 'zh'], description: 'Documentation language hint.' } }, []),
  },
  {
    name: 'os_status', title: 'Report dsh-os MCP status', readOnly: true,
    description: 'Report server mode, protocol version, catalog source, approval settings and tool counts. Does not contact a DSH host.', inputSchema: obj({}, []),
  },
  {
    name: 'os_request', title: 'Request approval for a write capability', readOnly: false, destructive: false, write: true,
    description: 'Create or poll a pending approval request for a write capability. Returns requestId and status. Once a human approves it, polling returns a single-use approvalToken bound to the capability and arguments for 5 minutes.',
    inputSchema: obj({ requestId: S('Existing request id to poll; omit capability/arguments when polling.', { maxLength: 96 }), capability: S('Write capability tool name, for example "fs_write".', { minLength: 1, maxLength: 64 }), arguments: { type: 'object', description: 'Arguments for the target capability.' }, reason: S('Optional human-readable reason for the request.', { maxLength: 512 }) }, []),
  },
  {
    name: 'os_do', title: 'Execute a dsh-os capability', readOnly: false, destructive: true, idempotent: false, write: true,
    description: 'Execute a capability. Write capabilities require the approvalToken returned by os_request after human approval; otherwise the call fails with JSON-RPC -32003 and data.nextTools. Tokens are single-use and bound to the capability and arguments.',
    inputSchema: obj({ capability: S('Capability tool name.', { minLength: 1, maxLength: 64 }), arguments: { type: 'object', description: 'Arguments for the capability.' }, approvalToken: S('Single-use token from os_request.', { maxLength: 256 }) }, ['capability']),
  },
  {
    name: 'os_approve', title: 'Approve or deny a pending request', readOnly: false, destructive: false, admin: true,
    description: 'Admin only. Approve or deny a pending write request using the server admin token. The requester polls os_request to receive the single-use approvalToken.',
    inputSchema: obj({ requestId: S('Pending request id.', { minLength: 1, maxLength: 96 }), adminToken: S('Server admin token from --admin-token.', { minLength: 1, maxLength: 512 }), decision: { type: 'string', enum: ['approve', 'deny'], description: 'Decision; defaults to approve.' } }, ['requestId', 'adminToken']),
  },
]

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message, data) => { throw new RpcError(code, message, data) }
const TYPES = { string: v => typeof v === 'string', integer: v => Number.isInteger(v), number: v => typeof v === 'number' && Number.isFinite(v), boolean: v => typeof v === 'boolean', array: v => Array.isArray(v), object: v => isPlainObject(v) }
function cardToTool(card) {
  const suffix = card.readOnly ? '\n\nRead-only capability.' : '\n\nWrite capability: execute it through os_do with an approvalToken from os_request.'
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
  const invalid = (key, why) => fail(-32602, `argument "${key}" ${why}`, { code: 'E_INVALID_ARGUMENT', argument: key })
  for (const required of inputSchema.required ?? []) if (!(required in args)) invalid(required, 'is required')
  for (const [key, value] of Object.entries(args)) {
    const property = inputSchema.properties?.[key]
    if (property === undefined) {
      if (inputSchema.additionalProperties === false) invalid(key, 'is not allowed')
      continue
    }
    const check = TYPES[property.type]
    if (check !== undefined && !check(value)) invalid(key, `must be ${property.type}`)
    if (typeof value === 'string') {
      if (property.minLength !== undefined && value.length < property.minLength) invalid(key, 'is too short')
      if (property.maxLength !== undefined && value.length > property.maxLength) invalid(key, 'is too long')
    }
    if (typeof value === 'number') {
      if (property.minimum !== undefined && value < property.minimum) invalid(key, 'is below the minimum')
      if (property.maximum !== undefined && value > property.maximum) invalid(key, 'is above the maximum')
    }
    if (property.enum !== undefined && !property.enum.includes(value)) invalid(key, `must be one of ${property.enum.join(', ')}`)
  }
}
/** Enforce the 32 KiB resource ceiling on UTF-8 boundaries. */
function clampResource(text) {
  const marker = `\n[truncated at ${MAX_RESOURCE_BYTES} bytes]`
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_RESOURCE_BYTES) return text
  let end = MAX_RESOURCE_BYTES - Buffer.byteLength(marker)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8') + marker
}

export function createServer({ cards = [], source = 'builtin', allowWrite = false, maxBytes = 1024 * 1024, adminToken = null, requestStore = null, clock = () => Date.now(), log = () => {} } = {}) {
  const state = { protocolVersion: PROTOCOL_VERSIONS[0] }
  const store = createApprovalStore({ file: requestStore, now: clock })
  const exposed = cards.filter(card => card.readOnly || allowWrite)
  const cardMap = new Map(cards.map(card => [card.tool, card]))
  const tools = [...TOOLS.filter(tool => (tool.admin ? allowWrite && adminToken !== null : tool.write ? allowWrite : true)), ...exposed.map(cardToTool)]
  const toolMap = new Map(tools.map(tool => [tool.name, tool]))
  const resources = new Map()

  function renderTool(tool) {
    return {
      name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      ...(state.protocolVersion === PROTOCOL_VERSIONS[0] ? { outputSchema: OUTPUT_SCHEMA } : {}),
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive ?? !tool.readOnly, idempotentHint: tool.idempotent ?? true, openWorldHint: false },
    }
  }
  function findCapabilities(args) {
    const ranked = exposed.map(card => ({ card, ...rankCard(args.intent, card) })).sort((left, right) => right.score - left.score)
    const best = ranked[0]?.score ?? 0
    return {
      ok: true, intent: args.intent,
      matches: ranked.slice(0, args.k ?? 5).map(({ card, hits }) => ({ verb: card.tool, module: 'example', why: hits.length > 0 ? `matched ${hits.join(', ')}` : 'catalog fallback (no keyword match)', argsExample: exampleArgs(card.inputSchema), risk: card.risk, approval: card.readOnly ? 'none' : 'os_request_then_os_do', returns: card.title })),
      avoid: [], confidence: best > 0 ? Math.min(0.95, Number((0.4 + best / 20).toFixed(2))) : 0.1, truncated: false, note: 'Catalog-only match. No dsh-os host was contacted.',
    }
  }
  function help(args) {
    if (args.verb !== undefined) {
      const tool = toolMap.get(args.verb)
      if (tool === undefined) fail(-32602, `Unknown verb: ${args.verb}`, { code: 'E_NOT_FOUND', verb: args.verb })
      return { doc: `${tool.name}: ${tool.description}`, examples: [{ tool: tool.name, arguments: exampleArgs(tool.inputSchema) }], related: tools.filter(candidate => candidate.name !== tool.name).slice(0, 4).map(candidate => candidate.name), version: SERVER_INFO.version }
    }
    const prefix = args.topic ? `No topic-specific entry for "${args.topic}". ` : ''
    const write = allowWrite ? ' Write capabilities are executed through os_do with a single-use approvalToken from os_request; os_approve is admin-only.' : ' Write capabilities are hidden; restart with --allow-write to expose the approval flow.'
    return {
      ok: true, doc: `${prefix}dsh-os MCP server. Use os_find to search capabilities, os_status for mode and os_help for one verb.${write} No dsh-os host is connected, so capability calls return sample data or a simulated authorization receipt.`,
      examples: [{ tool: 'os_status', arguments: {} }, { tool: 'os_find', arguments: { intent: 'search clipboard' } }, ...(allowWrite ? [{ tool: 'os_request', arguments: { capability: 'fs_write', arguments: { path: '/tmp/example.txt' } } }] : [])],
      related: tools.map(tool => tool.name), version: SERVER_INFO.version,
    }
  }
  function status() {
    return {
      ok: true, degraded: false, connected: false, mode: allowWrite ? 'write-approval' : 'read-only', protocolVersion: state.protocolVersion, source,
      approval: { enabled: allowWrite, admin: adminToken !== null, store: requestStore ?? 'memory', tokenTtlMs: store.ttlMs },
      counts: { meta: tools.length - exposed.length, capabilities: exposed.length, tools: tools.length }, installed: tools.map(tool => tool.name), missing: [],
      warnings: ['No dsh-os host adapter is connected; capability calls use catalog samples, and approved writes return simulated authorization receipts.', allowWrite ? 'Write calls require a single-use approvalToken from os_request after human approval.' : 'Write cards and os_do/os_request are hidden because allowWrite is false.'],
    }
  }
  function readCapability(card, args) {
    if (card.sample === null) fail(-32001, `Capability ${card.tool} has no host backend and no sample.`, { code: 'E_UNAVAILABLE', tool: card.tool, retryable: false })
    const data = structuredClone(card.sample)
    if (typeof args.query === 'string' && data.query === undefined) data.query = args.query
    return { ok: true, data, sample: true, connected: false, summary: `${card.tool}: ${Array.isArray(data.items) ? data.items.length : 0} sample row(s); no dsh-os host connected.`, truncated: false, warnings: ['Sample data from a capability card. Connect a dsh-os host adapter for live results.'], auditRef: `mcp-sample:${card.tool}` }
  }
  function denyWrite(card, args, subcode, requestId) {
    fail(-32003, `Write capability ${card.tool} requires a valid single-use approvalToken.`, {
      code: 'E_DENIED', subcode, tool: card.tool, ...(requestId === undefined ? {} : { requestId }),
      remediation: 'Call os_request with the same capability and arguments, wait for human approval, then call os_do with the returned approvalToken.',
      nextTools: [{ capability: 'os_request', args: { capability: card.tool, arguments: args } }],
    })
  }
  function callCapability(card, args) {
    if (!card.readOnly) denyWrite(card, args, 'grant_required')
    return readCapability(card, args)
  }
  function approvalEnvelope(record) {
    const envelope = { ok: true, requestId: record.id, status: record.status, tool: record.capability, argsHash: record.argsHash, createdAt: record.createdAt, expiresAt: record.expiresAt, handles: [`dsh://requests/${record.id}`] }
    if (record.status === 'pending') return { ...envelope, approvalHint: 'A human must approve this request with os_approve (admin token) or `dsh-os-mcp --approve <id> --request-store <file>`.', nextTools: [{ capability: 'os_request', args: { requestId: record.id } }] }
    if (record.status === 'approved') {
      const issued = store.issue(record.id)
      const token = issued?.token ?? null
      if (token !== null) return { ...envelope, approvalToken: token, tokenExpiresAt: issued.record.tokenExpiresAt, approvalHint: 'Token is single-use, bound to this capability and arguments, and expires in 5 minutes.', nextTools: [{ capability: 'os_do', args: { capability: record.capability, arguments: record.args, approvalToken: token } }] }
      return { ...envelope, tokenIssued: true, tokenExpiresAt: issued?.record?.tokenExpiresAt, approvalHint: 'An approval token was already issued. If it was lost, deny this request and create a new one.', nextTools: [] }
    }
    return { ...envelope, approvalHint: 'This request is no longer usable. Create a new request with the same capability and arguments.', nextTools: [{ capability: 'os_request', args: { capability: record.capability, arguments: record.args } }] }
  }
  function requestApproval(args) {
    if (args.requestId !== undefined) {
      const record = store.get(args.requestId)
      if (record === null) fail(-32602, `Unknown approval request: ${args.requestId}`, { code: 'E_NOT_FOUND', requestId: args.requestId })
      return approvalEnvelope(record)
    }
    if (typeof args.capability !== 'string' || args.capability === '') fail(-32602, 'os_request requires either "requestId" or "capability"', { code: 'E_INVALID_ARGUMENT', argument: 'capability' })
    const card = cardMap.get(args.capability)
    if (card === undefined || (!card.readOnly && !allowWrite)) fail(-32602, `Unknown capability: ${args.capability}`, { code: 'E_NOT_FOUND', capability: args.capability })
    const targetArgs = args.arguments ?? {}
    validateArgs(card.inputSchema, targetArgs)
    if (card.readOnly) return { ok: true, requestId: null, status: 'not_required', tool: card.tool, approvalHint: 'Read capabilities do not need approval; call os_do directly.', nextTools: [{ capability: 'os_do', args: { capability: card.tool, arguments: targetArgs } }] }
    const { record, created } = store.create({ capability: card.tool, args: targetArgs, reason: args.reason ?? '' })
    return { ...approvalEnvelope(record), created }
  }
  function doCapability(args) {
    const card = cardMap.get(args.capability)
    if (card === undefined || (!card.readOnly && !allowWrite)) fail(-32602, `Unknown capability: ${args.capability}`, { code: 'E_NOT_FOUND', capability: args.capability })
    const targetArgs = args.arguments ?? {}
    validateArgs(card.inputSchema, targetArgs)
    if (card.readOnly) return readCapability(card, targetArgs)
    if (typeof args.approvalToken !== 'string' || args.approvalToken === '') denyWrite(card, targetArgs, 'grant_required')
    const check = store.consume(args.approvalToken, card.tool, argsHash(targetArgs))
    if (!check.ok) denyWrite(card, targetArgs, check.code, check.requestId)
    return { ok: true, tool: card.tool, requestId: check.record.id, status: 'authorized', applied: false, simulated: true, connected: false, summary: `Authorized ${card.tool} with a single-use token; no dsh-os host is connected, so no side effect was performed.`, data: targetArgs, handles: [`dsh://requests/${check.record.id}`], nextTools: [] }
  }
  function approveRequest(args) {
    if (adminToken === null) fail(-32602, 'Unknown tool: os_approve', { code: 'E_NOT_FOUND' })
    if (!sameSecret(args.adminToken, adminToken)) fail(-32003, 'A valid admin token is required to approve requests.', { code: 'E_DENIED', subcode: 'admin_required' })
    const decision = args.decision ?? 'approve'
    const record = decision === 'deny' ? store.deny(args.requestId, 'admin') : store.approve(args.requestId, 'admin')
    if (record === null) fail(-32602, `Unknown approval request: ${args.requestId}`, { code: 'E_NOT_FOUND', requestId: args.requestId })
    return { ok: true, requestId: record.id, status: record.status, decision, handles: [`dsh://requests/${record.id}`], nextTools: record.status === 'approved' ? [{ capability: 'os_request', args: { requestId: record.id } }] : [] }
  }
  function initialize(params) {
    const requested = isPlainObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : null
    state.protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
    const client = isPlainObject(params?.clientInfo) ? `${params.clientInfo.name ?? 'client'}/${params.clientInfo.version ?? '?'}` : 'unknown'
    log(`initialize from ${client}: requested ${requested ?? 'none'}, negotiated ${state.protocolVersion}`)
    return {
      protocolVersion: state.protocolVersion, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: SERVER_INFO,
      instructions: 'dsh-os MCP server. Read-only by default. With --allow-write, call os_request first, wait for human approval, then call os_do with the returned single-use approvalToken. Write calls without a valid token fail with -32003 and data.nextTools. No dsh-os host is connected; writes return simulated authorization receipts.',
    }
  }
  function callTool(params) {
    if (!isPlainObject(params)) fail(-32602, 'tools/call requires a params object', { code: 'E_INVALID_ARGUMENT' })
    const tool = toolMap.get(params.name)
    if (tool === undefined) fail(-32602, `Unknown tool: ${String(params.name)}`, { code: 'E_NOT_FOUND', hint: allowWrite ? undefined : 'Write tools are hidden while allowWrite is false.' })
    const args = params.arguments ?? {}
    validateArgs(tool.inputSchema, args)
    let envelope
    if (tool.name === 'os_find') envelope = findCapabilities(args)
    else if (tool.name === 'os_help') envelope = help(args)
    else if (tool.name === 'os_status') envelope = status()
    else if (tool.name === 'os_request') envelope = requestApproval(args)
    else if (tool.name === 'os_do') envelope = doCapability(args)
    else if (tool.name === 'os_approve') envelope = approveRequest(args)
    else envelope = callCapability(tool.card, args)
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], ...(state.protocolVersion === PROTOCOL_VERSIONS[0] ? { structuredContent: envelope } : {}), isError: false }
  }
  function readResource(params) {
    if (!isPlainObject(params) || typeof params.uri !== 'string' || params.uri === '') fail(-32602, 'resources/read requires a uri string', { code: 'E_INVALID_ARGUMENT' })
    const uri = params.uri
    const resource = resources.get(uri)
    if (resource !== undefined) return { contents: [{ uri, mimeType: resource.mimeType, text: clampResource(resource.text()) }] }
    if (uri.startsWith('dsh://requests/')) {
      const record = store.get(uri.slice('dsh://requests/'.length))
      if (record === null) fail(-32002, `Resource not found: ${uri}`, { code: 'E_NOT_FOUND', uri })
      return { contents: [{ uri, mimeType: 'application/json', text: clampResource(JSON.stringify(store.view(record), null, 2)) }] }
    }
    fail(-32002, `Resource not found: ${uri}`, { code: 'E_NOT_FOUND', uri })
  }
  function dispatch(method, params) {
    if (method === 'initialize') return initialize(params)
    if (method === 'ping') return {}
    if (method === 'tools/list') return { tools: tools.map(renderTool) }
    if (method === 'tools/call') return callTool(params)
    if (method === 'resources/list') {
      const dynamic = store.list().map(record => ({ uri: `dsh://requests/${record.id}`, name: `request-${record.id}`, title: `${record.status} write request`, mimeType: 'application/json' }))
      return { resources: [...[...resources.values()].map(({ text, ...meta }) => meta), ...dynamic] }
    }
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
    if (!isPlainObject(message)) return writeError(null, -32600, 'Invalid Request: expected a JSON object')
    const hasId = message.id !== undefined
    if (message.jsonrpc !== '2.0') return hasId ? writeError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"') : undefined
    if (typeof message.method !== 'string') return hasId ? writeError(message.id, -32600, 'Invalid Request: method must be a string') : undefined
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
    return `# ${SERVER_INFO.name} ${SERVER_INFO.version}\n\nStdio MCP server for dsh-os capability cards. Read-only by default; \`--allow-write\` adds the approval-gated write path. It does not connect to DSH and performs no OS actions.\n\n## Tools\n\n${tools.map(tool => `- \`${tool.name}\` — ${tool.title}`).join('\n')}\n\n## Write path\n\n1. \`os_request\` creates a pending request and returns \`requestId\`/\`status\`.\n2. A human approves it with \`os_approve\` (admin token) or \`dsh-os-mcp --approve <id> --request-store <file>\`.\n3. \`os_request\` polled with \`requestId\` returns a single-use \`approvalToken\`, bound to the capability and arguments, valid for 5 minutes.\n4. \`os_do\` consumes the token and returns a simulated authorization receipt; no host adapter executes it.\n\nCalls without a valid token return JSON-RPC \`-32003\` with \`data.nextTools\`.\n\n## Protocol\n\nJSON-RPC 2.0 over stdio, one JSON message per line. Negotiated MCP version: ${state.protocolVersion}. Methods: initialize, tools/list, tools/call, resources/list, resources/read, ping. Resources: \`dsh-os://readme\`, \`dsh-os://catalog\`, \`dsh-os://approval\`, \`dsh://requests/<id>\`.\n\n## Safety\n\n- Read-only by default; write tools exist only with \`--allow-write\`.\n- Approval tokens are hashed at rest, single-use, bound to capability + arguments, TTL 5 minutes.\n- Every stdout line is a JSON-RPC message; logs go to stderr.\n- Request lines are limited to ${maxBytes} bytes; arguments to ${MAX_ARGS_BYTES} bytes; resources to ${MAX_RESOURCE_BYTES} bytes.\n- No network, no DSH connection, no writes to user files except an explicit \`--request-store\` path.\n- Capability data is sample data from a capability card until a host adapter exists.\n`
  }
  function catalogText() {
    return JSON.stringify({ server: SERVER_INFO, protocolVersion: state.protocolVersion, source, allowWrite, approval: { admin: adminToken !== null, store: requestStore ?? 'memory', tokenTtlMs: store.ttlMs }, capabilities: exposed.map(card => ({ tool: card.tool, title: card.title, readOnly: card.readOnly, risk: card.risk, keywords: card.keywords })) }, null, 2)
  }
  function approvalText() {
    return `# Write path: pending request → approval → single-use token\n\nRead-only is the default. With \`--allow-write\`, write cards and the tools \`os_request\` and \`os_do\` are exposed; \`os_approve\` exists only when \`--admin-token\` is set.\n\n## Flow\n\n1. The model calls \`os_request({ capability, arguments, reason })\`. The server creates a pending request and returns \`{ requestId, status: "pending" }\`.\n2. A human approves it. Either call the admin-only \`os_approve\` tool with the admin token, or run \`dsh-os-mcp --approve <id> --request-store <file>\` in a shell. The model cannot approve its own request.\n3. The model polls \`os_request({ requestId })\` (or repeats the same capability + arguments). Once approved, the response contains a single-use \`approvalToken\`, bound to the capability and canonical arguments hash, with a 5-minute TTL.\n4. The model calls \`os_do({ capability, arguments, approvalToken })\`. The server validates the arguments, atomically consumes the token, and returns a simulated authorization receipt.\n\nTokens are stored as SHA-256 hashes. Replaying a consumed token, using it for different arguments, or using it after expiration fails with JSON-RPC \`-32003\`, \`data.code: "E_DENIED"\`, and \`data.subcode\` of \`grant_required\`, \`token_invalid\`, \`token_used\`, \`token_mismatch\` or \`token_expired\`. Every denial includes \`data.nextTools\` with the \`os_request\` call needed to recover.\n\nPending requests live in memory by default. \`--request-store <file>\` makes them durable and lets the \`--approve\` CLI share them with the server; the file is written atomically with mode 0600. No host adapter is connected, so no side effect is performed after authorization.\n`
  }
  resources.set('dsh-os://readme', { uri: 'dsh-os://readme', name: 'readme', title: 'Server overview', description: 'Profile, tools, write path, protocol and safety limits.', mimeType: 'text/markdown', text: readmeText })
  resources.set('dsh-os://catalog', { uri: 'dsh-os://catalog', name: 'catalog', title: 'Capability catalog', description: 'Static snapshot of the exposed capability cards.', mimeType: 'application/json', text: catalogText })
  resources.set('dsh-os://approval', { uri: 'dsh-os://approval', name: 'approval', title: 'Write approval contract', description: 'Pending request, approval and single-use token rules.', mimeType: 'text/markdown', text: approvalText })
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
  const options = { catalog: null, allowWrite: false, adminToken: null, requestStore: null, approve: null, maxBytes: 1024 * 1024, help: false, version: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = name => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`)
      return next
    }
    if (arg === '--catalog') options.catalog = value(arg)
    else if (arg === '--allow-write') options.allowWrite = true
    else if (arg === '--admin-token') options.adminToken = value(arg)
    else if (arg === '--request-store') options.requestStore = value(arg)
    else if (arg === '--approve') options.approve = value(arg)
    else if (arg === '--max-bytes') {
      const parsed = Number(value(arg))
      if (!Number.isInteger(parsed) || parsed < 256) throw new Error('--max-bytes requires an integer >= 256')
      options.maxBytes = parsed
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
  if (options.adminToken !== null && (!options.allowWrite || options.adminToken === '')) {
    process.stderr.write(`${SERVER_INFO.name}: --admin-token requires --allow-write and a non-empty value\n`)
    return 2
  }
  if (options.approve !== null) {
    if (options.requestStore === null) {
      process.stderr.write(`${SERVER_INFO.name}: --approve requires --request-store <file>\n`)
      return 2
    }
    let record
    try {
      record = createApprovalStore({ file: options.requestStore }).approve(options.approve, 'cli')
    } catch (error) {
      process.stderr.write(`${SERVER_INFO.name}: ${error.message}\n`)
      return 2
    }
    if (record === null) {
      process.stderr.write(`${SERVER_INFO.name}: unknown approval request: ${options.approve}\n`)
      return 1
    }
    process.stdout.write(`${JSON.stringify({ ok: record.status === 'approved', requestId: record.id, status: record.status, store: options.requestStore })}\n`)
    return record.status === 'approved' ? 0 : 1
  }
  let server
  try {
    const catalog = loadCatalog(options.catalog)
    server = createServer({ ...catalog, allowWrite: options.allowWrite, adminToken: options.adminToken, requestStore: options.requestStore, maxBytes: options.maxBytes, log: message => process.stderr.write(`[${SERVER_INFO.name}] ${message}\n`) })
  } catch (error) {
    process.stderr.write(`${SERVER_INFO.name}: ${error.message}\n`)
    return 2
  }
  attachStdin(server)
  return 0
}
