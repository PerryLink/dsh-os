# Act · 动作总线与 NL 动作面板

> npm `dsh-act` ｜ CLI `dsh-act` ｜ Host seam `ctx.actions` ｜ 目标 DSH `0.2.2-rc.4`（checkout `ca33fd6`）
> **Not affiliated with DeepSeek.** 与 `dsh-actions`（pure-craft）不是同一插件，见 §1.1。
> 产品线 Act / Allow / Snip / Stage / Trigger：Act 是动作协议与执行入口，授权在 Allow，剪贴板在 Snip，窗口在 Stage，触发在 Trigger。

## 0. 结论
- **做的不是启动器，是“系统调用层”**：统一 `ActionDescriptor` + Host `ctx.actions` + 8 类 provider 源 + NL 面板 + 预览/审批/撤销/审计 + Agent tools + CLI。
- **空位经复核**：DSH 有 6 个人类面半注册表 + 2 个模型面注册表 + approval，但 `ctx.actions` 在 0.2.2-rc.4 全仓 **0 命中**（`grep -rn ctx.actions packages/ docs/ apps/`），`docs/capability-seams.md:719` 写明 computerUse “no common action API”。
- **名字必须换**：计划名 `dsh-actions` 已被**直接竞品**占用（0.5.2、343 周下载、6★），改用 **Act / `dsh-act`**（npm 与 GitHub 均 404），差异见 §1.1。
- **会撞墙的约束**：`ctx.approval.request()` **只在 open turn 内可用**，否则 throw（`packages/interaction/user-approval/src/index.ts:243-254`）⇒ 人类面不能复用它，需双通道（§6.3）。
- **MVP 5 周**：W1 协议+Registry，W2 面板+搜索，W3 预览+双通道审批，W4 跨源 provider+撤销+eval，W5 dogfood+10 个外部 action+upstream RFC；**止损线**：W4 末 top-1 采纳 <50% ⇒ 砍 NL，只发 Registry+精确搜索+动作面板。

## 0.1 五条共享契约的落位
| 契约 | 本设计落点 |
|---|---|
| ① 每产品 = `ctx.<name>` + Client UI + Agent tool(s) + CLI | §4.1：Host `ctx.actions`、Client 面板、tools `act_search/act_invoke/act_receipt`、bin `dsh-act` |
| ② 对象基类 id/owner/scope/createdAt/updatedAt/expiresAt?/auditRef | §4.2：`ActionDescriptor` 与 `ActionReceipt` 均继承 |
| ③ ActionDescriptor 是跨产品动作协议 | §5：Snip/Stage/Trigger/Allow 的关键操作**注册为 action**，不自建执行入口 |
| ④ Grant 是跨产品授权协议，写前必查 | §5.1 伪代码 + §6.3 双通道；`descriptor.grant` 声明 capability |
| ⑤ 可导出/可审计、本地优先、not affiliated | §4.6 回执 JSONL 落盘 + `dsh-act export`；§10 README 首行 |

## 1. 名字与可用性（2026-11-20 实测）
| 候选 | npm | GitHub | 结论 |
|---|---|---|---|
| **`dsh-act`** | **404 ✅** | `PerryLink/dsh-act` 404；npm/web 搜索无同名 ✅ | **采用**（对齐产品线 Act） |
| `dsh-actions` | 200 ❌ 0.5.2 | `pure-craft/dsh-actions` 6★，actions.json → 面板+Agent 工具+审批 | **直接竞品，弃用** |
| `dsh-do` | 200 ❌ 0.2.6 | `BingChanCN/dsh-do`：profile/plugin/settings manager | 弃用（语义不符） |
| `dsh-run` | 200 ❌ 0.0.1 占位 | `dushaobindoudou/dsh-plugin` 的 packages/dsh-run | 弃用（占位） |
| `dsh-move` | 404 ✅ | 未发现同名 | 备选（“移动”语义，与总线不符） |

