# 06 · Act — 统一动作总线（0.3）

> 2026-11-21 · 基线 dsh-os 0.2.0 / Act 0.1.1（`packages/act/index.js`）· 目标 Act 0.3.0
> 定位：**一个入口、一套描述、一条管线**；AI 只面对动作，不再面对 17 个包的 73 个工具。
> 非目标：工作流引擎、OS 沙箱实现、MCP 网关、替代 Allow / Check / Trigger 的领域逻辑。

## 0. 结论

- **14 个内置动作**（见 §3）；模块动作按 `<module>.<verb>` 注册，目标形态只暴露 3 个总线工具：`act_list` / `act_invoke` / `act_receipt`（0.3 过渡期 alias 见 §9）。
- 现状缺口：Act 只有 `echo/now/list` 三个演示动作（`index.js:67-108`），73 个工具里没有 `fs.read/write`、没有 `shell.exec`；宿主自带的 `read/write/bash` 又绕过 Act/Allow（可用性实测 WF1/WF2 均卡在“无写动作 + 无 Grant 申请”）。
- 管线固定为 **validate → authorize → preview → execute → verify → audit → undo token**；write 及以上无 Grant 不执行，danger 无预览不执行，不可逆动作不发 undo token。
- 迁移不是“把 73 个工具换个名字”，而是**把副作用收进动作**：旧工具降为 alias，经同一管线转发；保留 **2 个 minor 且不短于 6 个月**，0.5 删除。
- 诚实边界：Act 是控制面，不是沙箱；DSH 的 `ctx.sandbox` 只约束文件效果（`docs/subsystems/sandbox.md`），网络与进程可见性由 Act 策略层兜底，不能宣称内核级隔离。

## 1. 问题与约束（实测）

| 事实 | 证据 | 对设计的约束 |
|---|---|---|
| 73 工具 / 17 包，读多写少但权限面割裂 | 2026-11-21 以 fake ctx 挂载 17 包枚举：act 2、allow 1、backup 3、check 1、context 3、cost 3、help 3、nest 5、notify 3、os 3、ring 7、root 5、seek 3、snip 9、stage 8、trace 7、trigger 7 | 不能逐工具加审批；必须按 capability 批量授权 |
| Act 的 Descriptor 只用到 id/title/risk/parameters/execute；`preview/output/permissions` 未进模型，`undo` 只校验类型不执行 | `packages/act/index.js:24-52`；`undo` 仅存函数，无 token、无 TTL | Descriptor 要成为唯一契约，缺字段即注册失败 |
| 授权是死胡同 | `act_invoke` 只回 `grant_required`（`:186-204`）；Allow 只有 `allow_check`，`issue` 是 admin | authorize 阶段必须内建 Request/Grant 通道，模型不能自授 |
| 宿主已有 fs/shell 工具 | DSH `tool-fs`（read/write/edit/apply_patch）、`tool-bash`；seam 见 `docs/capability-seams.md:787-796` | Act 复用 `ctx.fs`/`ctx.subprocess`/`ctx.sandbox`，不重写；部署侧需关闭旁路工具 |
| 模块各自注册工具 | `packages/snip/index.js:43-158` 等 17 个包各自 `ctx.tools.register` | 模块改为“动作提供者”，`apply()` 不再注册实现型工具（只留薄 alias） |

## 2. ActionDescriptor（唯一契约）

