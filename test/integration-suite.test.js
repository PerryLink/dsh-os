/**
 * Cross-module integration suite for dsh-os.
 *
 * Exercises real module services wired through one fake Cordis context
 * (`provide` / `get` / `tools.register`) exactly as the Host would mount them.
 * No DSH process is started and nothing touches the network or the real
 * clipboard; every ledger used here is in-memory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyAllow } from '../packages/allow/index.js'
import { apply as applyAct } from '../packages/act/index.js'
import { apply as applySnip } from '../packages/snip/index.js'
import { apply as applyTrigger } from '../packages/trigger/index.js'
import { apply as applyRing } from '../packages/ring/index.js'
import { apply as applySeek } from '../packages/seek/index.js'
import { apply as applyTrace } from '../packages/trace/index.js'
import { apply as applyNest } from '../packages/nest/index.js'
import { apply as applyRoot } from '../packages/root/index.js'

/** Minimal fake `ctx`: the only Host seams these modules consume. */
function fakeContext() {
  const services = new Map()
  const tools = new Map()
  return {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
    _services: services,
    _tools: tools,
  }
}

const SUBJECT = 'session:integration'

test('Act + Allow + Snip: a gated write action stores a clipping and revocation closes the gate', async () => {
  const ctx = fakeContext()
  const allow = applyAllow(ctx)
  const snip = applySnip(ctx)
  const act = applyAct(ctx)

  const text = 'pnpm install --frozen-lockfile'
  act.register({
    id: 'snip.save',
    title: 'Save a clipping',
    risk: 'write',
    execute: async args => ctx.get('snip').add({ text: args.text, sourceApp: 'integration-suite' }),
  })

  // The agent surface only exposes a read-only check; grants are minted by the
  // host (or a human-facing client) through the Allow service.
  assert.equal(ctx._tools.has('allow_issue'), false)
  assert.equal(ctx._tools.has('allow_check'), true)

  const denied = await act.invoke('snip.save', { text }, { subject: SUBJECT })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'grant_required')
  assert.equal(denied.capability, 'act:invoke:snip.save')
  assert.deepEqual(snip.list(), [], 'a denied action must not write the ledger')

  // Grant issued directly by the Allow service, not through an admin tool.
  const grant = allow.issue({
    subject: SUBJECT,
    capability: 'act:invoke:snip.save',
    scope: '*',
  })
  assert.equal(grant.status, 'active')

  const allowed = await act.invoke('snip.save', { text }, { subject: SUBJECT })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.actionId, 'snip.save')
  assert.match(allowed.result.handle, /^clipboard:\/\//)
  assert.equal(allowed.result.preview, text)

  const found = snip.search('frozen-lockfile')
  assert.equal(found.length, 1)
  assert.equal(found[0].id, allowed.result.id)
  assert.equal(snip.get(allowed.result.handle).text, text)
  assert.equal(snip.list().length, 1)

  allow.revoke(grant.id)
  const afterRevoke = await act.invoke('snip.save', { text: 'second write' }, { subject: SUBJECT })
  assert.equal(afterRevoke.ok, false)
  assert.equal(afterRevoke.code, 'grant_required')
  assert.equal(snip.list().length, 1, 'revocation must not erase the earlier clipping')

  const denials = allow.audit().filter(entry => entry.event === 'denied')
  assert.ok(
    denials.some(entry => entry.capability === 'act:invoke:snip.save' && entry.reason === 'no-grant'),
    'the first denial is audited',
  )
  assert.ok(
    denials.some(entry => entry.capability === 'act:invoke:snip.save' && entry.reason === 'revoked'),
    'the post-revocation denial is audited as revoked',
  )
})

test('Trigger + Act + Ring: build.failed runs an Act action and Ring records escalation, ack and resolution', async () => {
  const ctx = fakeContext()
  const act = applyAct(ctx)
  const triggers = applyTrigger(ctx)
  // Deterministic SLA clock: the case is raised at t0 and ticked at t1.
  const ring = applyRing(ctx, { now: () => 0 })
  const T1 = 3 * 60 * 1000

  const seen = []
  const trigger = triggers.register({
    id: 'tg.build.failed',
    event: 'build.failed',
    action: async payload => {
      seen.push(payload)
      return act.invoke('echo', { text: `build failed: ${payload.reason}` }, { subject: SUBJECT })
    },
  })
  assert.equal(trigger.id, 'tg.build.failed')

  const fired = await triggers.fire('build.failed', { reason: 'lint' })
  assert.deepEqual(seen, [{ reason: 'lint' }])
  assert.equal(fired.runs.length, 1)
  assert.equal(fired.runs[0].ok, true)
  assert.equal(fired.runs[0].triggerId, 'tg.build.failed')
  assert.deepEqual(fired.results[0].result, {
    ok: true,
    actionId: 'echo',
    result: { text: 'build failed: lint' },
  })

  const [recorded] = triggers.runs(1)
  assert.equal(recorded.ok, true)
  assert.equal(recorded.event, 'build.failed')

  const kase = ring.raise({ source: 'build', risk: 'write' })
  assert.equal(kase.state, 'pending')

  const ticked = await ring.tick(T1)
  assert.deepEqual(ticked.receipts.map(receipt => receipt.kind), ['delivery', 'escalation'])
  const escalated = ring.get(kase.id)
  assert.equal(escalated.state, 'escalated')
  assert.equal(escalated.level, 1)

  const acked = ring.ack(kase.id, { by: 'lead' })
  assert.equal(acked.state, 'acked')
  assert.equal(acked.ackedBy, 'lead')

  const resolved = ring.resolve(kase.id, { decision: 'approved' })
  assert.equal(resolved.state, 'resolved')
  assert.equal(resolved.decision, 'approved')

  const receipts = ring.receipts(kase.id)
  assert.deepEqual(
    receipts.map(receipt => receipt.kind),
    ['delivery', 'escalation', 'ack', 'decision'],
  )
  for (const receipt of receipts) assert.equal(receipt.caseId, kase.id)
})

