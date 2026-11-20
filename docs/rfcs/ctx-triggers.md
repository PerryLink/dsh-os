# 建议：一个可选的 `ctx.triggers` seam（事件 → 动作）

> **状态：** discussion draft。**这是建议，不是要求**，也不代表 DeepSeek 的路线图。
> **基线：** DeepSeek Harness `0.2.2-rc.4`（checkout `ca33fd6`）。`ctx.triggers` 在该
> 版本全仓 **0 命中**；现有的事件面是 `ctx.on(...)` 和 `ctx.webhookRuntime`。
> **本仓实现：** `dsh-trigger`（Host seam `ctx.triggers`，4 个 agent 工具，内存版）。
> 如果宿主提供 `ctx.triggers`，这个包可以退化为适配器；不提供也可以继续自足。

---

## 1. 问题

DSH 把**时间轴**做得很完整：`schedule` 支持多种 timing，`every` 至少 60 秒，
`new` 目标有投递下限（`docs/subsystems/schedule.md:30,129`）。但**事件轴**没有
对应的公共层：

- 插件要监听事件，只能直接 `ctx.on('...')`，事件名和 payload 形状靠读宿主源码；
  没有稳定的 source registry，也没有跨插件的事件目录。
- `webhook` 运行时明确没有 queue、retry、deduplication、execution status、
  crash replay，重复投递可能创建重复 Session（`docs/subsystems/webhook.md:23`）。
- 插件想暴露自己的事件给别的插件，没有公共入口；要么让对方直接 import，
  要么自己发明一个总线。
- 每个“事件 → 动作”插件都要重写：匹配、冷却、去重、重试、账本、错误处理。
  用户拿到的是一堆互不兼容的触发器 UI。

我们**不是**建议宿主内置一个完整的工作流引擎。缺的是一层很薄的事件传输/注册
seam：让 source 可以登记、事件可以带统一信封、订阅可以被撤销；调度、重试、
账本、策略仍然留给插件或上层产品。

**可验证的现状**（2026-11-20，`0.2.2-rc.4`）：

- `grep -rn 'ctx.triggers' packages docs apps` → 0 命中。
- `docs/capability-seams.md` 的服务表里，事件相关只有 `ctx.webhookRuntime`；
  没有 trigger / hook / event bus 这类 seam。
- `ctx.on` 是 Cordis 的通用事件订阅，不是“可发现的事件源”协议。
- DSH 的 “hook” 是 Claude Code / Codex 的兼容桥（只跑 command handler），
  和“事件触发器”不是同一个概念。

## 2. 接口草案（建议）

建议把 seam 做小：**host 只负责“谁能发事件、怎么订阅、信封长什么样”**，
不负责触发器定义、条件 DSL、重试或 UI。

```ts
/** 所有跨插件事件统一走这个信封；payload 由 source 定义。 */
interface EventEnvelope<P = unknown> {
  id: string                    // 宿主或 source 生成的唯一 id
  type: string                  // 例如 'session/turn-end'、'file/changed'
  at: number                    // Unix ms
  source: string                // 注册的 source id
  subject?: { sessionId?: string; plugin?: string }
  payload: P                    // 建议 ≤ 8 KB，敏感字段由 source 脱敏
}

interface SourceSpec {
  id: string                    // 唯一，建议带命名空间
  title?: string
  /** 该 source 可能发出的事件名；用于发现和 allowlist。 */
  events?: string[]
  /** 返回 disposer；宿主卸载时调用。 */
  subscribe(
    emit: (event: EventEnvelope) => void,
    ctx: unknown,
  ): () => void
}

interface FireResult {
  eventId: string
  delivered: number
  errors: Array<{ source: string; message: string }>
}

interface TriggersService {
  /** 登记一个事件源；重复 id 应报错而不是覆盖。 */
  registerSource(spec: SourceSpec): () => void

  /** 没有原生事件推送的插件，也可以主动 fire。 */
  fire(type: string, payload: unknown, meta?: {
    source?: string
    subject?: EventEnvelope['subject']
    idempotencyKey?: string
  }): Promise<FireResult>

  /** 只读发现；不要暴露订阅者列表。 */
  listSources(): Array<{ id: string; title?: string; events: string[] }>
}
```

几点语义建议：

- **只观察，不拦截。** 不要复用 `waterfall` 事件（如 `approval/request`）来做触发，
  也不要把订阅者插进宿主的决策链；触发是 post-commit 的观察者。
- **信封统一。** 有 `type`、`source`、`at`、`id`，消费方才能做去重、审计和
  provenance；payload 由 source 定义，但建议有大小上限。
- **订阅可撤销。** `registerSource` / `subscribe` 都返回 disposer；插件卸载时
  建议能干净退订。
- **不内置调度。** 时间触发交给官方 `schedule`；`ctx.triggers` 不实现 cron，
  也不承诺 60 秒以内的时间精度。
- **不内置重试。** 投递失败怎么处理由订阅方决定；宿主只报告 delivered/errors。
- **不内置条件 DSL。** `when X and Y` 是插件/产品层的事；宿主不需要理解条件。

## 3. 兼容性

- **`ctx.on` 不变。** 现有插件继续直接订阅 Cordis 事件；`ctx.triggers` 是新增的
  可选层，不改变事件发射顺序或 waterfall 语义。
- **缺省可用。** 插件探测 `ctx.get('triggers')`；没有就用自己的 `TriggerService`
  （`dsh-trigger` 当前就是这个形态），或者直接 `ctx.on`。
- **不改变 `schedule` / `webhook`。** 时间触发仍走 schedule；HTTP 投递仍走
  webhook runtime。`ctx.triggers` 可以作为它们的上层消费者，但不替换它们。
