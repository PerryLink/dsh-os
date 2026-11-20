# Ring · 审批升级与回执
> npm `dsh-ring`（404；GitHub 有同名 0★ 提示音插件，见 §1）｜ CLI `dsh-ring` 独立 bin｜ Host seam `ctx.ring`｜ DSH `0.2.2-rc.4`（`ca33fd6`）
> **Not affiliated with DeepSeek.** 同线：Act 动作协议、Allow Grant 授权、Ring “没人回”时的升级与回执。
## 0. 结论
- **不是收件箱、不是 IM、不是通知器**：Ring 是审批的 SLA/寻呼层——未 ack 就按 t0–t3 升级，决定即停，每次触达/ack/决策都有回执与审计。
- **空位**：DeepCanary 本地收件箱、dsh-im 远程批、dsh-notifier 多通道、dsh-pager 通知栏批；都停在“首触”，没人管“没人回”。
- **硬约束**：`ctx.approval.request()` 无 open turn 即 throw（`user-approval/src/index.ts:243-254`）⇒ **v0 不远程批准**，只做 ack + 打开会话；批准仍由 Web/dsh-im 完成，out-of-turn 预授权只能走 Allow Grant。
- **观测点**：`ctx.on('session/event')` 的 `approval/asked`/`approval/decided` 是 post-commit 审计对（`core/session/src/index.ts:79`）；Ring 不抢 answerer、无 stale card、不改 turn 语义。
- **MVP 5 周**；最大风险：dsh-im（3,733★）或 dsh-pager（2★）顺手补上定时升级，以及通知疲劳。
## 1. 名字与可用性（2026-11-20 实测）
| 候选 | npm | 生态 | 结论 |
|---|---|---|---|
| **`dsh-ring`** | **404 ✅** | `PerryLink/dsh-ring` 404；`Sanksu/dsh-ring` 存在（0★，2026-09-30，提示音，tarball 安装） | **首选，需区分**：不是提示音，是审批寻呼 |
| `dsh-ack` | **404 ✅** | 无精确同名仓 | **零歧义备选**（产品名/`ctx.ack` 需改） |
| `dsh-alert`/`dsh-call`/`dsh-nudge` | 200，均 0.0.1 | 同一作者 `dushaobindoudou` 占位 | ❌ 已占 |
| `dsh-escalate` | 404 | `almazom/...approve-escalate`（0★，提权语义） | ❌ 语义撞“提权” |
| `dsh-oncall`/`dsh-receipt`/`dsh-sla` | 200 | `dsh-pager` 2★ | ❌ 已占/相邻 |

- **为什么仍选 Ring**：响铃直到有人接 = “未 ack → 升级”；同名插件是 0★、单日、纯提示音，不构成品类竞争。代价：依赖键同为 `dsh-ring`，已装 tarball 版会互相覆盖；README 必须写清，同日占 `@perrylink/dsh-ring` 镜像。
- **CLI**：`dsh ring` 不可用，launcher 把首个非 flag token 当 profile 名（`apps/cli/src/args.ts:206`）；用独立 `bin`，同 `dsh-locator`。
## 2. 一句话 / 问题 / 用户
**一句话**：Ring 给每个阻塞审批一条 SLA——t0 本地、t1 3 分钟、t2 10 分钟 IM/邮件、t3 30 分钟电话；没人 ack 就升级，决定即停，全程回执可审计。

**问题**：审批 seam 无超时，未回答就一直占着该轮；`schedule` 到期只是普通 follow-up，不是 push（`packages/schedule/README.md:12`）；webhook 只入不出（`docs/subsystems/webhook.md:5,23`）；桌面唯一原生通知是强制更新（`apps/desktop/src/update-attention.ts:2,38-44`）。

