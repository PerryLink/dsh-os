# 建议：一个可选的 `ctx.actions` seam

> **状态：** discussion draft。**这是建议，不是要求**，也不代表 DeepSeek 的路线图或承诺。
> **基线：** DeepSeek Harness `0.2.2-rc.4`（checkout `ca33fd6`）。`ctx.actions`
> 在该版本 `packages/`、`docs/`、`apps/` 全仓 **0 命中**；`docs/capability-seams.md:719`
> 只说明 `ctx.computerUse` “has no common action API”。
> **本仓实现：** `dsh-act`（Host seam `ctx.act`，2 个 agent 工具）。如果宿主将来
> 提供 `ctx.actions`，这个包可以退化为一个适配器；不提供也可以继续自足。

---

## 1. 问题

DSH 已经有很多“可以被调用”的东西，但它们没有共同的描述：

| 面 | 现有入口 | 形状 | 谁能调用 |
|---|---|---|---|
| 工具 | `ctx.tools` | `ToolDefinition`，模型面 | Agent |
| 命令 | `ctx.commands` | 字符串命令 + 参数 | 人（CLI/聊天） |
| 技能 | `ctx.skill` | prompt 片段 | 模型 |
| MCP | `ctx.mcp*` | MCP server 自己的能力 | Agent |
| 客户端动作卡 | `ctx.actionCards` | 客户端渲染 | 人（点了才发生） |
| computer-use | `ctx.computerUse` | provider 私有 | 该 provider |

结果是三件事重复发生：

1. **每个插件自己发明动作描述**：id、标题、参数 schema、风险级别、是否需要确认、
   是否可撤销、执行结果怎么表示。没有共识，前端就无法通用地列出来。
2. **同一个动作要为不同入口写多份适配**：给 Agent 的工具、给人的面板、给 CLI 的
   子命令，通常是三套代码，权限检查也各写一遍。
3. **审批语义对不上**：模型面有 `ctx.approval`，人类面和回合外入口没有统一的授权
   对象（见 [`ctx-grant`](./ctx-grant.md)）。写动作要么预配置成 `danger-full-access`，
   要么每个插件自己弹窗。

我们**不是**说 DSH 应该把 tools/commands/skills 合并。相反，这些注册表各有各的
用途。缺的是一层很薄的“动作描述 + 注册表 + 调用入口”，让同一份描述可以被不同
前端复用，而权限判断仍然留给宿主既有的 approval / permission rules / sandbox。

**可验证的现状**（2026-11-20，`0.2.2-rc.4`）：

- `grep -rn 'ctx.actions' packages docs apps` → 0 命中。
- `docs/capability-seams.md:719`：computerUse 服务 “has no common action API”。
- `docs/capability-seams.md:793`：`ctx.approval` 是 one-shot，一次决定只覆盖所问的
  那一次；没有可撤销、可过期的跨轮授权对象。
- `docs/subsystems/webhook.md:23`：webhook 运行时没有 queue / retry / deduplication /
  execution status，重复投递可能创建重复会话——回合外动作缺少统一的“这次调用是什么”
  的描述，只能靠每个插件自己补。

## 2. 接口草案（建议）

下面的类型只是**一个可能的最小形状**。字段名、事件名和错误码都可以改；重要的是
语义：描述是纯数据，建议执行仍然经过宿主已有的权限面。

