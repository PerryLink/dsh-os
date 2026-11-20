# Trigger · 事件触发器（Trigger Fabric）

> 2026-11-20 · 对象：DeepSeek Harness `0.2.2-rc.4`（checkout `ca33fd6`，live 0.2.2-rc.4）+ 社区插件；作者：PerryLink（个人开发者，**not affiliated with DeepSeek**） · 结论先行：**把“事件 → 条件 → Agent 运行”做成一张声明式触发器表 + 一本运行账本，以 `ctx.triggers` 作为其他插件可注册的 seam；不做 cron、不做画布。** 产品名定为 **Trigger / `dsh-trigger`**（原名 Hook 因与 `dsh-hooks` 近名、且宿主 “hook” 已被兼容桥占用而弃用，见 §1）。

## 0. 结论

- **缺口比预研更窄、更硬**：事件→Agent 已有两个 0★、未发 npm 的民间实现（`vaniawang/dsh-trigger-hub` 自称 “one ledger, one console”；`msilita/dsh-waker-trigger` 做条件唤醒）；`dsh-hooks` 0.14.8 已有 18 类事件 + GUI 编辑器 + JSONL 历史（1,109 周下载、10★）。⇒ 护城河**不是**“事件→动作”，而是 **seam + 对象契约 + 可靠性语义 + 分发**。
- **宿主没有触发 seam**：`ctx.hooks` / `ctx.triggers` 在 0.2.2-rc.4 的 Cordis 服务表里不存在（`docs/capability-seams.md`；事件相关只有 `ctx.webhookRuntime`）；DSH 的 “hook” 仅指 Claude Code / Codex 的**兼容桥**（`hook-protocol`，只跑 command handler，`http`/`mcp_tool`/`prompt`/`agent` 一律跳过并告警）。⇒ 自建注册表 + 上游 RFC（§4.6）。
- **一条会撞墙的约束**：`ctx.approval.request()` 无 open turn 即 throw（`packages/interaction/user-approval/src/index.ts:243-254`）。触发器发起的写动作发生在 turn 之外 ⇒ 只能走 **Allow 的 standing Grant + 客户端确认**，不能复用模型面审批（§5.1）。
- **动作以 `agent.run` 为一等公民**：走 `ctx.agents.create`（`packages/core/agent/src/index.ts:421`），新会话 + preset + permission；而不是 `schedule` 的 prompt 投递（60s 下限、receipt ≠ 执行结果、无重试循环）。
- **MVP 5 周**；止损线：W4 末 5 个配方中 <3 个可日用 ⇒ 退为“可靠性层”（预研 4.2 Supervisor）。

### 0.1 五条共享契约的落位

| 契约 | 本设计落点 |
|---|---|
| ① `ctx.<name>` + Client UI + tool(s) + CLI | §4.6 `ctx.triggers`；§8 W4 设置页；tools `trigger_create/list/test/runs/replay/explain`；bin `dsh-trigger` |
| ② 对象基类 id/owner/scope/createdAt/updatedAt/expiresAt?/auditRef | §4.1 `Trigger`/`Run`/`SourceRef`/`ActionRef` 全部继承 |
| ③ ActionDescriptor 是跨产品动作协议 | §4.4 `action` 直接 `ctx.actions.invoke`；反向把 `trigger:fire/enable/disable` 注册为 Act 动作 |
| ④ Grant 是跨产品授权协议，写前必查 | §5.1 发布期要求 standing Grant（含 `expiresAt`）、运行期每次 `check`；缺失→`awaiting-grant` |
| ⑤ 可导出/可审计、本地优先、不关联官方 | §4.5 本地 JSONL 账本 + `dsh-trigger export`；README 首行声明；默认零遥测 |

## 1. 名字与可用性（2026-11-20 实测）

| 候选 | npm | 邻名 / 语义 | 结论 |
|---|---|---|---|
| `dsh-trigger` | **404 ✅** | **`dsh-hooks` 0.14.8 / 1,109 周下载 / 10★**，只差一个 `s`；且 DSH 里 “hook” = Claude Code/Codex 兼容桥（`hook-protocol/README.md:12`） | **弃用**：近名 + 语义双撞 |
| **`dsh-trigger`** | **404 ✅** | GitHub 精确名未占用（`dsh-triggers`/`dsh-trigger-hub` 均 0★、未发 npm）；与契约 `ctx.triggers` 同名；`@perrylink/dsh-trigger` 亦 404 作兜底 | **采用** |
| `dsh-when` | **200 ❌ 0.1.0** | 同生态包，功能是“自然语言相对时间解析”；`when` 也是 Claude Code hook 字段 | 弃用 |
| `dsh-once` | 404 ✅ | “一次性”暗示单发，不适合 fabric | 弃用 |
| `dsh-upon` | 404 ✅ | 无邻名、语义好（upon X → do Y），但不可检索 | 备选 #2 |

