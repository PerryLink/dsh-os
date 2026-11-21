# 02 · 能力描述符（Capability Descriptor）与注册中心 v1

> 2026-11-21 · 基线 dsh-os 0.2.0 · 20 包 / 17 个带工具的包 / 74 个手写工具（brief 记 73，实测 74，差 1 待对账）
> 结论：descriptor 留在模块内，registry 只是薄 Map；`snip.search ↔ snip_search` 双射，迁移不改任何工具名。

## 1. CapabilityDescriptor v1

```ts
interface CapabilityDescriptor {
  id: string                  // `namespace.verb`，verb 只允许 [a-z0-9_]；`id.replaceAll('.','_')` === 工具名（双射）
  title: string               // ≤40 字，人类面标题
  summary: string             // 一句话 ≤120 字：tool description 首行 + CLI 列表
  whenToUse: string[]         // ≥1；写触发场景（"用户问刚才复制的那段"），不复述功能
  whenNotToUse: string[]      // ≥1；必须点名最近的替代能力，消歧是 AI 选对的唯一手段
  inputSchema: JsonSchema     // 2020-12 子集；非 read 必须 additionalProperties:false
  outputSchema: JsonSchema    // 成功返回；strict 模式每次 invoke 校验
  risk: Risk[]                // read|write|execute|network|secret|approval；数组=多重标签
  permissions: string[]       // `fs.read` 等 manifest capability，或 `allow.check`、`act:invoke:*`
  cost: { tokens: number; latencyMs: number; moneyUsd: number }   // 估算，不做计费
  idempotency: 'pure' | 'idempotent' | 'non-idempotent' | 'destructive'
  examples: Example[]         // { input, expect:'ok'|{code,alias?}, note? }；≥1 正 ≥1 反，conformance 真跑
  returns: string             // 成功返回的一句话，告诉 AI 下一步能用哪个字段
  errors: { code: ErrorCode; alias?: string; when: string; retry: boolean }[]
  version: string             // descriptor semver，独立于包版本；同 id 大版本不共存
  tags: string[]              // 横切标签：search / clipboard / pii / admin
  handler: (input, ctx, exec) => Promise<unknown>  // 唯一不可序列化字段；生成器经 toJSON() 剥离
  ui: null | { view: string; label: string; expose: 'button' | 'form' | 'command' }
  aliases?: string[]          // 旧工具名/旧 id；resolve 可命中，list 默认隐藏
  deprecated?: null | { since: string; replacedBy: string; removeAt: string; reason: string }
  audience?: ('agent' | 'human' | 'cli')[]   // 默认全开；allow.issue/revoke/list 只给 human+cli
}
```

- `defineCapability()` 只补默认值、校验必填、冻结对象；不注册、不执行、不 import 别的模块。
- `risk` 是调用者能造成的影响，`permissions` 是模块自身要碰的 OS 面，两者可以不等：`snip.search` 标 `read`（用户可见效果只读），但 TTL 清理会写账本，所以 permissions 含 `fs.write`。授权只看 risk，审计看 permissions。
- `risk` 是分类而非闸门位置：`write|execute` 由 registry 加 `cap:<id>` 授权；`approval` 表示闸门在 handler/目标能力内，registry 不再加一层（否则 Act 双层审批）；`network|secret` 额外要求 manifest 已声明。
- `audience` 把现有 `allow` 的 `exposeAdminTools` 显式化：`allow.issue/revoke/list` 标 `['human','cli']`，`toTools({audience:'agent'})` 直接过滤。
- AI 面基线：`01-research/dsh-os-ai-usability-2026-11-21/AI-USABILITY.md` 本次核验**不存在**（目录未落盘）；whenToUse/whenNotToUse 先按本文件写，文档到位只改文案、不动 schema。

## 2. 注册中心（≤300 行，零 import）