**用户**：个人开发者（长任务/开会/睡前被卡）；团队 on-call（要“谁接了、多久接、谁升级”的账）；企业（SLA/审计导出/自托管）。
## 3. 范围与非目标
**v0**：`ApprovalCase` 账本；SLA 状态机/计时器；ack（非 approve）；升级链；local/webhook/ntfy/voice；签名一次性 ack 链接；回执；hash-chain 审计 + 导出；`ctx.ring`；3 个 agent tools；CLI；策略/静默；owner+backup。**非目标**：又一个收件箱（DeepCanary）；IM 客户端/远程批准（dsh-im）；审批 UI/权限语义（复用 `ctx.approval`）；自动批准/always-allow；v0 排班轮转；OS 原生 toast 引擎；插件私有确认框。
## 4. 架构
### 4.1 四层
```
Client: SLA Board / badge / policy     Host: ctx.ring (ledger + timers + policy + token + receipts)
        ▲ ack / open session           ▲ ctx.on('session/event')
        └──────── Remote ──────────────┘  DSH: approval/asked ──► approval/decided
Channels: local(浏览器) / webhook(飞书/Slack/Discord) / ntfy / voice(阿里/腾讯, Twilio 可选)
CLI: dsh-ring list|show|ack|export    Agent tools: ring_list / ring_raise / ring_receipt
```
### 4.2 `ApprovalCase`（共享基类 ②）
```ts
type RingPriority = 'P0'|'P1'|'P2'
type RingState = 'pending'|'notified'|'escalated'|'acked'|'resolved'|'expired'|'cancelled'
interface ApprovalCase {                    // 任务书叫 ApprovalRequest；改名避撞 DSH 类型
  id: string; owner: string; scope: 'session'|'workspace'|'global'
  createdAt: number; updatedAt: number; expiresAt: number; auditRef: string
  source: 'approval'|'question'|'plan-review'|'job'|'hook'|'manual'
  sessionId: string; requestId: string; callId?: string; toolName?: string
  title: string; reasonRedacted?: string; reasonHash?: string   // 无参数/路径/密钥
  priority: RingPriority; actionRisk?: 'read'|'write'|'exec'|'danger'  // 策略映射，seam 无 risk
  state: RingState; level: number; nextAt?: number
  acks: Array<{ by: string; at: number; channel: string; actionId: string; receiptId: string }>
  escalationChain: Array<{ level: number; afterMs: number; channels: ChannelId[]; requireAck: boolean }>
  decision?: { outcome: 'allowed-once'|'rejected'|'cancelled'|'unavailable'; at: number; grantRef?: string }
  delivery: { attempts: number; lastError?: string }
}
```
- `ApprovalCase` 不改 DSH 的 `ApprovalRequest`（`user-approval/src/index.ts:129`）；`expiresAt` 必填（默认 60m）；请求只有 toolName/callId/reason，**无 risk**（`types.ts:63-76`），priority 靠策略映射。
- `reason` 只存 80 字脱敏 + SHA-256；完整理由留在 session log；升级链快照，策略变更只影响新 case。
### 4.3 SLA 状态机
| 状态 | 进入 | 离开 |
|---|---|---|
| `pending` | 观察到 `approval/asked` | t0 发出→`notified`；1s 内 decided→`resolved`（suppressed） |
| `notified` | t0 至少一个通道尝试 | t1→`escalated`；ack→`acked`；decided→`resolved`；到期→`expired` |
| `escalated` | level 1..3 已发出 | 下一级→`escalated`；ack→`acked`；decided→`resolved`；到期→`expired` |
| `acked` | 首次有效 ack | 停升级；decided→`resolved`；到期→`expired`；T-5m 一次本地提醒 |
| `resolved` | `approval/decided` | 终态；写 decision receipt + Grant 账本证据 |
| `expired` | `now >= expiresAt` 且未决 | 停升级但可见；late decided→`resolved`（标 late） |
| `cancelled` | abort / turn 结束无决定 / Host 重启 | 终态；不自动 deny、不写 Grant |

- **ack ≠ approve**：ack 只停升级、认领责任；只有 decided 能 resolved；`expired` 绝不写 deny Grant、不自动拒绝。
- **并发/恢复**：同 `requestId` 幂等；ack 与 decided 同时到 decided 胜；monotonic 计时、UTC 审计；重启重放 ledger、错过步骤合并 1 条 catch-up，turn 已结束标 cancelled。
### 4.4 默认策略
| level | after | 通道 | 规则 |
|---|---|---|---|
| t0 | 0s | local：badge + 浏览器 Notification | 页面不在记 `unreachable` |
| t1 | 3m | local 重提醒 + 标题闪烁 | 仅未 ack 时 |
| t2 | 10m | webhook/IM（飞书/Slack/Discord/企微） | “打开确认页”按钮，不做各平台回调 |
| t3 | 30m | ntfy push + voice call | voice 仅 P0；静默时段仅 P0 穿透 |
| t4 | 45m | 最后一次 local + “仍未解决” | 60m 到期；每 case 最多 3 次升级 |