- **与 Act 预研的冲突（需 lead 裁决）**：`01-act.md` §1 把 `dsh-trigger` 列入产品线（dsh-allow/snip/stage/hook），§5.2 也按 “Trigger” 写了组合契约；改名需同步那两处。
- **三条理由**：① `dsh-hooks` 已在 1,109 周下载量级，同形近名会被当它的兄弟包/克隆；② 宿主内 “hook” 已被兼容桥占用，叫 Trigger 会让人以为要改 `hooks.json`；③ 契约要求 seam 为 `ctx.triggers`，名实一致。
- **README 首句固定**：“Trigger 是事件触发器（事件→条件→Agent 运行），不是 `dsh-hooks` 那种事件→shell 的生命周期钩子。” 方法：`curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<name>` + GitHub Search API（未认证可能限流；残留不确定性：可能存在非发布用途的同名私有仓）。

## 2. 一句话 / 问题 / 用户

**一句话**：当 X 发生、且满足 Y，就派一个 Agent 去做 Z——每次运行都有账可查、可重试、可追到死信。

**问题**：DSH 的时间轴做透了（`schedule` 七种 timing、`every` ≥60s、`new` 目标 60s 投递下限；Host 必须常驻，**失败只留任务告警、没有重试循环**，投递 at-least-once 且 **receipt ≠ 执行结果**）；事件轴要么是 shell-only 的兼容层（`dsh-hooks`），要么是明确“no queue, retry, deduplication, execution status, crash replay”的实验 webhook（`docs/subsystems/webhook.md:23`）。用户只能围着宿主写胶水脚本，无法表达“CI 失败 → 开个会话修 → 失败两次升级给人”。

**用户**：① 个人自动化开发者——文件/CI/会话事件 → agent，不写胶水；② 团队——共享配方库与运行账本；③ 企业——Grant 约束下的无人值守动作 + 审计导出。

## 3. 范围与非目标

**范围**：Trigger/Run 对象与 schema；四类 source 适配（session / fs / webhook / plugin）；条件 DSL；四类 action 适配（agent.run / notify / command / action）；冷却、去重、预算、重试/退避/死信；账本与 `trigger_explain`；设置页（列表/详情/Runs/Test fire）；6 个 agent tool；CLI；JSON 导入导出；`dsh-hooks` YAML 导入。

**非目标**：❌ 替代 cron（不自建定时 UI，时间源交给官方 `schedule`）；❌ 可视化 DAG / n8n 画布（预研 4.3 已判需求未验证）；❌ 云端中继与跨设备；❌ 团队协作/共享（v2）；❌ 剪贴板/窗口/应用事件（属 OS Bridge 4.4）；❌ 任意 JS 表达式或 eval；❌ 宿主离线补跑（只标 missed）；❌ 自建告警通道（复用 Nest / `dsh-event-notice`）。

## 4. 架构

### 4.1 对象（契约 ②）

```ts
interface Trigger {                    // 基类：id/owner/scope/createdAt/updatedAt/expiresAt?/auditRef
  id: string; owner: string; scope: 'global'|'workspace'|'session'; name: string; enabled: boolean
  source: SourceRef; condition?: ConditionNode   // 'trg_<ulid>'/'user:<id>'|'plugin:<pkg>'；SourceRef={kind,config,event?,path?,route?}
  policy: {                             // 触发与可靠性策略
    cooldownMs: number                  // 同 trigger 最小间隔，默认 5_000
    dedupe: { by: 'payload-hash'|'field'; field?: string; ttlMs: number }  // 默认 60_000
    budget: { maxRunsPerHour: number; maxRunsPerDay: number; maxConcurrent: number }
    retry: { maxAttempts: 1|2|3; backoffMs: [1000, 5000, 30000]; jitter: true }
    deadLetter: { enabled: true; replayable: true }   // 退避耗尽 → dead，可人工 replay
    timeoutMs: number; onFailure: 'dead-letter'|'escalate'; unattended: boolean   // 默认 600_000；false ⇒ 每次需客户端确认
  }
  action: ActionRef; grantRefs: string[]   // 契约④：Allow 的 capability 主键
}
interface Run {                         // 账本条目，不可变 + 状态追加
  id: string; triggerId: string; traceId: string; attempt: number; dedupeKey?: string; sourceEventId?: string
  status: 'queued'|'running'|'succeeded'|'failed'|'skipped'|'awaiting-grant'|'dead'|'interrupted'
  input: { payloadDigest: string; payload?: unknown }; action: { kind: string; ref: string; sessionId?: string }   // payload 脱敏后 ≤8KB
  output?: { sessionId?: string; turnEndReason?: string; exitCode?: number }
  error?: { code: string; message: string; at: number }; startedAt: number; finishedAt?: number; nextRetryAt?: number
}
```

