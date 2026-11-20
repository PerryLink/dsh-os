# Trace：可审计长期记忆（`dsh-trace`）

> 2026-11-20 · DSH `0.2.2-rc.4`（checkout `ca33fd6843`）· 对象：PerryLink（个人开发者，非官方）。 **结论先行**：Trace 是 `dsh-memory-protocol/v1` 之上的**治理与溯源层**，不是第 322 个记忆仓库。一句话：**让 Agent 跨会话记住决策与偏好，并让每条记忆都能回答“从哪来、凭什么信、谁批准、何时过期、为什么被召回、忘了没有”。** MVP **7 周**。

> **npm package:** `@perrylink/dsh-trace` — the unscoped `dsh-trace` is blocked by npm name-similarity rules; the product name remains **Trace**.

## 0. 结论
- **名字**：`Trace` / npm **`dsh-trace`**（2026-11-20 实测 404，可用）；备选 `Past` / `dsh-past`（404）。`Recall`、`Memo` 均已被正面竞品占用（见 §1）。
- **定位修正（重要）**：`dsh-memento` **0.5.32（2026-11-18）已经发布** `dsh-memory-protocol/v1`：审批门、审计账本、预算、`ctx.memoryAdapters`、一致性套件、upstream proposal 都在。任务简报里“无人定义记忆协议”的表述已过时（研究文档已把 memento 标为最接近者）。
- 因此 Trace 的差异化不在“协议/存储”，而在 **v1 缺失的治理字段与流程**：`kind/subject/confidence/expiry/sensitivity/status/supersedes/auditRef`、冲突裁决、遗忘证明、召回评测、浏览器，以及 Allow/Seek/Snip 的组合。
- 商业上个人免费、团队/企业卖“共享记忆 + 审计导出 + 保留/隔离策略”，不卖云端记忆仓库；最大风险是**官方内置 `ctx.memory`**，其次是投毒/隐私（见 §7/§11）。

## 1. 名字与可用性
| 候选 | npm 包 | 2026-11-20 实测 | 判断 |
|---|---|---|---|
| **Trace** | `dsh-trace` | registry **404**；GitHub `PerryLink/dsh-trace` 公开 **404** | **选**。语义=“记忆痕迹/审计轨迹”，贴合 provenance |
| Recall | `dsh-recall` | **200**，0.3.0（Relistencode，会话历史召回） | 正面冲突，弃 |
| Memo | `dsh-memo` | **200**，0.13.2（lesliechowsh，会话记忆检索） | 正面冲突，弃 |
| Past | `dsh-past` | registry **404** | 备选；但像“历史会话”，治理感弱 |
| Memento | `dsh-memento` | 200，0.5.32；PerryLink 现有品牌 | 不作新产品名；作为**前代/迁移源**保留 |

- 风险：DSH 官方工具已有 `session_trace` / `session_event_trace`（`docs/tool-catalog.md:43`），npm 还有 `dsh-trace-extension`、`@vibeinging/dsh-trace-viewer`。**“trace=调用追踪”的歧义真实存在**。锁定语义：所有文案用 **“Trace · 记忆溯源”**，关键词只打 `memory/provenance/audit/forget`，CLI 用 `dsh trace memory ...` 而非裸 `trace`。
- 不建议叫 `dsh-memory`：memento README 明确说该名是“deleted legacy name”；且与多个 `ctx.memory` 实现冲突。

## 2. 问题、用户、一句话
**问题**：跨会话时 Agent 要么从零开始（用户重复解释约束），要么“记得”却没有来源、无法纠错/遗忘；团队无法回答“Agent 到底记住了什么、谁批准的、离职后还在不在”。
**一句话**：Trace 是 DSH 的**可审计长期记忆**——记住决策/偏好/约束，每条都可溯源、可审批、可过期、可冲突裁决、可遗忘、可导出、可评测。
| 用户 | 场景 | 最关键诉求 |
|---|---|---|
| 个人 | 长期项目/多仓开发者、顾问；一个 DSH profile | 少重复解释；记错能改；隐私可控 |
| 团队 3–50 人 | 共享 workspace 约定/决策/踩坑 | 共享但不串味；管理员可审；成员离职可回收 |
| 企业 | 受监管/安全敏感 | 租户隔离、保留策略、审计导出到 SIEM、DLP；**v1 只做设计约束，不宣称合规认证** |

