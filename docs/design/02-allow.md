# 02 · Allow — 可撤销权限中心（TCC for Agents）

> 2026-11-20 · DSH 0.2.2-rc.4（checkout `ca33fd6`）· PerryLink 个人项目，非官方，not affiliated with DeepSeek
> Host seam `ctx.grant` + Client 权限页 + Agent tools + CLI；11 个 AI OS 基础性工具之一。

## 1. 名字与可用性

**最终名 Allow**；包/仓库/bin `dsh-allow`；Host seam `ctx.grant`（Grant 服务；产品名 Allow，seam 取跨产品授权协议名）；会话命令 `/allow`；UI “Allow · 权限中心”。

| 候选 | npm（2026-11-20 实测） | 判断 |
|---|---|---|
| **dsh-allow** | **404 可用**；`PerryLink/dsh-allow` 404 | ✅ 选中：短、动词、对应 TCC/Android 的 “Allow” |
| dsh-permit | 200；`tudamu` 的 `0.0.1`，2026-10-07 预留，“Permit-based execution…” | ❌ 被占，描述就是本题 |
| dsh-grant | 200；同一作者，“approve a capability once, watch its use, and revoke it automatically” | ❌ 被占，概念正面冲突 |
| dsh-let / dsh-pass | 404 / 404 | 备选：let 是 JS 关键字、语义弱；pass 易联想密码管理器 |
| dsh-consent | 404 | 备选：更企业化，不够用户友好 |

- 关键发现：`dsh-permit` 与 `dsh-grant` 都由第三方在 2026-10-07 预留，且 README 写明 “Name reserved; first release in development”——**已被占位，可能有人在做同一概念**。Allow 是当前“准确且可用”的名字；发布当天同时占 npm、GitHub 与 `@perrylink/dsh-allow` 镜像 scope。
- GitHub 有 `DWJZ/dsh-allow`（2★，2026-10-30 更新），是**相邻但不同**的插件：按路径/能力给 shell 文件权限。README 首屏必须写区别，避免搜索混淆。
- “Allow” 是通用词，不主张商标；品牌写法 “Allow for DSH”。降级备选：Consent（`dsh-consent`）。GitHub `dsh-allow` 搜索另有 68 个结果，需靠包名/README 区分。

## 2. 一句话 / 问题 / 用户

**一句话**：给 DSH 补上缺失的跨轮次授权层——模型面仍走 `ctx.approval`，Act 面板/CLI/Trigger/后台走可过期、可撤销的 Grant，一处回答“谁能动什么、谁批准的、怎么收回”。

**问题（DSH 现在只有 L2）**
1. 没有 Grant 对象：`allowed-once` 只授权所问的那一次；`ask/never` 只管会话；4 套权限面（approval / presets / permission-rules / auto-review）各管一段。
2. **out-of-turn 授权空洞（最锋利）**：`ctx.approval.request()` 无 open turn 直接抛错（`packages/interaction/user-approval/src/index.ts:243-254`）。Act 面板、CLI、Trigger、后台任务发起的写动作没有人类授权通道，只能预配置或 `danger-full-access`。
3. 撤销不是 first-class：没有稳定对象/传播/墓碑；permission-rules 的 “Allow” 反而在规则首部写一条持久 allow（research §3）。
4. 审计散落：per-session JSONL + 各插件事件，无跨会话索引、导出、SIEM。

**用户**：① 装 10+ 插件/MCP 的个人开发者，每天点几十次 Allow；② 多会话/子代理的团队 lead，父会话撤销无法传播；③ dsh-ee/企业安全与合规，采购第一问“能审计/能撤销吗”；④ 插件作者，需要统一 consent API 而不是各写弹窗。
**10 秒三问**：现在谁能动什么？这件事谁批准的？怎么立刻收回？

## 3. 范围与非目标

**v0 范围内**：Grant 生命周期（issue/check/authorize/use/revoke/list/expire）、账本、4 个观察型适配器 + perm-gate 只读导入、权限中心 UI、`dsh-allow` CLI、JSONL/CSV/OCSF 导出、out-of-turn 客户端同意、子代理继承衰减、环境指纹、密钥 per-use 审计（opt-in broker）、墓碑与级联。只强制**自己的 Grant**。

