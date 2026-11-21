import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TEXT = 'written through the kernel gateway\n'

export default {
  id: 'kernel-write',
  title: '内核网关写入',
  goal: '用 os_find 找到 fs.write 能力，经 os_request/os_do 完成一次真实文件写入，并确认 gateway 健康。',
  initial: [
    '临时目录为空，kernel 注册一个真实的 fs.write 能力（handler 写盘）',
    'kernel os_request 对接真实 Allow：创建 pending request，人类批准后生成 Grant',
    'kernel os_do 接受显式 grant；批准后由宿主把 Grant 交给 agent（kernel 尚不自动消费）',
  ],
  allowedInterventions: ['human.approve'],
  success: [
    'os_find 返回 fs.write 能力卡（risk=write）',
    '未授权时 os_do 返回 E_DENIED',
    'os_request 创建 pending request，批准后状态 approved 且有 grantId',
    'os_do 带批准后的 Grant 恰好写盘 1 次，文件内容正确',
    'os_status 报告 6 个 gateway 工具且 health=ok',
  ],
  maxSteps: 14,
  expectedFirstTool: 'os_find',
  allowedTools: ['os_find', 'os_do', 'os_request', 'os_status'],
  async setup(env) {
    const dir = env.temp('dsh-eval-kernel-')
    env.cwd = dir
    env.state.writes = 0
    await env.mount({}, {
      mounts: [{
        name: 'kernel',
        config: {
          capabilities: [{
            id: 'fs.write',
            title: 'Write a workspace file',
            summary: 'Write text to a workspace file.',
            whenToUse: ['Write or create a file in the workspace.'],
            whenNotToUse: ['Only read an existing file.'],
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'content'],
              properties: { path: { type: 'string' }, content: { type: 'string' } },
            },
            risk: 'write',
            permissions: ['fs.write'],
            tags: ['fs', 'write', 'file'],
            handler: async args => {
              env.state.writes += 1
              env.write(resolve(env.cwd, args.path), args.content)
              return { path: args.path, bytes: Buffer.byteLength(args.content) }
            },
          }],
        },
      }],
    })
  },
  async policy(ai) {
    const found = await ai.call('os_find', { intent: 'write a file fs.write' })
    ai.state.card = found?.items?.find(item => item.id === 'fs.write')
    const writeArgs = { path: 'note.txt', content: TEXT }
    const denied = await ai.call('os_do', { id: 'fs.write', args: writeArgs })
    ai.state.deniedCode = denied?.error?.code
    const requested = await ai.call('os_request', { id: 'fs.write', args: writeArgs, reason: 'write note.txt' })
    ai.state.requestId = requested?.requestId
    ai.state.requestOk = requested?.ok === true
    await ai.intervene('human.approve')
    // The host approval seam hands back the real Grant; kernel does not fetch it
    // from Allow itself (it has no auto-consume path yet).
    const written = await ai.call('os_do', { id: 'fs.write', args: writeArgs, grant: ai.state.approvedGrant })
    ai.state.writeOk = written?.ok === true
    ai.state.gateway = await ai.call('os_status', {})
  },
  async check(env) {
    const request = env.ctx.get('allow').requests({ subject: env.subject }).find(item => item.id === env.state.requestId)
    let file = null
    try { file = readFileSync(env.path('note.txt'), 'utf8') } catch { /* missing */ }
    const gateway = env.state.gateway
    return [
      { id: 'find-returns-fs-write', ok: env.state.card?.id === 'fs.write' && env.state.card?.risk?.includes('write'), detail: `card=${env.state.card?.id ?? 'missing'} risk=${env.state.card?.risk ?? 'none'}` },
      { id: 'denied-before-grant', ok: env.state.deniedCode === 'E_DENIED', detail: `os_do before grant=${env.state.deniedCode ?? 'missing'}` },
      { id: 'os-request-opens-request', ok: env.state.requestOk === true && request?.status === 'approved', detail: `requestId=${env.state.requestId ?? 'none'} status=${request?.status ?? 'missing'}` },
      { id: 'write-exactly-once', ok: env.state.writes === 1 && env.state.writeOk === true && file === TEXT, detail: `handler writes=${env.state.writes} os_do=${env.state.writeOk === true} file=${file === null ? 'missing' : 'ok'}` },
      { id: 'gateway-healthy', ok: gateway?.ok === true && gateway?.capabilities >= 1 && Array.isArray(gateway?.tools) && gateway.tools.length === 6, detail: `ok=${gateway?.ok} capabilities=${gateway?.capabilities} tools=${gateway?.tools?.length ?? 0}` },
    ]
  },
}