## 3. 范围与非目标
| 做（v1） | 不做（明确非目标） |
|---|---|
| profile 内跨会话记忆；scope=user/workspace/preset/team | 向量数据库、通用 RAG、文档知识库（Seek/Library 的职责） |
| 显式写入 + 审批 + compaction/剪贴板**提案** | 自动抓网页/自动把整段会话摘要写成事实 |
| 带引用的按需召回 + 预算 + `why` | 云端记忆托管、多租户 SaaS、自建同步中继 |
| TTL/衰减、冲突/supersede、软/硬遗忘 | 替换 session log / compaction；模型微调 |
| 浏览器、CLI、Agent tools、JSONL/MD 导出 | 秘密存储（只存 `credentials` 指针）；跨设备同步（v2） |

## 4. 架构
### 4.1 总览
- **Host seam**：`ctx.memory`（Trace 拥有；协议 v1 + Trace Profile）；`ctx.memoryTrace`（只读审计/评测面，供 UI/CI/其它插件）。MVP 内置 SQLite provider；`ctx.memory.useProvider()` 预留给第三方（v1.1），避免再出现多个不兼容 `ctx.memory`。
- **存储**：`node:sqlite`，WAL，文件 `0600`，默认 `$DSH_HOME/dsh-trace/memory.db`；表：`records / record_versions / sources / edges / recalls / audit_events / tombstones / policies / tenants`。FTS5 索引 `subject+text+tags`。
- **写路径**：`tool/CLI/UI → ctx.memory.write → 分类/策略 → Grant → approval → 冲突检测 → SQLite 事务 → audit_events(链) → projection`。
- **读路径**：`agent/pre-step`（可选）或 `memory_recall` → `search` → 过滤/排序/预算 → 带 `recordId + source.ref` 的冻结片段注入。
- **Client**：Trace 面板（收件箱/记录/冲突/审计/设置）；聊天里的引用 chip 可点回原会话。
- **Agent tools**：`memory_remember`、`memory_recall`、`memory_forget`、`memory_why`。
- **CLI**：`dsh trace list|search|why|forget|export|import|conflicts|expire|eval|audit|policy`。

### 4.2 MemoryRecord（Trace Profile v1）
```ts
type MemoryRecord = {
  id: string; version: number          // 稳定 id；每次变更自增
  owner: string; tenantId?: string     // 个人/团队/企业隔离键
  kind: 'decision'|'preference'|'constraint'|'fact'|'lesson'|'entity'
  subject: string                      // 归一化主题键，如 "repo:dsh/pkg" / "tool:pnpm"
  text: string                         // 一条可独立判断真假的陈述（v1 的 claim）
  scope: 'user'|'workspace'|'preset'|'team'; scopeKey: string
  source: { kind:'session'|'file'|'clipboard'|'manual'|'import'|'agent'
            ref: string; quote?: string; hash: string }  // ref=sessionId:seq / path:line / clip://id
  confidence: number                   // 0..1；来源先验 + 用户确认，不静默衰减
  sensitivity: 'public'|'internal'|'private'|'secret'
  status: 'proposed'|'active'|'superseded'|'expired'|'forgotten'
  consent: 'explicit'|'approved'|'auto'|'imported'
  createdAt: number; updatedAt: number
  validFrom?: number; expiresAt?: number
  lastRecalled?: number; recallCount: number
  supersedes?: string[]; supersededBy?: string; conflictOf?: string[]
  auditRef: string                     // trace://event/<id>；哈希链定位
  tags?: string[]
}
```
- **兼容**：wire 层保留 memento v1 的 `track/scope(user-global|workspace)/workspaceKey/agentKey/text/source:string/tags/version/时间戳/recallCount/sessionId`；Trace 的 `scope(user|workspace|preset|team)` 映射到 `track+scope+agentKey`，其余 Trace 字段是**可选扩展**（`trace` 对象）。导出/导入支持 `memory-export-v1` 与 `trace-export-v1`，旧库一次性迁移。
- `secret` 分类结果 **不落库**：`write` 返回 `SECRET_REJECTED`，只在审计里留“拒绝写入 + 来源 ref”，不存原文。

