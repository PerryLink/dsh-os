const CLIP = 'Meeting notes: ship dsh-os 0.2.0 on Friday. Owner: Lin. Link: https://example.test/roadmap'

export default {
  id: 'tidy-clipboard',
  title: '整理剪贴板',
  goal: '把剪贴板里的会议纪要写入 clip.md，保留来源应用，并确认没有密钥泄漏。',
  initial: [
    '剪贴板 adapter 预置一段会议纪要',
    'snip capture.enabled=true',
    'act 提供内置 fs.write（workdir 限定在临时目录）',
  ],
  allowedInterventions: ['human.approve', 'human.grant', 'host.registerAction'],
  success: ['clip.md 规范化后与剪贴板原文一致', 'Snip 记录 sourceApp=Chrome', '输出无密钥串'],
  maxSteps: 12,
  expectedFirstTool: 'snip_capture',
  allowedTools: ['snip_capture', 'snip_search', 'snip_get', 'snip_list', 'act_invoke', 'allow_request', 'allow_wait', 'allow_check'],
  async setup(env) {
    const dir = env.temp('dsh-eval-clip-')
    env.cwd = dir
    const adapter = {
      available: () => ({ available: true }),
      read: () => ({ ok: true, kind: 'text', text: CLIP }),
    }
    await env.mount({
      act: { workdir: dir },
      snip: { capture: { enabled: true, adapter } },
    })
  },
  async policy(ai) {
    const captured = await ai.call('snip_capture', { sourceApp: 'Chrome' })
    ai.state.handle = captured?.handle
    const found = await ai.call('snip_search', { query: 'Meeting', limit: 5 })
    const id = found?.entries?.[0]?.handle ?? captured?.handle
    await ai.call('snip_get', { id })
    await ai.write(ai.env.path('clip.md'), CLIP, '把剪贴板纪要保存为 clip.md')
  },
  async check(env) {
    const file = env.read(env.path('clip.md'))
    const entry = env.ctx.get('snip').get(env.state.handle)
    const flat = text => text.replace(/\s+/g, ' ').trim()
    return [
      { id: 'file-normalized', ok: flat(file) === flat(CLIP), detail: `clip.md ${Buffer.byteLength(file)} bytes` },
      { id: 'source-app', ok: entry?.sourceApp === 'Chrome', detail: `sourceApp=${entry?.sourceApp ?? 'missing'}` },
      { id: 'no-secret', ok: entry?.redacted === false && !/\bsk-[A-Za-z0-9_-]{6,}|BEGIN [A-Z ]*PRIVATE KEY/.test(file), detail: '无密钥串，Snip 未命中 redaction' },
    ]
  },
}
