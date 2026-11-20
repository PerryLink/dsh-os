/** The three 0.2.0 source tools; plain ToolDefinitions, no dependency. */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const SOURCE_OPTION_KEYS = ['id', 'path', 'sessionId', 'token', 'secretEnv']

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args) {
      return execute(args ?? {})
    },
  }
}

function requiredString(args, key, toolName) {
  if (typeof args[key] !== 'string' || args[key] === '') {
    throw Object.assign(new Error(`${toolName} requires a non-empty ${key}`), { code: 'invalid_arguments' })
  }
  return args[key]
}

/** Forward only the source options the tools expose (never secrets). */
function sourceOptions(args) {
  const options = {}
  for (const key of SOURCE_OPTION_KEYS) {
    if (typeof args[key] === 'string' && args[key] !== '') options[key] = args[key]
  }
  return options
}

export function makeSourceTools(service) {
  return [
    tool(
      'trigger_sources',
      'List the real event sources running in this process with their counters and adapter info.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => ({ sources: service.sources() }),
    ),
    tool(
      'trigger_source_start',
      'Start a real event source that fires Triggers by event name. '
        + 'agent: session/turn-end, session/approval-asked, session/tool-result, agent/error, agent/status. '
        + 'fs: fs.change for non-recursive file changes under `path`. '
        + 'webhook: webhook/received from POST /os-trigger/<token> (loopback only).',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['agent', 'fs', 'webhook'], description: 'Source kind.' },
          id: { type: 'string', description: 'Optional source id; generated when omitted.' },
          path: { type: 'string', description: 'fs source: absolute path to a file or directory.' },
          sessionId: { type: 'string', description: 'agent source: only project this session.' },
          token: { type: 'string', description: 'webhook source: URL token; generated when omitted.' },
          secretEnv: {
            type: 'string',
            description: 'webhook source: env var holding the HMAC secret; never pass the secret itself.',
          },
        },
        required: ['type'],
      },
      async args => ({
        source: await service.startSource(requiredString(args, 'type', 'trigger_source_start'), sourceOptions(args)),
      }),
    ),
    tool(
      'trigger_source_stop',
      'Stop a running event source and release its watcher, listeners or HTTP route.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Source id returned by trigger_source_start.' },
        },
        required: ['id'],
      },
      async args => {
        const id = requiredString(args, 'id', 'trigger_source_stop')
        return { id, stopped: await service.stopSource(id) }
      },
    ),
  ]
}