### 4.3 `ctx.memory` 协议（v1 + Trace Profile）
```ts
interface MemoryService {
  readonly protocol: 'dsh-memory-protocol/v1'
  readonly profile: 'trace/1'
  readonly capabilities: ReadonlySet<'write'|'search'|'forget'|'export'|'trace'>
  write(input: MemoryDraft, ctx: WriteCtx): Promise<MemoryRecord>   // 审批门在服务内部
  search(q: SearchQuery, ctx?: ReadCtx): Promise<SearchResult>      // 无审批，硬预算
  forget(id: string, o: {mode:'soft'|'hard'; reason: string}, ctx: WriteCtx): Promise<ForgetResult>
  export(o: {format:'jsonl'|'md'|'bundle'; scope?: string; audit: boolean}): Promise<ExportEnvelope>
  explain(id: string): Promise<TraceEvent[]>       // 来源/审批/召回/冲突/遗忘时间线
  verify(): Promise<AuditReport>                   // 重算哈希链，报告断点
  budgets(scope?: string): BudgetRow[]
  useProvider?(p: MemoryProvider): Disposer        // v1.1
}
```
规则：① 一条记录只有一个 owner；跨 scope 不复制，用 `scopeKey` 路由；② 任何 `write/forget` 必须带 `WriteCtx{agent,sessionId,callId,signal,grantRef?}`，缺 agent 写失败封闭；③ 所有响应带 `auditRef`；④ 协议版本只在必填字段/错误语义变化时升级，Trace 字段纯增量；⑤ 读到 `STORE_UNSUPPORTED_VERSION` 响亮拒绝，绝不盲读。

### 4.4 写入策略：何时记、谁批准
| kind | 默认 | 触发 | 批准人 | 有效期/复核 |
|---|---|---|---|---|
| `constraint` | `ask` | 用户明说“必须/不要”；规则文件 | 个人用户；团队需 admin | 不过期；每 90 天复核 |
| `decision` | `ask` | “我们选 X，因为 Y” | 用户；团队 admin | 不过期；90 天复核 |
| `preference` | `ask`；显式用户陈述可 `auto`* | “以后都用 pnpm” | 用户 | 180 天 |
| `fact` | `ask`；可信文件+Grant 可 `auto`* | 文件/命令/会话证据 | 用户 | 90 天 TTL |
| `lesson` | `ask` | 失败、纠正、复盘 | 用户 | 不过期 |
| `entity` | `ask` | 人/项目/服务 | 用户 | 180 天 |
\* `auto` 仅当 Allow 的 `Grant{capability:'memory.write', kind, scope, sensitivityMax:'internal', expiry≤30d}` 存在；否则一律走审批。企业版由策略管理员定义 kind 白名单，`sensitivity>=private` 可要求双人审批。**Agent 不能批准自己的写**；`approval` 无 answerer 时失败封闭。
- 写入流水线：**规范化 → 敏感分类 → 策略/Grant → 预算预检 → 审批（预览 claim/source/scope/expiry/diff）→ 同 subject 冲突检测 → 事务落库 → 审计链 → projection**。任何一步失败零部分写入。
- 何时**不**记：一次性任务状态、可从代码/文件直接读的事实、秘密、未经验证的网页断言、他人隐私、已经被 forget 的 hash。
- 自动捕获只做**提案**：compaction 摘要、剪贴板“存为记忆”、会话结束候选，进入 `proposed` 收件箱，不直接 `active`。