- **名称拥挤**：`dsh-action-hub`(215/wk)、`dsh-action-outbox`、`@mkaliezz/dsh-action-ledger`、`@phm-audit/dsh-action-guard`、官方 `@deepseek-ai/dsh-action-cards`。`act` 单数区分度最高，但**首句必须写**“Act 是动作总线（Action Bus），不是 `dsh-actions` 那种仓库任务运行器”。
- **复核方法与残留不确定性**：GitHub Search API 未认证额度耗尽（403），改用 ① 目标仓库直接 404 ② web 搜索无 `dsh-act` ③ npm 搜索无同名包。GitHub 仍可能有非发布用途的私有同名仓，不影响 npm 标识；发布前用 `npm view dsh-act` + `gh repo list PerryLink` 再核一次。**产品线可用性**：`dsh-allow` / `dsh-snip` / `dsh-stage` / `dsh-trigger` 均 npm 404，全套无冲突。

### 1.1 与 `dsh-actions` 的差异 + 竞品威胁
它是最近似的竞品，必须先说清“为什么不是它”：

| 维度 | `dsh-actions`（pure-craft，0.5.2） | Act |
|---|---|---|
| 定义来源 | 唯一来源 `actions.json`（项目/全局/会话三层，随仓库提交） | **注册表**：commands / tools / MCP / skills / 文件 / 剪贴板 / 窗口 / 插件 |
| 触发 | 侧栏点击 + 4 个 Agent `actions_*` 工具 + `/actions:` 引用 | 面板 + **NL 意图** + CLI + Trigger + 模型面，同一 descriptor |
| 参数 | 模板参数 modal | JSON Schema + 严格校验 + NL 填参 + 一次修复 |
| 风险/审批 | 任务级 `approval: never / agent / always` | **四级 risk** + Allow Grant + 双通道审批 + danger 双确认 |
| 预览/撤销 | 无 dry-run、无 undo（只有 run tab 流式输出） | `preview`/dry-run/diff + 声明式 `undo` + 回执 |
| 审计 | 运行日志 | `ActionReceipt` JSONL + `action/run` / `action/done` 事件 + `export` |
| 组合 | 单插件自足 | 与 Allow/Snip/Stage/Trigger 的跨产品协议（③④） |
| 定位 | “VS Code Tasks 替代”：固化并反复跑**已知命令** | “系统调用层”：**任意来源**的动作发现、类型化、执行、撤销 |

**威胁评估（高）**：① 它已占住 “DSH Actions” 心智与包名，343 周下载证明需求真实；② 强项是长任务流式输出、三层共享、团队提交 actions.json——**Act v0 不正面打**（不做长任务 runner、不做流式 tab）；③ 它自己的 README 承认“尚未完成：在会话框直接触发一次运行”，即 **NL 入口与跨源发现仍是空白**，这正是 Act 的窗口；④ 若它补上 NL/跨源，Act 会被夹击，护城河只能是**协议 + 跨源 + 组合**，不是 UI。
**应对**：v1 出 `actions.json` **导入器**（作为一个 `plugin` provider），把它的存量用户变成 Act 用户；Grant 是它没有的能力（§5.1）；README 首句区分，避免被当成它的改名版。

## 2. 一句话 / 问题 / 用户
**一句话**：说出你要做什么，Act 把它变成一条**类型化、可预览、可审批、可撤销、可审计**的动作并执行。

**问题**：DSH 的能力都“注册过”，但只对模型或单一面可见——命令只有字符串入参（`packages/interaction/commands/src/index.ts:61-78`），工具/MCP 人类无入口（`packages/core/tools/src/index.ts:99`），技能只能插 prompt（`packages/skill/skill/src/index.ts:54-56`），右键只覆盖 6 类目标且锁在客户端（`packages/client/ui-context-menu/src/client/types.ts:29-40`）。8 个启动器插件最高 337 周下载、0–1★，无一做“意图 → 类型化动作 → 预览 → 执行”。

**用户**：① 插件作者——注册一个 action 即得面板/CLI/审计，不必自建 UI 与权限；② 重度用户——不写 JSON、不进对话就能跑 MCP/工具/文件动作；③ 企业——动作白名单、审批链、可导出审计。