**明确不做**
- 不重造策略引擎：不实现 allow/deny/ask 规则语言，不替代 permission-rules / presets / auto-review / sandbox。
- 不做进程内插件沙箱、OS 隔离、杀毒/恶意插件检测、插件签名（属于 Check/其他原语）；不宣称能阻止同进程恶意代码。
- 不做数据流标签/血缘（P3）；不做合规认证，只导出证据。
- v0 不做云同步/SSO；不做“默认全放行”；**不自动把 `allowed-once` 变成持久授权**（必须显式 Remember）。
- 不覆盖其他层 `allow` 的结果：没有它们接入时，Grant 只替代 `ask`/out-of-turn 确认，不能否决 policy allow。

## 4. 架构

### 4.1 Grant schema

```ts
type Grant = {
  // 共享对象基类
  id: GrantId; owner: string; tenantId: string; createdAt: string; updatedAt: string
  expiresAt?: string; auditRef: AuditRef  // expiry = expiresAt + uses.max
  // 授权元组
  subject: { kind: 'plugin'|'agent'|'session'|'subagent'|'mcp'|'automation'|'cli'; id: string }
  capability: { kind: 'fs.read'|'fs.write'|'net.egress'|'secret.use'
                |'tool.invoke'|'spawn.subagent'|'model.egress'|'action.invoke'; name?: string }
  scope: { paths?: string[]; hosts?: string[]; ports?: number[]; secretRef?: string
           actionId?: string; descriptorHash?: string; environment?: string }
  approver: { kind: 'user'|'auto-review'|'policy'|'imported'; id: string; evidenceRef?: string }
  evidence: { channel: 'approval'|'out-of-turn'|'cli'|'import'; sessionId?: string
              callId?: string; approvalId?: string; consentId?: string; verdictId?: string; ruleId?: string }
  status: 'pending'|'active'|'revoked'|'expired'|'exhausted'|'suspended'
  uses: { count: number; max?: number; lastUsedAt?: string }
  parentGrantId?: string
  revocation?: { at: string; by: string; reason: string; cascade: string[]; epoch: number }
}
```

匹配语义：默认**精确**；路径先 canonicalize（拒绝 symlink 逃逸/相对路径），host 小写 + punycode，glob 必须显式 `*`/`**`；`descriptorHash` 绑定 ActionDescriptor 内容，动作定义一改旧 Grant 失效（防 confused deputy）；`environment` 绑定 Root 指纹且**必填**，缺失=不匹配；action 类 Grant 必须有 `descriptorHash`。scope 统一算 `scopeDigest`（canonical JSON hash），用于墓碑/去重/缓存键。`scope` 同时是共享基类字段与授权范围，不另设同名字段。

### 4.2 账本（本地优先）

- **真相源**：`$DSH_HOME/allow/<profile>/ledger.jsonl`，append-only，逐行 hash chain（`prevHash`）；事件 `grant/issued|used|revoked|expired|suspended|imported`、`consent/requested|decided`、`secret/used`；每条事件 id 即 Grant 的 `auditRef`。**任何事件不写密钥值**。
- **索引**：`ledger.sqlite`，用 Node 内置 `node:sqlite`（仓库 `package.json:9` 要求 Node ≥24.9），WAL；可随时从 JSONL 重建。不引入 native 依赖。
- **会话镜像**：`plugin:dsh-allow/*` 只读日志事件，用 `appendPluginRecord`（`packages/core/session/src/index.ts:472-503`，`ignorable`，不进模型上下文，fork/resume 保留）；宿主不暴露该 API 时降级为 ledger-only。跨会话真相以全局 ledger 为准。
- **多进程**：文件锁 + 单写者 + seq/gap 检测；冲突 fail-closed 并重读，不做 last-write-wins。
- 保留：Free 7 天（滚动归档），Pro 无限；墓碑**不过期**（`git reflog` 教训）。

### 4.3 查询/授权 API