### 4.5 检索
- **索引**：SQLite FTS5（BM25）+ 结构化过滤（kind/scope/status/minConfidence/sensitivity）；可选 embedding provider 做**内存内余弦**重排（不引入向量数据库，memento 已有 `ctx.memoryRetrieval`/`ctx.memoryEmbedding` 缝）。
- **排序**：`score = 0.55*BM25_norm + 0.20*confidence + 0.15*scopeMatch + 0.10*recency - stalePenalty`；`recency=exp(-age/90d)`；`recallCount` 只做小幅 boost（防“越常被召回越被召回”）。
- **预算**：默认每轮 ≤8 条 / ≤1,200 token；按 scope 配额（user 3 / workspace 5 / team 2）；超预算按 score 截断并标明 `truncated`。
- **模式**：默认 `on-demand`（工具/面板）；可选 `session-start` 只注入 `constraint` + 高置信 `preference`（≤5 条）；`private` 默认不自动注入，`secret` 永不注入。
- **引用**：每条注入带 `[mem:<id>]` + `source.ref`；`why` 返回分数分量、命中的 query、被过滤原因（过期/冲突/低置信/预算）。

### 4.6 衰减与冲突
- **衰减只作用于“时效/排序”，不改写 `confidence`**：`fact` 到期 → `expired`（不删除）；`decision/constraint` 到期 → 进复核队列，不静默失效。
- **同 subject 合并**：claim 相同 → 合并证据、`confidence = min(0.99, c + 0.03)`、更新 `updatedAt`；claim 不同 → 新记录 `proposed` + `conflictOf`，旧记录保持 `active`，**绝不静默覆盖**。
- **冲突裁决**：UI 并排显示两条的 source/quote/confidence/时间；用户选 keep-old / supersede / merge / scope-split；结果写 `edges` 与审计。未裁决的冲突**不进入自动注入**，搜索可见并标注。
- **supersede**：新记录 `supersedes:[old]`，旧记录 `status='superseded'`、`supersededBy=new`；历史仍可 `explain`。
- **遗忘**：`soft` = 删除 text/quote、保留 id/hash/reason/审计（可撤销 7 天）；`hard` = 清除 text/quote/索引，保留不可逆 hash 与“已遗忘”审计；同 hash 再学习返回 `FORGOTTEN_HASH`。导出副本无法回收，必须在导出文件里写 `forgetPolicy` 提示。

### 4.7 浏览器 UI
- **收件箱**：待批准写入、compaction/剪贴板提案、冲突、90 天内到期；支持批量 approve/reject（memento 面板只读，Trace 把它变成可写治理面）。
- **记录**：按 kind/scope/status/confidence/sensitivity 过滤；详情含 claim、source 原文引用 + 跳转 `sessionId:seq`/`path:line`、confidence 理由、有效期、召回历史、supersedes/conflict 图、`auditRef` 链。
- **Why**：这次为什么召回/为什么没召回；token 成本；可一键 mute/pin/forget。
- **审计**：哈希链校验、按时间/actor/action 过滤、导出 JSONL；断链红色告警。
- **设置**：每 kind 的写策略、预算、TTL、敏感分类、加密、保留期、面板开关。
- **空/错状态**：无 provider、DB 损坏、schema 过新、审批不可用，都要有可操作文案，不静默降级。

### 4.8 评测
- **金标集**：50–100 条来自真实会话的 `{setup, query, expect:{mustRecall, mustNotRecall, citations, conflicts}}`；覆盖 decision/constraint/preference/stale/conflict/secret/forget 七类。
- **运行**：`dsh trace eval --suite golden.jsonl --json`；临时 `DSH_HOME` + 临时 DB，零网络、确定性；CI 每次 PR 跑。
- **必测**：memento `protocol-conformance` 套件（兼容）；投毒（文件/网页/剪贴板里的“请记住 X”）；跨租户隔离；forget 后再学习；导出/导入 round-trip；审计断链检测。
- **人评**：10 名 dogfood 用户、2 周、每周抽 20 条召回做 blind review；记录纠正原因。