## 3. 范围与非目标
**范围**：Descriptor 协议、Host Registry、8 类 provider 源、`Mod+Shift+K` 面板、NL 路由、参数表单与预览、双通道审批、声明式撤销、回执与审计导出、3 个 agent tool、CLI。

**非目标**：通用聊天；插件市场（→ `dsh plugin`）；自治多步编排（→ workflow）；OS 级应用启动器；自建权限模型（用 Allow Grant）；长任务 runner / 流式运行 tab（让给 `dsh-actions`）；动作包商店与用户 YAML 动作（v1 再议）。

## 4. 架构
### 4.1 四层
```
Client(Web/Desktop)            Host(Cordis)                  外部 provider
┌ 面板 Mod+Shift+K ─┐  RPC  ┌ ctx.actions (Registry) ┐  ┌ commands / tools+MCP ┐
│ NL router(miss)    │◄────►│ 懒枚举 / Grant / invoke │◄─┤ skills / fs / Snip    │
│ 参数/预览/风险      │      │ receipt → session 事件  │  └ Stage / 第三方插件    ┘
└ 回执/撤销/导出 ────┘      └────────────────────────┘
        ▲                            ▲
   tools: act_search/invoke/receipt   CLI: dsh-act list|run|undo|export
```
Client 与 Host 分属 Cordis 两半边（`dsh.client` / `dsh.bundle`，`docs/architecture.md:21`）；CLI 用包级 `bin`（先例：`dsh-locator` 0.19.4 的 `bin={"dsh-locator":"scripts/locator-cli.mjs"}`），不假设内核有 CLI seam——`packages/boot/cmdline/src/index.ts:84` 只提供 `cmdlineArgs/appExit/appReady`，`docs/cli-help.md:62` 只有 `dsh plugin` 一个插件管理子命令。

### 4.2 ActionDescriptor（契约 ②③）
```ts
type ActionRisk = 'read' | 'write' | 'exec' | 'danger'
type ActionSource = 'command' | 'tool' | 'mcp' | 'skill' | 'file' | 'clip' | 'window' | 'plugin'

interface ActionDescriptor<A = unknown, R = unknown> {
  id: string; owner: string; scope: 'global' | 'workspace' | 'session'   // 基类：id/owner/scope
  createdAt: number; updatedAt: number; expiresAt?: number; auditRef?: string
  title: string; icon?: string; group?: string; keywords?: string[]     // keywords 供中英精确匹配
  source: ActionSource
  args?: JSONSchema; risk: ActionRisk
  grant?: { capability: string; scopeHint?: string }                    // 契约 ④：交给 Allow
  availability(ctx: ActionContext): { ok: true } | { ok: false; reason: string }
  preview?(args: A, ctx: ActionContext): Promise<ActionPreview>         // diff/摘要/影响面，dry-run 复用
  execute(args: A, ctx: ActionContext): Promise<ActionResult<R>>
  undo?(receipt: ActionReceipt<R>, ctx: ActionContext): Promise<void>
}
```
`ActionReceipt` 同样继承基类：`{ id, actionId, origin: panel|tool|cli|hook, principal, grantId?, argsHash, risk, startedAt, endedAt?, outcome: ok|denied|failed|undone, undoable }`。**参数只存 hash**，避免密钥/剪贴板内容进日志。

### 4.3 Registry（Host `ctx.actions`）
```ts
interface ActionRegistry extends Service {
  provide(source: ActionSource, provider: ActionProvider): Disposable   // 懒枚举，别在启动时拉全量 MCP
  register(d: ActionDescriptor): Disposable
  list(q?: { source?: ActionSource[]; riskMax?: ActionRisk; text?: string }): ActionDescriptor[]
  get(id: string): ActionDescriptor | undefined
  invoke(id: string, args: unknown, req: InvokeRequest): Promise<ActionReceipt>
  undo(receiptId: string): Promise<UndoOutcome>
}
type InvokeRequest = { origin: 'panel' | 'tool' | 'cli' | 'hook'; principal: string
  dryRun?: boolean; approval?: 'ask' | 'never'; idempotencyKey?: string }
```
执行后向 session 追加 `action/run` / `action/done` 两条 plugin record，**刻意对齐**命令生命周期（`packages/interaction/commands/src/index.ts:335-341, 373-380`）；不新建数据库，不写 `approval/*`（那是 turn 语义，见 §6.3）。Agent 面三个工具：`act_search`（只读检索，走本地索引，不调模型）、`act_invoke`（必须带注册表 id + 已校验 args，write/exec 强制审批，**模型不能自授 Grant**）、`act_receipt`（按 id/session 查回执）。

