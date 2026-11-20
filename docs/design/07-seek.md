# Seek（`dsh-seek`）：DSH 的统一证据检索层

> 对象：PerryLink（个人开发者，非官方；not affiliated with DeepSeek；dsh-locator / library / memento / capability_search）。
> 基线：DSH `0.2.2-rc.4`（checkout `ca33fd6`，2026-11-20），npm/GitHub 数据同日实测；**【事实】**有来源，**【提案】**是本设计。

## 0. 结论

- **名字**：Seek；包/命令 `dsh-seek`。`dsh-seek` 与 `dsh-gather` 在 npm 均 404；`dsh-find`、`dsh-search` 已被占用，故在给定候选中选 Seek。
- **一句话**：一次查询，跨文件、会话、文档、记忆、能力与网页，返回一份可核验、可引用、可审计的证据包。
- **MVP 4 周**（W1–W4），默认不扇出网页；网页 provider 仅 flag/alpha，不阻塞 0.1。
- **最大风险**：跨源权限泄露。provider 若“先取后滤”，或缓存跨 tenant 复用，一次事故就会摧毁“证据层”的信任。
- **三个事实**：DSH 有 6+ 可搜面却无跨源 query（`01-search-index.md:10`）；单库已商品化，官方 session-query 月下载 2,043,696（同文 `:72`）；DSH seams 中无 `ctx.evidence`（`docs/capability-seams.md` 全文 0 命中）。

## 1. 名字与可用性

| 候选 | npm 实测 | 判定 |
|---|---|---|
| **Seek** | `dsh-seek` **404**；GitHub `PerryLink/dsh-seek` **404** | **采用**：动词、单音节，和 Spotlight 同类；`seek` 裸包 0.3.0 是 2022 年无关包，不注册 |
| Find | `dsh-find` 0.2.1，888/月，in-conversation session find | 不用：语义撞“会话内查找” |
| Search | `dsh-search` 0.0.1，占名 “cross-session full-text search” | 不用：直接撞“跨会话检索”这一定位 |
| Gather | `dsh-gather` 404 | **备选**：若 Seek 商标/域名受阻再启用 |

**命名风险**：Seek 也是招聘品牌。缓解：UI 固定写 “DSH Seek”，包名始终带 `dsh-` 前缀；商标/域名未核查，付费版发布前补一次。生态里 `seek-on-dsh` 是像素桌宠，不是检索产品，无直接冲突。

## 2. 一句话 / 问题 / 用户

**一句话**：Search 给你页面，Seek 给你**能引用的证据**。

**问题**：DSH 的文件、会话、文档、记忆、能力、网页各有工具、语法、ACL 和打分口径。agent 每问一次要先猜“该用 `session_search` 还是 `grep`”，人要在几个面板间拼答案；结果不可比、重复多、引用不可核验。单库搜索已是红海；缺的不是第 9 个索引，是**检索总线 + 证据层**（`01-search-index.md:9-10`）。

| 用户 | 典型问题 | 要什么 |
|---|---|---|
| 重度用户 | “上周那个重试策略是谁定的？代码在哪？文档怎么说？” | 一次拿齐会话/代码/文档，带出处 |
| 研究者 | “这个结论我在哪读过？原文还在吗？” | provenance、freshness、可导出引用 |
| 企业 | “跨仓/团队文档里谁定义了这个口径？谁能看？” | ACL、审计、连接器、可撤销 |

非目标用户：只搜一个目录、只想要网页搜索的人——用 locator / web_search 即可。

## 3. 范围与非目标

| 做（In） | 不做（Out） |
|---|---|
| 跨源只读 query、融合排序、去重、分组、预算截断 | 重做文件索引/文件搜索（locator 是底座） |
| 统一 `ref`、`resolve`、freshness、permissions、citation | 做网页搜索引擎/爬虫（`ctx.web` 是 provider） |
| `ctx.evidence` seam、Agent tool、CLI、结果页 | 做向量库/embedding 服务（provider 内部可选） |
| 查询审计（不含正文）、provider 健康、eval | 做知识库/记忆系统的写入与治理 |
| 把结果接到 Act 动作；Nest 的 scope、Trace 的治理适配 | 自己执行写动作（写操作归 Act + Allow） |