```js
// dsh-os-contract/registry.js — 纯 ESM，无 node: 内建，浏览器/worker 可用
export function createRegistry({ authorize, strict = false } = {}) { /* Map + filter + gate */ }
const r = createRegistry({ authorize })             // 宿主装配时创建一次
r.register(desc | desc[] | { id, meta, load })     // 同步、幂等；返回 unregister()
r.list({ capability, risk, tag, q, includeDeprecated, limit, cursor })  // 摘要，不含 handler
r.search(q, { limit })                              // id/title/summary/whenToUse/tags 加权子串
r.resolve(idOrAlias)                                // → descriptor；懒加载时 await load()
r.invoke(id, input, { subject, signal })            // handler 收到 exec={subject,signal}；→ { ok, value|code }
r.toTools({ audience = 'agent', capability })       // name←id、description←summary+whenToUse/whenNotToUse、parameters←inputSchema
r.names() / r.manifestDiff(pkgJson)                 // 与 dsh.os.tools 对账
```

- **过滤**：`capability` = id 的 namespace（`list({capability:'snip'})`）；`risk` 为"至少含一项"；`tag` 数组为 AND；`q` 走 id/title/summary/tags 子串；按 id 稳定排序，游标分页，`limit` 上限 200。
- **冲突/重名**：同 id + 同 version + handler 指纹相同 → 幂等 no-op；同 id + 同 version + 指纹不同 → `E_CONFLICT`；两个 owner 声明同 id → `E_CONFLICT`（仅测试可 `override:true`）；alias 与真实 id 撞名 → `E_CONFLICT`；悬空 alias 允许注册，`doctor` 报 `danglingAlias`。
- **版本**：同 id 高版本替换低版本；低版本注册 → `E_CONFLICT`，除非 `allowDowngrade`（回滚/测试）；大版本不共存（v2 换 id 或先 unregister）。unregister 只允许注册者本人。
- **懒加载**：`{ id, meta, load }` 的 meta 必须含 id/title/summary/whenToUse/risk/tags/cost；`resolve/invoke/toTools` 才 import；加载后 meta 必须与 stub 深度相等，否则 `E_CONFLICT`（防两处漂移）。
- **零依赖**：不引 JSON Schema 库；用契约包内 ~120 行子集校验器（type/required/properties/items/enum/const/pattern/min/max/additionalProperties；`format` 仅注解）。指纹 = handler 源码 + 规范化 JSON 的 FNV-1a，不引 crypto。
- **错误归一**：handler 抛的 `SNIP_*`/`action_*` 按 `errors[].alias` 映射成规范码再返回 `{ok:false}`；未映射的抛错 → `E_UNAVAILABLE`（保留 `cause.code`）。旧模块不必改 throw 风格。
- **调用序**：resolve → 校验 input（拒未知字段）→ `authorize(desc, call)`（默认实现：`write|execute` 查 `allow.check({subject, capability:'cap:'+id})`，无 Allow 则 fail closed）→ handler → strict 校验 output → 审计 `capability/invoke`。预期拒绝返回 `{ok:false, code}`，不 throw。
- **挂载**：`ctx.capabilities` 是可选 seam。有它时模块只 register、工具由 registry 统一 `toTools()` 生成；没有时模块自己 `toTools()` 注册（契约 §1.8 仍成立）。kit/shell 负责装配，模块永不 import registry。
- **装配顺序**：registry 必须先于模块 apply（kit patch / shell 启动时先 provide），否则模块会走本地回退、与 registry 重复注册同名工具。

## 3. 代码生成：descriptor 是唯一手写物

| 产物 | 生成方式 | 消费者 | 漂移门 |
|---|---|---|---|
| agent tool 定义 | `r.toTools()` 运行时生成（无文件） | DSH `ctx.tools` | conformance 比对 `dsh.os.tools` |
| `capabilities.json` | `scripts/gen-capabilities.mjs` | CLI、CI、外部工具 | `--check` 失败即红 |
| CLI `--help` | 同一脚本，读上面的 json | `dsh-os cap snip.search --help` | 快照测试 |
| JSON Schema | `docs/schemas/cap/<id>.schema.json`（input+output 合成 `$id`） | 编辑器、MCP、表单 | 生成后 git diff |
| Markdown handbook | `docs/handbook/<namespace>.md`，顶部 `<!-- generated -->` | 人类面、README 链接 | 同上 |