```ts
/** 只读摘要，给列表/搜索用。 */
interface ActionSummary {
  id: string                    // 建议 ^[a-z][a-z0-9_.-]{1,63}$
  title: string
  description?: string
  risk: 'read' | 'write' | 'danger'
  requiresGrant?: boolean       // 写动作默认为 true
}

/** 注册时提交的完整描述。execute/undo 不进入序列化结果。 */
interface ActionDescriptor extends ActionSummary {
  parameters?: JSONSchema       // 宿主支持的 JSON Schema 子集
  output?: JSONSchema
  execute(args: unknown, ctx: ActionExecutionContext): Promise<unknown>
  undo?(receipt: ActionReceipt, ctx: ActionExecutionContext): Promise<void>
  /** 可选的授权提示；真正的判定仍由宿主 grant 服务做。 */
  grant?: { capability: string; scopeHint?: Record<string, unknown> }
}

interface ActionExecutionContext {
  origin: 'tool' | 'client' | 'cli' | 'trigger' | 'plugin'
  subject?: string              // 宿主签发的身份，不由调用方伪造
  sessionId?: string
  signal?: AbortSignal
  idempotencyKey?: string
}

type ActionResult =
  | { ok: true; actionId: string; result: unknown; receiptId?: string }
  | { ok: false; actionId: string; code: ActionErrorCode; message?: string; capability?: string }

type ActionErrorCode =
  | 'action_not_found' | 'invalid_arguments' | 'grant_required'
  | 'action_failed' | 'action_cancelled' | 'unavailable'

interface ActionsService {
  register(descriptor: ActionDescriptor): () => void
  unregister(id: string): boolean
  get(id: string): ActionDescriptor | undefined
  list(query?: { text?: string; riskMax?: 'read' | 'write' | 'danger' }): ActionSummary[]
  invoke(id: string, args: unknown, ctx: ActionExecutionContext): Promise<ActionResult>
}
```

几点语义建议：

- **`invoke` 对预期的拒绝返回结构化结果，不 throw**。`grant_required` 应该在
  `execute` 之前返回，和 `dsh-act` 当前的行为一致。
- **`risk` 是声明，不是保证**。宿主仍然可以用自己的 approval / sandbox / permission
  rules 覆盖；`danger` 动作不应因为注册了就自动获得执行权。
- **执行身份由宿主给**。不要把 `subject` 交给调用方随便填；回合外没有宿主身份时，
  建议直接 fail closed（`grant_required` 或 `unavailable`）。
- **事件可选**：`action/registered`、`action/invoked`、`action/settled`。如果宿主
  已有审计/事件机制，映射过去即可，不必新增一套持久化。

## 3. 兼容性

- **缺省可用。** 插件先探测 `ctx.get('actions')`；没有就继续用自己的注册表
  （`dsh-act` 的 `ctx.act` 就是这个形态）。宿主不需要一次性实现全部字段。
- **不改变现有注册表。** `ctx.tools`、`ctx.commands`、`ctx.skills`、MCP 的注册方式
  不变；`ctx.actions` 只是新增一层描述。可以在宿主内部把已有的 tool/command
  懒适配成只读 action，而不是要求插件重写。
- **不改变审批语义。** 模型面调用仍走 tools pipeline；人类面仍走 approval 或
  grant；`ctx.actions` 不自己在进程内放行写操作。
- **命名可替换。** 如果宿主更愿意叫 `ctx.actionRegistry` 或别的名字，插件侧用
  capability detection 适配即可；本文不主张名字的所有权。
- **版本化。** 建议先以 experimental 发布，`manifestVersion` 或服务版本号随宿主
  走；插件在 `dsh.os` 里声明自己依赖的 seam 版本，宿主可以拒绝不兼容的注册。
- **与 `dsh-actions` 的区别。** 本提案不是 `actions.json` 任务运行器，也不规定
  存储格式；它只描述“一个动作是什么、怎么调用、需要什么授权”。

## 4. 替代方案

| 方案 | 优点 | 代价 / 为什么不够 |
|---|---|---|
| **A. 只标准化 JSON Schema，不加宿主服务** | 改动最小，插件仍各自注册 | 没有共享 id/风险/授权语义；前端仍要认识每个插件 |
| **B. 扩展 `ctx.tools`，让人类面也调用工具** | 复用现有注册表 | 模型工具和人类动作的审批、参数展示、撤销需求不同；容易把工具权限暴露给人 |
| **C. 用 MCP 作为统一动作协议** | 跨进程、已有生态 | 本地动作要起 server；身份、审批、撤销仍要另做；对纯本地插件过重 |
| **D. 每个插件自带 registry（现状）** | 零宿主改动 | 前端无法通用；授权和审计继续碎片化；回合外动作没有统一入口 |
| **E. 只做 UI 聚合，不做服务** | 不动内核 | 只是把碎片搬到另一个地方；CLI/Agent 仍无法复用 |