**边界**：Seek 是**本地优先、只读的证据层**；v1 不自建大索引，只做短 TTL 缓存与 eval 留痕。找不到就返回空 + 警告，不猜、不编。

## 4. 架构

### 4.1 Host seam `ctx.evidence`

```ts
type Scope = 'files' | 'sessions' | 'docs' | 'memory' | 'capability' | 'web'
interface EvidenceProvider {
  id: string
  scopes: Scope[]
  search(q: ProviderQuery, signal: AbortSignal): Promise<ProviderHit[]>
  resolve?(ref: string, signal: AbortSignal): Promise<ResolvedRef>
  health?(): { ok: boolean; p95ms?: number; detail?: string }
}
interface EvidenceService {
  register(p: EvidenceProvider): () => void
  search(q: EvidenceQuery, caller: CallerContext): Promise<EvidencePack>
  resolve(ref: string): Promise<ResolvedRef>
  sources(): SourceStatus[]
}
```

`CallerContext = { sessionId, workspaceId, tenantId?, scopes, allowWeb, allowSensitive }`；`ProviderQuery` 只带归一化文本、时间范围、limit 和**不透明调用者上下文**，不带原始凭据。`EvidenceHit = { ref, provider, title, snippet, score, rank, sourceTime, observedAt, hash?, freshness, sensitivity, actions? }`；`EvidencePack = { query, generatedAt, groups, hits, citations, cost, warnings, truncated }`。持久对象（pack/savedQuery/provider 注册）统一带 `id, owner, scope, createdAt, updatedAt, expiresAt?, auditRef`。Host 侧用 Cordis service 注册（同 `storageDomain` 的 `provide` 形态，`packages/storage/storage-domain/src/index.ts:234`）；Client 侧不直连 provider，只消费 pack。

### 4.2 Provider 分工

| provider | 语料 / 调用 | 默认 | 权限来源 |
|---|---|---|---|
| `locator` | 文件/会话消息/符号；`locator_search` + `locator_resolve`（`ref://`/`dsh-session:`） | 开 | locator root + ACL |
| `session-query` | 实时会话；`ctx.sessionQuery.searchSessions`（`packages/session-query/session-query/src/index.ts:183`） | 开 | host workspace authority |
| `library` | 导入的 md/txt；hybrid + `[n]` 引用 | 开 | collection ACL |
| `memento` | 记忆；`ctx.memory` + `dsh-memory-protocol/v1` → `memory://`；可选 `memoryRetrieval` | 开 | v1 审批/审计 + 可见性 |
| `capability` | 工具/技能/插件；`capability_search` → `capability://` | 开（便宜） | 仅可见能力 |
| `web` | `ctx.web` search/fetch → `https://` | **关** | `allowWeb` + Allow `net` Grant |

locator 的 refs/resolve/freshness 已就绪（npm `dsh-locator@0.19.4` README；`ref://`、`locator_resolve`、`locator_cite`），Seek 不复制它的索引，只做归一化与融合。memento 0.5.32（2026-11-18）已有 `dsh-memory-protocol/v1`：双层双轨（user/agent × user-global/workspace）、写前审批门、可重建审计、字符预算、一致性套件、`ctx.memory`/`ctx.memoryAdapters`，并已提 upstream proposal；Seek 只按 v1 协议消费，不重造记忆层，任何写记忆仍走 v1 审批门。

### 4.3 Query planner

1. 归一化 query；解析 `scope:`/`since:`/`until:`/类型过滤；**不把自然语言翻译成 FTS 语法**，语法交给各 provider，避免“翻译即失真”。
2. 轻量意图路由：路径/文件名 → locator；谁/上次/决定 → sessions+memory；规范/怎么做 → docs；哪个工具/插件 → capability；URL/域名 → web（仅显式）。
3. scope 来自 Nest 的 workspace（root set + membership）；默认只查本 workspace；`web`/敏感源必须显式 opt-in。
4. 并行扇出；每 provider `limit = clamp(2×limit, 10, 50)`、800ms 超时、总预算 4s；跳过不健康 provider；每个请求带 `AbortSignal`。
5. `Promise.allSettled`：失败只降级该源，返回 partial pack + `warnings`；绝不让一个 provider 拖垮整次查询。

