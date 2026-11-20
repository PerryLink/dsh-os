# DSH OS 产品族：11 个原语的详细设计与落地顺序

> 对象：PerryLink（个人开发者，非官方，not affiliated with DeepSeek）
> 基线：DSH `0.2.2-rc.4`（checkout `ca33fd6`，2026-11-20）
> 方法：11 条产品设计子代理（每条读对应原语研究报告 + 本机源码 + npm/GitHub 实测），主代理统一命名、契约与节奏
> 说明：每份设计 190-220 行，含名字可用性、架构、数据模型、MVP 周计划、指标、变现、风险；本文只做总览与编排。

---

## 0. 一句话

**这不是 11 个插件，是一套「Agent OS 的系统层」**：
`Act` 是系统调用，`Allow` 是权限内核，`Snip` 是输入服务，`Nest` 是工作区契约，`Root` 是环境，`Check` 是升级门禁，`Trigger` 是事件总线，`Seek` 是证据检索，`Trace` 是记忆治理，`Stage` 是窗口拓扑，`Ring` 是审批寻呼。

**做全部 11 个，但不要同时做**：按 4 个 release 排，约 15 个月（留 3 个月缓冲 = 18 个月）；共享一个 `core` 包，边际成本从第 3 个产品开始明显下降。

---

## 1. 名字总表（全部裸名，单字，初高中词汇）

| # | 裸名 | 含义 | npm 包 | 实测 | 冲突/备注 |
|---|---|---|---|---|---|
| 1 | **Act** | 行动 | `dsh-act` | 404 可用 | `dsh-actions` 已被竞品占（0.5.2、343 周下载、6★）；`dsh-do`/`dsh-run` 被占 |
| 2 | **Allow** | 允许 | `dsh-allow` | 404 可用 | `dsh-grant`/`dsh-permit` 被 `tudamu` 预留（0.0.1，概念正面冲突）→ 尽快占位 |
| 3 | **Snip** | 剪取 | `dsh-snip` | 404 可用 | `dsh-clip`/`dsh-copy`/`dsh-paste` 被占；同名截图仓 3 个，需 README 区分 |
| 4 | **Check** | 检查 | `@perrylink/dsh-check` | 404 可用 | `dsh-test`/`dsh-guard` 被占；`dsh-eval-harness` 已做 baseline+CI（237/月） |
| 5 | **Nest** | 巢/工作窝 | `dsh-nest` | 404 可用 | `dsh-room`/`dsh-profile` 被占位；`dsh-workspace-combiner` 564/周是最近竞品 |
| 6 | **Trigger** | 扳机/触发 | `dsh-trigger` | 404 可用 | 原名 Hook 弃用：`dsh-hooks` 0.14.8/1,109 周、且宿主 “hook” 已被兼容桥占用 |
| 7 | **Seek** | 寻找 | `dsh-seek` | 404 可用 | `dsh-find`/`dsh-search` 被占；`session-query` 每月 204 万次是单库红海 |
| 8 | **Trace** | 痕迹 | `@perrylink/dsh-trace` | 404 可用 | `dsh-recall`/`dsh-memo` 被占；memento 0.5.32 已发 memory protocol v1 → Trace 做治理层 |
| 9 | **Stage** | 舞台/台面 | `dsh-stage` | 404 可用 | `dsh-window-locator` 是单点；无强竞品 |
| 10 | **Ring** | 铃响 | `dsh-ring` | 404 可用 | `Sanksu/dsh-ring` 是 0★ 提示音，非品类；`dsh-alert`/`dsh-call`/`dsh-nudge` 被占 |
| 11 | **Root** | 根/基础 | `@perrylink/dsh-root` | 404 可用 | `@deepseek-ai/dsh-root` 是官方 private 内部名（npm 404），搜索会撞；`dsh-env` 被占 |

> npm 相似度规则：`dsh-check`（像 es-check/nth-check）、`dsh-trace`（像 dd-trace）、`dsh-root`（像 is-root）被拒，故这三个改用 `@perrylink/` scope；产品裸名不变。