test('Seek + Trace: a trace-backed provider yields dsh:// hits and duplicate refs keep the highest score', async () => {
  const ctx = fakeContext()
  const trace = applyTrace(ctx)
  const seek = applySeek(ctx)

  const first = trace.remember({
    key: 'repo:dsh-os',
    text: 'dsh-os exposes OS primitives to agents',
    confidence: 0.9,
  })
  const second = trace.remember({
    key: 'fact:build',
    text: 'The dsh-os integration build once failed',
    confidence: 0.4,
  })

  seek.registerProvider({
    name: 'trace',
    search(query) {
      return trace.search(query).flatMap(record => {
        const hit = {
          ref: `dsh://trace/${record.id}`,
          source: 'trace',
          title: record.key,
          snippet: record.text,
          score: record.confidence,
        }
        // The same ref twice with a worse score: Seek must keep the best hit.
        return [hit, { ...hit, score: 0.01 }]
      })
    },
  })

  const result = await seek.search('dsh-os')
  assert.equal(result.query, 'dsh-os')
  assert.deepEqual(result.errors, [])
  assert.equal(result.total, 2)
  assert.equal(result.hits.length, 2)
  assert.equal(new Set(result.hits.map(hit => hit.ref)).size, 2, 'refs are deduplicated')

  assert.deepEqual(result.hits.map(hit => hit.ref), [
    `dsh://trace/${first.id}`,
    `dsh://trace/${second.id}`,
  ])
  for (const hit of result.hits) {
    assert.equal(hit.source, 'trace')
    assert.match(hit.ref, /^dsh:\/\/trace\/[0-9a-f-]{36}$/)
  }
  assert.equal(result.hits[0].score, 0.9)
  assert.equal(result.hits[0].title, 'repo:dsh-os')
  assert.equal(result.hits[1].score, 0.4)
  assert.equal(result.hits[1].title, 'fact:build')
})

test('Nest + Root: a workspace profile references acme-dev and the agent layer hides user-trust vars', () => {
  const ctx = fakeContext()
  const nest = applyNest(ctx)
  const root = applyRoot(ctx)
  const workspace = process.cwd()

  const stored = nest.set(workspace, {
    title: 'Acme dev workspace',
    envProfile: 'acme-dev',
  })
  assert.equal(stored.envProfile, 'acme-dev')

  root.set('acme-user', {
    trust: 'user',
    scope: 'user',
    vars: { ACME_USER_HOST: 'internal.acme.test' },
  })
  root.set('acme-dev', {
    inherit: 'acme-user',
    trust: 'agent',
    scope: 'agent',
    vars: { ACME_DEV_HOST: 'dev.acme.test' },
  })

  // Nest stores the envProfile reference and serves it back through the seam.
  assert.equal(nest.get(workspace).envProfile, 'acme-dev')
  assert.equal(ctx.get('nest').get(workspace).envProfile, 'acme-dev')

  const full = root.resolve('acme-dev')
  assert.deepEqual(full.vars, {
    ACME_USER_HOST: 'internal.acme.test',
    ACME_DEV_HOST: 'dev.acme.test',
  })

  const agentView = root.resolve('acme-dev', { layer: 'agent' })
  assert.deepEqual(agentView.vars, { ACME_DEV_HOST: 'dev.acme.test' })
  assert.equal(Object.hasOwn(agentView.vars, 'ACME_USER_HOST'), false)
  assert.equal(Object.values(agentView.vars).includes('internal.acme.test'), false)
  assert.equal(agentView.sources.ACME_USER_HOST, undefined)
  assert.deepEqual(agentView.secretRefs, {})

  // A user-trust profile above the agent ceiling is not resolvable at all.
  assert.throws(
    () => root.resolve('acme-user', { layer: 'agent' }),
    error => error.code === 'layer_forbidden',
  )
})
