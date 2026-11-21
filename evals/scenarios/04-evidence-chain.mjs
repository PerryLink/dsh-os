import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

const hit = (dir, name, snippet, refStatus = 'fresh') => ({
  path: join(dir, 'docs', name), title: name, snippet, refStatus,
})
// The decoy is a stale provider hit: the file does not exist. `locator_resolve`
// reports it missing, and Trace now verifies a dsh:// source before storing it.
const locatorOf = dir => ({
  name: 'locator_find',
  async execute() {
    return { ok: true, totalCount: 3, truncated: false, hits: [
      hit(dir, 'missing.md', 'User-trust profiles are hidden from agent-layer resolution.', 'missing'),
      hit(dir, 'user-trust.md', 'User-trust profiles are hidden from agent-layer resolution.'),
      hit(dir, 'env.md', 'Root never materializes process.env.'),
    ] }
  },
})
const locatorResolveOf = () => ({
  name: 'locator_resolve',
  async execute(args) {
    let path
    try { path = new URL(args?.ref).searchParams.get('path') } catch { /* invalid ref */ }
    if (!path) return { ok: false, error: 'invalid-ref' }
    return {
      ok: true, ref: args.ref, status: existsSync(path) ? 'fresh' : 'missing',
      title: basename(path), checkedAt: Date.now(),
    }
  },
})
const memoryOf = () => ({
  async query() {
    return { entries: [
      { id: 'mem-42', scope: 'user-global', agentKey: 'web', title: 'user-trust decision', text: 'Ask a human to publish an agent-trust profile.', score: 0.9 },
      { id: 'mem-43', scope: 'workspace', title: 'workspace note', text: 'must be filtered', score: 0.8 },
    ] }
  },
})

export default {
  id: 'evidence-chain',
  title: '证据链',
  goal: '查 user-trust 的证据，记住两条结论；每条结论的 ref 都必须可解析，不能收录伪 ref。',
  initial: [
    '2 篇真实文档 + 1 个不存在文档的 locator 命中（freshness=missing 的陈旧命中）',
    'memento 有 1 条 user-global 记忆和 1 条 workspace 记忆',
    'seek_resolve 可按 provider 校验 ref；Trace 在写入前校验 dsh:// source',
  ],
  allowedInterventions: [],
  success: [
    '至少 2 条 trace claim',
    '2 个 source ref 可解析',
    '0 条伪 ref',
    '伪 ref 被 seek_resolve 标为 missing，且 Trace 拒收',
  ],
  maxSteps: 12,
  expectedFirstTool: 'seek_providers',
  allowedTools: ['seek_providers', 'seek_search', 'seek_register_defaults', 'seek_resolve', 'trace_remember', 'trace_search', 'trace_list'],
  async setup(env) {
    const dir = env.temp('dsh-eval-evidence-')
    env.cwd = dir
    env.write(env.path('docs/user-trust.md'), '# user-trust\n\nUser-trust profiles are hidden from agent-layer resolution.\n')
    env.write(env.path('docs/env.md'), '# env\n\nRoot never materializes process.env.\n')
    await env.mount({}, {
      services: { memory: memoryOf() },
      tools: { locator_find: locatorOf(dir), locator_resolve: locatorResolveOf() },
    })
  },
  async policy(ai) {
    await ai.call('seek_providers', {})
    const found = await ai.call('seek_search', { query: 'user-trust', limit: 5 })
    const hits = found?.hits ?? []
    const bogus = hits.find(item => /\/missing\.md$/.test(item.ref))
    const memory = hits.find(item => item.source === 'memento')
    const envHit = hits.find(item => /\/env\.md$/.test(item.ref))
    // Resolve before remembering: this is the resolver the old surface lacked.
    ai.state.bogusResolution = bogus === undefined ? null : await ai.call('seek_resolve', { ref: bogus.ref })
    ai.state.memoryResolution = memory === undefined ? null : await ai.call('seek_resolve', { ref: memory.ref })
    ai.state.envResolution = envHit === undefined ? null : await ai.call('seek_resolve', { ref: envHit.ref })
    const rejected = bogus === undefined ? null : await ai.call('trace_remember', {
      key: 'repo:dsh-os/bogus', text: 'stale decoy must not be stored', source: bogus.ref, confidence: 0.2,
    })
    ai.state.bogusRejected = rejected?.ok === false && rejected?.code === 'E_REF_NOT_FOUND'
    await ai.call('trace_remember', {
      key: 'repo:dsh-os/user-trust',
      text: 'user-trust profiles are hidden from agent-layer resolution.',
      source: memory?.ref,
      confidence: 0.8,
    })
    await ai.call('trace_remember', {
      key: 'repo:dsh-os/env',
      text: 'Root never materializes process.env.',
      source: envHit?.ref,
      confidence: 0.7,
    })
    await ai.call('trace_search', { query: 'user-trust' })
  },
  async check(env) {
    const records = env.ctx.get('trace').list({ limit: 20 })
    const sourceOf = record => record.provenance?.source ?? record.source
    const resolves = ref => {
      if (typeof ref !== 'string') return false
      if (ref.startsWith('dsh://locator/')) return existsSync(join(env.cwd, decodeURIComponent(ref.slice('dsh://locator/'.length))))
      if (ref.startsWith('dsh://memento/')) return ['mem-42', 'mem-43'].includes(decodeURIComponent(ref.slice('dsh://memento/'.length)))
      return false
    }
    const sources = records.map(sourceOf), valid = sources.filter(resolves)
    return [
      { id: 'two-claims', ok: records.length === 2, detail: `${records.length} 条 claim` },
      { id: 'seek-resolve-finds-refs', ok: env.state.memoryResolution?.found === true && env.state.envResolution?.found === true, detail: `memory=${env.state.memoryResolution?.status ?? 'missing'} env=${env.state.envResolution?.status ?? 'missing'}` },
      { id: 'seek-resolve-missing-decoy', ok: env.state.bogusResolution?.found === false && env.state.bogusResolution?.status === 'missing', detail: `bogus=${env.state.bogusResolution?.status ?? 'missing'}` },
      { id: 'two-resolvable-refs', ok: valid.length >= 2, detail: `${valid.length}/${sources.length} 个 source ref 可解析` },
      { id: 'no-bogus-ref', ok: records.length === 2 && records.every(record => resolves(sourceOf(record))), detail: sources.join(', ') || 'none' },
      { id: 'trace-rejects-bogus-ref', ok: env.state.bogusRejected === true && records.every(record => !/\/missing\.md$/.test(sourceOf(record))), detail: `rejected=${env.state.bogusRejected === true}` },
    ]
  },
}