```ts
ctx.grant.check(req): Promise<GrantCheck>        // 只读、无 turn、绝不弹窗
ctx.grant.authorize(req): Promise<GrantDecision> // check，否则挂起等客户端同意；out-of-turn 主路径
ctx.grant.issue(req): Promise<Grant>             // 受控签发：Client/人类 CLI；预授权 approver 例外
ctx.grant.revoke(req): Promise<RevokeReport>     // id | subject | capability；级联 + 墓碑 + epoch++
ctx.grant.use(lease): Promise<UseReceipt>         // Act 执行前原子扣减 maxUses；check 不消耗
ctx.grant.list(req?): Promise<GrantPage>         // 租户/主体/状态过滤；不含 secret 值
ctx.grant.explain(req): Promise<Explanation>     // 为什么 allow/no-grant，命中哪条 evidence
```

- `check` 只在 **active + 未过期 + 有剩余次数 + subject/capability/scope/descriptorHash/environment 全匹配** 时返回 `allow`（附 `lease`）；其余 `no-grant|revoked|expired|unavailable`。任何错误 → `unavailable`，调用方必须中止；**没有默认放行**。`check` 不消耗次数，Act 必须在执行前 `use(lease)` 原子扣减并写 `grant/used`，防 TOCTOU 重放。
- `authorize` 不要求 open turn，**不 append `approval/asked`**（那会污染 crash-tail 语义）；无客户端/超时 60s → denied。批准后签发 `maxUses=1` 的一次性 Grant 并返回 `lease`，调用方执行前仍需 `use(lease)`；用户可选 “1 小时” 才延长。
- `issue` 必须带 `approver.evidenceRef`（approval id / consent id / verdict id）；模型不可直接调用，防止 agent 自授权。自动签发只允许用户预先授权的 approver（如 auto-review），短 TTL、可随时撤销、默认不在 UI 隐藏。
- `revoke` 幂等；父 Grant 撤销时按 `parentGrantId` 级联子代理；墓碑按 `(tenant, subject, capability, scopeDigest)` 记录，**阻止静默重导入**，重新授权必须走新的显式同意。
- **Agent tools**：`allow_check`、`allow_list`、`allow_request`（只创建 pending，不签发）；`issue/revoke` 只走 Client/CLI。

### 4.4 四个适配器（观察型，不参与执行决策）

全部只订阅 `ctx.on('session/event', (session, event) => …)`（`packages/core/session/src/index.ts:79`），**不注册 `tools/pre-execute`、不做 answerer**——这是避免成为“第五套规则”的结构性保证。approval 的 capability/scope 由 `tool/call`（`callId` + `arguments`，`packages/core/session/src/types.ts:373`）与 `approval/asked.callId` join 得到；join 失败只存 toolName 证据，**不生成 Grant**，避免按错误 scope 授权。

| 权限面 | 读的事件 | 写进 Allow 模型 | 撤销/失效 |
|---|---|---|---|
| approval | `approval/asked` / `approval/decided` | 权限页对最近 approval 显示 Remember 建议；用户显式点击 → Grant（approver=user，evidence=approvalId）；否则只作证据 | 撤销 Grant 只影响后续 out-of-turn，不影响 in-turn approval |
| presets | `permission/preset`、`sandbox/mode`、`approval/policy` | 环境快照；标注 Grant 的 `scope.environment` | 收紧档位时 suspend/revoke 该环境下的宽松 Grant |
| permission-rules | `permissionRules/decision`、`permissionRules/network` | 只读覆盖视图：“规则 R 放行”，不生成 Grant；`allowHost` 写持久规则 → 深链规则编辑器 | 不直接改 YAML；撤销走其 RPC/编辑器 |
| auto-review | `autoReview/verdict`、`autoReview/rejection`、`autoReview/state` | 裁决证据；用户可把某能力“委托给 auto-review” → 短 TTL Grant（approver=auto-review） | 调其缓存失效钩子（60s verdict cache）；无钩子则 UI 标“未强制” |

- 可选：`dsh-perm-gate` 只读导入（TTL/maxUses → `imported` Grant）；`dsh-trust-check` 能力声明仅展示，不产生授权。
- auto-review 是 `approval/request` 的 answerer（PerryLink 包，含 60s verdict cache）；Allow 不抢它的裁决，只把裁决变成可审计证据与 out-of-turn 可复用授权。

