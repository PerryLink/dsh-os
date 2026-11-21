import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { buildAgentCard, DEFAULT_URL, PACKAGE_VERSION, SKILL_IDS } from './card.mjs'

const STATES = Object.freeze(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'])
const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const SKILLS = new Set(SKILL_IDS)
const MAX_LINE_BYTES = 1024 * 1024

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

const fail = (code, message, data) => { throw new RpcError(code, message, data) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const messageText = message => (message.parts ?? []).filter(part => part?.kind === 'text').map(part => part.text).join('\n')

/** Default executor: no DSH, no kernel, no side effects. */
export function simulateExecutor({ text, skill }) {
  return { data: { echo: text, skill } }
}

function errorResponse(id, error) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
}

export function createServer({
  url = DEFAULT_URL,
  version = PACKAGE_VERSION,
  executor = simulateExecutor,
  clock = () => new Date(),
  newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
} = {}) {
  const card = buildAgentCard({ url, version })
  const tasks = new Map()
  const simulated = executor === simulateExecutor
  const now = () => new Date(clock()).toISOString()
  const agentMessage = (task, text) => ({ kind: 'message', messageId: newId('msg'), role: 'agent', taskId: task.id, contextId: task.contextId, parts: [{ kind: 'text', text }] })

  function taskOrFail(value) {
    if (typeof value !== 'string' || value === '') fail(-32602, 'params.id must be a non-empty string', { code: 'E_INVALID_PARAMS' })
    const task = tasks.get(value)
    if (task === undefined) fail(-32001, `Task not found: ${value}`, { taskId: value })
    return task
  }

  async function execute(task, { skill, text, message, approval }) {
    task.status = { state: 'working', timestamp: now() }
    try {
      const result = (await executor({ task: structuredClone(task), skill, text, message, approval })) ?? {}
      const data = result.data ?? { echo: text, skill }
      const parts = result.text ? [{ kind: 'text', text: result.text }, { kind: 'data', data }] : [{ kind: 'data', data }]
      task.artifacts = [{ artifactId: newId('artifact'), name: result.name ?? `${skill}-result`, parts, metadata: { simulated } }]
      task.status = { state: 'completed', timestamp: now(), message: agentMessage(task, `Skill ${skill} completed.`) }
    } catch (error) {
      task.status = { state: 'failed', timestamp: now(), message: agentMessage(task, `Skill ${skill} failed: ${error.message}`) }
      task.metadata = { ...task.metadata, error: { message: String(error.message ?? error) } }
    }
    return task
  }

  async function send(params) {
    const input = params.message
    if (!isObject(input) || !Array.isArray(input.parts) || input.parts.length === 0) fail(-32602, 'params.message.parts must be a non-empty array', { code: 'E_INVALID_PARAMS' })
    if (input.role !== undefined && input.role !== 'user') fail(-32602, 'params.message.role must be "user"', { code: 'E_INVALID_PARAMS' })
    const message = { ...input, kind: 'message', messageId: typeof input.messageId === 'string' && input.messageId !== '' ? input.messageId : newId('msg'), role: 'user' }
    const skill = params.skill ?? params.metadata?.skill ?? message.metadata?.skill ?? 'act'
    if (typeof skill !== 'string' || !SKILLS.has(skill)) fail(-32602, `Unknown skill: ${skill}`, { code: 'E_UNKNOWN_SKILL', skill, knownSkills: [...SKILL_IDS] })
    const requiresApproval = params.requiresApproval === true || params.metadata?.requiresApproval === true || message.metadata?.requiresApproval === true
    const task = {
      kind: 'task',
      id: newId('task'),
      contextId: message.contextId ?? params.contextId ?? newId('ctx'),
      status: { state: 'submitted', timestamp: now() },
      history: [message],
      artifacts: [],
      metadata: { skill, requiresApproval },
    }
    tasks.set(task.id, task)
    if (requiresApproval) {
      task.approvalRequest = { id: newId('approval'), taskId: task.id, skill, risk: 'write', state: 'pending', reason: params.metadata?.reason ?? 'Task declared requiresApproval=true.', createdAt: now() }
      task.status = { state: 'input-required', timestamp: now(), message: agentMessage(task, `Approval required before running skill ${skill}.`) }
      return task
    }
    return execute(task, { skill, text: messageText(message), message, approval: null })
  }

  function pendingApproval(task) {
    if (task.status.state !== 'input-required' || task.approvalRequest?.state !== 'pending') {
      fail(-32010, `Task ${task.id} has no pending approval`, { code: 'E_APPROVAL_NOT_PENDING', taskId: task.id, state: task.status.state })
    }
  }

  async function approve(params) {
    const task = taskOrFail(params.id)
    pendingApproval(task)
    task.approvalRequest.state = 'approved'
    task.approvalRequest.decidedAt = now()
    return execute(task, { skill: task.metadata.skill, text: messageText(task.history[0]), message: task.history[0], approval: task.approvalRequest })
  }

  function deny(params) {
    const task = taskOrFail(params.id)
    pendingApproval(task)
    task.approvalRequest.state = 'denied'
    task.approvalRequest.decidedAt = now()
    task.approvalRequest.reason = typeof params.reason === 'string' && params.reason !== '' ? params.reason : 'Denied by local approver.'
    task.status = { state: 'canceled', timestamp: now(), message: agentMessage(task, `Approval denied for skill ${task.metadata.skill}.`) }
    return task
  }

  function cancel(params) {
    const task = taskOrFail(params.id)
    if (TERMINAL.has(task.status.state)) fail(-32002, `Task ${task.id} is already ${task.status.state}`, { taskId: task.id, state: task.status.state })
    if (task.approvalRequest?.state === 'pending') {
      task.approvalRequest.state = 'canceled'
      task.approvalRequest.decidedAt = now()
    }
    task.status = { state: 'canceled', timestamp: now(), message: agentMessage(task, `Task ${task.id} canceled.`) }
    return task
  }

  function list(params) {
    if (params.state !== undefined && !STATES.includes(params.state)) fail(-32602, `Unknown state: ${params.state}`, { code: 'E_INVALID_PARAMS', states: [...STATES] })
    const found = [...tasks.values()].reverse().filter(task =>
      (params.contextId === undefined || task.contextId === params.contextId) &&
      (params.state === undefined || task.status.state === params.state))
    return { tasks: found, total: found.length }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'agent/card': return card
      case 'message/send': return send(params)
      case 'tasks/get': return taskOrFail(params.id)
      case 'tasks/cancel': return cancel(params)
      case 'tasks/list': return list(params)
      case 'tasks/approve': return approve(params)
      case 'tasks/deny': return deny(params)
      default: return fail(-32601, `Method not found: ${method}`, { code: 'E_METHOD_NOT_FOUND', method })
    }
  }

  async function handle(request) {
    const hasId = isObject(request) && Object.prototype.hasOwnProperty.call(request, 'id')
    try {
      if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') fail(-32600, 'Invalid Request', { code: 'E_INVALID_REQUEST' })
      if (request.params !== undefined && !isObject(request.params)) fail(-32602, 'params must be an object', { code: 'E_INVALID_PARAMS' })
      const result = await dispatch(request.method, request.params ?? {})
      return hasId ? { jsonrpc: '2.0', id: request.id, result: structuredClone(result) } : null
    } catch (error) {
      if (!hasId && isObject(request) && request.jsonrpc === '2.0' && typeof request.method === 'string') return null
      const rpc = error instanceof RpcError ? error : new RpcError(-32603, error.message ?? 'Internal error', { code: 'E_INTERNAL' })
      return errorResponse(isObject(request) ? request.id : null, rpc)
    }
  }

  async function handleLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return null
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return errorResponse(null, new RpcError(-32600, `Request exceeds ${MAX_LINE_BYTES} bytes`, { code: 'E_LIMIT' }))
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return errorResponse(null, new RpcError(-32700, 'Parse error', { code: 'E_PARSE' }))
    }
    return handle(request)
  }

  return { card, handle, handleLine }
}

/** Newline-delimited JSON-RPC 2.0 over stdin/stdout; logs stay on stderr. */
export async function runStdio({ stdin = process.stdin, stdout = process.stdout, server = createServer() } = {}) {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false })
  for await (const line of lines) {
    const response = await server.handleLine(line)
    if (response !== null) stdout.write(`${JSON.stringify(response)}\n`)
  }
}