所有对象带 `owner/scope/auditRef`；删除是软删除（`expiresAt`/`removedAt`），账本条目永不随触发器删除。

### 4.2 事件源适配（无宿主 seam，全部基于已有面）

| source | 接入面（证据） | 粒度 | 已知限制 | MVP |
|---|---|---|---|---|
| `session` | `ctx.on('session/event', (session, event) => …)` 过滤 `turn/end`/`approval/asked`/`tool/result`；另有 `agent/error`（`docs/event-producer-consumer.md:18,77`） | 单会话事件，post-commit、fire-and-forget，**不阻塞 agent** | 只覆盖已加载会话；重启后可从 session log 回填窗口内 `turn/end`（`session-query.listEvents`） | ✅ |
| `fs` | `ctx.fs.watch(target, changed, signal)`（`packages/fs/fs/src/index.ts:117`） | 单文件或目录**直接子项**（`fs/README.md:38`） | **非递归**；provider 可能直接 reject ⇒ 递归按目录注册（≤64 目录/深度 2）或 5s mtime 轮询兜底，UI 显示降级原因 | ✅ |
| `webhook` | `ctx.webServer.register(route)`（`packages/host/webserver/src/index.ts:520`；`web-server.md:120`：命名路由、返回 disposer、重复即 throw） | 每条已认证投递：`POST /dsh-trigger/hook/<id>` | 仅 web profile 有 webServer；默认关闭，需显式开启 + 每触发 token | ✅ |
| `plugin` | `ctx.triggers.registerSource()` + `fire()` | 插件自定义事件 / 无事件推送 | 需插件作者接一次；这是“成为他插件标准”的入口 | ✅ |
| `time` | 官方 `schedule`（不自建） | 分钟级 | 60s 下限、无重试；**非目标** | ❌ |
| `clipboard`/`window` | Snip 的 `ctx.clipboard` / Stage 的 `ctx.windows`（若已装） | 变化事件 | 依赖兄弟产品；本产品只做触发侧适配，**不读内容**、不做权限判定 | v1.1 |

**无宿主 seam 的接入方式（不是私有总线）**：① **事件目录**——构建期从 `docs/event-producer-consumer.md` 固化 **111 条**事件名（逐行计数 111），运行时按触发器**精确订阅**（`ctx.on` 是可逆副作用，卸载即退订）；只订阅 `emit/serial`，**不拦截 waterfall**（如 `approval/request`），不改变宿主语义。② **推送**——复用宿主 WebServer 与 `webserver/authorize` 的 peer 判定，不自建 HTTP 栈。③ **显式 API**——`fire()`/`registerSource()` 让无事件插件也能接入。④ **不假设钩子总线**——DSH 的 hook 只有兼容桥（`hook-protocol/README.md:12`），既不依赖也不复用。

### 4.3 条件 DSL（声明式，不 eval）

```json
{"all":[
  {"field":"payload.name","op":"glob","value":"*.pdf"},
  {"field":"session.turnEnd.reason.kind","op":"in","value":["error","max-tokens"]},
  {"not":{"field":"payload.path","op":"startsWith","value":"/tmp"}}
]}
```
运算符 `all/any/not` + `eq/neq/in/nin/glob/regex/exists/gt/gte/lt/lte/contains/startsWith`；字段路径来自 source spec 白名单（`payload.*`/`session.*`/`file.*`），字符串 ≤1KB、regex ≤256 字符，保存时编译并拒绝未知 op/path。**三级漏斗**：源侧粗筛（事件名/路径）→ DSL → 冷却/预算，决定了风暴时的成本。