### 4.4 Provider 适配（8 源）
| source | 适配自 | args 来源 | 默认 risk | undo |
|---|---|---|---|---|
| `command` | `ctx.commands`：name/description/`input`/handler（`commands/src/index.ts:61-78, 285`） | 单个字符串 | read | 命令自报 |
| `tool` | `ctx.tools` 可见定义 + executor（`core/tools/src/index.ts:99,114`） | tool `parameters` | exec（保守） | 声明式 `undoTool` |
| `mcp` | 工具名 `mcp:<server>/<tool>`，走同一 tool pipeline | `inputSchema` | write（默认不可信） | 无 → 仅审计 |
| `skill` | `ctx.skills` 的 `userInvocable` 技能（`skill/src/index.ts:54-56`） | 无参 / 一个文件参数 | read | 无（只注入 prompt） |
| `file` | fs 动作：定位/打开/复制路径/在编辑器打开 | path(+line) | read；写入类 write | 写前快照 |
| `clip` | Snip 的 `ctx.clipboard`（缺失则整源 unavailable） | 文本/图像句柄 | write | 恢复上一份 |
| `window` | Stage 的 `ctx.windows`（缺失则 unavailable） | appId/windowId/layout | exec | focus 可逆 |
| `plugin` | 第三方 `ctx.actions.register`（含 actions.json 导入） | 自定义 | 自定义 | 自定义 |

工具默认 `exec` 而非 `read`：MCP 与写工具的副作用无法静态判定（`docs/capability-seams.md:769` 只描述 scoped executor，不提供风险标注），宁可多一次确认。

### 4.5 面板与 NL
- **`Mod+Shift+K`**：`Mod+K` 已被 `session.search` 占用（`packages/client/ui-workspace/src/client/shortcuts.ts:85`，`KeyK + primary`）。注册器遇默认键冲突直接 throw（`packages/client/shortcuts/src/client/registry.ts:98`）⇒ 插件加载时 try/catch，冲突则降级 `Mod+Shift+J` 并在设置页提示；TUI 用 `/act`，CLI 兜底。
- **三档检索**：① 精确/别名（本地子串，p95 <16ms）② 模糊（title+keywords）③ **仅 miss 时**调模型，返回严格 JSON `{actionId, args, confidence}`，schema 校验 + 一次修复，取 top-3。**永不透传未校验的模型输出**。
- **面板**：上下文动作（选中文本/当前文件/当前会话）→ 常用（本地频次）→ 全部（按 source 分组）；每行 icon、source、risk 徽标、不可用原因。**预览**：schema 生成参数表单；write/exec 必展示 dry-run（文件 diff、影响路径数、目标主机）；MCP 无 preview 时标“无法预览，仅展示 schema”。

### 4.6 执行管线与审计
`resolve` → `grant`（§5.1）→ `validate`（严格解析，未知字段拒绝）→ `preview`（write/exec 必填）→ `approve`（§6.3）→ `invoke`（捕获副作用）→ `receipt`（落盘 + `action/run|done`）→ `undo window`（有 `undo` 且 risk≥write 才可撤，默认 5 分钟）。

回执存 profile state 的 `act/receipts.jsonl`（本地优先、无遥测），`dsh-act export --since 7d --format jsonl` 导出，企业版可导 SIEM；`expiresAt` 用于动态 action（临时文件句柄等），过期即拒。