**命名纪律**：
- 产品名只用裸名（Act/Allow/…），包名统一 `dsh-<name>`；README 首行 `Not affiliated with DeepSeek.`
- **立刻占位**：11 个 npm 包 + `@perrylink/*` 镜像 + GitHub 仓，发 `0.0.1` 占位；`dsh-allow` 已出现被预留的先例，晚一周可能就没了。
- 不使用 `@deepseek-ai/*` scope；不使用官方商标/图标。

---

## 2. 产品总表（一句话 / MVP / 最大风险）

| 产品 | 一句话 | MVP | 最大风险 |
|---|---|---:|---|
| **Act** | 说出要做什么，变成类型化、可预览、可审批、可撤销、可审计的动作并执行 | 5 周 | `dsh-actions` 已占心智且可能补 NL/跨源；官方自建 |
| **Allow** | 跨轮次授权层：模型面 `ctx.approval`，Act/CLI/Trigger 走可过期可撤销的 Grant | 4 周 | 同进程插件可绕过/伪造 Grant；它是控制面，不是沙箱 |
| **Snip** | 每条复制变成本地加密、默认排除秘密、可检索审计的记录，Agent 经 `clipboard://` 引用 | 5 周 | 秘密误入库一次即致命 |
| **Check** | 升级/换模型/升插件前，用 10 条真实任务在旧新环境配对跑，四维 diff，回归 `exit 1` | 5 周 | 金任务过拟合 + 模型非确定性误报，导致门禁被关 |
| **Nest** | 给每个 workspace 一份契约：打开项目自动继承上下文/权限/环境/默认值，可 diff/解释/回退 | 4 周 | 官方吸收（workspace 仅 5 字段，加 policy 是自然演进） |
| **Trigger** | 当 X 发生且满足 Y，就派 Agent 做 Z；每次运行有账、可重试、可追到死信 | 5 周 | `dsh-hooks`（1,109 周）补 agent 动作；官方给 schedule 加事件 |
| **Seek** | 一次查询，跨六源返回可核验证据包 | 4 周 | 跨源权限泄露（provider ACL、禁先取后滤） |
| **Trace** | 让 Agent 跨会话记住决策/偏好，每条记忆可溯源、可审批、可过期、可遗忘 | 7 周 | 官方内置 `ctx.memory`；投毒/隐私 |
| **Stage** | 查清显示器/窗口/Space 拓扑，把窗口摆到 zone，验证后可撤销 | 4 周 | macOS 辅助功能/AX 稳定性，布局成功率不达标 |
| **Ring** | 审批 SLA：t0 本地、t1 3 分钟、t2 10 分钟 IM、t3 30 分钟电话；没人 ack 就升级 | 5 周 | `dsh-im`/`dsh-pager` 顺手补升级；通知疲劳 |
| **Root** | 给每个 workspace/agent 可解释、可快照的环境，值可溯源 | 4 周 | 无 per-execution env seam，per-agent 环境到不了 shell |

**串行总工期**：52 周（不含集成/维护）。一个人做 11 个 = 约 14-18 个月；两个人可压到 9-12 个月。

---

## 3. 共享架构：先造“底座”，再造 11 个产品

### 3.1 一个 core 包（所有产品共用）

```
@perrylink/dsh-os-core
├── object      BaseObject / Owner / Scope / TTL / AuditRef
├── audit       append-only event log + hash chain + export
├── ref         dsh://<kind>/<id> 引用 + freshness + resolve
├── store       本地 SQLite/JSONL + 加密 + 租户隔离
├── policy      Grant 查询接口（由 Allow 提供，core 只依赖接口）
├── action      ActionDescriptor 接口（由 Act 提供，core 只依赖接口）
├── ui          shared settings page / command palette / i18n / badge
└── test        golden-task harness（由 Check 提供）
```

**原则**：core 不实现业务，只定义对象/审计/引用/存储/策略/动作接口；11 个产品各自是独立 npm 包，可单独安装，缺失依赖时降级而不是崩溃。

### 3.2 跨产品协议（写进每个 README）