### 4.4 动作适配

| kind | 实现 | risk | 说明 |
|---|---|---|---|
| `agent.run` | `ctx.agents.create`（`core/agent/src/index.ts:421`）→ `permissionPresets.set`（`permission-presets/src/index.ts:470`）→ `followup(prompt)` | write | 新会话默认隔离（`cwd`/`preset`/`permissionPreset` 显式，默认只读 preset + 工具白名单）；模板只允许 `{{payload.x}}`，payload 包进数据围栏并标注“不可信数据”；`resume` 复用会话放 v1.1 |
| `notify` | Nest / 桌面 / HTTP | read | 不自建通道；失败不影响 run 状态 |
| `command` | `ctx.shell` + `ctx.sandbox`（`capability-seams.md:788,791`） | exec | 显式开启；继承 sandbox 模式，**不提权**；输出截断 64KB |
| `action` | `ctx.actions.invoke(descriptor, { origin:'hook', idempotencyKey: run.id })` | 由 descriptor 决定 | 未装 Act 时显示“不可用：未安装 Act”；`danger` 类**禁止被自动触发**（对齐 `01-act.md` §5.2） |

反向注册：`trigger:fire`/`trigger:enable`/`trigger:disable`/`trigger:create-from-recipe` 进 Act 注册表，使面板/CLI/Agent 都能操作触发器——**这同时带来循环风险**（§7）。

### 4.5 运行账本

- **定义**：`ctx.storageDomain` 的 `trigger/definitions`（v1，zod 校验；同步读、持久写、发 `domain/changed`，`storage-domain/README.md:12`）；**运行**另存 append-only JSONL `$DSH_HOME/dsh-trigger/runs.jsonl`（0600）+ 内存 ring（2,000）+ 2MB 原子压缩——storageDomain 整 unit 写入代价随数据增长（同 `schedule` 已知限制），运行记录是追加型数据。
- **状态机与成功判定**：`queued → running → succeeded|failed|skipped|awaiting-grant|dead|interrupted`；重启把 `running` 标 `interrupted`（不增 attempt），仅幂等动作可 `resumeOnRestart`。`agent.run` 需该会话 `turn/end` 的 `reason.kind === 'completed'` 且无 `agent/error`；`error`/`max-tokens`/超时 ⇒ failed 可重试——这是补上“投递≠执行”的地方。

### 4.6 `ctx.triggers` seam 与上游提案

```ts
interface TriggersService {
  registerSource(spec: SourceSpec): () => void    // { id, title, configSchema, availability(ctx), subscribe(ctx,cfg,emit)→dispose, backfill? }
  registerAction(spec: ActionKindSpec): () => void // { id, title, inputSchema, risk, descriptorId? }
  create/update/enable/disable/remove; fire(id, payload, { manual? }): Promise<Run>; list/get/runs/explain
}
// 新增 Cordis 事件：trigger/created|changed|fired|run-started|run-settled|dead-letter|storm
```

**上游提案（一页，随包发 `docs/upstream-rfc-ctx-triggers.md`）**：DSH 有 `ctx.webhookRuntime` 却没有触发 seam；本产品**不 fork、零宿主 patch**，只用稳定面（`storageDomain`/`fs.watch`/`webServer`/`agents.create`/session 事件），凭据与路由走宿主既有判定；RFC 按 `docs/capability-seams.md` 服务表格式申请一行 `ctx.triggers`，把 `registerSource/registerAction` 与 `trigger/*` 事件作为契约。不采纳则插件层自足；采纳则本产品退为贡献者。

**一次触发**：`source 事件 → 规范化 payload（≤8KB、脱敏）→ 源侧粗筛 → DSL → 冷却/去重/预算/熔断 → Grant 检查 →（必要时）客户端确认 → action → 结果判定 → 账本 + trigger/run-settled →（失败）重试 → 死信 → Ring 升级`。

## 5. 与 Act / Allow / Ring 的组合

### 5.1 写操作前查 Grant（契约 ④）