- 规则：手写只有模块里的 `capabilities.js`（`export const capabilities = [...]`）；README 工具表删除、改为指向 handbook；生成物一律不手改。复用现有模式——CLI 已在用 `packages/cli/catalog.json`（构建产物 + 运行时只读）。

## 4. 兼容与迁移：74 个旧工具

- **双射已核验**：`id.replaceAll('.','_')` 对 74/74 都还原出今天的工具名（`act.invoke↔act_invoke`、`snip.watch_start↔snip_watch_start`、`os_shell.views↔os_shell_views`）。`seek.search↔seek_search` 说明 namespace 取工具前缀，不取 service 名（`ctx.evidence`）。
- `aliases: ['snip_search']` 与 `deprecated: {since, replacedBy, removeAt, reason}` 并存：alias 让旧名继续 resolve，deprecated 让 `list`/生成器隐藏并在描述首行加"已弃用，用 X"；alias 只解析、不生成第二个工具（避免模型上下文翻倍）。
- **不强迫重写**：`fromTool(tool, {risk, permissions, cost})` 把现有 ToolDefinition 一行包成 descriptor 并标 `legacy:true`；允许一个模块一半 descriptor 一半 legacy，registry 两者都 list，`doctor` 报覆盖率。现有 conformance 的 `LEGACY_WARNINGS` 开关可直接复用作灰度。
- 风险词表映射：Act 的 `read|write|danger` → `read` / `write` / `['execute','approval']`；模块 capability 兜底（`spawn→execute`、`net→network`、`secret→secret`、`fs.write→write`）。
- 迁移波次（每波可独立回滚）：
  1. **W0** 每包加 `capabilities.js`，`apply` 仍手写注册；conformance 只查形状（warning）。
  2. **W1** 挂 registry，`toTools()` 生成工具，删手写 wrapper；`dsh.os.tools` 不变，正常路径行为不变，边界校验按 descriptor 收紧（逐项记 CHANGELOG）。
  3. **W2** conformance 要求 manifest 每个 tool 都有 descriptor（legacy 白名单只减不增），examples 全绿。
  4. **W3（1.0）** 删 alias / legacy 适配器，descriptor 升 1.0，manifest 增 `dsh.os.descriptors`（可选 `namespace`，`service:null` 的 shell 必须写）。
- 契约要改一处：450 行上限拆成"可执行逻辑 ≤450 + 声明 ≤20 行/能力"，否则 9 个工具的 Snip 会被 descriptor 挤爆。

## 5. 校验：让"描述"必须等于"实现"

1. **形状**：descriptor 顶层拒绝未知键（拼错字段静默失效是最贵的 bug；新字段走 `x-*` 或升大版本）；id/namespace/owner 必须匹配。
2. **handler 必填**：`defineCapability()` 缺 handler 直接抛；registry 不接受无 handler 的 descriptor。
3. **examples 真跑**：`conformance --examples` 在 temp DSH_HOME 沙箱逐条 invoke；ok 例必须过 outputSchema，error 例必须得到同一 `code`/`alias`。
4. **唯一生成路径**：静态扫描 `ctx.tools.register(` 只允许出现在 registry adapter 与 `legacy.js`；新模块手写 tool 即 error。
5. **清单对账**：`dsh.os.tools` ≡ `r.names()`（legacy 白名单除外）；`permissions` 里属于 capability 的部分必须 ⊆ `dsh.os.capabilities`（seam 与授权模式见下条）。
6. **权限/风险对账**：permissions 必须是 manifest capability 或 declared seam；risk 必须被 capability 支撑。**这条会先报红**：Snip 只声明 `clipboard/secret/spawn` 却在读写账本文件（缺 `fs.read/fs.write`）；Act 也没写 `requires:['allow']`。说明 manifest 一直在少报。
7. **错误码**：`errors[].code` 必须是契约 §6 表或 alias 表成员，且 alias 字面量必须出现在模块源码里（grep）——防"编了一个不存在的错误码"。
8. **可序列化**：`toJSON()` 后无函数/无循环；handler 不可枚举，避免误传进模型上下文。
9. **删除测试**：`unregister()` 后 `names()` 不含它，其他 descriptor 不受影响（契约 §1.8）。
10. **输出契约**：handler 返回 `undefined` 即 error；strict 每次校验 outputSchema，生产可采样。

