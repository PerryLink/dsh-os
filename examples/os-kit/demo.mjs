#!/usr/bin/env node
/**
 * dsh-os in ten minutes — Allow + Act + Snip, with no host and no install.
 *
 * This file imports the package sources directly. It needs Node 22+ and nothing
 * else: no dependencies, no build step, no DSH profile, no network.
 *
 * Story:
 *   1. boot a fake Cordis ctx and apply Allow, Act and Snip
 *   2. register demo.read (read) and demo.write (write -> snip.add);
 *      echo is already an Act built-in, so it must not be registered twice
 *   3. read-risk actions run without a grant
 *   4. writing without a grant fails closed and leaves no Snip entry
 *   5. a human issues a 30-minute Grant through ctx.allow; the write succeeds
 *   6. revoking the Grant makes the next write fail again (forward-looking)
 *
 * Exit codes: 0 = all six steps passed, 1 = a step failed.
 * Run from the repository root: `node examples/os-kit/demo.mjs`.
 */

const TOTAL_STEPS = 6
const SUBJECT = 'agent:demo'
const CAPABILITY = 'act:invoke:demo.write'
const GRANT_TTL_MS = 30 * 60 * 1000
const WRITE_TEXT = 'dsh-os demo: the write action stored this line through Snip.'

let stepNumber = 0

function step(title) {
  stepNumber += 1
  console.log(`\n[${stepNumber}/${TOTAL_STEPS}] ${title}`)
}

function check(condition, message) {
  if (!condition) {
    throw new Error(`step ${stepNumber}/${TOTAL_STEPS}: ${message}`)
  }
}

function json(value) {
  return JSON.stringify(value)
}

/** Minimal stand-in for the Cordis context: provide/get plus a tool registry. */
function createFakeCtx() {
  const services = new Map()
  const tools = new Map()
  return {
    provide(name, service) {
      if (services.has(name)) throw new Error(`service already provided: ${name}`)
      services.set(name, service)
      return service
    },
    get(name) {
      return services.get(name)
    },
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string' || tool.name === '') {
          throw new Error('tool registration needs a non-empty name')
        }
        if (tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get(name) {
        return tools.get(name)
      },
      list() {
        return [...tools.values()]
      },
    },
  }
}

/**
 * Register the two demo actions. `echo` is not registered here: Act's `apply`
 * already registers an action with that id, and Act rejects duplicates with
 * `action_exists`.
 */
function registerDemoActions(ctx) {
  const act = ctx.get('act')
  const files = new Map([
    ['notes.md', '# dsh-os demo\n\nA fake workspace file served by demo.read.\n'],
  ])

  act.register({
    id: 'demo.read',
    title: 'Read a demo workspace file',
    description: 'Read one file from the in-memory workspace; read risk needs no grant.',
    risk: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'File name, e.g. "notes.md".' } },
    },
    async execute(args = {}) {
      const text = files.get(args.path)
      if (text === undefined) throw new Error(`no such file: ${String(args.path)}`)
      return { path: args.path, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length }
    },
  })

  act.register({
    id: 'demo.write',
    title: 'Store a note in the Snip ledger',
    description: 'Write risk: Act asks Allow for act:invoke:demo.write before snip.add runs.',
    risk: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: 'Text to store in Snip.' } },
    },
    async execute(args = {}) {
      if (typeof args.text !== 'string' || args.text.trim() === '') {
        throw new Error('demo.write needs a non-empty text')
      }
      const clip = ctx.get('snip').add({ text: args.text, sourceApp: 'dsh-os demo' })
      return { handle: clip.handle, preview: clip.preview, redacted: clip.redacted }
    },
  })
}