```ts
// 发布期：write/exec 必须已有 standing Grant（带 expiresAt），否则保存为 paused:'awaiting-grant'
const need = trigger.action.risk === 'read' ? [] : trigger.grantRefs.length ? trigger.grantRefs : [capabilityOf(trigger.action)]
if (need.length && !(await ctx.grants.covering({ subject: trigger.id, capabilities: need, requireExpiry: true })).ok) save(trigger, { enabled: false, pauseReason: 'awaiting-grant' })
// 运行期：动作前再查（Grant 可能被撤销/过期）；denied 无副作用但仍写审计，missing 升级给 Ring
const g = await ctx.grants.check({ subject: trigger.id, capability: cap, scope: trigger.scope })
if (g.denied) settle(run, 'skipped', 'grant-denied'); else if (!g.granted) settle(run, 'awaiting-grant', 'grant-missing', { escalate: 'ring' })
```
- `danger` 动作**永不自动触发**；`command` 必须 `exec` 级 Grant；触发器**不能自授** Grant（Agent 也不能）。未装 Allow 时降级：**不做模型面审批**（无 open turn，`approval.request()` 会 throw），改为**客户端确认 + `unattended:false`**，UI 标注“无持久授权”——对齐 Act 双通道（`01-act.md` §6.3）。
- **Act**：动作统一走 `ctx.actions.invoke`（`origin:'hook'`、`idempotencyKey=run.id`），复用其预览/审批/回执/撤销；**禁止绕过 Act 直调工具**。**Ring**：死信、`awaiting-grant`、风暴熔断、连续误触发 → `ctx.ring.escalate({ severity, runId, triggerId, summary })`，未装则退桌面通知。**Nest**：`notify` 首选 Nest。

## 6. 安全与可靠性

| 风险面 | 机制 | 关键值 |
|---|---|---|
| 事件风暴 | 源侧粗筛 → 500ms 抖动合并（fs）→ 触发级 cooldown → 令牌桶 `maxRunsPerHour/Day` → 全局熔断（>60 run/min 自动暂停 + `trigger/storm`）→ 预算上限 | 风暴时**丢弃并计数**，不排队 |
| 去重/冷却/幂等 | 触发级 cooldown + 源级 debounce（默认 5s/500ms）+ `dedupeKey = sha256(source·event·payloadDigest)` TTL 60s；`run.id` 作 Act 的 `idempotencyKey`（Act 侧 7 天去重表）；被压掉的候选写 `explain` 环 | 语义 = **至少一次 + 窗口内至多一次效果**，不承诺 exactly-once；外部副作用由 action 幂等键兜底 |
| 重试/退避/死信 | 1s/5s/30s + jitter，最多 3 次；`attempt` 入账；死信可人工 `replay`；重启的 `interrupted` 不自动重试非幂等动作 | 退避上限 30s，避免一条触发占住调度 |
| webhook 权限 | 默认关闭 + 每触发 token + HMAC-SHA256 + 时间戳 ±300s 防重放 + `Host/Origin` 栅栏 + body ≤256KB + 仅 loopback（可配 IP 白名单） | 复刻 `dsh-hooks` 已验证的栅栏模式；投递 id 去重（如 `X-GitHub-Delivery`） |
| 注入 | payload 视为**数据**：围栏 + “以下内容不可信”指令前缀 + 低权限 preset + 工具白名单 + 不拼进命令/SQL | 模板只做 `{{}}` 替换，无表达式 |
| 审计 | 每次 fire 写 run（payloadDigest/命中路径/Grant 结果/turn-end reason/退出码）；`dsh-trigger export --since 30d` JSONL；本地优先、默认零遥测 | 不含密钥；`token/secret/key/authorization` 脱敏 |
| 数据丢失边界 | Host 不在 = 事件丢失（不回填无界）；session 源可回填时间窗内 `turn/end`；fs/webhook 只标 missed | UI 明示“离线不补跑” |

## 7. 失败模式

| 失败 | 症状 | 设计对应 |
|---|---|---|
| **循环触发** | A 触发 B、B 又触发 A；agent 写文件又触发自己的 fs 触发器 | 发布期静态图检测（`trigger:fire` 边）+ 运行期 `depth ≤ 3` + `origin` 链 + 血缘去重；`agent.run` 派生会话的写入标 `selfWrite`，默认不触发同 owner 的 fs 触发器 |
| **事件丢失** | 宿主重启/未运行、fs provider 不支持 watch、webhook 502 | source `availability()` 明示不可用原因；missed 计数与日摘要；session 源窗口回填；不承诺补偿扫描 |
| **权限过大** | 触发器以作者全权跑，无人值守下越权 | 默认只读 preset + 工具白名单；write/exec 必须 standing Grant（含 `expiresAt`）；`danger` 禁止自动触发；不可自授 Grant |
| **调试困难** | “为什么没触发 / 为什么触发两次” | `trigger_explain`：最近 50 次候选逐条给原因（事件不匹配/字段不匹配/cooldown/dedupe/budget/grant/熔断）；Test fire 干跑 + Run 详情展示 `turn/end` 与工具错误；CLI `tail` |