### 4.4 合并 / 排序 / 去重

- **RRF**：`rrf(d) = Σ_p w_p / (60 + rank_p(d))`；`w_p` 按意图 0.8–1.2，**按名次而非原始分数**融合，规避各库打分不可比。
- **去重**：`canonicalRef` 相同、`sourceId + contentHash` 相同、或同文档不同片段 → 合并为一组；保留最高分并集 snippets。
- **多样性**：每 provider 前 20 条最多占 5 条；按 source 分组；同一文件不同段落聚合，避免一个库刷屏。
- **预算**：`budgetChars` 默认 12k，按组截断并标 `truncated`；返回 `cost{providers,ms,chars}`。
- **可解释**：每 hit 带 `why`（命中词、provider 名次、freshness），排序不透明就不做“黑箱相关性”。

### 4.5 Refs / freshness

- 复用 locator 的 `ref://file?...`、`dsh-session:`；新增 `library://`、`memory://`、`capability://`、`https://`。
- `resolve` 返回 `status: fresh|stale|missing|tombstoned|unknown`、`checkedAt`、`hash`、`permissions`、有界 excerpt；**绝不静默替换**失效引用。
- 区分 `sourceTime`（文件 mtime / 会话事件时间 / 文档版本）与 `observedAt`（索引观测时间）；UI 分列显示，避免“新索引=新内容”的误判。
- 引用必须可点击回源；agent 输出引用时优先给 ref，而不是只给一段无法核验的摘要。

### 4.6 Client UI

- `/seek <query>` 命令（`ctx.commands`，`docs/capability-seams.md:773`）+ 侧栏结果页；三栏：facet（源/时间/workspace）/ 分组结果 / 预览。
- 结果卡：源图标、标题、高亮 snippet、freshness 徽标、provider 延迟；顶部显示各源健康与“部分结果”警告。
- 操作：打开、定位、复制引用（markdown/mention/json）、存入记忆、附加到当前对话、创建任务——全部走 Act 的 ActionDescriptor，不在 UI 里硬编码写逻辑。
- 空结果不是死路：提示可放宽 scope / 关闭时间过滤 / 显式开启 web；显示“哪些源被跳过及原因”。

### 4.7 Agent tool / CLI

| 名称 | 入参 | 返回 |
|---|---|---|
| `seek_search` | `query, scopes?, since?, until?, limit?, budgetChars?, includeWeb?` | 紧凑 EvidencePack + refs + warnings |
| `seek_resolve` | `ref` | status/hash/freshness/permissions/excerpt |
| `seek_sources` | — | provider 列表、scope、健康、最近错误 |
| CLI | `dsh-seek search/resolve/sources/eval` | 同上，支持 `--json` |

## 5. 与 Act / Trace / Nest 的组合

| 产品 | 接口 | Seek 的用法 |
|---|---|---|
| **Act** | `ActionDescriptor`（id/title/argsSchema/risk/preview/execute/undo） | 每个 hit 返回 `actions[]` 的 actionId+args；用户点“存入记忆/打开/建任务”时由 Act 预览、审批、执行；Seek 只提议，不执行。`seek.search` 本身也可注册为 Act 动作，供启动器调用。 |
| **Trace** | v1 之上的治理层（策略/审计/保留） | 记忆 provider 来自 memento 的 `dsh-memory-protocol/v1`；Trace 在其上做跨产品治理与审计；Seek 把 `evidence.query`/`evidence.resolve` 写入 Trace：query hash、provider ids、命中数、耗时、refs，**不写 snippet/正文**。 |
| **Nest** | workspace：id、root set、membership、生命周期 | Nest 注入默认 scope 与 `workspaceId`；跨 workspace 必须显式 `scope:all` 且 Nest 策略允许；结果按 workspace 标注，保存的查询也归属 workspace。 |
| **Allow** | `Grant`（subject × capability × scope × expiry） | 读默认走 provider ACL；`web`/`sensitive` 读取前查 Grant；Act 的写动作执行前由 Act 查 Grant。Seek 不自己发明权限规则。 |

