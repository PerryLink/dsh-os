export const PACKAGE_VERSION = '0.1.0'
export const DEFAULT_URL = 'http://127.0.0.1:8787/a2a'

/** One A2A skill per dsh-os module; a skill is a task family, not a tool. */
export const SKILLS = Object.freeze([
  { id: 'act', name: 'Actions and undo', description: 'Preview and run typed filesystem actions, then undo them.',
    tags: ['filesystem', 'actions', 'undo', 'write'],
    examples: ['Create a note file, then undo it', 'Preview moving a file before running it'] },
  { id: 'allow', name: 'Capability grants', description: 'Issue, revoke and audit time-boxed capability grants.',
    tags: ['permissions', 'grants', 'approval', 'audit'],
    examples: ['Grant one-hour write access to a workspace', 'Revoke a stale grant and show its audit trail'] },
  { id: 'snip', name: 'Clipboard ledger', description: 'Capture, search and redact a local-first clipboard ledger.',
    tags: ['clipboard', 'search', 'secrets', 'local'],
    examples: ['Search my clipboard for the last URL', 'Capture the clipboard without secrets'] },
  { id: 'check', name: 'Regression canary', description: 'Compare two environments and flag regressions after upgrades.',
    tags: ['regression', 'checks', 'upgrades', 'ci'],
    examples: ['Run the canary after a plugin upgrade', 'Compare host and sandbox environments'] },
  { id: 'nest', name: 'Workspace profiles', description: 'Version context, permissions and environment defaults per workspace.',
    tags: ['workspace', 'profiles', 'context', 'environment'],
    examples: ['Apply the CI workspace profile', 'Show what changed between two profiles'] },
  { id: 'trigger', name: 'Triggers', description: 'Turn events into actions with a condition DSL and run ledger.',
    tags: ['events', 'automation', 'conditions', 'webhook'],
    examples: ['Run a check when a file changes', 'Disable a trigger after three failures'] },
  { id: 'seek', name: 'Evidence search', description: 'Search across sources and return verifiable references.',
    tags: ['search', 'evidence', 'references', 'research'],
    examples: ['Find evidence for this claim', 'Resolve an evidence marker to its source'] },
  { id: 'trace', name: 'Memory governance', description: 'Track provenance, expiry and conflicts for long-term memory.',
    tags: ['memory', 'provenance', 'retention', 'conflict'],
    examples: ['Forget a memory and keep its tombstone', 'Explain where this memory came from'] },
  { id: 'stage', name: 'Windows and spaces', description: 'Inspect and arrange display, window and space layouts.',
    tags: ['windows', 'display', 'layout', 'stage'],
    examples: ['Snapshot the current window layout', 'Arrange two windows side by side'] },
  { id: 'ring', name: 'Approval escalation', description: 'Acknowledge, escalate and audit approvals with delivery receipts.',
    tags: ['approval', 'escalation', 'sla', 'receipts'],
    examples: ['Escalate an approval after ten minutes', 'Show the receipt for an approval'] },
  { id: 'root', name: 'Environment profiles', description: 'Name, explain and snapshot environment profiles.',
    tags: ['environment', 'profiles', 'snapshot', 'shell'],
    examples: ['Snapshot my current environment', 'Compare two environment profiles'] },
  { id: 'kernel', name: 'Capability kernel', description: 'Register capability descriptors and route os_* gateway verbs.',
    tags: ['kernel', 'registry', 'capabilities', 'gateway'],
    examples: ['List capabilities with write risk', 'Explain how to call a capability'] },
])

export const SKILL_IDS = Object.freeze(SKILLS.map(skill => skill.id))

export function buildAgentCard({ url = DEFAULT_URL, version = PACKAGE_VERSION } = {}) {
  return {
    name: 'dsh-os',
    description: 'OS primitives for DSH: actions, grants, clipboard, regression checks, workspace profiles, triggers, evidence, memory, windows, approvals, environment and a capability kernel.',
    url,
    version,
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'PerryLink' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: SKILLS.map(skill => ({ ...skill, tags: [...skill.tags], examples: [...skill.examples] })),
  }
}