## 8. MVP 5 周计划

| 周 | 交付 | 验收 |
|---|---|---|
| W0（3 天，前置） | 10 个 DSH 用户访谈 + 落地页 | ≥20 留资或 ≥5 愿付定金，否则不做 |
| W1 | `Trigger`/`Run` schema、`storageDomain` 定义、`ctx.triggers` 骨架、fs 源（非递归 + 轮询兜底）、cooldown/dedupe | fs 触发器可建可触发；冷却与去重有单测 |
| W2 | session 源（`turn/end`/`approval/asked`/`tool/result` + 回填）、webhook 源（HMAC/栅栏/去重）、条件 DSL、`explain` 采集 | 3 类源端到端；注入 100 ev/s 后 run ≤10/s |
| W3 | `agent.run`（新会话 + preset + 权限）、账本、重试/退避/死信、结果判定 | 失败可重试到死信并可 replay；重启账本恢复 |
| W4 | 设置页（列表/详情/Runs/Test fire/风暴横幅）、6 个 tool、CLI、`notify` + `command`（显式开启） | 5 个配方可复现；`test/explain/tail` 可用 |
| W5 | Act/Allow/Ring 适配、`dsh-hooks` YAML 导入、配方库、24h soak、打包发布、upstream RFC | 100 ev/s 无泄漏；同 dedupeKey 0 重复；p95 fire→会话 <2s |

## 9. 指标与验证

- **北极星**：每周“有结论的运行”数（succeeded + dead，去重会话）。**供给/需求**：每用户触发器数（≥3）、7 日内有 ≥1 次运行的触发占比（≥60%）、创建→首次 fire 中位 <10min、配方安装数。
- **可靠性护栏**：run 成功率 ≥95%、重试恢复率、死信数（>5/周即排查）、**误触发率 <5%**（用户标“无用”或 0 工具调用的运行）、风暴丢弃数、p95 fire→会话 <2s。
- **验证**：5 个内部配方日用 2 周（下载 PDF 摘要、CI 失败开修、`turn/end` error 告警、审批超时升级、每日失败摘要）+ 3 个外部插件接入 `registerSource` + 与 `dsh-hooks` 迁移对照（导入其后行为一致）。

## 10. 打包与变现

- **安装与品牌**：`dsh plugin --profile web add dsh-trigger`；bundle patch 注册主机与客户端两半；bin `dsh-trigger`（先例：`dsh-hooks` 的 bin）；README 首行 “Not affiliated with DeepSeek”，不用官方商标/图标，与 11 产品家族打包 30% 折扣但不锁核心。
- **Free（MIT 核心）**：5 条触发器、本地、7 天账本、session+fs 源、`agent.run`/`notify`。**Pro $6/月**：无限条、90 天账本、webhook 源、`command`/`action`、配方库、导出；Lifetime $79。
- **Team $12/seat（5 起）**：共享配方库（按 workspace）、审批路由（结合 Allow）、账本导出到 SIEM、风暴/死信看板。**Enterprise（年费/自托管）**：策略模板、私有配方 registry、SSO、离线审计归档、SLA。

## 11. 风险与开放问题

| 风险 | 级别 | 缓解 |
|---|---|---|
| 官方给 `schedule` 加事件触发 / 直接收编 `ctx.triggers` | 高 | 先插件、seam 可替换、随时退为主要贡献者；RFC 早发 |
| `dsh-hooks` 补齐 agent 动作（1,109 周下载的分发优势） | 高 | 差异点必须在 seam + 账本 + Grant + 跨源；首发带 YAML 导入抢迁移 |
| 事件风暴把 token 烧穿 | 高 | 三级漏斗 + 预算 + 熔断 + 每日上限；UI 显示单触发周成本 |
| webhook/文件 payload 注入 | 高 | 数据围栏 + 低权限 preset + 工具白名单 + `danger` 禁止自动触发 |
| Allow 延期 / `fs.watch` 非递归 / provider 不支持 / 平台差异 | 中 | 降级客户端确认 + `unattended:false`；目录级注册上限 + 轮询兜底 + availability 明示 |
| 触发链放大（经 Act 互触）、范围滑向工作流引擎、近名混淆 | 中 | 图检测 + depth ≤3；§3 非目标写死；改名 `dsh-trigger` + README 首句声明 |