## 5. 与 Allow / Snip / Stage / Trigger 的组合
### 5.1 执行前查 Grant（契约 ④）
```ts
const cap = descriptor.grant?.capability ?? `${descriptor.source}:${descriptor.id.split(':')[1]}`
const g = await ctx.grants.check({ subject: descriptor.owner, capability: cap, scope: descriptor.grant?.scopeHint })
if (g.denied) return receipt('denied')                    // 无副作用，仍写审计
if (!g.granted) await ctx.grants.request({ subject, capability: cap, reason: descriptor.title, risk })
```
`never` 策略下未授权动作**直接拒绝、不弹窗**（对齐 approval 的 `never`，`packages/interaction/user-approval/README.md:36`）。未装 Allow 时降级为 `ctx.approval`（模型面）或客户端确认（人类面），UI 标注“无持久授权”。

### 5.2 三个 provider 契约
- **Snip**：提供 `ctx.clipboard`（读写、项元数据、历史 1 步）。Act 注册 `clip:copy-as` / `clip:paste-into` / `clip:pin`；剪贴板写入是 write 动作，先过 Grant；撤销 = 恢复上一份快照（不承诺多步历史）。
- **Stage**：提供 `ctx.windows`（拓扑/聚焦/布局）。Act 注册 `window:focus` / `window:move-to-display` / `window:layout`，risk=exec；只有 focus 可 undo。
- **Trigger**：规则动作 `{ action: 'mcp:github/create_issue', args, grantId, idempotencyKey: event.id }`，以 `origin:'hook'` 调 `invoke`；**必须有带 expiresAt 的 standing Grant**，`danger` 禁止被自动触发，同 `idempotencyKey` 只执行一次（去重表 7 天）。
- **反向要求**：Act 只做协议与入口，不实现剪贴板/窗口/触发逻辑；Snip/Stage/Trigger 自有 UI 的点击也应走 `ctx.actions.invoke`，共享审批、回执、撤销——这是“ActionDescriptor 是跨产品协议”的落地检验。

## 6. 权限与安全
### 6.1 risk 四级
| risk | 例 | 默认闸门 |
|---|---|---|
| read | 查看会话、定位文件、复制路径 | 直跑；仍记回执 |
| write | 改文件、写剪贴板、MCP 写操作 | Grant + 预览 + 确认 |
| exec | bash、跑测试、窗口/应用操作 | Grant + 一次性审批 + 继承 sandbox，不绕过 |
| danger | 删除、发布、推送、改凭据 | 双确认（点击 + 输入动作名）+ 10s 冷却 + 强制审计 + 默认关闭 |

### 6.2 校验与防注入
参数一律 JSON Schema 严格解析（zod/schemastery，与 DSH 同款依赖），拒绝未知字段与超长字符串；NL 只输出 id + args，id 必须命中注册表；面板**绝不自动执行**模型提案，必须人点；模型面只能调 `act_invoke`，`write/exec` 永远走审批，**模型不能自授 Grant**；MCP 结果与工具描述视为不可信文本，渲染转义、不参与权限判断。

### 6.3 双审批通道（硬约束）
`approval.request()` 无 open turn 时 throw（`user-approval/src/index.ts:243-254`，理由：`approval/*` 必须 turn-enclosed 才能可靠重放）。因此：
- **模型/工具面**：`ctx.approval`（一对一、fail-closed、写 `approval/asked|decided`）。
- **人类面（面板/CLI）**：Allow Grant（持久，带 scope+expiry）+ 客户端确认弹窗；审计写 `action/run|done`，**不伪造 `approval/*`**。
- **Trigger 面**：只认 standing Grant + 幂等键，不弹窗（无人可问）。**降级**：Allow 未上线时人类面用“本次允许 / 本会话允许”两档内存态临时 Grant，会话结束失效，并显式标注降级。