- 6 次/小时、30 次/天；P0 可透支但记审计；同 case+channel+level 去重，幂等键 `caseId:level:channel`。与首触插件共存：`firstTouch:'external'`，装了 dsh-im/DeepCanary/dsh-notifier 时 Ring 从 t2 起，避免双发。
### 4.5 通道适配
| 通道 | v0 | 回执 | 约束 |
|---|---|---|---|
| local | Client event + 浏览器 Notification | 客户端 ack/receipt | 无原生模块；页面关=unreachable |
| webhook | 飞书/Slack/Discord/企微 | HTTP 2xx + message id | 只发卡片+链接；secret 存 credentials |
| ntfy | PUT topic，priority 4/5，actions `view`+`http` | 2xx + message id | topic 即密码；必须 secret/self-host |
| voice | 阿里/腾讯语音（+86），Twilio 可选 | call id + 状态 | v0 只通知不 DTMF ack；号码先验证 |
| dsh-im/dsh-pager | 不重造；共存通道 | — | Ring 只补“没人回”；只发深链 |
### 4.6 签名动作、回执与审计
- **token**：HMAC-SHA256，密钥存 `ctx.credentials`；payload `{v,caseId,action:'ack'|'open',exp,nonce,channel}`；TTL 15m 或 case 到期；base64url。
- **端点**：`ctx.webServer.register({kind:'exact',path:'/ring/a',auth:'anonymous'})`——`WebRoute.auth` 默认 required，必须显式 anonymous，靠自己的签名（`host/webserver/src/index.ts:95,108,117-124,520`）。
- **GET 渲染确认页，POST 才 ack**：防链接预取；常量时间比较；nonce 原子消费；重放→409+审计；token 只含 caseId，**v0 无 approve**。
- **回执** `RingReceipt`：`{id,caseId,kind:'delivery'|'ack'|'decision',channel,providerId?,status,at,error?,auditRef}`；JSONL。
- **审计**：`$DSH_HOME/ring/ledger.jsonl` 逐行 `prevHash`；**不写 session log**（外部插件不得调 `appendPluginRecord`，`core/session/README.md:74`）；`dsh-ring export` + HMAC manifest；Free 30 天 / Team 1 年。
### 4.7 `ctx.ring`
```ts
interface RingService extends Service {
  escalate(input: { severity: RingPriority; source: 'approval'|'hook'|'act'|'manual'
    summary: string; sessionId?: string; runId?: string; triggerId?: string
    idempotencyKey?: string }): Promise<ApprovalCase>          // Trigger/Act 入口，24h 去重
  get(id): ApprovalCase | undefined; list(q?): ApprovalCase[]
  ack(id, by: Principal, channel: ChannelId): Promise<RingReceipt>
  cancel(id, reason: string): Promise<void>
  policy: { get(): RingPolicy; set(p: RingPolicy, by: Principal): Promise<void> }
  on(e: 'ring/acked'|'ring/resolved'|'ring/expired', fn): Disposable
}
```
- approval 由 `session/event` 自动建 case；`escalate` 是 Trigger/Act/manual 入口（对齐 `06-trigger.md:148`）。模型面只能 `ring_list/ring_raise/ring_receipt`，**不能 ack、不能改策略、不能自授 Grant**。
## 5. 与 Allow / Act / Trigger 组合
### 5.1 Allow（`ctx.grant`；Act 文档暂写 `ctx.grants`，以 Allow 为准）
- 审批结果是 **Grant 账本里的 evidence/decision**，不自动发持久 Grant——对齐 Allow“不自动把 allowed-once 变成持久授权”（`02-allow.md:43`）。用户显式 Remember 才 `ctx.grant.issue({approver:user, evidence:{approvalId}, maxUses:1, expiresAt})`。
- Ring 能改授权面的写（policy/channel/export）先 `ctx.grant.check`；无 Grant 则 `ctx.grant.authorize`（out-of-turn，60s，无客户端 deny；`02-allow.md:84-95`）。
- **ack 不是能力授予**：只改 Ring 账本；由一次性 token 认证，token 以 `maxUses:1` 登记为 Ring capability，Allow 在场时同步为 `action.invoke` evidence。
- **out-of-turn**：turn 外的签名 approve 一律拒绝并记 `late`；要预授权未来动作，先发 Allow standing Grant（带 expiresAt），不能补批已结束的审批。
### 5.2 Act / 5.3 Trigger
- Act：注册 `ring:ack`（write）、`ring:raise`（write）、`ring:policy-set`（write/danger）、`ring:test-channel`（exec）为 ActionDescriptor；写类带 `grant`，走 Act 的预览/回执；danger 动作可在执行前 `ctx.ring.escalate` 预提醒，禁止重复建 case（`idempotencyKey=actionReceipt.id`）。
- Trigger：死信、`awaiting-grant`、风暴熔断、连续误触发 → `ctx.ring.escalate({severity,runId,triggerId,summary})`（`06-trigger.md:148`）；必须带 standing Grant + `run.id` 幂等键，否则只本地记录。Ring 发 `ring/*` 事件供 Trigger/Act 消费；不反向注入 `approval/*`。
## 6. 安全
- **签名/防重放**：HMAC + 短 TTL + nonce 单次 + 常量时间比较；绑定 case/action/channel；密钥在 credentials、可轮换；重放/过期/错 case 全部 401/409 + 审计。
- **敏感信息**：通知只放 toolName + 80 字脱敏理由 + case id；不放参数/路径/diff/密钥；审计存 hash；默认零遥测、本地优先。
- **通道可信**：local > IM 私聊 > ntfy secret topic > voice；voice 只通知不 ack（防 caller ID 伪造）；公开 topic 禁止；dsh-im 回复沿用其绑定身份。
- **HTTP 面**：`/ring/a` 唯一 anonymous 路由；30/min/IP、body <4KB、POST-only、`Referrer-Policy: no-referrer`、无 CORS。
- **身份/值班**：ack 必须绑定 owner/backup 的 IM id 或手机号；未知身份拒绝；排班变更是 Grant-gated 写并审计；v0 只有 owner+backup，完整轮转是 Team 版。**无 auto-approve、无 always-allow、模型不能 ack/issue Grant。**
## 7. 失败模式
| 失败 | 行为 | 护栏 |
|---|---|---|
| 通知疲劳 | 同 case ≤3 次；P2 不进 v0；静默时段 | 6/h、30/day；opt-out <5% |
| 通道失败 | 5s 超时、2 次退避、fallback；全失败→`channel_down` + local | 绝不把“已发送”当 ack |
| 误升级 | t1 前 ack 取消后续；按 tool 映射 priority | 误升级率、ack<60s 比例 |
| out-of-turn | 签名 approve 拒绝，只记 late | 只用 Allow standing Grant 预授权 |
| 与首触插件重复 | `firstTouch:'external'` 从 t2 起；case+channel 去重 | 同装 dsh-im/DeepCanary dogfood |
| Host 重启 | 重放 ledger、合并 catch-up；turn 已结束标 cancelled | 重启演练，不补发风暴 |
| token 泄露/重放 | 409 + 审计 + 轮换；case 可 revoke | 15m TTL、单次、无 approve |
| 时钟/DST | monotonic 计时、UTC 审计；值班用 IANA tz | 时钟跳变测试 |
| 客户端离线 | local 记 unreachable，跳过；重连补 badge | 不因本地离线阻塞远程 |
| 电话成本/合规 | 每 case ≤1 通；号码验证；P0 only | 成本/ack 指标；国内用阿里/腾讯 |
## 8. MVP 5 周
| 周 | 交付 | 验收 |
|---|---|---|
| W1 | `ctx.ring` + ApprovalCase/ledger + `session/event` 观察 + policy schema + CLI list/export | asked→case、decided→resolved 100%；不写 session log |
| W2 | 状态机/计时器 + local 通道 + SLA Board + ack + 回执 | ack 后 1s 停发；重启恢复 |
| W3 | webhook/IM + ntfy + 签名 ack 端点 + 防重放 + hash-chain 审计 | 一次性/15m/POST-only/0 重放 |
| W4 | Allow/Act/Trigger 适配 + dsh-im/DeepCanary 共存 + voice 适配（可滑 v0.1）+ 5 人 dogfood + chaos | 重复 <5%；全通道失败可解释 |
| W5 | 安全评审（token 端点/威胁模型）、文档、打包、发布、upstream RFC | 安装/卸载干净；0 未授权 |

