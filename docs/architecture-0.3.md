# dsh-os 长期架构：从 73 个工具到“一个能力面”

> 结论日期：2026-11-21
> 输入：11 份架构研究（[`01-agent-surface`](01-agent-surface.md) … [`11-ecosystem`](11-ecosystem.md)）
> 性质：**决策记录 + 目标架构 + 迁移路线**，不是又一个补丁清单。

## 0. 一句话

**模块继续小而美；把“能力”从“工具”里抽出来，做成一份可检索、可授权、可恢复、可负担的能力图；模型只看到 5 个固定动词 + 当前任务需要的 3–5 个能力。**

不是把 73 个工具改得更好，而是让 73 个工具**不再是模型界面**。

## 1. 问题不在“数量”，在“平面”

当前每个模块直接注册 3–9 个 agent tool，结果：

- 73 个工具平铺，模型要自己选；5 个意图测试只有 1 个唯一正确。
- 每个工具各自定义返回/错误/权限，116 种 error code、5 种信封。
- 写动作被拒后没有 request 通道；AI 停在 `grant_required`。
- 默认全量结果；`backup_snapshot` 一次 64.8k tok。
- 人类 2/5；AI 无人监督 30/100。

**根因：工具面 = 模块 API 的投影，而不是能力的决策界面。**

## 2. 目标架构（五层）

```
L4  Evals       场景库 / 指标 / CI / 人类可用性
L3  Surfaces    Agent Gateway (5 verbs) | Human Console | MCP/A2A
L2  Capabilities  capability graph (descriptors + handlers)
L1  Kernel       registry · permission broker · result/error · audit
L0  Host         DSH services, tools, sandbox, sessions
```

### L1 Kernel：薄，但唯一

新包 `@perrylink/dsh-os-kernel`，职责只有五件：

1. **Capability Registry**：注册/检索/解析/调用；按 risk/tag/capability 过滤。
2. **Permission Broker**：Request → Approval → Grant → use；模型不能批准。
3. **Protocol**：`OsResult`、`OsError`、`Handle`、`AuditEvent`。
4. **Audit**：谁、在哪个 session、用什么 capability、结果、耗时、费用。
5. **Projection**：把 capability 投影成 agent tool / CLI help / MCP tool / handbook。

Kernel 不实现业务；业务仍在各模块。Kernel 代码预算 ≤1,500 行，零运行时依赖。

### L2 Modules：只声明一次

每个模块提供 `capabilities.js`（或 `capabilities.json`），不再手写 tool 定义：

```js
export default [{
  id: 'snip.search',
  title: 'Search clipboard history',
  summary: 'Find a previously copied item by text, app or time.',
  whenToUse: 'The user refers to something copied earlier, or asks to reuse a clipping.',
  whenNotToUse: 'The user wants the current clipboard content; use snip.capture or context.snapshot.',
  input: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', maximum: 20 } }, required: ['query'] },
  output: { type: 'object', properties: { items: { type: 'array' }, page: { type: 'object' } } },
  risk: 'read',
  permissions: ['clipboard.read'],
  cost: { tokens: 800, latencyMs: 50, money: 0 },
  idempotency: 'supported',
  examples: [{ args: { query: 'invoice', limit: 5 }, result: { items: 1 } }],
  errors: ['E_INVALID_ARGUMENT', 'E_UNAVAILABLE'],
  handler: async (args, ctx) => { /* existing service call */ },
  version: '0.3.0',
  tags: ['clipboard', 'search'],
}]
```

Descriptor 是**唯一事实源**；tool schema、CLI help、MCP tool、handbook 都从它生成。

### L3 Agent Gateway：5 个固定动词

模型默认只看到这 5 个（加 1 个 status）：

| 动词 | 作用 | 返回 |
|---|---|---|
| `os_find` | 意图 → top-k 能力卡（默认 5，最多 10） | `{items:[{id,title,summary,risk,permissions,cost,example}], total}` |
| `os_do` | 执行已解析的 capability；支持 `preview:true` | `OsResult` |
| `os_request` | 为写/危险/网络动作创建 pending request | `{requestId,status,reason,approvalHint}` |
| `os_observe` | 查 request/job/handle 状态 | `{state,result?,progress?}` |
| `os_help` | 任务级指引（3–5 步 + 工具 + 风险 + 示例） | `{steps:[...], capabilities:[...], risks:[...]}` |
| `os_status` | 装了哪些模块、健康、版本、权限 | `{modules,health,version}` |