- **feature-detect。** 宿主可以先只实现 `registerSource`/`listSources`，不实现
  `fire`；插件应分别探测。
- **事件命名。** 建议 source id + 事件名都有命名空间，避免两个插件都叫
  `changed`；宿主可维护一个 allowlist，默认不允许订阅未登记的事件。
- **版本化。** 事件 payload 的形状变化由 source 负责；建议在事件名或 envelope
  里带 `version`，宿主只保证信封字段稳定。

## 4. 替代方案

| 方案 | 优点 | 代价 / 为什么不够 |
|---|---|---|
| **A. 只用 `ctx.on`** | 零宿主改动，现成 | 没有 source 发现、没有统一信封、没有跨插件边界；插件耦合宿主内部事件名 |
| **B. 只用 `schedule`** | 现成、稳定 | 只能表达时间，不能表达“文件变了/CI 失败了/会话结束了”；最小 60 秒 |
| **C. 只用 `webhook`** | 有 HTTP 入口 | 没有 queue/retry/dedup/execution status；需要起 HTTP，进程内事件很别扭 |
| **D. 宿主内置完整 trigger 引擎** | 一致体验 | 范围太大：条件 DSL、重试、死信、UI、持久化、权限；会把内核变成 workflow 产品 |
| **E. 用 MCP notifications** | 跨进程标准 | 只覆盖 MCP server；本地插件和 session 事件仍无入口；身份/授权另做 |
| **F. 每个插件自带总线（现状）** | 零宿主改动 | 互不兼容；用户无法发现；重复实现冷却/重试/账本 |

我们倾向 **A + 最小 seam**：先统一信封和 source 注册，调度/重试/条件留给上层。
如果宿主认为连 `fire` 都不需要，只做 `registerSource` + 信封也是有价值的。

## 5. 最小实现（建议分阶段）

**Phase 0（约 150–250 行）——内存 source registry**

- 新增 `EventEnvelope` / `SourceSpec` 类型。
- `registerSource` / `listSources` / `fire`；纯内存，无持久化、无重试。
- `fire` 同步或异步调用订阅者；单个订阅者失败不影响其他订阅者，错误汇总返回。
- 限制：source 数量、事件 payload 大小、单次 fan-out 上限。

**Phase 1（约 100–200 行）——宿主事件桥**

- 把一组**白名单**宿主事件（例如 `session/turn-end`、`agent/error`、
  `approval/asked`）适配成 `EventEnvelope`，通过 `ctx.triggers` 暴露。
- 只订阅 `emit`/`serial` 类事件，不拦截 waterfall；不改变宿主语义。
- 用 `ctx.on` 的 disposer 做卸载；进程退出时不再投递。

**Phase 2（可选）——投递元数据**

- `idempotencyKey`、`delivered`/`errors`、简单的 backpressure 信号。
- 仍然不做重试/死信；这些属于消费者。

**明确不建议放进最小实现的东西：** 触发器 CRUD、条件 DSL、cron、重试/退避、
死信队列、运行账本、设置页、云端中继。它们是产品，不是 seam。

## 6. 风险与缓解

| 风险 | 说明 | 建议的缓解 |
|---|---|---|
| **事件风暴** | 一个高频事件唤醒大量订阅者 | source 侧粗筛 + 订阅方冷却；宿主限制 fan-out；可配置采样 |
| **递归 / 自激** | 触发器执行的动作又发出同一事件 | 信封带 `causedBy`/深度；订阅方按 idempotencyKey 去重；宿主限制深度 |
| **重复投递** | 重连/重启导致同一事件多次到达 | 信封带稳定 `id`；消费者幂等；宿主不承诺 exactly-once |
| **payload 注入** | 事件内容被拼进 prompt，造成提示注入 | 消费方把 payload 当不可信数据；包进数据围栏；限制大小；不执行 payload 里的指令 |
| **跨插件数据泄露** | A 插件的事件被 B 插件读到 | source 声明可见性；宿主按 plugin/session 隔离；敏感字段由 source 脱敏 |
| **顺序错乱** | 多订阅者并发，事件顺序不保证 | 明确“不保证跨 source 顺序”；需要顺序的消费者自己排队 |
| **卸载泄漏** | 插件卸载后订阅仍在 | disposer 建议幂等；宿主在插件卸载时统一清理；测试覆盖 |
| **阻塞宿主** | 订阅者同步做重活 | `fire` 异步/有界；慢订阅者不阻塞 emit；超时与降级 |
| **误以为是可靠队列** | 用户以为事件不会丢 | 文档明确：内存投递、无持久化、无重试；可靠性由上层产品负责 |

## 7. 开放问题

1. 事件名是否应该由宿主统一注册表管理，还是 source 自由命名 + allowlist？
2. `fire` 是同步返回 delivered，还是返回一个可 await 的 Promise？
3. 事件是否应该带 session/workspace 作用域，默认只投递给同会话订阅者？
4. 宿主事件桥应该暴露哪些事件？全量 111 个，还是一个精选白名单？
5. 订阅者能不能看到 payload 全文，还是只能拿到摘要 + 拉取？
6. 插件卸载/宿主退出时的在途事件怎么处理——丢弃、等完成，还是标记 interrupted？
7. 如果宿主只想做 `ctx.on` 的语法糖，是否值得新增一个 seam 名字？

## 8. 非目标

- 不做 cron / 定时器；时间触发交给官方 `schedule`。
- 不做重试、退避、死信、队列、持久化或 crash replay。
- 不做条件 DSL、可视化 DAG、画布或触发器 UI。
- 不做云端中继、跨设备同步或团队共享。
- 不拦截/改变宿主的 waterfall 事件，不改变审批或工具执行语义。