- 5 周 cut：voice 滑到 v0.1，只发 local+webhook+ntfy+ack；排班也延后。验收：未 ack 的 P0 100% 至少升级一次；decided 后所有计时器 1s 内取消；0 自动批准；0 token 重放；重复通知 <5%；同装 dsh-im 不双发。
## 9. 指标与验证
- **北极星**：P0 time-to-ack p50（<5m）/ p90（<15m）；blocked approvals（age>10m）数量。
- 升级：升级后 ack 率（>60%）、远程 ack 占比、误升级率、每 case 升级次数、通道送达率、每次 ack 的电话成本。
- 护栏：未授权 ack/approve 0、token 重放 0、自动批准 0、P0 漏升级 0（dogfood）、重复通知 <5%。验证：2 周 dogfood（5–8 人、≥50 个真实审批）对比基线；chaos；5 名 on-call 访谈；10 名团队 lead 的 $10/seat 意愿；**止损**：升级后 ack 提升 <30%，或 dsh-im/DeepCanary 5 周内补上升级 → 转审计/团队或并入对方。
## 10. 打包与变现
- 安装：`dsh plugin --profile web add dsh-ring`；bundle patch + client 半 + 独立 `bin`；peer `@deepseek-ai/dsh-* >=0.2.2-0 <0.3.0`；无 native 依赖。
- **Free**：1 owner、local+ntfy、20 次升级/月、7 天审计；**Pro $6/月**：不限升级、webhook/IM、voice 按量、90 天审计；**Team $10–15/seat/月**：排班/多接收人/项目策略/SSO/SIEM/1 年保留；**Enterprise**：自托管、离线、合规。README 首行 “Not affiliated with DeepSeek”。
## 11. 风险与开放问题
| 风险 | 级别 | 缓解 |
|---|---|---|
| dsh-im（3,733★/144,737 月下载）补“未 ack 升级” | 高 | 做通道中立层、先接它的首触、5 周内发；必要时并入 |
| DeepCanary（83★/2,342）扩到多通道升级 | 中高 | 差异在跨通道/审计/团队；共存 |
| dsh-pager（2★）扩到定时升级 | 中 | 把它当通道，不造手机 App |
| 上游给 approval 加 timeout/ack | 中 | 适配器 + RFC；退为 UI/策略层 |
| 通知疲劳/被静音 | 高 | 保守默认、上限、静默、P0 穿透 |
| 电话成本/国内合规 | 中 | 阿里/腾讯、号码验证、每 case 1 通 |
| 签名密钥泄露 | 中 | credentials + 轮换 + 短 TTL + 无 approve |
| `dsh-ring` 同名混淆 | 低 | README 首行 + 安装检查 + `@perrylink` 镜像 |

