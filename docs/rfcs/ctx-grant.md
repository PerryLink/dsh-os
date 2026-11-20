# 建议：一个可选的 `ctx.grant` seam（回合外授权）

> **状态：** discussion draft。**这是建议，不是要求**，也不代表 DeepSeek 的路线图。
> **基线：** DeepSeek Harness `0.2.2-rc.4`（checkout `ca33fd6`）。`ctx.grant` 在该版本
> 全仓 **0 命中**；现有授权面是 `ctx.approval`（one-shot）、permission presets、
> permission rules、auto-review 和 OS sandbox。
> **本仓实现：** `dsh-allow`（Host seam `ctx.allow`，默认只注册只读的 `allow_check`）。
> 现有实现有 `check` / `issue` / `revoke` / `list`、TTL 和 scope；本文里的 `authorize`、
> `maxUses`、级联撤销等是**建议的扩展**，不是现有行为。
> 如果宿主提供 `ctx.grant`，这个包可以退化为适配器；不提供也可以继续自足。

---

## 1. 问题

DSH 现在有 **L1 的沙箱模式**、**L2 的一次性审批**，但没有一个**可撤销、可过期、
可审计的授权对象**来覆盖“没有 open turn”的场景。

最关键的约束（已核对）：

```ts
// packages/interaction/user-approval/src/index.ts:243-254
async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
  const session = req.agent.session
  if (!this.approvalStateOf(session).turnOpen) {
    throw new Error(
      'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
      + 'must be turn-enclosed ...',
    )
  }
  // ...
}
```

也就是说：

- CLI 命令、客户端面板、触发器、后台任务、子代理在回合外发起的写动作，**没有**
  人类审批通道；只能预配置成 `danger-full-access`，或者干脆拒绝。
- `allowed-once` 只覆盖所问的那一次；没有“批准一次、在 TTL 内复用、随时撤销”的
  对象。
- 四套权限面（approval / presets / permission-rules / auto-review）各管一段，
  没有统一的“谁批准了什么、何时过期、怎么收回”的查询与撤销入口。
- 审计散落在会话日志和各插件自己的记录里，跨会话无法索引。

这不是说 DSH 的审批设计有问题——`approval` 的 turn-enclosed 审计对模型面是正确
的约束。问题是**回合外**没有等价物。社区插件目前各自发明 grant/consent 对象，
彼此不兼容，用户也无法在一个地方撤销。

## 2. 接口草案（建议）

下面是一个**可选**的最小形状。名字、字段和持久化方式都可以改；语义建议是：
**check 只读、authorize 可以弹一次确认、issue/revoke 只给人类面、默认拒绝。**

```ts
type SubjectKind = 'user' | 'session' | 'subagent' | 'plugin' | 'automation' | 'cli'

interface GrantSubject {
  kind: SubjectKind
  id: string                    // 由宿主签发，不接受调用方随意伪造
}

interface GrantScope {
  paths?: string[]              // 已 canonicalize 的绝对路径
  hosts?: string[]              // 小写、punycode
  ports?: number[]
  actionId?: string
  descriptorHash?: string
  environment?: string
  [key: string]: unknown        // 宿主可扩展；未知字段不匹配
}

interface GrantRequest {
  subject: GrantSubject
  capability: string            // 例如 'fs.write'、'act:invoke:demo.write'
  scope?: GrantScope            // 缺省表示最小范围，而不是全部
  ttlMs?: number                // 建议有上限（例如 30 天）
  maxUses?: number
  reason?: string
}

type GrantStatus = 'active' | 'revoked' | 'expired' | 'exhausted'

interface Grant {
  id: string
  subject: GrantSubject
  capability: string
  scope: GrantScope
  status: GrantStatus
  issuedAt: number
  expiresAt: number
  maxUses?: number
  uses: number
  approver: { kind: 'user' | 'policy' | 'imported'; id: string; evidenceRef?: string }
  auditRef: string
}

type GrantReason =
  | 'allowed' | 'no-grant' | 'expired' | 'revoked'
  | 'exhausted' | 'scope-mismatch' | 'unavailable'

interface GrantCheck {
  allowed: boolean
  grantId?: string
  reason: GrantReason
}

interface GrantService {
  /** 只读、不弹窗、可在任何 turn 外调用。 */
  check(req: GrantRequest): Promise<GrantCheck>

  /** check，缺失时向人类面发起一次确认；超时/取消一律拒绝。 */
  authorize(req: GrantRequest, opts?: {
    signal?: AbortSignal
    timeoutMs?: number
    reason?: string
  }): Promise<GrantCheck & { grant?: Grant }>

  /** 只允许人类面调用；Agent 不应有这个能力。 */
  issue(req: GrantRequest, evidence: {
    channel: 'client' | 'cli' | 'import'
    consentId?: string
    approvalId?: string
  }): Promise<Grant>

  revoke(id: string, opts?: { by?: string; reason?: string }): Promise<Grant>
  list(filter?: Partial<Pick<Grant, 'status'>> & {
    subject?: GrantSubject
    capability?: string
  }): Promise<Grant[]>
}
```