```ts
type Risk = 'read' | 'write' | 'exec' | 'danger'
type Idem = 'pure' | 'keyed' | 'at-most-once' | 'none'

interface ActionDescriptor<A = unknown, R = unknown> {
  id: string                         // <domain>.<verb>，如 fs.write；全局唯一，注册即冻结
  title: string; description?: string; version: string   // semver + descriptorHash 用于 Grant 绑定
  input: JSONSchema                  // 严格：additionalProperties:false，拒绝未知字段
  output: JSONSchema                 // 结果必须可验证/可渲染，不能是 any
  risk: Risk                         // 仅作 UX 与默认闸门；真正拦截看 permissions
  permissions: {
    capability: string               // fs.read / fs.write / shell.exec / net.egress / clipboard.read / ui.window / notify.send / check.run
    scope: string[]                  // path:/abs/dir、host:api.example.com、cmd:npm、action:<id>；沿用 Allow 的 ':*' 前缀匹配
    grant: 'never' | 'once' | 'standing'   // read 默认 never；敏感 read 可 once
  }
  idempotency: Idem
  preview: { kind: 'diff' | 'plan' | 'effect'; build(a: A, c: ActionContext): Promise<Preview> } | 'unsupported'
  undo: { kind: 'restore' | 'inverse' | 'trash'; ttlMs?: number; run(r: ActionReceipt, c: ActionContext): Promise<UndoOutcome> } | 'none'
  cost: { usd?: number; tokens?: number; ms?: number; estimate?(a: A): Promise<{ usd?: number; ms?: number }> }
  examples: Array<{ title: string; args: A; expect?: string }>   // 至少 1 条，供 NL/面板/few-shot 共用
  limits?: { timeoutMs?: number; maxOutputBytes?: number; concurrency?: number }
  verify?(a: A, r: R, c: ActionContext): Promise<{ ok: boolean; checks: string[]; detail?: string }>
  handler(a: A, c: ActionContext): Promise<R>   // 只有总线能调用；模块不得把 handler 直接挂成 tool
}
```

- `ActionContext` 只给 `subject/sessionId/cwd/workspaceRoot/sandboxPolicy/signal/deadline/idempotencyKey/receiptId/resolveSecret(ref)`；**不暴露 `process.env`、`child_process`、原始 socket**，副作用必须走受控 adapter（`ctx.fs` / `ctx.subprocess` / Act 自带 http adapter），handler 不得直接 `import('node:child_process')` 或裸 `fetch`。
- 注册校验（相对 0.1.1 新增）：id 正则、schema 可编译、risk 合法、`permissions.capability` 与 risk 匹配（read 不得声明 `fs.write`）、`risk>=write` 时 `grant!=='never'`、`preview==='unsupported'` 时 risk 只能是 read（write/exec 需显式 `allowUnpreviewed`）、`undo==='none'` 时 `reversible=false`。重复 id 抛 `action_exists`，不做“后注册覆盖”。
- 兼容：保留 `parameters` 作为 `input` 的别名一个 minor；`execute` 作为 `handler` 的别名一个 minor；0.4 删除。

## 3. 内置动作集（0.3，14 个）

| id | 作用 | risk | permissions（capability / scope） | 幂等 | 预览 | 撤销 |
|---|---|---|---|---|---|---|
| `fs.read` | 读 UTF-8 文本 | read | `fs.read` / `path:` | pure | path、大小、编码；**不展示内容** | none |
| `fs.write` | 全量写或 patch | write | `fs.write` / `path:` | keyed（target+content hash） | unified diff + 前后 hash | restore 前一版；新建则删除 |
| `fs.list` | 列目录 | read | `fs.read` / `path:` | pure | 条目数/深度；不列隐藏文件 | none |
| `fs.move` | 移动文件/重命名 | write | `fs.write` / `path:src`+`path:dst` | keyed | 源→目标、覆盖策略、跨设备降级 | inverse move |
| `fs.delete` | 删文件（默认回收站） | danger | `fs.write` / `path:` | at-most-once | 文件树、总字节、回收站/永久 | trash restore；永久删除=`none` |
| `shell.exec` | 执行 argv（可选） | exec | `shell.exec` / `cmd:`+`path:` | at-most-once | argv、cwd、env diff、网络开关、timeout | none |
| `http.fetch` | GET/HEAD（可选） | read | `net.egress` / `host:` | pure | method/URL/host/header 摘要、响应上限 | none |
| `clipboard.read` | 读当前剪贴板 | read | `clipboard.read` / `*` | pure | 大小/hash；“内容将进入会话日志” | none |
| `clipboard.write` | 写剪贴板 | write | `clipboard.write` / `*` | at-most-once | 新旧摘要；含密钥则拒绝 | restore 上一份（1 步） |
| `window.move` | 移动窗口 | exec | `ui.window` / `action:window.move` | at-most-once | 目标 rect/display/DPI 校验 | restore 原 rect |
| `window.resize` | 调整窗口 | exec | `ui.window` / `action:window.resize` | at-most-once | 目标 w/h/最小尺寸 | restore 原 size |
| `notify.send` | 发通知 | write | `notify.send` / `channel:` | keyed（dedupeKey） | channel/title/body hash/收件人 | none |
| `check.run` | 跑一条 Check 任务 | exec | `check.run` / `task:` | keyed（task+env hash） | 任务/prompt 摘要、超时、预算 | none |
| `snip.capture` | 剪贴板入库 | write | `clipboard.capture` / `*` | none（内容 hash 去重） | “将读取当前剪贴板”；秘密脱敏 | forget 该 clip |