## 7. 失败模式与兼容
- **`Cmd+K` 冲突**：已占用（`shortcuts.ts:85`）→ `Mod+Shift+K`；注册 throw 则降级 `Mod+Shift+J`；Web/Desktop 同键，TUI 走 `/act`。
- **官方可能自己做 / 上游 RFC `ctx.actions`**：协议层只依赖 JSON Schema 与 `ctx.actions` 形状，官方出同名 seam 可直接换实现；官方若出面板，Act 退为 provider 适配层；**不 fork 内核、不往官方包打补丁**。`docs/capability-seams.md` 无此 seam（0 命中），提案 = seam 行 + Client `useActions` + 生命周期事件；先插件跑 6 个月再提，PR 只带文档与最小 seam。
- **内核缺口**：无 `ctx.clipboard`（只有 client `writeClipboard`，`packages/client/ui-primitives/src/index.ts:79`）、无通用 `ctx.hooks`（只有 compat 的 `experimental/hooks-claude-code`、`hooks-codex` 与 `ctx.webhookRuntime`）⇒ clip/hook provider 为可选依赖，缺失时整源 unavailable 并给出原因，不静默隐藏。
- **规模与版本**：MCP 可能数百工具 → 懒枚举 + 索引上限 500 + 5 分钟缓存 + `list()` 分页；peer `@deepseek-ai/dsh-tools >=0.2.2-0 <0.3.0`（参照 `dsh-locator`），bundle patch 安装，`0.2.x → 0.3` 视为 breaking。
- **provider 抛错**：`execute` 抛错 → `receipt.failed` + 摘要，不影响其它 action；`undo` 失败标记 `undoFailed`，不回滚 receipt 状态。

## 8. MVP 5 周
| 周 | 交付 | 验收 |
|---|---|---|
| W1 | Descriptor + `ctx.actions` + command/tool/skill 适配 + 15 个只读动作 + `dsh-act list` | 单测覆盖校验/作用域；15 动作可列可执行 |
| W2 | 面板 `Mod+Shift+K` + 精确/模糊搜索 + 上下文区 + 只读执行 | 精确 p95 <16ms；不覆盖 `Mod+K`；冲突可降级 |
| W3 | 参数表单 + 预览/dry-run + 风险徽标 + **双通道审批** + 回执与 `action/*` | 未授权 write/exec = 0；每条执行有回执；无 turn 时面板仍可审批 |
| W4 | file/clip(MCP 若可用) provider + fs 写撤销 + 60 条中英 eval + 10 个外部 action | top-1 ≥70%/top-3 ≥90%；fs 撤销成功率 100%；外部插件 ≥5 |
| W5 | dogfood、bundle 打包、文档（not affiliated）、upstream RFC 草稿 + 插件作者反馈 | 安装/卸载干净、无新凭据；RFC 发出；内部周执行 ≥200 次 |

## 9. 指标与验证
- **北极星**：每周被执行的动作次数（去重会话）——同时衡量“被发现”与“被信任”。
- **供给 / 需求**：注册 action 数（W5 ≥30，外部插件 ≥10）、provider 源数 ≥5；面板打开→执行转化 ≥35%、top-1 采纳 ≥70%、time-to-action 中位数 <8s、7 日留存 ≥25%。
- **护栏**：未授权写/exec = 0；错误执行率 <2%；NL p95 <2.5s；审批拒绝率 >40% 说明闸门过严（回流调 risk）。
- **验证**：60 条中英 eval（30 只读/20 写/10 exec）+ 5 名插件作者访谈 + 2 周内部 dogfood + 有/无 NL 对照实验。

## 10. 打包与变现
- **安装**：`dsh plugin --profile web add dsh-act`（`docs/cli-help.md:62`），bundle patch 注册；CLI 随包发 `bin: { "dsh-act": "..." }`（先例 `dsh-locator`）。
- **免费核心（MIT）**：registry + 面板 + 8 provider 源 + CLI + 本地回执导出。
- **Team（$8–12/seat/月）**：动作白名单（policy 文件，按 workspace）、集中审计导出（SIEM）、审批链与角色（谁能批 danger）。**企业（年费/自托管）**：动作包签名与私有 registry、SSO、离线审计归档、合规报告；**Action Packs**（GitHub/Linear/Notion/发布模板）单独售卖，不锁核心。
- **品牌**：README 首行 “Not affiliated with DeepSeek”；不用其商标/图标；包名与描述不暗示官方。