几点语义建议：

- **`check` 绝不 throw**：拒绝用 `{ allowed: false, reason }` 表示，便于回合外
  代码 fail closed。
- **`authorize` 是回合外的主路径**：它可以在没有 open turn 时请求一次客户端确认，
  但建议有超时和取消；超时视为拒绝。
- **`issue` 不接受模型调用**：如果 Agent 能给自己签发 grant，整套机制就没有意义。
  宿主应把 `issue` 限制在已认证的人类面（Client/CLI）。
- **scope 先 canonicalize 再比较**：路径拒绝 symlink 逃逸和 `..`；host 小写 +
  punycode；glob 建议显式 `*`/`**`；未知/缺省字段按不匹配处理。
- **默认精确匹配**，不做隐式通配；`scope` 缺省时不要解释成“全部”。
- **每次使用前再 check**：不要在一次长任务开始时 check 一次就永远信任；撤销要能
  在下一次调用生效。
- **审计不写密钥值**：只记录 grant id、subject、capability、scope digest、时间和
  结果；secret 只记录 ref 与使用结果。

## 3. 兼容性

- **`ctx.approval` 不变。** 模型面仍然用 one-shot approval；turn-enclosed 的审计
  对模型面是正确的。`ctx.grant` 是补回合外，不是替换。
- **缺省可用。** 插件探测 `ctx.get('grant')`；没有就退回自己的 `ctx.allow` 服务
  （`dsh-allow` 当前就是这个形态），或者拒绝回合外写。
- **不覆盖显式 deny。** grant 只能收窄/补充授权，不能推翻 permission rules 或
  sandbox 的 deny；建议优先级：sandbox deny > explicit deny > grant > default ask。
- **身份由宿主给。** `subject` 不能由调用方随便填字符串；宿主应提供当前 session /
  subagent / plugin 的稳定身份，并在 check 时校验调用栈或 RPC 来源。
- **可以只是适配器。** 宿主不需要新建一套存储：如果已有 permission-rules，可以
  把 grant 映射成带过期时间的临时规则；但最好支持撤销和审计，否则只是换名字。
- **实验性。** 建议先以 experimental 发布，限定 capability 白名单；不要一上来
  就允许任意字符串 capability。

## 4. 替代方案

| 方案 | 优点 | 代价 / 为什么不够 |
|---|---|---|
| **A. 允许 `approval.request()` 在回合外调用** | 复用现有 UI | 审计对 `approval/asked`/`decided` 要求 turn-enclosed；回合外调用会破坏恢复语义；而且它仍然是一次性，不解决复用/撤销 |
| **B. 只用长期 permission rules** | 现成机制 | 没有 TTL、没有 per-use 计数、没有撤销对象；规则一改就影响所有会话，审计也弱 |
| **C. 每个插件自己发 grant（现状）** | 零宿主改动 | 用户要在 N 个地方撤销；scope 语义不一致；插件可以伪造自己的授权 |
| **D. OAuth / token 式授权** | 标准化 | 对本地进程过重；token 的颁发、刷新、撤销仍要宿主做；威胁模型不同 |
| **E. 什么都不做，回合外用 `danger-full-access`** | 简单 | 这正是当前最危险的默认；一次配置永久放行，审计缺失 |