async function main() {
  // Apply packages before using them. Allow must exist before Act invokes a
  // write; Snip must exist before the write action's execute() runs.
  const { apply: applyAllow } = await import('../../packages/allow/index.js')
  const { apply: applyAct } = await import('../../packages/act/index.js')
  const { apply: applySnip } = await import('../../packages/snip/index.js')

  step('fake ctx + apply Allow, Act, Snip')
  const ctx = createFakeCtx()
  applyAllow(ctx)
  applyAct(ctx)
  applySnip(ctx)
  const allow = ctx.get('allow')
  const act = ctx.get('act')
  const snip = ctx.get('snip')
  check(allow && act && snip, 'the three services must be provided on ctx')
  const toolNames = ctx.tools.list().map(tool => tool.name).sort()
  check(toolNames.length === 9, `expected 9 agent tools, got ${toolNames.length}`)
  console.log(`  node ${process.version} · services: allow, act, snip · ${toolNames.length} agent tools`)
  console.log(`  tools: ${toolNames.join(', ')}`)

  step('register demo.read (read) and demo.write (write -> snip.add); echo ships with Act')
  registerDemoActions(ctx)
  const wired = ['echo', 'demo.read', 'demo.write'].map(id => act.get(id))
  check(wired.every(Boolean), 'echo, demo.read and demo.write must all be registered')
  check(act.get('echo').risk === 'read', 'Act built-in echo must be read risk')
  console.log(`  actions: ${wired.map(action => `${action.id}/${action.risk}`).join(', ')}`)

  step('read-risk actions run with no Grant')
  const echoed = await act.invoke('echo', { text: 'hello from dsh-os' }, { subject: SUBJECT })
  check(echoed.ok === true, `echo should succeed, got ${json(echoed)}`)
  check(echoed.result.text === 'hello from dsh-os', 'echo must return the supplied text')
  const read = await act.invoke('demo.read', { path: 'notes.md' }, { subject: SUBJECT })
  check(read.ok === true, `demo.read should succeed, got ${json(read)}`)
  check(read.result.lines === 4, 'demo.read should report four lines')
  console.log(`  echo -> ${json(echoed.result)}`)
  console.log(`  demo.read notes.md -> ${read.result.lines} lines, ${read.result.bytes} bytes`)

  step('write without a Grant is refused (fail closed)')
  const denied = await act.invoke('demo.write', { text: WRITE_TEXT }, { subject: SUBJECT })
  check(denied.ok === false && denied.code === 'grant_required', `expected grant_required, got ${json(denied)}`)
  check(denied.capability === CAPABILITY, `expected capability ${CAPABILITY}, got ${denied.capability}`)
  check(snip.list().length === 0, 'a denied write must not reach snip.add')
  console.log(`  demo.write -> ${json({ ok: denied.ok, code: denied.code, capability: denied.capability })}`)
  console.log(`  snip entries: 0 (execute() never ran)`)

  step('a human issues a 30-minute Grant; the same write now succeeds')
  const grant = allow.issue({
    subject: SUBJECT,
    capability: CAPABILITY,
    scope: '*',
    ttlMs: GRANT_TTL_MS,
    approver: 'user',
    evidence: { approvalId: 'demo-approval-1' },
  })
  check(grant.status === 'active', `new grant must be active, got ${grant.status}`)
  check(grant.expiresAt - grant.createdAt === GRANT_TTL_MS, 'grant TTL must be exactly 30 minutes')
  const written = await act.invoke('demo.write', { text: WRITE_TEXT }, { subject: SUBJECT })
  check(written.ok === true, `granted write should succeed, got ${json(written)}`)
  check(written.result.redacted === false, 'the demo text contains no secret and must not be redacted')
  const stored = snip.get(written.result.handle)
  check(stored !== null && stored.text === WRITE_TEXT, 'snip.get(handle) must return the stored text')
  console.log(`  grant ${grant.id} · status=${grant.status} · ttl=30min · scope=${grant.scope}`)
  console.log(`  demo.write -> ${json({ ok: written.ok, handle: written.result.handle, redacted: written.result.redacted })}`)
  console.log(`  snip.get(handle).text === written text: ${stored.text === WRITE_TEXT}`)

  step('revoke the Grant; the next write is refused again')
  const revoked = allow.revoke(grant.id, { subject: SUBJECT })
  check(revoked.status === 'revoked', `revoked grant must report revoked, got ${revoked.status}`)
  const after = allow.check({ subject: SUBJECT, capability: CAPABILITY })
  check(after.allowed === false && after.reason === 'revoked', `expected revoked denial, got ${json(after)}`)
  const deniedAgain = await act.invoke('demo.write', { text: 'after revoke' }, { subject: SUBJECT })
  check(deniedAgain.ok === false && deniedAgain.code === 'grant_required', `expected grant_required, got ${json(deniedAgain)}`)
  check(snip.list().length === 1, 'revocation is forward-looking: the granted clipping stays')
  console.log(`  grant status after revoke: ${revoked.status}`)
  console.log(`  allow.check -> ${json({ allowed: after.allowed, reason: after.reason })}`)
  console.log(`  demo.write -> ${json({ ok: deniedAgain.ok, code: deniedAgain.code })}`)
  console.log(`  snip entries: 1 (forward-looking: the earlier clipping stays)`)

  const stats = allow.auditStats()
  console.log('\nPASS: 6/6 steps — denied -> issued -> allowed -> revoked -> denied')
  console.log(`  audit: ${stats.retained.entries} events ` +
    `(security=${stats.totals.security}, allowed=${stats.totals.allowed}, denied=${stats.totals.denied})`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\nFAIL: ${message}`)
  if (process.env.DEBUG) console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}
