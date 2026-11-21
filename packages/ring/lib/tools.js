/** Atomic Ring tools; plain ToolDefinitions with no runtime dependency. */
import { RISKS, STATES } from './constants.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const argsSchema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, ...(required === undefined ? {} : { required }) })

const CHAIN_SCHEMA = {
  type: 'array',
  description: 'Full SLA chain; omit for t0 0s, t1 3m, t2 10m, t3 30m.',
  items: {
    anyOf: [
      { type: 'number', minimum: 0 },
      { type: 'object', additionalProperties: false, properties: { level: { type: 'integer', minimum: 0 }, afterMs: { type: 'number', minimum: 0 }, channel: { type: 'string' } } },
    ],
  },
}

const tool = (name, description, parameters, execute) => ({ name, description, parameters, output: OUTPUT, execute })

/** Build the eight model-facing tools over one RingService. */
export function createTools(service) {
  return [
    tool('ring_raise', 'Raise a pending approval case with an SLA escalation chain. Delivery only happens when a channel is explicitly configured.',
      argsSchema({
        source: { type: 'string', description: 'Origin, e.g. approval, hook, act or manual.' },
        risk: { type: 'string', enum: RISKS, description: 'Defaults to write.' },
        ttlMs: { type: 'number', minimum: 1, description: 'Case lifetime in ms; defaults to 60 minutes.' },
        escalationChain: CHAIN_SCHEMA,
      }, ['source']),
      async args => ({ case: service.raise(args ?? {}) })),
    tool('ring_ack', 'Acknowledge and claim a case. Ack stops escalation but is not approval.',
      argsSchema({
        id: { type: 'string' },
        by: { type: 'string', description: 'Principal acknowledging the case.' },
      }, ['id', 'by']),
      async args => ({ case: service.ack(args?.id, { by: args?.by }) })),
    tool('ring_escalate', 'Escalate a case to a chain level (number or t1..t3) or target label; omit to target the next level.',
      argsSchema({
        id: { type: 'string' },
        to: { type: ['integer', 'string'], description: 'Escalation level or target label.' },
      }, ['id']),
      async args => ({ case: service.escalate(args?.id, args?.to === undefined ? {} : { to: args.to }) })),
    tool('ring_list', 'List approval cases, optionally filtered by status.',
      argsSchema({
        status: { type: 'string', enum: STATES },
      }),
      async args => ({ cases: service.list(args?.status === undefined ? {} : { status: args.status }) })),
    tool('ring_receipts', 'List the audit receipts for one case (delivery, escalation, ack, decision or expiry).',
      argsSchema({ id: { type: 'string' } }, ['id']),
      async args => ({ receipts: service.receipts(args?.id) })),
    tool('ring_channels', 'List configured notification channels. No network is used unless a channel is explicitly configured.',
      argsSchema({}),
      async () => ({ channels: service.channels() })),
    tool('ring_notify', 'Send one notification for a case through a configured channel; requires an Allow Grant for "ring:notify" on the calling subject (exec.subject). A delivery receipt is recorded on success and failure.',
      argsSchema({
        id: { type: 'string' },
        channel: { type: 'string', description: 'webhook, ntfy, console, local or voice.' },
      }, ['id']),
      async (args, exec) => service.notify(args?.id, {
        ...(args?.channel === undefined ? {} : { channel: args.channel }),
        ...(exec?.subject === undefined ? {} : { subject: exec.subject }),
      })),
    tool('ring_tick', 'Advance every open case to `at` (default: the service clock): expire, deliver t0 and escalate due levels. Automatic delivery needs the "ring:notify" Grant; without it a blocked receipt is written and nothing is sent. Returns receipts, changed cases and delivery results.',
      argsSchema({
        at: { type: 'number', minimum: 0, description: 'Unix epoch milliseconds; omit to use the current clock.' },
      }),
      async args => service.tick(args?.at)),
  ]
}