1. **Act 的 `ActionDescriptor`** 是跨产品动作协议；其他产品的关键操作必须注册为 action。
2. **Allow 的 `Grant`** 是跨产品授权协议；任何写操作执行前 `grant.check()`。
3. **统一对象基类**：`id/owner/scope/createdAt/updatedAt/expiresAt/auditRef`。
4. **统一引用**：`dsh://<kind>/<id>`；Seek 返回的 ref 可被 Act/Trace/Check 直接消费。
5. **统一审计**：每个产品写 `audit` 事件，Allow 的权限中心可聚合导出。
6. **统一降级**：没有 Allow 时用内存 one-shot；没有 Act 时产品自带最小入口；没有 core 时单包也能跑。

### 3.3 关键硬约束（来自本机源码实测）

- `ctx.approval` **只在 open turn 内可用**（`packages/interaction/user-approval/src/index.ts:243-254`）→ Act 面板/CLI/Trigger 的写动作必须走 **Allow Grant**；模型面才走 `ctx.approval`。
- `ctx.actions` / `ctx.clipboard` / `ctx.hooks` / `ctx.triggers` **均无宿主 seam**（`docs/capability-seams.md:719` “no common action API”）→ 产品自建 seam，并提 upstream RFC；不要假设内核已有。
- `ctx.settings` 只投影插件 Config 的 Volatile 字段；项目 `.env` 被设计成不能设 PATH/代理/endpoint（`app-boot/src/index.ts:137-157,189-196`）→ Root 必须做“两层应用模型”，并接受 v1 只能部分生效。
- workspace 记录只有 5 个字段（`packages/workspace/workspace/src/spec.ts:24`）→ Nest 的 profile 是外挂对象，不是改内核。
- `tool-bash` 只传 `dshEnv`（`packages/tool-bash/src/index.ts:535-540`）→ Root 的 per-agent 环境到不了 shell，v1 需 patch/上游提案。

---

## 4. 依赖图与 Release 编排

### 4.1 依赖图（→ 表示“被谁依赖/组合”）

```
Act ──→ Allow（执行前查 Grant）
Act ──→ Snip / Stage / Trigger（它们把操作注册为 action）
Allow ──→ Ring（审批超时升级）
Allow ──→ Root（按环境授权）
Nest ──→ Allow / Root / Check（引用 Grant / Env / 回归）
Trigger ──→ Act / Allow / Ring
Seek ──→ Trace / Nest（memory provider / workspace scope）
Trace ──→ Allow / Seek / Snip
Check ──→ Root / Nest（环境快照）
Stage ──→ Act（布局即 action）
Ring ──→ Allow（审批结果写 Grant）
Root ──→ Nest / Allow / Check
```

### 4.2 四个 release（15 个月 + 3 个月缓冲，单人）

| Release | 时间 | 产品 | 主题 | 验收 |
|---|---|---|---|---|
| **v0.1 Control** | 2026-11 → 2027-02 | **Act + Allow** | 系统调用 + 权限内核 | 10 个 action 注册；4 套权限面适配；3 个外部插件依赖 |
| **v0.2 Capture** | 2027-02 → 2027-06 | **Snip + Nest + Root** | 输入 + 工作区 + 环境 | 日活 100；3 个团队 profile；环境事故 0 |
| **v0.3 Guard** | 2027-06 → 2027-10 | **Check + Trigger + Ring** | 可靠性 + 自动化 + 寻呼 | 1 个 CI 门禁；10 个触发器；ack 时延 < 5min |
| **v0.4 Knowledge** | 2027-10 → 2028-02 | **Seek + Trace + Stage** | 证据 + 记忆 + 桌面 | 跨源命中率 > 60%；记忆纠正率 < 10%；布局成功率 > 95% |

> 为什么 Act+Allow 先做：它们是所有其他产品的“执行/授权”底座；先做别的，后面每个产品都要重造入口和权限。
> 为什么 Snip 在 Nest/Root 前：它是最独立、最高频、最容易验证需求的产品；先拿用户反馈，再碰工作区/环境这种重集成。

