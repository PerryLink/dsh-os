# Recipe：Act + Allow 的写动作授权与撤销

> 目标：注册一个 `risk: 'write'` 的 Act 动作；没有 Grant 时 **fail closed**；
> 人类签发 Grant 后同一个动作可以执行；撤销后下一次调用再次
> `grant_required`。
>
> 适用 `dsh-act` / `dsh-allow` 0.1.x。Allow 是**控制面，不是沙箱**：它记录和
> 回答“谁批准了什么、多久、什么范围”，不替代 DSH 的审批提示、permission
> rules、preset 或 OS 沙箱。

## 1. 安装

独立脚本（本 recipe 的主路径，最容易看清语义）：

```sh
mkdir act-allow-demo
cd act-allow-demo
npm init -y
npm install dsh-act dsh-allow
```

或者装进 DSH profile：

```sh
dsh plugin --profile web add dsh-act dsh-allow
dsh --profile web --dump-config | grep -E '^# == (dsh-act|dsh-allow)'
```

预期：

```text
# == dsh-act
# == dsh-allow
```

## 2. 可跑的最小脚本

新建 `demo.mjs`：

```js
import { apply as applyAllow } from 'dsh-allow'
import { apply as applyAct } from 'dsh-act'

// 最小 Cordis 替身：只需要 provide/get 和 tools.register。
const services = new Map()
const ctx = {
  provide: (name, value) => services.set(name, value),
  get: name => services.get(name),
  tools: { register: () => {} },
}

const allow = applyAllow(ctx)
const act = applyAct(ctx)

act.register({
  id: 'demo.write-note',
  title: 'Write a note',
  risk: 'write',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path', 'text'],
  },
  async execute(args) {
    return { path: args.path, bytes: Buffer.byteLength(args.text) }
  },
})

const subject = 'session-42'
const capability = 'act:invoke:demo.write-note'
const call = () =>
  act.invoke('demo.write-note', { path: 'notes.md', text: 'hello' }, { subject })

console.log('before:', JSON.stringify(await call()))

const grant = allow.issue({
  subject,
  capability,
  scope: '*',
  ttlMs: 60_000,
  approver: 'user',
})
console.log('grant:', JSON.stringify({ id: grant.id, status: grant.status, expiresAt: grant.expiresAt }))

console.log('after:', JSON.stringify(await call()))

const revoked = allow.revoke(grant.id, { subject })
console.log('revoked:', JSON.stringify({ id: revoked.id, status: revoked.status }))

console.log('after revoke:', JSON.stringify(await call()))
console.log('check:', allow.check({ subject, capability }).reason)
console.log('audit:', JSON.stringify(allow.audit().map(event => event.event)))
```

运行：

```sh
node demo.mjs
```

预期（id 和 `expiresAt` 每次不同；其余字段来自实测）：

```text
before: {"ok":false,"code":"grant_required","actionId":"demo.write-note","capability":"act:invoke:demo.write-note"}
grant: {"id":"grant_<uuid>","status":"active","expiresAt":<epoch-ms>}
after: {"ok":true,"actionId":"demo.write-note","result":{"path":"notes.md","bytes":5}}
revoked: {"id":"grant_<uuid>","status":"revoked"}
after revoke: {"ok":false,"code":"grant_required","actionId":"demo.write-note","capability":"act:invoke:demo.write-note"}
check: revoked
audit: ["denied","denied","revoked","allowed","issued","denied"]
```

关键点：

- `before` 的拒绝发生在 `execute()` **之前**，所以不会产生副作用；
- `issue()` 只写 Grant，不执行动作；
- `revoke()` 之后下一次 `invoke()` 立刻回到 `grant_required`；
- `audit()` 最新在前；`denied`、`issued`、`allowed`、`revoked` 都是可审计事件。

## 3. 放进 DSH 插件

在真实插件里，服务从 `ctx.get()` 拿，依赖用 `inject` 声明：

```js
export const name = 'my-write-plugin'
export const inject = ['tools', 'act', 'allow']

export function apply(ctx) {
  const act = ctx.get('act')

  act.register({
    id: 'demo.write-note',
    title: 'Write a note',
    risk: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' }, text: { type: 'string' } },
      required: ['path', 'text'],
    },
    async execute(args) {
      return { path: args.path, bytes: Buffer.byteLength(args.text) }
    },
  })
}
```

**不要在 `apply()` 里自动签发 Grant。** 授权应该来自人类动作（审批结果、
管理面板、CLI），再把 Grant 交给服务。一个最小的人类侧助手：

```js
export function issueWriteGrant(allow, { subject, approvalId }) {
  return allow.issue({
    subject,
    capability: 'act:invoke:demo.write-note',
    scope: '*',
    ttlMs: 30 * 60 * 1000,
    approver: 'user',
    evidence: { approvalId },
  })
}
```

`evidence` 只放审批引用，不要放密钥或凭据值。Grant 默认 TTL 24 小时，最长
30 天；过期后 `check()` 返回 `reason: 'expired'`，不会隐式续期。