### 4.5 权限中心 UI / CLI / 导出

- **UI**：`settings.section` 新页（参照 `packages/client/ui-agent-preset/src/client/index.ts:283`），5 个视图：By app / By session / Recent / Pending / Export。行内显示 subject、capability、scope、approver+evidence、到期/次数、last used、状态、Revoke；“Why?” 抽屉展示 approval id、verdict、rule id、preset、descriptorHash。撤销弹窗先给影响面预览（几个会话/子代理/缓存裁决），级联需二次确认；撤销不可 undo，只能重新签发新 Grant。
- **out-of-turn 同意**：`shell.overlay` 全局对话框（或 Pending 队列）：动作标题、精确路径/host、发起者、默认 “Allow once”、可选 “1 hour”、Deny；同一 `(actionId, scopeDigest)` 去重，防提示轰炸。无客户端 → fail-closed。
- **CLI**：`dsh-allow list|check|authorize|revoke|export|verify|import`。**不能用 `dsh allow`**：`dsh` launcher 只解析 profile/plugin/dump，其余参数交给已启动 app（`apps/cli/src/args.ts:1-30`），第三方无法注册顶层子命令。因此独立 bin + 运行中 profile 内的 `/allow` 命令，共享同一 ledger；CLI 写 ledger 后 host 通过 fs.watch 重载 epoch（撤销 p95 <1s）。
- **导出**：JSONL/CSV/OCSF；`--since --tenant --redact`；含 grant id/call id/approver/reason，不含 secret；`verify` 重算 hash chain；可选把 head hash 锚进 session log（tamper-evident，不宣称 tamper-proof）。

## 5. 与 Act / Check / Root 的组合

**双通道（核心）**：`ctx.approval` 是 turn-bound 的模型面通道；Grant 是 out-of-turn 的人类/后台通道。两者不互相替代，只共享证据。

| 发起面 | open turn | 授权通道 | 审计 |
|---|---|---|---|
| 模型工具调用（含 Act action） | 有 | `ctx.approval` → `allowed-once`；Grant 仅作“曾批准”证据，不消耗 | `approval/asked/decided`；Grant 只被引用 |
| Act 面板 / 命令面板 | 无 | `ctx.grant.check` → `authorize` → 客户端同意 → 一次性 Grant | `consent/requested/decided` + `grant/issued/used` |
| CLI（人类在终端） | 无 | `authorize --yes --action-hash` 或交互确认 | ledger `consent` + `grant/issued/used` |
| Trigger / 后台任务 | 无 | 只 `check`；无预置 Grant 就失败 | `grant/used` 或 `grant/denied` |
| 子代理 out-of-turn | 无 | `check`，仅接受 `parentGrantId` 且 scope 是父集子集 | 继承链 + 级联撤销 |

- **Act**：`ActionDescriptor` 增加 `authorization: 'approval'|'grant'`、`capability`、`scopeOf(input)`、`risk`、`reversible`、`descriptorHash`。写动作执行前先 `check`；按发起面选通道。Allow 也以 ActionDescriptor 注册：`allow.grant.issue`、`allow.grant.revoke`、`allow.audit.export`——issue/revoke 必须人类确认，且绑定 descriptorHash。
- **Check**：把 out-of-turn 同意记录为 `check/consent`（channel=grant，字段同 approval），把 in-turn approval 记录为 `check/approval`；两者都引用 `grantId`/`consentId`。Check 是证据展示方，Allow 不重复造审计 UI。
- **Root**：提供 `environmentFingerprint`（profile、workspace、runtime、tenant、设备）、存储根与租户；Grant 的 `environment` 绑定它。Root 环境变化 → 环境绑定 Grant 自动 suspend；导出证据带上 Root id。
- **契约 #4 的落地**：所有写动作都先 `check`；但“放行”按通道决定——turn 内由 approval，out-of-turn 由 Grant/consent。Grant 不把 `no-grant` 变成放行，也不把 `deny` 变成放行。跨产品协议面只暴露 `check/authorize/use`；Act/Check/Root 不读 ledger、不依赖 SQLite。