### 4.3 两个人的分工（可选）

- **A（平台）**：Act + Allow + Ring + Trigger（控制/信任/事件）。
- **B（数据/桌面）**：Snip + Nest + Root + Seek + Trace + Stage + Check。
- 共享 core 由 A 维护；每个 release 一次集成周。

---

## 5. 每个产品的设计要点（详细版见各自文件）

### 5.1 Act（5 周）
- **核心对象**：`ActionDescriptor { id,title,icon,argsSchema,risk,availability,preview,execute,undo }`。
- **Provider**：commands / tools / MCP / skills / files / Snip / Stage / Trigger。
- **入口**：`Cmd+Shift+K`（避开 `Cmd+K` 的 session.search）+ 自然语言 + CLI + Agent tool。
- **双审批**：模型面 `ctx.approval`；人类面 `Grant + 客户端确认`；`danger` 动作必须二次确认。
- **竞品差异**：`dsh-actions` 只做 actions.json；Act 做“跨 6+2 注册表 + NL + preview/undo + 跨产品协议”。
- **上游**：`ctx.actions` RFC。

### 5.2 Allow（4 周）
- **核心对象**：`Grant { subject, capability, scope, expiry, approver, evidence, status }`。
- **适配器**：approval / permission-presets / permission-rules / auto-review。
- **UI**：权限中心（按插件/Agent/资源分组）、一键撤销、审计导出。
- **硬约束**：同进程插件可绕过/伪造 Grant；Allow 是控制面，不是沙箱。
- **上游**：`ctx.grant` RFC；先占 `dsh-allow`。

### 5.3 Snip（5 周）
- **核心对象**：`Clip { id, kind, contentRef, sourceApp, createdAt, expiresAt, sensitivity }`。
- **策略**：默认关；默认排除密码管理器/transient；TTL；按 app/格式排除；本地加密。
- **Agent**：`clipboard.read/write/history/search` + `clipboard://<id>` 句柄。
- **平台**：Windows 首发（WinRT 历史快路径），macOS 先手动捕获。
- **风险**：秘密误入库一次即致命；必须默认安全。

### 5.4 Check（5 周）
- **核心对象**：`GoldenTask { id, sessionRef, task, assertions, budget }`、`Run { env, result, trajectory, cost, approvals }`。
- **流程**：旧环境跑一遍 → 新环境跑一遍 → 四维 diff → 回归 `exit 1`。
- **差异**：`dsh-eval-harness` 做 baseline+CI；Check 做“跨环境配对 + 四维 diff + 真实 session 取例 + 夜间升级金丝雀”。
- **风险**：金任务过拟合、模型非确定性；必须允许“已知 flaky”白名单。

### 5.5 Nest（4 周）
- **核心对象**：`WorkspaceProfile { path, context, permissionPreset, envProfile, defaults, skills, lifecycle, owners, version }`。
- **应用时机**：新会话 / 恢复 / fork / 切换；`agent/created` + `SessionStartSource`。
- **差异**：`dsh-workspace-combiner` 是运行时注入器；Nest 是版本化/可审计/可共享的档案。
- **风险**：官方 workspace 只有 5 字段，加 policy 是自然演进 → 用“版本/审计/团队基线”做差异。

### 5.6 Trigger（5 周）
- **核心对象**：`Trigger { event, condition, action, cooldown, retry, deadLetter, owner }`、`Run`。
- **事件源**：111 个类型化事件 + `fs.watch` + webhook + clipboard + window。
- **可靠性**：去重/冷却/重试/退避/死信/账本；`trigger_explain`。
- **差异**：`dsh-hooks` 做 18 事件 + shell/GUI；Trigger 做 `ctx.triggers` seam + Agent 运行 + Grant + 账本。
- **风险**：事件风暴、循环触发、权限过大。

### 5.7 Seek（4 周）
- **核心对象**：`Evidence { ref, source, score, freshness, snippet }`、`QueryPlan`。
- **Provider**：locator / library / memento / capability / web。
- **差异**：单库搜索红海；Seek 做“跨源 + 统一引用 + 可核验”。
- **风险**：跨源权限泄露；禁止“先取后滤”，provider 侧 ACL。