**渐进暴露**：`os_find` 只回 top-k；高频能力可在后续通过“pinned tools”直接暴露，但默认不摊开 73 个。

**为什么不是 code mode**：typed SDK + 模型写代码适合复合任务，但把代码沙箱变成硬依赖；作为第二投影（`os_do` 的 batch/code 模式）保留，不做唯一入口。

### L4 Human Console：审批、时间线、预览、健康

- **Approval Inbox**：谁请求、要做什么、影响范围、风险、diff、批准/拒绝/收窄/一次性/记住；失败行凭 `approvalRequestId` 直达。
- **Activity Timeline**：按 session/agent 聚合 action→result→cost→approval；可筛/搜/导出。
- **Preview / Undo**：文件 diff、剪贴板、窗口布局、通知；不可逆动作明确拒绝。
- **Health**：模块版本、权限、最近错误、配额、doctor。
- CLI 同 API：`dsh-os approvals list/approve/deny`、`dsh-os activity`、`dsh-os doctor`。

## 3. 三个协议（必须一起做，不能只做 UI）

### 3.1 权限：Request 与 Grant 两段，CAS 交界

```
Request: requested → pending → approved | denied | expired
Grant:              granted → used | revoked | expired
```

- `approved` 与 `granted` 在同一 CAS 事务；不存在“批了没发”。
- 批准与执行绑定同一 `requestHash = H(descriptorHash + argsHash + scopeDigest)`。
- Grant 只能由带 proof 的 Approval 派生、只能收窄、执行前原子 `use()` 消费。
- 模型侧没有“批准”动词，不能传 `subject/approver/ttl`。
- `pending` 超时只 `expired`；没有“超时自动批准”。

### 3.2 结果：`OsResult`

```js
{
  schema: 'os.result/v1',
  ok: true,
  tool: 'snip.search',
  requestId, auditId,
  summary: 'Found 3 clippings matching “invoice”.', // ≤200 chars
  items: [...],                                    // ≤20
  page: { limit: 20, returned: 3, total: 3, hasMore: false, nextCursor: null },
  handles: ['dsh://snip/abc'],                     // ≤5
  truncated: false,
  warnings: [],
  cost: { tokens: 420, latencyMs: 38, money: 0 },
  next: [{ capability: 'snip.get', args: { id: 'abc' } }], // ≤3
  provenance: { source: 'snip', freshness: 'live', hash: '...' },
  data: { ... }                                     // ≤2KB
}
```

- >2KB 文本、二进制、>20 条列表、>4KB 对象 → `dsh://<kind>/<id>` handle。
- cursor 是服务端快照 + HMAC，默认 15 分钟。
- 长任务返回 `{job:{id,state}}`；`os_observe` 查进度。

### 3.3 错误：9 个主类 + 恢复字段

`E_INVALID_ARGUMENT / E_DENIED / E_NOT_FOUND / E_CONFLICT / E_UNAVAILABLE / E_LIMIT / E_STATE / E_TIMEOUT / E_INTERNAL`

```js
{ ok: false, error: {
  code: 'E_DENIED', subcode: 'grant_required',
  message: 'Writing this file needs a one-time Grant.',
  retryable: false,
  remediation: 'Call os_request with the same args, then wait for approval.',
  nextTools: [{ capability: 'os_request', args: { capability: 'act.fs.write', args: {...} } }],
  requestId: 'req_...', auditId: 'aud_...',
  details: { path: 'src/a.ts' }, // redacted
}}
```

旧 116 个 code 走 alias 表；contract 是唯一来源。

## 4. Act：统一动作总线

14 个内置动作：`fs.read/write/list/move/delete`、`shell.exec`（可选）、`http.fetch`（可选）、`clipboard.read/write`、`window.move/resize`、`notify.send`、`check.run`、`snip.capture`。

执行管线：

```
validate → authorize(Request/Grant) → preview(optional) → execute(sandbox/timeout)
→ verify → audit → undo token (if reversible)
```

- 每个动作声明 risk/permissions/idempotency/preview/undo。
- 路径 allowlist、env 清洗、网络默认关、子进程限制。
- 不可逆动作不发 undo token，明确拒绝 preview 以外的“撤销”承诺。
- Snip/Stage/Ring 等模块从“各自注册工具”变成“动作提供者”。

## 5. 安全模型

- **默认拒绝**：无 Grant 不执行写/网络/执行类动作。
- **污点**：剪贴板、文件、webhook、网页、MCP 返回标记 `tainted`；tainted 进入控制位（写/外发/执行）必须新鲜人工批准。
- **能力不可转授**，只能收窄；撤销级联。
- **审计不可用即拒绝**。
- **供应链**：安装时展示权限清单、provenance、更新 diff。