我们倾向于 **A + 最小服务**：先有描述和注册表，执行仍然走宿主已有的权限面。
如果宿主判断连注册表都不需要，只统一 JSON 描述也是有价值的。

## 5. 最小实现（建议分阶段）

**Phase 0（约 100–150 行）——只读注册表**

- 新增 `ActionDescriptor` / `ActionSummary` 类型（可放在宿主已有的 contract 包）。
- `register` / `get` / `list`；不实现 `invoke`。
- 把已有的 commands 和 tools 懒适配成 `ActionSummary`，让前端可以先列出来。

**Phase 1（约 200–300 行）——调用与授权**

- `invoke` 返回结构化结果；写/危险动作在执行前查 `ctx.grant.check`（如果宿主
  已有 grant seam）。
- 没有 grant seam 时，`invoke` 只允许 `read`；`write`/`danger` 返回 `grant_required`。
- 不实现 UI、不实现持久化、不实现 undo。

**Phase 2（可选）——回执、撤销、事件**

- `ActionReceipt` 与 `undo`；`action/*` 事件；审计导出。
- 这些可以完全留给插件，宿主只提供最小 seam。

**明确不建议放进最小实现的东西：** 自带面板、自带存储、自带审批 UI、跨进程
调度、动作市场。它们会把一个薄 seam 变成框架。

## 6. 风险与缓解

| 风险 | 说明 | 建议的缓解 |
|---|---|---|
| **风险级别标错** | 插件把写动作标成 `read`，绕过授权 | 宿主对未知/缺失风险 fail closed；注册时校验；高风险动作要求显式 grant |
| **id 冲突 / 命名空间** | 两个插件注册同一个 id | 建议 `plugin:<pkg>:<id>` 或宿主分配的命名空间；重复注册返回错误而不是覆盖 |
| **描述被篡改** | 注册后修改 descriptor 影响已缓存的授权 | 注册时冻结/拷贝；授权绑定 descriptor hash（如果 grant 支持） |
| **undo 不安全** | 撤销动作本身有副作用，或撤销错对象 | undo 也走同样的授权；回执带不可变 id；失败不回滚已发生的副作用 |
| **confused deputy** | 低权限调用方借高权限动作做事 | 执行身份由宿主签发；动作内部再校验 subject/scope；不信任调用方传的 subject |
| **动作爆炸** | 插件注册几千个动作拖慢启动 | 懒枚举、上限、分页；列表只返回摘要 |
| **误以为它是沙箱** | 同进程代码可以绕过 registry 直接执行 | 文档明确：这是控制面/描述层，不是安全边界；真正的隔离靠 sandbox |
| **与现有 `dsh-actions` 混淆** | 名字接近，用户以为同一个东西 | README/描述第一句写清“动作总线，不是 actions.json 任务运行器” |

## 7. 开放问题

1. 动作 id 是否应该带插件命名空间，还是由宿主统一分配？
2. `risk` 由谁最终裁决——注册者、宿主策略，还是调用时的人工确认？
3. 人类面和模型面调用同一个动作时，是否应该共用一份 receipt？
4. `undo` 的语义是“补偿”还是“精确回滚”？失败时如何记账？
5. 动作是否应该绑定 session/workspace，还是全局注册？
6. 如果宿主只想要描述、不想要执行入口，是否接受 Phase 0 作为最终形态？

## 8. 非目标

- 不替代 `ctx.tools` / `ctx.commands` / `ctx.skills` / MCP。
- 不提供 UI、主题、快捷键或面板。
- 不提供调度、重试、队列或触发器（见 [`ctx-triggers`](./ctx-triggers.md)）。
- 不提供授权存储或审批 UI（见 [`ctx-grant`](./ctx-grant.md)）。
- 不承诺跨进程安全；同进程插件仍然可以直接调用底层 API。