## 4. Agent 调用路径与 subject

Agent 通过 `act_invoke` 工具调用动作：

```json
{
  "id": "demo.write-note",
  "args": { "path": "notes.md", "text": "hello" }
}
```

`act_invoke` 的 subject 来自 `exec.agent.session.id`（没有 session 时退回
`exec.agent.id`），**不是**你随手写的 `agent:planner`。所以：

- 如果 Grant 签给 `session-42`，持有该 session 的 agent 才能通过；
- 如果 Grant 签给 `agent:planner`，agent 的工具调用通常对不上，会继续
  `grant_required`；
- 后台/插件代码可以自己调 `act.invoke(id, args, { subject })`，但 subject
  必须和 Grant 的 subject 完全一致。

`act_list` 是只读的，可以先看动作 id 和 risk（下面是结构示意，实际还会带
内建动作和可选 `description`）：

```text
act_list -> { actions: [ { id: 'demo.write-note', title: 'Write a note', risk: 'write' }, ... ] }
```

### 不要把 admin tools 交给不可信 agent

Allow 0.1.1+ 默认只注册 `allow_check`。`allow_issue`、`allow_revoke`、
`allow_list` 需要人类侧客户端显式配置 `exposeAdminTools: true` 才会注册。把它们暴露给模型，
等于让模型自己铸 Grant、绕过 Act 的写门禁。这个开关只给可信的人类界面/管理
客户端。

## 5. 撤销、审计与持久化

撤销：

```js
const revoked = allow.revoke(grant.id, { subject })
```

- `subject` 必须匹配 Grant 的 owner，否则抛 `E_SUBJECT_MISMATCH`；
- 对已撤销/已过期的 Grant 再撤是幂等的，返回当前记录；
- 撤销是**向前生效**的：下一次 check 会拒绝，但无法停止已经在执行的调用。

`check()` 的 `reason`：

| reason | 含义 |
|---|---|
| `allowed` | 找到并命中了 active Grant |
| `no-grant` | 没有该 subject + capability 的 Grant |
| `expired` | 有，但已过期 |
| `revoked` | 有，但已撤销 |
| `scope-mismatch` | 有 active Grant，但 scope 不覆盖请求 |

持久化：默认只在进程内存里，重启即丢。需要跨重启就配置 `stateFile`：

```js
const allow = apply(ctx, { stateFile: '/var/lib/dsh/allow.json' })
```

写入是临时文件 + `fsync` + `rename`，文件模式 `0600`；目录必须可写。损坏或
不可读的状态文件会以 `E_STATE` **fail closed**，不会静默变成“全部允许”。

0.1.2+ 的审计保留是分层的：`allowed`/`denied` 最多保留 200 条，`issued` /
`revoked` / `expired` 只有在总上限 2000 条内、且没有 check 事件可挤掉时才被
淘汰。`auditStats()` 同时给出累计计数和当前保留量。

## 6. 边界与安全

- **不是沙箱。** Grant 只回答授权问题；同一进程里的代码仍可绕过检查直接做
  事。真正的文件/网络/进程限制仍由 DSH 权限、审批和 OS 沙箱负责。
- **不覆盖 DSH 的 deny。** Grant 只能 allow，不能把 DSH 的拒绝变成允许。
- **scope 的现状。** 本 recipe 用 `scope: '*'`。`dsh-act` 0.1.x 调
  `allow.check` 时只传 subject + capability，不传 scope；要按 scope 收紧，
  需要在调用前自行 `allow.check({ subject, capability, scope })`，或等 0.2.0
  的 seam 集成。
- **不要存密钥。** `evidence` 只放审批 id/引用；凭据放 credential store。

## 7. 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 已 issue 仍 `grant_required` | subject 不一致（尤其是 agent 工具用 session id）、capability 拼错、Grant 已过期/撤销 | 用 `allow.check({ subject, capability })` 看 `reason`；capability 必须是 `act:invoke:<id>` |
| `E_SUBJECT` | `subject` 为空/非字符串/超过 256 字符 | 传稳定的调用方身份 |
| `E_SUBJECT_MISMATCH` | revoke 时传了别人的 subject | 用 Grant 的 owner；或省略 subject（仅可信服务端） |
| `E_TTL` | `ttlMs` <= 0、非有限数或超过 30 天 | 用 1 毫秒到 30 天之间的值 |
| 找不到 `allow_issue` 工具 | admin tools 默认不注册 | 从人类侧代码 `allow.issue()`，或显式 `exposeAdminTools: true` |
| `E_STATE` | stateFile 损坏/不可读/版本不支持 | 先备份再检查文件；不要用删除状态来“修复”授权 |
| 撤销后旧调用还在跑 | 撤销是向前生效 | 等 in-flight 结束；需要强隔离时用 OS/DSH 沙箱 |

下一步：把写动作串进 CI 见 [`ci-gate.md`](ci-gate.md)；把写出的内容交给
Snip 并用 `clipboard://` 取回见 [`clipboard.md`](clipboard.md)。