## 6. 可用性评测（把“好用”变成 CI）

10+2 场景（修测试、整理剪贴板、升级回归、证据链、环境排障、审批恢复、批量文件、窗口布局、通知升级、权限拒绝后继续 + 2 红队）。

指标：

- 任务成功率
- 首步工具选择准确率
- 失败后自助恢复率
- 无效调用率
- 上下文 tokens / 延迟
- 人类介入次数
- 安全违规数

基线：**30/100**（0/5 无人通过；首步 1/5；自助恢复 0/9）。
目标：0.3 **70** / 0.4 **85** / 1.0 **95**。

## 7. 迁移：12 个月，5 阶段

| 阶段 | 时间 | 做什么 | 兼容 |
|---|---|---|---|
| W0 冻结 | M1 | 停止新增手写 tool；建 descriptor schema/registry | 旧工具不变 |
| W1 双写 | M2–M3 | 模块加 `capabilities.js`；registry 投影新 tool；旧 tool 保留 | 旧名/参数/返回不变 |
| W2 灰度 | M4–M6 | `os_*` 网关按 profile 灰度；pinned tools 试运行 | 可回滚 |
| W3 alias | M7–M9 | 旧名 → capability id alias；错误/结果双写 | 旧调用方无感 |
| W4 墓碑 | M10–M12 | 删除旧 tool；文档/迁移指南 | 只保留 alias 表 |

分类（73 工具）：A 51 保留为 action/descriptor、L 9 保留 service-only、D 8 删除/合并、S 3 shell/CLI、X 2 兼容层。

## 8. 生态：DSH 插件 → MCP → A2A

- **原生**：DSH 插件，`ctx.*` 服务 + `dsh.os` manifest。
- **MCP server（首协议）**：tools + resources + MRTR 审批；stdio/HTTP + OAuth；先只读，后写。
- **A2A**：1 card / 12 skills；长任务 + 审批回调。
- Apps SDK 作为 MCP UI 渠道；skills 作为分发层。

## 9. 非目标

- 不再增加第 12 个原语；先把能力图做对。
- 不把 73 个工具继续摊给模型；不靠“更多工具”提升能力。
- 不做大单体；kernel 薄，模块独立。
- 不允许模型自批、超时自动批准、无审计执行。
- 不把 code mode 作为唯一入口；不把 MCP 当内部协议。

## 10. 最小垂直切片（验证架构，不是最终产品）

1. `@perrylink/dsh-os-kernel`：descriptor + registry + `os_find/os_do/os_request/os_observe/os_help/os_status`。
2. 把 **Act、Snip、Check** 三个模块改成 descriptor + handler，旧工具保留 alias。
3. `allow_request/allow_wait` + `dsh-os approvals` + Shell pending。
4. Act 内置 `fs.read/write/list`（Grant-gated）。
5. `evals/` 5 个场景，基线 30 → 首版目标 50。
6. 结果/错误 envelope 先在这三个模块生效；旧字段保留。

验收：**AI 修一个失败测试，人类只批 1 次；5 个场景成功率 ≥50%；上下文 ≤30k tok；0 安全违规。**

## 11. 文档索引

| # | 报告 | 关键决策 |
|---|---|---|
| 1 | [01-agent-surface.md](01-agent-surface.md) | 渐进暴露：5 固定 + 7–9 高频 + os_find top-k |
| 2 | [02-capability-registry.md](02-capability-registry.md) | descriptor 单一事实源；registry 薄层 |
| 3 | [03-permission-protocol.md](03-permission-protocol.md) | Request/Grant 两段；CAS；不可自批 |
| 4 | [04-result-protocol.md](04-result-protocol.md) | OsResult；handle/cursor/预算 |
| 5 | [05-error-protocol.md](05-error-protocol.md) | 9 主类；retryable/remediation/nextTools |
| 6 | [06-action-bus.md](06-action-bus.md) | 14 动作；preview/undo/audit |
| 7 | [07-human-oversight.md](07-human-oversight.md) | 审批收件箱 / 时间线 / 预览 |
| 8 | [08-eval.md](08-eval.md) | 10+2 场景；30→70/85/95 |
| 9 | [09-security.md](09-security.md) | 污点/默认拒绝/审计 |
| 10 | [10-migration.md](10-migration.md) | 5 阶段/12 个月 |
| 11 | [11-ecosystem.md](11-ecosystem.md) | DSH → MCP → A2A |