## 6. 权限 / 安全

- **撤销传播**：内存 active 索引先同步更新，再 `fsync` ledger；`epoch++`；`check/authorize` 读最新 epoch；级联 parent→children、session→subagent tree、subject→all、action→all；pending consent 命中墓碑自动失效。已在执行的调用**不能保证停止**：用 `exec.signal` best-effort abort，UI 明示“已执行 N 次，撤销不回溯”。
- **缓存失效**：自己的 `check` 零缓存；外部 auto-review 60s verdict cache / perm-gate TTL 只能调钩子或标“未强制”；导出与 UI 一律显示 `effectiveAt` 与 `epoch`，不显示“永久有效”。时钟回拨 → 视为过期。
- **fail-closed**：未知 subject / scope 解析失败 / descriptorHash 不符 / 过期 / 已撤销 / 账本损坏 → 一律 no-grant/unavailable；无客户端、同意超时 → denied；绝不因“读不到 ledger”而放行。仅严格模式（企业）可把 no-grant 升级为 deny。
- **密钥 per-use 审计**：`ctx.grant.brokerSecret(ref, grantId, fn)`：先查 `secret.use` Grant（`secretRef` 精确匹配），再 `ctx.credentials.resolve(ref)`（DSH 本就要求每次操作重新 resolve，`docs/subsystems/credentials.md:131-200`），写 `secret/used {ref, subject, grantId, at, outcome}`，**不写值、不写 hash**。v0 仅覆盖 opt-in 工具与声明了 `credentials` 的 action；未接入插件在覆盖率里标 “unaudited”。
- **租户隔离**：`tenantId` = profile + workspace 指纹；ledger 行分区、文件 0600；`list/export` 必须带 tenant，拒绝 `--tenant all`；企业版一租户一 ledger，不做跨租户通配。v0 单用户，多租户是 W4 POC。
- **防自授权**：Agent 只能 `check/list`；需要新授权时只能发起 `authorize` 请求（等待人类同意），不能 `issue/revoke`；`issue` 只接受 Client Remote 或人类 CLI（`--yes` + action hash）；审批/同意证据必须由人类面产生。注意：同进程插件仍可直接调用 `ctx.grant.issue`，evidenceRef 校验只能提高门槛（见风险 #3）。
- **防篡改**：hash chain + session 镜像 + 可选签名导出；本地管理员仍可重写，故只称 tamper-evident；不存 secret，审计“谁导出了审计”。

## 7. 失败模式

| 失败 | 症状 | 缓解 | 验收测试 |
|---|---|---|---|
| 做成“第五套规则” | 用户以为 Grant 能 allow/deny，和 rules/presets 打架 | 观察型适配器、不注册 pre-execute/answerer；Grant 只服务 out-of-turn；文案写“授权记录，不是策略” | deny 规则 + 有效 Grant → 仍 deny |
| 缓存/传播不一致 | revoke 后 auto-review/perm-gate 仍放行；子代理仍用旧 Grant | epoch、零自缓存、钩子失效、子代理 scope 衰减、UI 显示 effectiveAt | 并发 revoke + check → 100% no-grant |
| 企业策略冲突 | 组织 deny vs 本地 Grant allow | 优先级 deny > ask > Grant；签名策略包；冲突 UI；离线 fail-closed | 离线 org deny 下 Grant 不放行 |
| out-of-turn 提示轰炸 | Trigger 反复弹同意 | 队列去重、速率限制、默认 one-shot、N 次拒绝后静默 deny | 100 次请求只弹 ≤1 次 |
| `allowed-once` 被悄悄持久化 | 用户以为只批一次，实际长期有效 | 绝不自动 Remember；一次性默认 `maxUses=1`；对账 UI | 无 Remember 时 Grant 数=0 |
| scope/symlink 误匹配 | 路径 glob 过宽、host 后缀混淆 | canonicalize、默认精确、签发前显示匹配数、secret 不允许 glob | 路径穿越/`evil.com` 不命中 |
| 账本双写/脑裂 | 两个 DSH 实例互相覆盖 | 文件锁 + seq gap 检测 + fail-closed 重读 | 双实例并发 100 次无丢事件 |
| 隐私泄露 | 导出含路径/host/secret | 默认 redact、保留期、导出审计、secret 扫描 | 导出中 secret 值=0 |