- **可选即默认关**：`shell.exec`、`http.fetch` 在配置 `allowShell/allowNetwork` 前 `available()=false`，`act_list` 显示原因而不是静默隐藏。新增 capability 词表（`shell.exec`/`ui.window`/`notify.send`/`check.run`/`clipboard.capture`）由 contract 0.3 增补，Allow 只做字符串匹配。
- `clipboard.*`、`window.*`、`notify.send`、`check.run`、`snip.capture` 是 **Act 内置描述符 + 模块适配器**：分别绑定 `ctx.snip` / `ctx.stage` / `ctx.notify` / `ctx.check`；模块缺失时动作 unavailable，不复制实现。注意 Snip 0.2 只有 capture/ledger、无 OS 写，`clipboard.write` 需补 adapter（否则 unavailable）。
- `http.fetch` 0.3 只允许 GET/HEAD；POST/PUT 不塞进同一个动作（避免一个 id 跨 read/write 两级风险），需要时另立 `http.post`（write/danger）。
- 敏感读例外：`clipboard.read` / `snip.capture` 的 grant 配 `once`；普通 `fs.read/fs.list` 用 `never`，仍写回执。
- 可用性：`check.run` 需 `dshBin`/`runner`，`window.*` 需 Stage live adapter，`notify.send` 需至少一个 channel；缺失时 `available()=false` 并列原因。

## 4. 执行管线

```
act_invoke(id,args,{dryRun,idempotencyKey,previewToken})
  │
  ├─ resolve   取 descriptor + version/hash；过期/已卸载 → action_not_found
  ├─ validate  JSON Schema 严格解析；路径 realpath、参数上限、未知字段拒绝
  ├─ authorize grant==='never' → 跳过（仍记 receipt）；否则 allow.check({subject,capability,scope})
  │             ├─ 有 Grant → 继续（danger 另需双确认）
  │             ├─ 无 Grant + 模型面 → ctx.approval.request（仅 open turn；一次性）
  │             ├─ 无 Grant + 面板/CLI → 客户端同意 → allow.issue（standing，带 TTL）
  │             ├─ Trigger 无人可问 → 只认预置 standing Grant，否则 denied
  │             └─ 拒绝/无通道 → receipt denied（无副作用，仍审计）
  ├─ preview   write/exec/danger 强制；生成 diff/plan/effect + preconditionHash + previewToken
  │             dryRun=true 在此返回，不进入 execute
  ├─ execute   复核 precondition（文件 version / topologyHash / clipboard hash）
  │             handler 在 sandbox + timeout + AbortSignal 下运行；输出截断
  ├─ verify    descriptor.verify 或默认检查（hash/存在性/exit code/窗口 bounds/投递回执）；结果按 output schema 校验
  ├─ audit     receipt 追加 `act/receipts.jsonl`：argsHash、grantId、previewHash、effects[]、outcome、耗时
  └─ undo      仅 verify ok + risk≥write + undo≠none → 发 token（默认 TTL 300s，单次，绑定 receipt）
```