**开放问题**：① 上游 0.3 是否加 approval timeout/ack（现在无）？② dsh-im 的“另一端随即失效”能否复用做远程 claim？③ `ctx.webServer` anonymous 路由在 Desktop/Electron 是否可达？④ 国内 voice 选阿里还是腾讯？⑤ 排班自建还是接 PagerDuty？⑥ 是否先请 `Sanksu/dsh-ring` rename？⑦ 审计保留与 PIPL/GDPR 默认值。
## 12. 证据
- DSH：`user-approval/src/index.ts:129,243-260,294-320`（类型/无 turn 抛错/waterfall）；`types.ts:44,55,63-76,87`（asked/decided、无 risk）；`user-questions/src/index.ts:254-271,370-380`（timed wait）；`core/session/src/index.ts:79` + `README.md:74`（session/event、外部插件不得写 record）；`host/webserver/src/index.ts:95,108,117-124,520`（auth 默认 required）；`docs/capability-seams.md:793,807`；`packages/schedule/README.md:12`；`docs/subsystems/webhook.md:5,23`；`apps/desktop/src/update-attention.ts:2,38-44`；`apps/cli/src/args.ts:206`。
- npm/GitHub：`dsh-ring`/`dsh-ack` 404；`dsh-alert`/`dsh-call`/`dsh-nudge` 0.0.1（`dushaobindoudou`）；`dsh-oncall`/`dsh-receipt`/`dsh-sla` 200；`Sanksu/dsh-ring`（0★，2026-09-30）；`wg5759/dsh-pager`（2★）；`almazom/dsh-almazom-approve-escalate`（0★）。
- 生态：dsh-im 3,733★/144,737，远程批先到先得、无永久批准（README §365-367）；DeepCanary 83★/2,342，Acknowledge/Snooze（README §96）；dsh-notifier 29★/2,907。URL：https://github.com/xmanrui/dsh-im ｜ https://github.com/Oscar-Williams/dsh-deepcanary ｜ https://github.com/wg5759/dsh-pager ｜ https://github.com/Sanksu/dsh-ring
- 内部：`05-notifications-attention.md`（四层注意力/PagerDuty/ntfy/5 周原案）；`02-allow.md:43,84-95`（Grant、不自动持久化）；`06-trigger.md:148`（`ctx.ring.escalate`）。