## 11. 风险与开放问题
| 风险 | 级别 | 缓解 |
|---|---|---|
| 官方自己做并占 `ctx.actions` | 高 | 先插件、协议可替换、随时退为 provider 层（§7） |
| `dsh-actions` 认知混淆/被夹击 | 高 | 名字区分 + 首句声明；护城河是协议+跨源+组合（§1.1） |
| 审批 turn 约束导致体验割裂 | 高 | 双通道 + 临时 Grant；尽早与 Allow 对齐 |
| MCP 无预览/不可撤销却被当安全动作 / undo 过度承诺 | 中 | 强制审批 + “无法预览”“不可撤销”标记 + 只承诺 provider 声明的 undo |
| 权限疲劳 / upstream RFC 被拒 / 动作索引拖慢启动 | 中 | 按 source 批量授权 + danger 强确认；插件层自足不 fork；懒枚举 + 上限 + 缓存 |

**开放问题**：① `Mod+Shift+K` 在部分浏览器/输入法下是否被占（W2 实测）；② action id 版本化与废弃策略；③ 动作包是否签名；④ 是否开放用户 YAML 动作（v1）；⑤ 与 Snip/Stage 的 provider 版本协商；⑥ 多 profile 下 Grant 与回执隔离。

## 12. 证据索引
**DSH 源码**（`/home/yy/deepseek-harness`，`0.2.2-rc.4`，`ca33fd6`）
- `packages/interaction/commands/src/index.ts:61-78`（CommandDefinition 仅 name/description/input）、`:285`（register）、`:335-341`（`command/run`→`command/done`）；`packages/core/tools/src/index.ts:94,99,114`（guards / ToolsService / executor）；`packages/skill/skill/src/index.ts:54-56`（modelInvocable / userInvocable）
- `packages/experimental/action-cards/src/index.ts:70`（verbs）、`:189`（register kind）；该包 **无 undo**（`grep undo|rollback` 0 命中）；`packages/interaction/user-approval/src/index.ts:243-254`（无 open turn 即 throw）、`README.md:12,36`（one-shot、fail-closed、ask/never）
- `packages/client/ui-workspace/src/client/shortcuts.ts:85`（`session.search` = `KeyK + primary`）；`packages/client/shortcuts/src/client/registry.ts:84,98`（register / 冲突 throw）；`packages/client/ui-context-menu/src/client/types.ts:29-40`（六类目标）；`packages/client/ui-input-trigger/src/client/contract.ts:18`；`packages/client/ui-commands/src/client/contract.ts:129`
- `packages/client/ui-primitives/src/index.ts:79`（仅 client `writeClipboard`）；`packages/boot/cmdline/src/index.ts:84`（仅 cmdlineArgs/appExit/appReady）；`docs/capability-seams.md:697`（actionCards）、`:719`（computerUse “no common action API”）、`:769`（tools）、`:773`（commands）、`:776`（skills），全文 **无 `ctx.actions`**（grep 0）；`docs/architecture.md:21`（`dsh.profile`/`dsh.bundle`）；`docs/cli-help.md:62`（`dsh plugin`）

**生态数据**（2026-11-20，npm downloads API / registry）
- 周下载：`dsh-workspace-kit` 337、`dsh-quick-actions` 322、`dsh-spotlight` 319、`dsh-shortcut-extensions` 292、`dsh-action-hub` 215、`@qzsy/dsh-command-palette` 179、`@dsh-community/...` 17、`dsh-command-palette` 15；对照 `dsh-actions` 343、`dsh-lsp-actions` 2413
- npm：`dsh-act` 404、`dsh-do` 0.2.6、`dsh-run` 0.0.1、`dsh-actions` 0.5.2、`dsh-allow`/`dsh-snip`/`dsh-stage`/`dsh-trigger` 404；`dsh-locator` 0.19.4 的 `bin` 字段。https://www.npmjs.com/package/dsh-actions ｜ https://github.com/pure-craft/dsh-actions ｜ https://www.npmjs.com/package/dsh-locator

**内部研究**：`01-research/dsh-os-primitives-2026-11-20/02-launcher-actions.md`（动作层原语、8 插件盘点、5 周里程碑）；`OS-PRIMITIVES.md:60-106`（11 条线定位；其 `dsh-actions` 命名已由本文件 §1/§1.1 修正为 `dsh-act`）。