注：契约 §6 缺 `E_FAILED`/`E_TIMEOUT`，`action_failed` 目前只能错配到 `E_UNAVAILABLE`；v1.1 应补两个码，过渡期用 alias 表兜底。

## 6. 两个真实例子

### 6.1 `snip.search`（现 `snip_search`）

```js
export const snipSearch = defineCapability({
  id: 'snip.search', title: 'Search clippings', version: '1.0.0',
  summary: '按大小写不敏感子串搜本地 Snip 账本，返回 handle 与预览，永不返回正文。',
  whenToUse: ['用户问"我刚才复制的那段/那个报错/那个链接"', '先定位再决定要不要 snip.get 读全文'],
  whenNotToUse: ['已知 id 或 clipboard:// handle → 用 snip.get', '要当前系统剪贴板 → 用 snip.capture'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
    query: { type: 'string', minLength: 1, description: '要查找的文本（大小写不敏感）。' },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回条数。' } } },
  outputSchema: { type: 'object', additionalProperties: false, required: ['query', 'entries'], properties: {
    query: { type: 'string' },
    entries: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'handle', 'kind', 'preview', 'createdAt', 'expiresAt', 'redacted'], properties: {
        id: { type: 'string' }, handle: { type: 'string', pattern: '^clipboard://' },
        kind: { type: 'string', enum: ['text', 'html', 'link', 'color'] },
        preview: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' }, redacted: { type: 'boolean' } } } } } },
  risk: ['read'],
  permissions: ['fs.read', 'fs.write'],   // 搜索会做 TTL 清理并写回账本；manifest 两样都没声明
  cost: { tokens: 60, latencyMs: 8, moneyUsd: 0 },
  idempotency: 'pure',
  examples: [
    { input: { query: 'ECONNREFUSED', limit: 5 }, expect: 'ok' },
    { input: { query: '   ' }, expect: { code: 'E_INVALID_ARGUMENT', alias: 'SNIP_BAD_QUERY' },
      note: '空白 query 必须原样报错，不能被工具层吞成空结果' } ],
  returns: '`{ query, entries[] }`，每条只含 id/handle/kind/preview/时间/redacted，不含正文；要正文再调 snip.get。',
  errors: [
    { code: 'E_INVALID_ARGUMENT', alias: 'SNIP_BAD_QUERY', when: 'query 为空白', retry: false },
    { code: 'E_STATE', alias: 'SNIP_STATE_INVALID', when: '账本损坏，fail closed', retry: false } ],
  tags: ['search', 'clipboard', 'local', 'pii'],
  handler: (input, ctx) => ({ query: input.query, entries: ctx.snip.search(input.query, { limit: input.limit }) }),
  ui: null, aliases: ['snip_search'], deprecated: null, audience: ['agent', 'human', 'cli'],
})
```

### 6.2 `act.invoke`（现 `act_invoke`）