- **顺序不可交换**：validate 在 authorize 前（避免用未校验参数推导 scope）；preview 在 execute 前（否则预览的是已发生的事实）；verify 在 audit 前（回执要带验证结论）。
- **模型面只有一个执行入口**：`act_invoke {id,args,dryRun?,idempotencyKey?,previewToken?}`；`act_list` 只读发现，`act_receipt` 查回执；不提供 `fs_write`/`bash` 等同义工具。
- **模型不能自授**：`act_invoke` 没有任何 `grant`/`approve` 参数；无 Grant 时只产生 pending Request 或一次 `ctx.approval`，签发必须由 Allow 的人类/策略通道完成。
- **Request / Grant 形状**：`Request={subject,capability,scope,reason,risk,ttlMs}` 只表达“想做什么”；Grant 由 Allow 签发（含 approver/expiresAt/status），Act 只存 `grantId` 并在每次执行前重新 `check`，不缓存“已授权”结论。
- **previewToken**：`hash(descriptorHash + argsHash + preconditionHash + policyEpoch)`；execute 时若文件/拓扑/剪贴板已变，返回 `stale_preview`，要求重新预览，绝不“按旧计划硬跑”。
- **结果状态**：`ok` / `denied` / `failed` / `unverified` / `partial` / `cancelled` / `undone`；`verify` 失败不算 `failed`（副作用可能已发生），标 `unverified` 并禁止自动重试。

## 5. 预览与撤销

- **三种预览**：`diff`（fs.write：before/after 逐行 diff + 影响行数）；`plan`（fs.move/delete：操作列表、目标、覆盖/回收站策略、总字节）；`effect`（shell/http/window/notify/check：argv、hosts、rect、收件人、任务与预算）。complex 动作可组合，但必须返回 `effects[]` 供 UI 展开。
- **预览是快照承诺**：preview 记录 precondition（`ctx.fs` 的 version、Stage 的 topologyHash、剪贴板 hash）；execute 前复核，避免 TOCTOU。预览不执行 handler 的副作用分支；需要“试运行”的动作提供 `previewOnly` 实现，禁止用真实 execute 当 dry-run。
- **可撤销的边界**：`fs.write` 只有在 `before` 可获取时才能 restore（二进制/超限 → `undo:none`，回执明确写“不可撤销”）；`fs.move` 目标被改过则拒绝逆操作；`fs.delete` 默认进 workspace 内 `.dsh-trash/<receipt>`（不依赖 OS 回收站），永久删除必须 `mode:'permanent'` + danger 双确认且**不发 token**；`clipboard.write` 只恢复 1 步；`window.*` 在当前 bounds 仍等于应用值时才能还原（Stage 0.2 只对 layout apply 有 undo，`window.move/resize` 的 before bounds 需在 0.3 补记录）。
- **撤销也是动作**：`act_invoke('act.undo',{token})`（meta 动作，不计入 14）走同一 authorize/audit 管线（capability `action.undo`，scope 绑 receipt），校验 token 未过期、未使用、subject 一致；失败标 `undoFailed`，不回滚 receipt 状态，不掩盖。
- **不可逆动作明确拒绝**：`shell.exec`、`http.fetch`、`notify.send`、`check.run`、`snip.capture` 的 `undo` 为 `none`；`act_invoke` 返回 `undoable:false, irreversibleReason`，面板与模型提示都显示，不允许“先做再说”。

## 6. 沙箱与 DSH 的关系