## 8. MVP 4 周计划

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | Grant schema、ledger（JSONL+SQLite）、`ctx.grant.check/issue/use/revoke/list`、out-of-turn `authorize` + 同意事件、子代理继承衰减、单测 | 重启可从 JSONL 重建；无 Grant 的 out-of-turn 写 100% 拒绝；撤销后下一次 check 无 allow；issue 无 evidence 被拒 |
| W2 | approval/presets 两个观察型适配器；`/allow remember <approvalId>` + `dsh-allow list/revoke/export`；session 镜像；审计事件 | 一次显式 Remember → 出现 Grant；revoke 后 CLI/UI 同步 <1s；导出扫描 secret=0 |
| W3 | permission-rules/auto-review 适配器；权限页 5 视图 + Why 抽屉 + 撤销影响预览；Pending 队列；perm-gate 导入 | 10 秒答三问；规则/裁决来源可见；deny 始终优先；导入可 dry-run |
| W4 | Act 集成（descriptor + panel/CLI/hook 双通道）、Check 证据、Root 指纹、严格模式、OCSF/CSV + verify、文档、dogfood、发 0.1.0 | 面板写动作无 turn → 同意 → 一次性 Grant → 第二次被拒；父撤销 → 子代理失效；e2e 全绿 |

W5–6 stretch：auto-review 原生 `ctx.grant` 对接、签名策略包、SSO/团队账本、企业 POC。投入：1 人 4 周（W3 起 0.5 前端/设计）。

## 9. 指标 / 验证

- **产品**：安装→首个 Grant <5 分钟；活跃 Grant 数/主体；周活权限页；out-of-turn 同意通过率；approval→Remember 转化（目标 20–40%，不追高）；周撤销次数；撤销 p95 <1s；Why 抽屉打开率；7 天未使用 Grant 占比（清理候选）。
- **安全**：ledger/导出 secret 值=0（自动扫描）；fail-closed 用例 100%；撤销后拒绝率 100%；缓存不一致事件=0；out-of-turn 超时拒绝 100%；子代理越权=0。
- **商业**：10 个设计伙伴、6 周内 3 个企业 POC；Pro 转化 3–5%；每账户月审计导出次数；NPS。
- **验证方法**：自己 dogfood 2 周；5 个访谈（个人/团队/安全）；红队清单（直接 fs、同进程绕过、旧缓存、descriptor 替换、CLI 伪造 action hash）；对照 TCC/1Password 心智。**可证伪点**：若用户从不打开权限页/从不撤销，则退化为“审计导出”产品，别硬卖控制台。

## 10. 打包 / 变现

- 开源核心 MIT，npm `dsh-allow`，GitHub Releases；无默认遥测；README 顶部 “not affiliated with DeepSeek”。
- **Free**：本地账本、7 天保留、手动撤销、JSONL 导出。**安全功能（撤销/查看）必须免费**。
- **Pro $8–15/月**：无限保留、CSV/OCSF、策略模板、定时导出、secret per-use 审计、多 profile。
- **Team $25–40/seat/月**：共享策略包、SSO（OIDC/SAML）、证据包、审批流、租户隔离、SIEM 连接器。
- **Enterprise**：私有化/air-gapped、自定义保留、审计 attestation、支持；走 dsh-ee。
- 分发：DSH plugin market、`dsh plugin add`、awesome 列表；与 permission-rules/auto-review 组 “trust pack”（披露同作者）。

## 11. 风险 / 开放问题