### 5.8 Trace（7 周）
- **核心对象**：`MemoryRecord { source, scope, confidence, expiry, sensitivity, auditRef }`。
- **协议**：在 memento `dsh-memory-protocol/v1` 之上做治理（confidence/expiry/sensitivity/conflict/forget/evals）+ 浏览器。
- **差异**：不做“第一个协议”；做“v1 之上的治理层 + 迁移源”。
- **风险**：官方内置 `ctx.memory`；投毒/隐私。

### 5.9 Stage（4 周）
- **核心对象**：`Display`、`Window`、`Space`、`Layout`。
- **能力**：list/move/resize/layout/focus；DPI/坐标对齐 CUA；布局可撤销。
- **平台**：macOS 优先（AX），Windows 第 4 周；Wayland 明确边界。
- **风险**：辅助功能/屏幕录制权限、AX 稳定性。

### 5.10 Ring（5 周）
- **核心对象**：`ApprovalCase { source, risk, expiresAt, acks, escalationChain }`。
- **状态机**：pending → notified → acked → expired → escalated → resolved。
- **通道**：本地 / webhook / ntfy / voice；签名一次性 ack 链接。
- **硬约束**：v0 不远程批准（`ctx.approval` 只在 open turn）；只做 ack + 打开会话；out-of-turn 预授权走 Allow Grant。
- **风险**：`dsh-im`/`dsh-pager` 补升级；通知疲劳。

### 5.11 Root（4 周）
- **核心对象**：`EnvProfile { vars, secretRefs, proxy, pathPrepend, inherit, deny, trustLevel, scope }`。
- **应用**：启动层 materialize + 运行时 proxy 叠层；provenance（值从哪来）；snapshot/diff。
- **硬约束**：launch 快照在插件 mount 前冻结（`apps/cli/src/bin.ts:36`）；`tool-bash` 只传 `dshEnv` → per-agent 环境到不了 shell，v1 需 patch/上游提案。
- **风险**：环境漂移、子代理继承、代理/TUN。

---

## 6. 商业与打包

| 层 | 免费 | Pro（个人） | Team/企业 |
|---|---|---|---|
| Act | 核心 registry + 面板 | 高级 action 包/同步 | 动作白名单、审计 |
| Allow | 本地 Grant 账本 | 审计导出/策略模板 | SSO、租户、合规报告 |
| Snip | 本地历史/搜索 | 跨设备/无限历史 | 团队策略、DLP |
| Check | 本地 CLI | 云 baseline/报表 | CI/夜间金丝雀、SLA |
| Nest | 单 workspace profile | 多 profile/同步 | 团队基线、审计 |
| Trigger | 本地触发器 | 云 webhook/配额 | 团队触发器、审计 |
| Seek | 本地跨源 | 连接器/缓存 | 企业连接器、权限 |
| Trace | 本地记忆治理 | 记忆浏览器/评测 | 团队记忆、合规 |
| Stage | 基础布局 | 多显示器预设 | 企业布局策略 |
| Ring | 本地 SLA | IM/voice 升级 | on-call、审计 |
| Root | 本地 EnvProfile | 团队共享/漂移告警 | SSO/私有 registry |

**打包**：`DSH OS Kit`（11 个产品的 bundle）给 30% 折扣；核心单包永久免费；企业版按席位/审计收费。**不锁核心**，否则与 MIT/开源叙事冲突。

---

## 7. 指标（产品族级，不只看单产品 star）

| 指标 | 12 个月目标 | 说明 |
|---|---|---|
| 安装产品数/用户 | ≥2.5 | 套件交叉安装率 |
| 跨产品 action 注册 | ≥30 | Act 生态 |
| Grant 覆盖写操作 | ≥80% | Allow 渗透 |
| 外部插件依赖 core | ≥10 | 平台化 |
| 付费席位 | ≥50 | 商业验证 |
| 事故数（秘密/越权/数据丢失） | 0 | 信任底线 |
| 文档/教程完成率 | ≥70% | 降低门槛 |