| 维度 | Act 0.3 规则 | 与 DSH 的衔接 |
|---|---|---|
| 工作目录 | 会话 cwd 为根；所有相对路径先 resolve 再 realpath | `ctx.sandboxPolicy.resolve({session})` 给出 workspaceRoot；Act 不另立根 |
| 路径 allowlist | `permissions.scope` 的 `path:` 前缀 + 动作级 deny；写默认只允许 workspace 与 `additionalWritableRoots` | `ctx.fs` 已实现 containment；Act 只做动作级收窄，**不放宽** |
| 符号链接/越界 | 拒绝 `..`、symlink/junction 逃逸、UNC/设备路径；Windows 大小写不敏感比较 | `ctx.fs.resolve()` 负责 canonical target；Act 复核 target 在 scope 内 |
| env | 从空白构造：`PATH`、`LANG`、`TZ`、沙箱内 `TMPDIR`；密钥按 `secretRef` 即时解析，不落日志；剥离 `*_TOKEN/*_KEY/*_SECRET` 与未声明的 `DSH_*` | `ctx.shell` 已有凭据清洗；`ctx.subprocess` 的 env 显式传入，不继承宿主 |
| 网络 | `shell.exec` 默认无网（策略层标记，不是内核隔离）；`http.fetch` 走 host allowlist，阻断私网/链路本地/云元数据地址，DNS 解析后 IP 复核防 rebinding，重定向逐跳复核，限响应大小与超时 | DSH 沙箱**只约束文件效果**（`sandbox.md`）；Act 必须标注 `enforcement:'policy-only'`，不能冒充内核网络隔离 |
| 子进程 | 仅 argv 数组、禁止 `shell:true`；可执行文件 allowlist；cwd 受限；timeout 默认 120s；输出 1 MiB；进程组 kill；并发上限；默认无 TTY/后台 | `ctx.sandbox.confine(argv, policy)` + `ctx.subprocess.spawn()`；`danger-full-access` 只有显式策略才放行 |
| 无 DSH seam 时 | 只读动作可用（路径守卫）；写/exec 默认禁用，除非 `standalone:{workspaceRoot,allowWrite:true}`；回执标 `enforcement:'partial'` | 单包 dsh-os 场景的降级，不承诺 OS 级隔离 |

- **取严原则**：`effectiveMode = min(dshMode, action.maxMode)`；Act 只能收窄，不能把 `read-only` 提升为 `workspace-write`。`danger` 动作请求 `danger-full-access` 时，必须同时有显式部署配置与 Allow danger Grant，二者缺一即拒。
- **旁路**：宿主 `read/write/edit/bash` 工具不经过 Act，Act 无法拦截（同进程插件本来就可绕过 Allow）。统一入口的落地条件是部署侧关闭这些工具或把它们路由到 Act；Act 只负责“经过我的动作 100% 有授权/预览/审计”，不宣称“全系统 100%”。

## 7. 幂等、重试与部分失败

- **key 派生**：调用方给 `idempotencyKey`；否则 `sha256(actionId + JCS(args) + preconditionHash)`。key 作用域 `subject+actionId`，账本保留 24h。
- **重复执行**：同 key 同 args → 返回首次 receipt（`deduped:true`），不再产生副作用；同 key 不同 args → `idempotency_conflict`；首次仍在执行 → `idempotency_in_flight`（可等待，不重复派发）。
- **重试**：只有 descriptor 声明 `retry:{max,on}` 且错误可重试（timeout、`E_AGAIN`、HTTP 429/5xx、`EBUSY`）才自动重试；`at-most-once` 在副作用派发后**永不自动重试**；verify 失败不重试，转人工 reconcile。
- **部分失败**：回执用 `effects[]` 逐项记录 `{target,status}`。`fs.move` 出现 `sourceDeleted:false` 即 `partial`，不假装成功；多文件动作不回滚已成功的项，除非动作声明 `rollbackOnPartial:true` 且每项都有 undo。超时/取消后副作用未知 → `reconcile_required`，不自动重放。
- **原子性声明**：descriptor 标 `atomicity:'none'|'file'|'txn'`；`fs.write` 用 `ctx.fs.writeText` 的临时文件+原子发布；`fs.move` 用 `moveFile` 的两段结果；跨文件批量动作默认 `none`，必须在预览里列出。

## 8. 与模块的关系：服务拥有状态，Act 拥有协议