```js
export const actInvoke = defineCapability({
  id: 'act.invoke', title: 'Invoke action', version: '1.0.0',
  summary: '按 id 调一个已注册 Act 动作；write/danger 动作缺少 Grant 时返回 grant_required。',
  whenToUse: ['act.list 已找到目标动作，且参数能对上它的 parameters', '人类面/CLI 与模型面共用一条执行与审计通道'],
  whenNotToUse: ['只是看有哪些动作 → 用 act.list', '动作已有专用工具（snip.*/stage.*）→ 优先专用工具，少一层转发'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string', minLength: 1, description: '已注册动作 id，如 echo。' },
    args: { type: 'object', additionalProperties: true, description: '目标动作参数，由其 parameters 校验。' } } },
  outputSchema: { type: 'object', required: ['ok'], properties: {
    ok: { type: 'boolean' }, actionId: { type: 'string' }, result: {},
    code: { type: 'string' }, message: { type: 'string' }, capability: { type: 'string' } },
    additionalProperties: true },
  risk: ['approval'],               // 闸门在目标动作内（act:invoke:<id>），registry 不再加一层
  permissions: ['allow.check', 'act:invoke:*'],
  cost: { tokens: 80, latencyMs: 25, moneyUsd: 0 },
  idempotency: 'non-idempotent',
  examples: [
    { input: { id: 'echo', args: { text: 'ping' } }, expect: 'ok', note: 'read 动作直跑' },
    { input: { id: 'no-such-action' }, expect: { code: 'E_NOT_FOUND', alias: 'action_not_found' },
      note: '未知 id 返回结构化失败，不 throw' } ],
  returns: '`{ok:true, actionId, result}`；拒绝/失败为 `{ok:false, code, actionId?}`；`grant_required` 带 `capability`，须先走 Allow。',
  errors: [
    { code: 'E_NOT_FOUND', alias: 'action_not_found', when: 'id 未注册', retry: false },
    { code: 'E_DENIED', alias: 'grant_required', when: '目标 write/danger 且无有效 Grant', retry: true },
    { code: 'E_INVALID_ARGUMENT', when: 'id 为空：inputSchema 的 minLength 先拦（旧 invalid_arguments 退役）', retry: false },
    { code: 'E_UNAVAILABLE', alias: 'action_failed', when: '目标 execute 抛错', retry: true } ],
  tags: ['actions', 'bus', 'approval'],
  handler: (input, ctx, exec) => ctx.act.invoke(input.id, input.args, { subject: exec.subject }),
  ui: { view: 'act.panel', label: '运行', expose: 'form' },  // Act 0.2 尚无 UI：W2 前记 warning
  aliases: ['act_invoke'], deprecated: null, audience: ['agent', 'human', 'cli'],
})
```

这两个例子已暴露两处现存不一致：`snip_search` 的 input 没写 `minLength`（空串跑到服务才报错）；`act_invoke` 的空 id 在工具层 throw，而服务层会返回 `action_not_found`。descriptor 把校验前移后，前者由 schema 拦、后者规约成 `E_INVALID_ARGUMENT`——调用方可见行为变了，必须写进 CHANGELOG。

## 7. 会不会变成"大框架"？

- **预算**：registry ≤300 行 + 校验器 ≤120 行，一次性；descriptor 取代现有 wrapper（schema 从 wrapper 搬过来），代码量净增≈0；无新依赖、无新包（registry 放契约包，不加第 21 个包）。
- **它只是路由表**：Map + filter + 一次授权 + 一次校验，没有生命周期、hook、插件、表达式、继承。任何一项出现即跑偏，应停下。
- **模块仍然小而美**：`capabilities.js` 是数据 + handler 引用，可单独 review；registry 不含业务知识；模块只在 `apply` 里 `ctx.get('capabilities')?.register(...)`，从不 import registry（契约 §1.4）。
- **三条护栏**：① registry 开始需要 hook/中间件 → 停；② descriptor 里出现 `if`/模板表达式 → 停（用 tags/risk 表达）；③ 一个能力要用 >20 行描述 → 该拆能力，不是加字段。
- **失败模式与退路**：若半年内迁移 <30/74，说明收益不成立，退回"只给现有 tool 加 whenToUse/risk 两个字段"，registry 与生成器全部不做。
- 最大的真实风险不是框架化，而是**写完 descriptor 忘了改 handler**：靠 §5 的 examples、错误码 grep、唯一生成路径三道锁，而不是靠 review。