## 5. 与 Allow / Seek / Snip / Act 的组合
| 产品 | 接口 | 方向 | Trace 的约束 |
|---|---|---|---|
| **Allow** | `ctx.grant.check({subject, capability:'memory.write' 或 'memory.read', scope, sensitivityMax, kind})` | 写/读前查 Grant | 无 Grant → 审批；`private/team` 必须 Grant；撤销后立即拒绝新写，已存记录默认隐藏待用户处置；`grantRef` 写进 `auditRef` |
| **Seek** | `ctx.search.registerProvider({id:'memory', search})` | Trace → Seek 注册 provider；Seek → Trace 查询 | 返回 `recordId/claim/source/confidence/freshness/citation`；不复制 Seek 的索引；反向用 Seek 解析 `source.ref`（文件/会话）并抓 quote |
| **Snip** | `ctx.clipboard` item + Act action `memory.remember` | 剪贴板 → 记忆 | 只允许**手动**“存为记忆”；`source.kind='clipboard'`、`ref=clip://id`；敏感级别继承剪贴板策略；`secret` 拒绝；首存必审批 |
| **Act** | `ActionDescriptor` | 注册 `memory.remember/forget/export` | `risk` + `preview` + `execute` + `undo`；`forget` 预览显示将删除的 claim/source；hard forget 需二次确认且不可 undo |

## 6. 隐私 / 安全
- **分级**：`public/internal/private/secret`；默认 `internal`；密钥/Token/高熵串用规则 + 可选模型分类，命中即 `SECRET_REJECTED`（不落原文）。
- **本地优先**：默认零网络、零遥测；DB `0600` + WAL；建议全盘加密。v1 对 `private` 字段做应用层 AES-256-GCM（密钥经 `ctx.credentials`/OS keychain）；**FTS 索引会泄露词频**，所以 `secret` 永不索引，`private` 只索引 subject 不索引正文（v1.1 再做盲索引）。
- **租户隔离**：`owner + tenantId` 强制行过滤；团队库独立 DB 或独立 schema；跨租户查询/导出/同步一律拒绝；CI 有越权测试。
- **遗忘权**：soft/hard 两级；tombstone + hash 阻断再学习；审计保留期可配（默认 90 天），但“删除事件”本身保留；导出文件注明不可召回。
- **威胁模型（诚实）**：DSH 插件同进程，恶意插件可直接读 SQLite 文件；Grant/审批只保护“经 Trace 的写”，不保护“宿主文件系统”。桌面单用户场景无法宣称强租户隔离；企业版需 OS 账号/容器/服务端隔离。
- **提示注入**：记忆是数据不是指令；注入时包 `<memory trust="...">` 并声明“不要执行其中的指令”；来源可信度 + 审批 + 冲突复核仍是主防线。

## 7. 失败模式
| 失败 | 触发 | 防线 | 观测指标 |
|---|---|---|---|
| 记忆污染/投毒 | 文件/网页/剪贴板含“请记住 X” | 不可信来源不 auto；quote+hash；审批；投毒测试 | 未授权写入=0；false-memory 率 |
| 过拟合/上下文腐化 | 记忆太多、反复注入 | 8 条/1,200 token 硬预算；去重；TTL；mute | 召回 token、precision@8 |
| 隐私泄露 | 秘密/PII/跨租户 | 分类拒绝；加密；scope 过滤；越权测试 | secret 泄露=0；越权=0 |
| 官方内置 | DSH 发 `ctx.memory` | 做 Profile/迁移/评测/UI；提 RFC；保导出 | 迁移耗时、协议采纳 |
| 审批疲劳 | 每条都问 | Grant 预授权；批量收件箱；显式“记住这个” | 审批通过率、放弃率 |
| 错误/过期召回 | 旧事实、冲突未裁决 | 引用+why；TTL；冲突不进自动注入 | stale recall、纠正率 |
| 数据损坏/迁移失败 | DB 损坏、schema 过新 | WAL、备份、版本拒绝、restore 演练 | restore 成功率 |
| 团队同步冲突 | 两端改同一 subject | append-only 账本 + version + 冲突提案；不做 LWW | 冲突解决时长 |