- **双层角色**：Snip/Stage/Notify/Check/Ring/Trigger/Root/Nest/Seek/Trace/Backup/Context/Cost 是 **service**（`ctx.<svc>`，拥有状态、适配器、领域校验），同时是 **action provider**（注册 descriptor）。Act 不实现剪贴板/窗口/通知逻辑；模块不实现校验/授权/审计/undo token。
- **注册方式**：模块 `apply()` 里 `ctx.act.registerAll(descriptors)`；`handler` 只调本模块 service。`exposeTools:'off'`（0.4 默认）不注册任何工具；`'alias'`（0.3 默认）只注册薄 alias（`act.toolAlias(旧名, actionId)`，`execute` 调 `ctx.act.invoke`，不直调 service）；`'all'` 仅应急保留旧实现。没有 Act 时降级 `'all'`。
- **挂载顺序**：kit/bundle 固定 Act 先挂载；独立安装时若模块先挂载，先注册 legacy tools，Act 后到不“收养”它们（避免隐式双入口），由 `dsh-os doctor` 提示重排或设 `exposeTools:false`。
- **不重复的三条判据**：① 一个 capability 只对应一个 action id；② 模块 UI/CLI 的点击也走 `ctx.act.invoke({origin:'panel'})`，不直调 service；③ 允许 alias，但 alias 必须转发到同一 action（同一风险/授权/审计），不能直调 handler。
- **控制面例外**：`allow.issue/revoke/list` 是权限管理，不是普通动作；只对管理员/CLI 开放，`risk:danger`，模型不可见。`ring.ack` 可注册为动作（人类面），但 `ring.notify` 不得复制 `notify.send` 的语义——Ring 只做升级寻呼。
- **Trigger 组合**：规则里的 `action` 就是 action id；`origin:'hook'` 必须有带 `expiresAt` 的 standing Grant，`danger` 禁止自动触发，`idempotencyKey=event.id` 去重 7 天。

## 9. 迁移：73 个工具 → 动作

- **盘点（2026-11-21 实测，17 包 73 工具）**：Act 2（总线 meta）、Allow 1、Backup 3、Check 1（配 runner 后 +`check_run`）、Context 3、Cost 3、Help 3、Nest 5、Notify 3、os_shell 3、Ring 7、Root 5、Seek 3、Snip 9、Stage 8、Trace 7、Trigger 7。
- **映射规则**：`<prefix>_<verb>` → `<namespace>.<verb>`，namespace 取产品语义而非包名：Snip→`snip.*`、Stage 的 live move/resize→`window.move/resize`（内置）、Stage 布局/拓扑→`window.layout.*`/`window.topology`、Check→`check.compare/run`、Notify→`notify.*`、Root→`root.*`、Seek→`seek.*`、Trace→`trace.*`、Trigger→`trigger.*`、Nest→`nest.*`、Backup→`backup.*`、Cost→`cost.*`、Context→`context.*`、Help→`help.*`、Ring→`ring.*`、Allow→`allow.check`（管理动作仅人类）。
- **三类处置**：① 只读工具 → 同名 read action；② 写/exec 工具 → write/exec action，旧工具变 alias；③ 管理/UI 工具（`allow_issue`、`os_shell_*`）→ 不进模型动作面，保留人类 RPC/CLI。
- **alias 期限**：0.3.0 默认 `legacyTools:'alias'`（默认 71 个非 Act 旧名 + 3 个总线工具 = 74 个工具面；输出加 `_meta:{actionId,deprecated:true}`）；0.4.0 默认 `'off'`（仍可显式开）；**0.5.0 删除**。承诺“2 个 minor 且不短于 6 个月”，每个 alias 在 0.3 首发即标 deprecated，不静默改语义。
- **验收口径**：0.4 起默认工具面从 73 降到 3（`act_list`/`act_invoke`/`act_receipt`）；开 alias 时 74（3 总线 + 71 薄 alias，启用 `check_run` 则 75），且 alias 全部经 Act 管线（无直调）；`dsh.os.actions` 写入 manifest，contract 校验动作 id/前缀，`dsh.os.tools` 对已迁移模块告警。

## 10. 串联示例：AI 修失败测试（fs.read → fs.write → check.run）