## 6. 权限 / 隐私

| 源 | 默认 | 边界 / 失败 |
|---|---|---|
| files | 本 workspace roots | 拒绝 `..`/symlink 逃逸；越界即 deny，不靠后置过滤 |
| sessions | 同 workspace | 跨 workspace 默认拒绝；是否含当前会话由策略决定 |
| docs | 已导入 collection | 无 collection 权限 → 该 provider 不返回 |
| memory | memento v1 可见性 | 只读已批准记忆；不读原始链；审计由 v1 账本与 Trace 双层保留 |
| capability | 可见能力 | 隐藏工具/插件不得出现在结果 |
| web | **关** | 必须 `allowWeb` + `net` Grant；域名 allow/deny；出网留审计 |
| 敏感 | 不返回 secret | `.env`/密钥/凭据由 provider 排除；`sensitivity` 标记；UI 点击才展开；agent 需 `allowSensitive` + Grant |

- **不放大权限**：router 只传 caller 身份与 scope；provider 在**生成 snippet 之前**完成 ACL。禁止“先取回再过滤”。
- **缓存**：key = normalized query + caller/tenant + scopes + provider version；TTL 30–120s；绝不跨 tenant；审计不存正文；登出清空。
- **审计**：只记 query hash、provider、命中数、耗时、refs；支持 JSONL 导出；企业可接 Trace。
- **引用核验**：`resolve` 校验 hash；stale/missing 明确展示；不把旧摘要伪装成当前原文。

## 7. 失败模式

| 失败 | 表现 | 处理 |
|---|---|---|
| 排序质量差 | 好结果排后，用户回到单库工具 | 50 条标注集 + RRF 调权；默认分组展示；提供“仅原文/仅最近”模式；不隐藏低分来源 |
| provider 延迟 | 一个慢源拖住整页 | 800ms/provider、4s 总预算、并行、熔断、partial + warning；`seek_sources` 暴露 p95 |
| 口径不一致 | 文件 mtime、会话事件时间、文档版本混用 | 分列 `sourceTime`/`observedAt`；名次融合而非分数融合；每源单独解释 |
| 引用失效 | 文件被改/会话压缩/文档删除 | `resolve` 返回 stale/missing；UI 徽标；可选快照仅在企业保留策略下开启 |
| 权限泄露 | 跨 workspace/tenant 命中 | provider 侧 ACL、deny-by-default、跨租户缓存禁用、红队测试 |
| provider 故障/不注册 | 结果残缺 | 首方 5 个 provider 自带；第三方用 MCP bridge；`sources` 显示健康 |
| 网页注入 | 网页 snippet 带指令 | web 结果标 `untrusted`；只当数据；agent 不执行其中指令；默认关闭 |
| 结果过载 | 预算爆、token 贵 | 每源 cap、分组、12k 字符预算、`truncated` |

## 8. MVP：4 周

| 周 | 交付 | 退出标准 |
|---|---|---|
| W1 | `ctx.evidence` 契约 + locator（文件/会话）+ session-query + RRF + `seek_search/resolve/sources` + CLI | 20 条真实查询可跑；单 provider 故障不影响整体 |
| W2 | library / memento v1 memory / capability provider；ref 归一化、去重、scope/ACL 透传 | 5 个 first-party provider 注册；跨源重复 <10% |
| W3 | `/seek` 面板 + 引用/freshness UI + 超时/预算/熔断 + 50 条 eval + 权限测试 | top-5 含已知源 ≥85%；0 跨区泄露；p95 ≤2s（web 关） |
| W4 | Act 动作菜单、Trace 审计、Nest scope 适配；web flag alpha；文档/bundle/0.1 | 3 个 profile dogfood；0.1 发布；web 默认关 |

**范围控制**：web 与跨 workspace 不阻塞 0.1；语义 rerank、共享索引放 0.2。

## 9. 指标 / 验证