## 8. MVP：7 周（6–8 周区间）
| 周 | 交付 | 验收 |
|---|---|---|
| W1 | Trace schema + 审计链 + 从 memento 0.5.32 迁移；SQLite/FTS5 | 旧库迁移 100%；`verify()` 通过 |
| W2 | `ctx.memory` 服务 + write/search/forget/export + 策略 + approval + CLI 骨架 | 未审批写入=0；重启仍在 |
| W3 | 检索/排序/预算/引用/`agent/pre-step` + `why` | p95 <50ms；≤1,200 token |
| W4 | 面板：收件箱/记录/详情/冲突/审计/设置；聊天引用 chip | 10 条真实记忆可审/可忘/可导出 |
| W5 | TTL/衰减/冲突/supersede + 敏感分类 + soft/hard forget | 冲突不静默覆盖；forget 后不召回 |
| W6 | 评测 harness + 50 条金标 + 投毒/租户/round-trip 测试 | precision@8 ≥0.85；secret=0 |
| W7 | 打包/文档/迁移指南/10 人 dogfood/npm 发布 | 7 日留存；0 P0 |
| W8（stretch） | 团队共享 scope alpha + 加密 bundle 导出 + 上游 RFC | 2 个团队试用 |

## 9. 指标 / 验证
| 指标 | 目标 | 口径 |
|---|---|---|
| 召回准确率 precision@8 | ≥0.85 | 金标集 + 人评 |
| 召回命中率 hit rate | ≥0.80 | 该召回的场景实际召回 |
| 过期召回率 | ≤5% | 召回中 `expired/superseded` 占比 |
| 用户纠正率 | ≤10% 且逐月下降 | edit/forget/supersede / 100 次召回 |
| 遗忘成功率 | 100% | forget 后 20 轮不召回 + 同 hash 拒绝再学习 |
| 未授权写入 / 无来源记录 | 0 / 0 | 审计扫描 |
| 秘密泄露 | 0 | 投毒+secret 金标 |
| 本地检索 p95 | <50ms | 1 万条、单机 |
| 导出/导入 round-trip | 100% | 含审计链 |
| 留存 | 7 日 ≥40%，30 日 ≥25% | dogfood 10 人 |

## 10. 打包 / 变现
| 版本 | 价格 | 内容 |
|---|---|---|
| **Free** | ¥0 | 个人本地全功能：记录/检索/浏览器/遗忘/导出/评测 CLI；Apache-2.0 core |
| **Pro** | ¥39/月 或 ¥299/年 | 加密跨设备同步（BYO S3/git，v2）、多 profile、保留策略、审计导出增强 |
| **Team** | ¥69/人/月 | 共享 workspace/team scope、管理员策略、审批收件箱、团队审计导出 |
| **Enterprise** | 年付定制 | 本地/私有部署、租户隔离、SIEM 导出、DLP、安全评审、支持 |

- 不卖“记忆存储量”；卖**治理与证明**。个人免费建立协议采用；团队/企业为审计、隔离、保留付费。
- 所有版本 README/关于页/`--version` 标注：**Not affiliated with DeepSeek**；核心协议/导出格式保持开放，避免锁定。

