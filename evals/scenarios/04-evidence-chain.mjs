import { existsSync } from 'node:fs'
import { join } from 'node:path'

const hit = (dir, name, snippet) => ({ path: join(dir, 'docs', name), title: name, snippet, refStatus: 'fresh' })
const locatorOf = dir => ({
  name: 'locator_find',
  async execute() {
    return { ok: true, totalCount: 3, truncated: false, hits: [
      hit(dir, 'missing.md', 'User-trust profiles are hidden from agent-layer resolution.'),
      hit(dir, 'user-trust.md', 'User-trust profiles are hidden from agent-layer resolution.'),
      hit(dir, 'env.md', 'Root never materializes process.env.'),
    ] }
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
  initial: ['2 篇真实文档 + 1 个不存在文档的 locator 命中（伪 ref 诱饵）', 'memento 有 1 条 user-global 记忆和 1 条 workspace 记忆', '工具面没有 ref resolver'],
  allowedInterventions: [],
  success: ['至少 2 条 trace claim', '2 个 source ref 可解析', '0 条伪 ref'],
  maxSteps: 10,
  expectedFirstTool: 'seek_providers',
  allowedTools: ['seek_providers', 'seek_search', 'seek_register_defaults', 'seek_resolve', 'locator_resolve', 'trace_remember', 'trace_search', 'trace_list'],
  async setup(env) {
    const dir = env.temp('dsh-eval-evidence-')
    env.cwd = dir
    env.write(env.path('docs/user-trust.md'), '# user-trust\n\nUser-trust profiles are hidden from agent-layer resolution.\n')
    env.write(env.path('docs/env.md'), '# env\n\nRoot never materializes process.env.\n')
    await env.mount({}, { services: { memory: memoryOf() }, tools: { locator_find: locatorOf(dir) } })
  },
  async policy(ai) {
    await ai.call('seek_providers', {})
    const found = await ai.call('seek_search', { query: 'user-trust', limit: 3 })
    const hits = found?.hits ?? [], first = hits[0], locator = hits.find(item => item.source === 'locator')
    await ai.call('seek_resolve', { ref: first?.ref })
    await ai.call('locator_resolve', { ref: first?.ref })
    await ai.call('root_resolve', { name: first?.ref })
    await ai.call('trace_remember', { key: 'repo:dsh-os/user-trust', text: 'user-trust profiles are hidden from agent-layer resolution.', source: first?.ref, confidence: 0.8 })
    await ai.call('trace_remember', { key: 'repo:dsh-os/env', text: 'Root never materializes process.env.', source: locator?.ref, confidence: 0.7 })
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
      { id: 'two-claims', ok: records.length >= 2, detail: `${records.length} 条 claim` },
      { id: 'two-resolvable-refs', ok: valid.length >= 2, detail: `${valid.length}/${sources.length} 个 source ref 可解析` },
      { id: 'no-bogus-ref', ok: records.length > 0 && records.every(record => resolves(sourceOf(record))), detail: sources.join(', ') || 'none' },
    ]
  },
}