我们倾向 **最小 `check` + `authorize`**：先让回合外写动作有一个可拒绝、可过期的
授权对象；`issue`/`revoke` 可以后做，但建议从一开始就只给人类面。

## 5. 最小实现（建议分阶段）

**Phase 0（约 150–250 行）——只读 check**

- 新增 `GrantSubject` / `GrantScope` / `GrantCheck` 类型。
- `check` 只查宿主已有的 permission 状态 + 一个内存 grant 表；不持久化、不弹窗。
- 没有匹配时返回 `no-grant`；任何内部错误返回 `unavailable`（fail closed）。
- 先只支持少量 capability：`fs.read`、`fs.write`、`act:invoke:<id>`、`tool.invoke`。

**Phase 1（约 250–400 行）——authorize**

- `authorize` 在缺失时向客户端发一次确认；带 `timeoutMs`（建议默认 60s）和
  `AbortSignal`；超时/取消返回拒绝。
- 确认通过后签发一个有 TTL / maxUses 的 grant；记录 `auditRef`。
- 仍然不实现 `issue`/`revoke`；人类面通过 `authorize` 获得短期授权。

**Phase 2——issue / revoke / list / use**

- `issue` 只暴露给已认证的人类面；`revoke` 支持按 id 或 subject+capability。
- `use`（原子扣减 maxUses）可以和 Phase 1 合并，视实现复杂度而定。
- 持久化可选：先内存 + 事件日志，重启后重新确认；稳定后再落盘。

**明确不建议放进最小实现的东西：** 跨设备同步、SSO、策略语言、自动审批模型、
云端账本、UI 权限中心。它们会把一个 seam 变成产品。

## 6. 风险与缓解

| 风险 | 说明 | 建议的缓解 |
|---|---|---|
| **自我授权** | Agent 调用 `issue` 给自己发 grant | `issue` 只给人类面；Agent 只能 `check`/`authorize`；宿主校验调用来源 |
| **身份伪造** | 调用方传 `subject: 'user:admin'` | subject 由宿主签发；check 时校验 RPC 来源/会话身份；不信任入参 |
| **scope 绕过** | symlink、大小写、Unicode、glob、相对路径 | 先 canonicalize；拒绝 `..`/symlink 逃逸；host 小写 + punycode；glob 显式 |
| **撤销不生效** | 长任务开始时 check 一次，之后不再查 | 每次使用前 check；`use` 原子扣减；撤销 epoch 递增 |
| **级联缺口** | 父会话撤销，子代理仍持有 grant | grant 带 parent/级联关系；撤销沿 subagent 树传播 |
| **审计被篡改** | 本地 JSON 被改 | append-only + hash chain；可选外部镜像；关键事件写 session 日志 |
| **误以为是沙箱** | 同进程插件可绕过 check 直接做事 | 文档明确“控制面，不是沙箱”；不宣称能阻止恶意同进程代码 |
| **授权疲劳** | 每次都要点，用户干脆全放行 | 支持 Remember + TTL；危险动作仍二次确认；默认最小 scope |
| **grant 爆炸** | 每个动作一条 grant，无法管理 | capability 命名空间 + 批量撤销 + 过期清理；列表过滤 |

## 7. 开放问题

1. `subject` 的规范身份是什么——session id、agent id，还是插件包名？
2. `allowed-once` 是否应该自动升级成短期 grant，还是必须显式 Remember？
3. grant 的作用域是全局、workspace 还是 session？跨 workspace 是否默认拒绝？
4. 子代理继承父 grant 时，应该衰减（只读/TTL 更短）还是完全继承？
5. 宿主已有 permission-rules 时，grant 应该映射成临时规则，还是独立存储？
6. 撤销后已经排队/正在执行的动作怎么处理——取消、等完成，还是标记为 stale？
7. `authorize` 在 headless / 无客户端时是否只能 fail closed？

## 8. 非目标

- 不做沙箱、OS 隔离、恶意插件检测或插件签名。
- 不替代 permission rules / presets / auto-review / `ctx.approval`。
- 不做合规认证；只提供可导出的证据。
- 不做云同步、SSO、团队账本（可以作为上层产品）。
- 不承诺“默认全放行”；默认建议是拒绝/询问。
