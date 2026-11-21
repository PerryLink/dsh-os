import { readdirSync, statSync, watch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const versionOf = stat => `${stat.ino}:${stat.size}:${stat.mtimeMs}`
const fsOf = () => ({
  resolve: async path => ({ targetKey: resolve(path), displayPath: resolve(path) }),
  stat: async target => { try { const stat = statSync(target.displayPath); return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, version: versionOf(stat) } } catch { return undefined } },
  listDir: async target => { try { return readdirSync(target.displayPath, { withFileTypes: true }).map(entry => { const stat = statSync(join(target.displayPath, entry.name)); return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: stat.size, version: versionOf(stat) } }) } catch { return [] } },
  watch: async (target, changed) => { const watcher = watch(target.displayPath, () => changed()); return async () => watcher.close() },
})
const runOf = text => ({
  schema: 'dsh.check.run/v1',
  tasks: [{ id: 'app.banner', result: { text }, trajectory: { steps: 4, toolCalls: 2, errors: 0 }, cost: { usd: 0.1 }, approvals: { asked: 0, rejected: 0 } }],
})

export default {
  id: 'upgrade-regression',
  title: '升级回归',
  goal: '外部把 app 从 v1 升级到 v2 后，用 fs 事件触发回归检查，升级为 escalated，并送达一条可回执的通知。',
  initial: [
    '临时目录 app.txt 内容为 v1',
    'ctx.fs 提供真实 fs.watch + snapshot diff',
    'check_compare 的 before/after run 对象由宿主提供',
    'Ring 默认无 channel',
    'trigger run 现记录 path 与脱敏 payload；ring_notify 成功/失败都写 delivery receipt',
  ],
  allowedInterventions: ['host.configureChannel'],
  success: [
    'check_compare verdict=regression',
    'fs.change 事件产生 trigger run',
    'console 送达 1 条，且 ring_notify 返回 delivery.ok=true',
    'case 状态 escalated',
    'trigger run 记录 fs.change 及变更路径 app.txt',
    'ring receipts 含 delivery（ok=true）',
  ],
  maxSteps: 16,
  expectedFirstTool: 'trigger_register',
  allowedTools: ['trigger_register', 'trigger_source_start', 'trigger_sources', 'trigger_runs', 'trigger_source_stop', 'check_compare', 'ring_raise', 'ring_escalate', 'ring_notify', 'ring_channels', 'ring_receipts'],
  async setup(env) {
    const dir = env.temp('dsh-eval-upgrade-')
    env.cwd = dir
    env.write(env.path('app.txt'), 'v1\n')
    env.state.oldRun = runOf('v1')
    env.state.newRun = runOf('v2 changed')
    await env.mount({}, { services: { fs: fsOf() } })
  },
  async policy(ai) {
    await ai.call('trigger_register', { id: 'tg.fs', event: 'fs.change', actionId: 'record' })
    await ai.call('trigger_source_start', { type: 'fs', path: ai.env.path('app.txt'), id: 'src.fs' })
    await ai.world('外部升级 app.txt 到 v2', async () => {
      writeFileSync(ai.env.path('app.txt'), 'v2 changed\n')
      await ai.sleep(900)
    })
    await ai.call('trigger_sources', {})
    await ai.call('trigger_runs', { limit: 5 })
    const compared = await ai.call('check_compare', { old: ai.state.oldRun, new: ai.state.newRun })
    ai.state.verdict = compared?.verdict
    const raised = await ai.call('ring_raise', { source: 'upgrade-regression', risk: 'write' })
    const id = raised?.case?.id
    ai.state.caseId = id
    await ai.call('ring_escalate', { id })
    // No channel yet: this is a real recoverable failure, not a scripted pass.
    const early = await ai.call('ring_notify', { id })
    ai.state.earlyNotify = early?.ok === false ? early?.error?.code ?? early?.code ?? 'failed' : 'unexpected-ok'
    await ai.call('ring_channels', {})
    await ai.intervene('host.configureChannel')
    const notified = await ai.call('ring_notify', { id })
    ai.state.delivery = notified?.delivery ?? null
    await ai.call('ring_receipts', { id })
    await ai.call('trigger_source_stop', { id: 'src.fs' })
  },
  async check(env) {
    const receipts = env.ctx.get('ring').receipts(env.state.caseId)
    const runs = env.ctx.get('triggers').runs(10)
    const escalated = env.ctx.get('ring').list({ status: 'escalated' })
    return [
      { id: 'regression-detected', ok: env.state.verdict === 'regression', detail: `verdict=${env.state.verdict ?? 'missing'}` },
      { id: 'fs-trigger-run', ok: runs.some(run => run.event === 'fs.change'), detail: `${runs.length} 条 trigger run` },
      { id: 'console-delivery', ok: env.consoleLines.length === 1, detail: `${env.consoleLines.length} 条 console 输出` },
      { id: 'notify-delivery-ok', ok: env.state.delivery?.ok === true, detail: `ring_notify delivery=${JSON.stringify(env.state.delivery ?? null)}` },
      { id: 'case-escalated', ok: escalated.length === 1, detail: `${escalated.length} 个 escalated case` },
      {
        id: 'trigger-run-has-path',
        ok: runs.some(run => run.event === 'fs.change'
          && (run.path === 'app.txt' || String(run.payload?.path ?? '').endsWith('/app.txt'))),
        detail: `paths=${runs.filter(run => run.event === 'fs.change').map(run => run.path ?? run.payload?.path ?? 'none').join(',') || 'none'}`,
      },
      {
        id: 'delivery-receipt',
        ok: receipts.some(receipt => receipt.kind === 'delivery' && receipt.ok === true),
        detail: `receipts: ${receipts.map(receipt => `${receipt.kind}${receipt.ok === undefined ? '' : `(ok=${receipt.ok})`}`).join(',') || 'none'}`,
      },
    ]
  },
}