**开放问题**：① “成功”是否只看 `turn/end` reason（turn 内工具失败但整体 completed 算不算成功）；② 是否允许 `resume` 复用会话（默认新会话隔离，v1.1 评估）；③ 定义存 storageDomain 时多进程（桌面 Host + CLI）如何避免写冲突；④ webhook 入口在 desktop host 是否有独立 WebServer 可复用；⑤ 是否需要“事件目录清单文件”供他插件声明 build 期事件；⑥ 定价按运行数还是触发器数计量。

## 12. 证据索引

**DSH 源码（`/home/yy/deepseek-harness`，`0.2.2-rc.4`，`ca33fd6`）**
- `docs/event-producer-consumer.md`：111 行事件矩阵（逐行计数 = 111）；`:18` `agent/error`、`:48` `domain/changed`、`:54` `fs/observed`、`:77` `session/event`（post-commit，observer 失败被收纳）
- `docs/capability-seams.md`：服务表无 `ctx.hooks`/`ctx.triggers`，只有 `:807` `ctx.webServer`、`:788` `ctx.shell`、`:791` `ctx.sandbox`；`packages/experimental/hook-protocol/README.md:12`：兼容桥只跑 command handler，`http`/`mcp_tool`/`prompt`/`agent` 跳过并告警
- `packages/interaction/user-approval/src/index.ts:226-254`：`request()` 需 open turn，否则 throw（审计对必须 turn-enclosed）
- `packages/fs/fs/src/index.ts:117`（`watch` seam）、`packages/fs/fs/README.md:38`（单文件/直接子项，非递归；不支持则 reject）；`packages/host/webserver/src/index.ts:520`（`register` 返回 disposer）、`docs/subsystems/web-server.md:120`（命名路由、重复即 throw）、`:53`（`webserver/authorize`）
- `packages/core/agent/src/index.ts:421`（`agents.create`）、`packages/experimental/webhook/src/session.ts:110-135`（建会话 + preset + permission + followup 范式）、`packages/interaction/permission-presets/src/index.ts:470`（`set(session, preset)`）、`packages/storage/storage-domain/README.md:12`（schema KV、写即持久、`domain/changed`）
- `packages/schedule/schedule/README.md:279-280`（无重试循环；receipt 只证明 inbox 持久化）、`:285`（60s 下限、`new` 目标可无限重叠）、`docs/subsystems/schedule.md:26-34,78-84`（七种 timing / 三种目标）、`docs/subsystems/webhook.md:23`（“no queue, retry, deduplication, execution status, crash replay… Repeated delivery may create repeated Sessions.”）、`packages/session-query/session-query/src/index.ts:299`（`listEvents`，session 源回填依据）

**外部（2026-11-20 抓取）**
- npm `dsh-hooks`：0.14.8、1,109 周下载（`api.npmjs.org/downloads/point/last-week`，11-13→19）、18 类事件、`run`/`notify` 两种动作、`history.jsonl` + GUI 编辑器：[PeterBon/dsh-hooks](https://github.com/PeterBon/dsh-hooks)
- 邻名与先例：[vaniawang/dsh-trigger-hub](https://github.com/vaniawang/dsh-trigger-hub)（0★，“one ledger, one console”）、[msilita/dsh-waker-trigger](https://github.com/msilita/dsh-waker-trigger)（0★，条件唤醒）、`ZiyaZhang/dsh-event-triggered-automation-rfc`（设计笔记）；命名可用性：`dsh-trigger`/`dsh-trigger`/`dsh-once`/`dsh-upon` = 404，`dsh-when` = 200（0.1.0 相对时间解析），`@perrylink/dsh-trigger` = 404
- OS 先例：[cron](https://man7.org/linux/man-pages/man5/crontab.5.html)、[launchd](https://www.manpagez.com/man/5/launchd.plist/)、[Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)、[Home Assistant](https://www.home-assistant.io/docs/automation/)（trigger/condition/action + run mode + trace）