**风险**
1. **命名/竞争**：`dsh-permit`、`dsh-grant` 已被第三方预留且描述命中本题；GitHub `dsh-allow` 有 2★ 相邻项目。缓解：4 面适配 + out-of-turn + 审计差异化，快速发 0.1.0；必要时降级 Consent。
2. **DSH 收编**：0.3 可能内置 Grant，插件价值被吞。缓解：协议/适配器 SDK 先行，主动 upstream；数据可导出、不锁定。
3. **强制天花板**：同进程插件可绕过；还能直接调 `ctx.grant.issue` 伪造 Grant（evidenceRef 必须指向已存在的 consent/approval 记录，只能提高门槛）；rules/auto-review 的 `allow` 不经过 Grant；v0 只覆盖 out-of-turn 与主动接入方。**不要宣称是沙箱**。
4. **API 漂移**：0.2.x 事件/服务签名变化；`callId` join 脆弱（approval 请求只有 toolName/callId/reason，`types.ts:63-76`）；适配器需版本探测 + 3 版本集成测试。
5. **企业信任**：本地 hash chain 非防篡改；需签名导出/HSM/外部锚定。
6. **隐私**：路径/host 本身敏感；默认 redact、保留期、导出审计。
7. **审批疲劳/UX**：out-of-turn 弹窗过多会让人无脑点 Allow；去重、限速、one-shot、拒绝学习。

**开放问题**
- 是否允许“连续 N 次相同批准后自动建议 Remember”？（建议只建议，不自动）
- Grant 应做 DSH core seam 还是插件？（v0 插件；稳定后提案 upstream）
- 子代理默认继承子集还是零继承？（建议显式 `parentGrantId` + 子集，fail-closed）
- 离线时组织策略与个人 Grant 谁赢？（建议签名 org deny 优先，UI 展示冲突）
- 本地优先下的多租户边界？（v0 profile/workspace；企业版一租户一账本）
- 撤销 policy-allow 覆盖：深链还是 veto？（v0 深链；只有显式企业模式才允许 veto）

## 证据（2026-11-20）

- DSH 审批：`docs/subsystems/approval.md:21,28,33,86`；无 turn 抛错 `packages/interaction/user-approval/src/index.ts:243-254`；请求字段仅 toolName/callId/reason `packages/interaction/user-approval/src/types.ts:63-76`；事件 `index.ts:253,260`。
- 工具瀑布：`packages/core/tools/src/events.ts:18`；`PreToolDecision` `contracts.ts:375-379`；短路由 `docs/subsystems/tools.md:541`。
- 会话/日志：`appendPluginRecord`/`ignorable` `packages/core/session/src/index.ts:472-503`；`session/event` `:79`；JSONL 校验帧 `docs/subsystems/persistence.md:345`；Node ≥24.9 `package.json:9`。
- Client/CLI：`settings.section` `packages/client/ui-agent-preset/src/client/index.ts:283`；launcher 只解析 profile/plugin/dump `apps/cli/src/args.ts:1-30`。
- 凭证：per-call resolve、无 per-use 事件 `docs/subsystems/credentials.md:131-200`；已有同名 `GrantRecord` 是凭证授权的不透明记录，与本产品无关 `packages/credentials/credentials/src/types.ts:52`。
- 研究底稿：`01-research/dsh-os-primitives-2026-11-20/08-permission-audit.md:33,39-46,58,64-74,126-159`。
- npm（实测 HTTP，2026-11-20）：<https://registry.npmjs.org/dsh-allow> 404；<https://registry.npmjs.org/dsh-permit>、<https://registry.npmjs.org/dsh-grant> 200（`tudamu`，0.0.1，2026-10-07 预留）；dsh-let/dsh-pass/dsh-consent 404。GitHub `PerryLink/dsh-allow` 404；<https://github.com/DWJZ/dsh-allow> 2★。
- 外部：TCC <https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol>；Android permissions <https://developer.android.com/guide/topics/permissions/overview>；OAuth revocation RFC 7009 <https://datatracker.ietf.org/doc/html/rfc7009>；1Password audit <https://support.1password.com/audit-log/>。
- 生态：<https://www.npmjs.com/package/dsh-permission-rules>（`permissionRules/decision`→`approval/asked`→`autoReview/verdict`→`approval/decided`；`allowHost` 写持久规则）；<https://www.npmjs.com/package/dsh-auto-review>（`approval/request` answerer，60s verdict cache）。