---

## 8. 风险与止损

| 风险 | 概率 | 影响 | 对冲 |
|---|---|---|---|
| 名字被抢注/预留 | 中高 | 高 | **7 天内占位 11 个 npm + GitHub**；备选名已列 |
| 竞品先发（dsh-actions/dsh-hooks/dsh-eval-harness/dsh-im） | 高 | 中高 | 差异化：seam + 跨产品协议 + 审计 + Grant，不做单点功能对撞 |
| 官方吸收（actions/workspace/memory/trigger） | 高 | 高 | 提 RFC，做“官方需要但不做的层”；被吸收则做迁移/治理/企业版 |
| 同进程插件绕过 Allow | 高 | 高 | 明确“控制面不是沙箱”；企业版配进程隔离/远程运行时 |
| 秘密/数据事故 | 中 | 致命 | 默认关、默认排除、加密、审计、可清空；上线前红队 |
| 单人维护 11 个产品 | 高 | 高 | 共享 core；每 release 只发 2-3 个；第 3 个产品起抽 co-maintainer |
| DSH 平台失败 | 中 | 高 | 方法/数据/标准可迁移到 MCP/企业 Agent/Koishi；不押单一平台 |

**止损线**：v0.2 结束时，如果 Act+Allow 的外部安装 <50、Grant 覆盖 <30%、无 3 个外部 action 注册 → 停止扩产品，回到“Act+Allow+Snip”三件套做深。
**加倍线**：v0.1 结束时，如果 Act 有 ≥10 个外部 action、Allow 有 ≥1 个企业 POC → 按计划推进 v0.2，并开始收 co-maintainer。

---

## 9. 未来 7 天（立刻做）

1. **占名**：11 个 npm 包发 `0.0.1`（README 首行 Not affiliated），建 11 个 GitHub 仓（private/public 均可），加 `@perrylink/*` 镜像。
2. **建 monorepo**：`dsh-os`（pnpm workspace），`packages/core` + 11 个空包 + `docs/`。
3. **冻结基类**：`BaseObject`、`AuditEvent`、`Ref`、`ActionDescriptor`、`Grant` 五个 schema，写成一页 ADR。
4. **搭 CI**：lint/test/build + 一个最小 `Check` 金任务（dogfood）。
5. **先写 Act 的 ADR**：`ActionDescriptor` + 双审批通道 + 与 `dsh-actions` 的差异；再写 Allow 的 Grant schema。
6. **约 5 个设计伙伴**：插件作者 3、企业 1、重度用户 1；用 Act 的原型做一次 30 分钟演示。
7. **发布第一篇**：《为什么 DSH 需要一层动作协议，而不是第 9 个启动器》——把 Act 的差异讲清楚，顺带占住叙事。

---

## 附录：11 份详细设计

| # | 文件 | 产品 | MVP |
|---|---|---|---|
| 1 | [01-act.md](01-act.md) | Act | 5 周 |
| 2 | [02-allow.md](02-allow.md) | Allow | 4 周 |
| 3 | [03-snip.md](03-snip.md) | Snip | 5 周 |
| 4 | [04-check.md](04-check.md) | Check | 5 周 |
| 5 | [05-nest.md](05-nest.md) | Nest | 4 周 |
| 6 | [06-trigger.md](06-trigger.md) | Trigger | 5 周 |
| 7 | [07-seek.md](07-seek.md) | Seek | 4 周 |
| 8 | [08-trace.md](08-trace.md) | Trace | 7 周 |
| 9 | [09-stage.md](09-stage.md) | Stage | 4 周 |
| 10 | [10-ring.md](10-ring.md) | Ring | 5 周 |
| 11 | [11-root.md](11-root.md) | Root | 4 周 |

> 口径提醒：npm 状态为 2026-11-20 实测；404 ≠ 永久可注册，发布前用 `npm view <name>` 再核。所有产品名均为裸名单字；包名统一 `dsh-<name>`；不使用 DeepSeek 商标。