## 11. 风险 / 开放问题
1. **官方内置**：DSH 若发 `ctx.memory`，Trace 是否还能存在？答：做 Profile + 迁移 + 评测/UI；现在就把 `dsh-memory-protocol/v1` 的 upstream proposal 接过来，别等。
2. **与 memento 的关系**：Trace 是继任者还是并列？建议继任：`dsh-trace` 吸收 memento 0.5.32（Apache-2.0，同作者），提供 `dsh-memento` 导入，不长期双包并存。
3. **`memory/*` 会话事件未入宿主白名单**：memento 只能用 approval pair + 自有账本审计；Trace 需要上游加类型或允许 `ignorable` append，否则审计链是“插件自证”。
4. **加密 vs 可检索**：字段加密会破坏 FTS；v1 用“secret 不存、private 不索引正文”的折中，是否够？
5. **团队同步后端**：BYO S3/git 的冲突/权限/密钥轮换谁负责？是否值得做托管中继？
6. **抽取质量**：MVP 不做 LLM 自动抽取，只做显式写入 + 提案；用户是否嫌“记得不够自动”？
7. **遗忘 vs 审计保留**：GDPR 删除与审计不可篡改冲突；tombstone 保留多久、谁可 purge？
8. **命名歧义**：`trace` 在 DSH 已指 session tracing；若 SEO/心智争夺过大，是否切 `Past`？
9. **定价**：记忆是“隐形价值”，团队是否愿为审计付费？先用 5 个团队访谈验证。

## 12. 证据
- npm（2026-11-20 实测）：`https://registry.npmjs.org/dsh-trace` **404**；`/dsh-past` **404**；`/dsh-recall` **200**（0.3.0，Relistencode）；`/dsh-memo` **200**（0.13.2，lesliechowsh）；GitHub `https://github.com/PerryLink/dsh-trace` 公开 **404**。npm search `https://www.npmjs.com/search?q=dsh-trace` 还返回 `dsh-trace-extension`、`@vibeinging/dsh-trace-viewer`。
- `dsh-memento` 0.5.32（2026-11-18，Apache-2.0）：`https://www.npmjs.com/package/dsh-memento/v/0.5.32`；协议 `https://github.com/PerryLink/dsh-memento/blob/main/docs/protocol-v1.zh.md`；类型 `https://github.com/PerryLink/dsh-memento/blob/main/types.d.ts`；上游提案 `https://github.com/PerryLink/dsh-memento/blob/main/docs/upstream-proposal.zh.md`；一致性套件 `https://github.com/PerryLink/dsh-memento/tree/main/test/protocol-conformance`；`ctx.provide('memory')` 见 `https://github.com/PerryLink/dsh-memento/blob/main/index.mjs#L1108`。
- DSH `0.2.2-rc.4` / `ca33fd6843`：`package.json`；`docs/subsystems/approval.md`；`packages/plan/plan-mode/src/index.ts:213`（`agent/pre-step`）；`docs/tool-catalog.md:43`（`session_trace`/`session_event_trace`）；`packages/session-query/session-query-sqlite/src/schema.ts:127`（`node:sqlite` FTS5 先例）；`docs/capability-seams.md` 无 `ctx.memory`（checkout `docs/`+`packages/` grep 无命中）。
- 研究：`01-research/dsh-os-primitives-2026-11-20/10-context-memory.md:9`（官方无内置、321 插件、memento 位置）、`:78`（可审计记忆原语）、`:128-160`（MVP/指标）；`OS-PRIMITIVES.md:51,70,83-106`；`01-search-index.md`（Seek 证据层）；`03-clipboard-selection.md`（Snip 隐私六条）；`08-permission-audit.md`（Grant 账本）。
- 官方：产品能力清单 `https://www.deepseek.com/harness/zh/`；Discussion #218 `https://github.com/deepseek-ai/deepseek-harness/discussions/218`；独立媒体“可能快有了” `https://deepseekv4pro.com/news/deepseek-harness-agent-team-cross-session-memory`。
- 生态快照：`https://awesome-dsh-plugin.com/`（2026-10-28 7,557 条；memory 321）。
- 说明：`dsh-trace` 的 GitHub 公开 404 不等于永不可用；npm 发布前再查一次。本文价格为假设，需访谈验证。