| 指标 | 目标（MVP） | 口径 |
|---|---|---|
| 查询数 / 周活 | 首月 2,000 npm 下载；≥30 周活 | npm + 本地匿名计数（opt-in） |
| ref 点击 / resolve | 每次 pack ≥0.8 次引用动作 | UI + tool 调用 |
| 跨源命中率 | ≥30% 查询命中 ≥2 个源；top-5 已知源 ≥85% | 50 条标注集 |
| 延迟 | p95 ≤2s（web 关）；单源超时 <5% | 本地基准 |
| 引用新鲜度 | resolve fresh ≥95% | `seek_resolve` 统计 |
| 去重 | 重复结果 <10% | eval 人工标注 |
| 工具调用下降 | 20 个任务上上下文查找调用 −40%，成功率不劣于基线 | A/B |
| 信任护栏 | 0 跨 tenant 泄露；stale 引用 <5% | 权限测试 + 审计 |

## 10. 打包 / 变现

| 层 | 内容 |
|---|---|
| 个人免费 | 本地 provider（files/sessions/docs/memory/capability）、基础引用、`/seek` 面板 |
| Pro（个人） | 证据板/导出、语义 rerank、长历史、跨设备同步（opt-in） |
| Team | 共享连接器、SSO/ACL、审计导出、保留策略、跨 workspace |
| Enterprise | 连接器网关（Confluence/Notion/Drive/SharePoint/Slack/Jira/GitHub/S3）、DLP、私有化、SLA |

- 打包进 `dsh-os-suite`（Act/Allow/Trace/Nest + Seek）；单卖 Seek 也可，但组合价值在“证据 → 动作 → 授权 → 审计”闭环。
- 护城河不是 UI，是 **evidence schema + refs/freshness + 50 条 eval + first-party provider 网络 + 跨产品集成**。
- 价格不做编造；先用 5 个设计伙伴验证“连接器/审计”哪个真付费。

## 11. 风险 / 开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 跨源权限泄露 | 致命（信任/合规） | provider 侧 ACL、deny-by-default、禁跨租户缓存、权限红队 |
| 排序质量不够好 | 用户回退单库 | 标注集、RRF、分组降级、可解释 why |
| 上游把统一检索做进 core | 定位被吞 | 把 `ctx.evidence` 协议捐给上游；做“最佳 provider + 兼容层” |
| provider 采用慢 | 覆盖不足 | 首方 5 个自带；第三方 MCP bridge，不改其代码 |
| 范围蔓延成搜索引擎/知识库 | 4 周做不完 | 守住非目标；写操作交 Act |
| 引用漂移 | 答案不可信 | resolve/hash/freshness；stale 明示 |

**开放问题**：① seam 叫 `ctx.evidence` 还是 `ctx.retrieval`，需 upstream RFC；② 统一 ref 是新建 `evidence://` 还是复用各源 scheme，resolver 归谁；③ 是否为引用保存快照（可核验 vs 隐私/保留）；④ 当前会话默认是否纳入；⑤ 跨 workspace 的企业语义（tenant/ACL/计费）；⑥ 连接器优先级与定价。前三个在 W1 定，否则后面会返工。

## 来源

- 研究底稿：[01-search-index.md](../dsh-os-primitives-2026-11-20/01-search-index.md)（`:9-10` 缺口、`:43-45` locator、`:72` session-query 下载、`:74` 竞品结论）；[OS-PRIMITIVES.md](../dsh-os-primitives-2026-11-20/OS-PRIMITIVES.md)（`:69` 评分）。
- DSH checkout `ca33fd6`：`package.json`（0.2.2-rc.4）；`docs/capability-seams.md:764` `ctx.sessionQuery`、`:773` `ctx.commands`、`:793` `ctx.approval`、`:804` `ctx.web`；`docs/tool-catalog.md:34/43/53`；`packages/session-query/session-query/src/index.ts:183`。
- npm：<https://www.npmjs.com/package/dsh-locator>（refs/resolve/cite）、<https://www.npmjs.com/package/dsh-memento>（0.5.32，`dsh-memory-protocol/v1`）、<https://www.npmjs.com/package/dsh-find>、<https://www.npmjs.com/package/dsh-search>、<https://www.npmjs.com/package/dsh-seek>（404）、<https://www.npmjs.com/package/dsh-gather>（404）。
- 上游：<https://github.com/deepseek-ai/deepseek-harness>；工具目录 <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md>。