| # | 调用 | 结果 / 闸门 |
|---|---|---|
| 1 | `check.run {taskId:'math.add', profile:'current'}` | `{passed:false, failures:[{test:'math.test.mjs:4', expected:4, actual:5}], runId:'r1'}`；exec，Grant `check.run/task:math.add`，keyed |
| 2 | `fs.read {path:'test/math.test.mjs'}` | 读到断言 `assert.equal(add(2,2),4)`；read，无需 Grant，pure |
| 3 | `fs.read {path:'src/math.mjs'}` | 读到 `return a + b + 1`；定位根因（diff 指向测试，根因在源码） |
| 4 | `fs.write {path:'src/math.mjs', patch:[{old:'a + b + 1',new:'a + b'}]}` + `dryRun:true` | 返回 unified diff、`beforeHash/afterHash`、`previewToken`；不落盘 |
| 5 | 同参 + `previewToken` + `idempotencyKey:'wf1-fix-1'` | 无 Grant → `consent_required`（requestId）；人批准 `fs.write`、scope `path:<workspace>/src/math.mjs`、TTL 30min，同 key 重试 |
| 6 | 重试第 5 步 | 复核 version/precondition → 原子写 → `{ok:true, version, beforeHash, afterHash, undoToken}`；verify 读回 hash |
| 7 | `check.run {taskId:'math.add'}` + 新 key | 重跑 → `{passed:true, runId:'r2'}`；exec，keyed |
| 8 | `check.compare {old:'r1', new:'r2'}` | `{verdict:'pass', summary:{regressions:0}}`；read |
| 9 | 若第 7 步失败 | 用第 6 步 `undoToken` 调 `act_invoke('act.undo',{token})`；当前文件 version 仍等于 afterVersion 才 restore，否则 `stale` 拒绝 |

- 这条链的关键不是“能写”，而是 **第 4 步先预览、第 5 步才申请、第 6 步校验 precondition、第 9 步可回退**；模型在 `act_list` 里直接看到 `fs.write` 与 `check.run`，不再猜 `fs.write` 是否存在（可用性实测里的 `action_not_found` 消失）。
- 成本前置：第 1/7 步走 `cost` 估算（token/USD/时长），超预算直接 `budget_exceeded`，不启动子进程。

## 11. 验收与风险

- **验收**：14 个内置动作全部有 input/output schema、risk、permissions、幂等、预览/撤销声明与至少 1 个 example；write+ 预览覆盖 100%；未授权 write/exec = 0；不可逆动作发 token = 0；alias 与 action 结果一致率 100%；幂等重放副作用 = 0；沙箱越界尝试成功数 = 0；管线额外开销 p95 < 50ms（不含动作本身）。
- **风险**：① 宿主旁路工具（需部署侧关闭，Act 只能检测不能拦）；② 预览与执行间状态变化（precondition 复核 + `stale_preview`）；③ undo 过度承诺（只承诺 descriptor 声明的，二进制/永久删除明确拒绝）；④ 网络无内核隔离（标 `policy-only`，不宣称沙箱）；⑤ 插件同进程可伪造 Grant/直接调 service（Allow 设计已声明是控制面，非安全边界）。

## 12. 证据

- 本仓：`packages/act/index.js:16-52`（校验）、`:67-108`（3 个内置）、`:186-218`（invoke/Allow）；`packages/allow/index.js:228-307`（issue/check）；`packages/check/index.js:224-243`（run）；`packages/stage/index.js:220-245`（live move/resize）；`packages/notify/index.js:109-146`（send）；`packages/snip/index.js:43-158`（9 工具）。
- DSH：`docs/subsystems/sandbox.md`（模式/仅文件效果）；`docs/capability-seams.md:787-796`（`ctx.subprocess`/`ctx.shell`/`ctx.sandbox`/`ctx.sandboxPolicy`/`ctx.fs`）；`packages/fs/fs/src/types.ts:128-200`（write 的 before/after、move 的两段结果）；`packages/shell/shell/src/types.ts:61-165`（timeout/abort/env/结果）。
- 可用性实测：`../deepseek-community-hub/01-research/dsh-os-ai-usability-2026-11-21/06-workflows.md`（73 工具、WF1/WF2 写路径断裂、Grant 死胡同）。
