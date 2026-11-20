# Recipe：在插件里使用 Snip 的 `clipboard://` 句柄

> Snip 0.1.x 是**本地账本，不是系统剪贴板监听器**。只有显式调用
> `snip.add(...)` 或 `snip_add` 工具才会记录；没有后台轮询、没有
> `snip_capture`、没有网络。
>
> `clipboard://<id>` 是账本句柄，不是 OS 剪贴板引用。它解决的是“把一段文本的
> 引用传给 agent/工具，而不是把全文塞进上下文”。

## 1. 安装

```sh
dsh plugin --profile web add dsh-snip
dsh --profile web --dump-config | grep '^# == dsh-snip'
```

预期：

```text
# == dsh-snip
```

## 2. 记录一段文本，拿到句柄

在工具/命令的处理函数里拿 `ctx.snip`，**不要**在 `apply()` 挂载时自动记录——
否则每次插件挂载都会多一条：

```js
// 由工具调用、命令或用户动作触发，而不是在 apply() 里直接执行。
export function rememberQuery(ctx, text) {
  const snip = ctx.get('snip')

  // 显式记录；0.1.x 不会自动读系统剪贴板。
  const clip = snip.add({
    text,
    sourceApp: 'psql',
  })

  // 只持久化 handle，不复制全文。
  const handle = clip.handle // "clipboard://<id>"

  const entry = snip.get(handle)
  // entry.text 才是原文；entry.preview 是给列表/搜索看的摘要。
  return { handle, entry }
}
```

`snip.add()` 返回的摘要形状（id/时间戳每次不同）：

```json
{
  "id": "<uuid>",
  "handle": "clipboard://<uuid>",
  "kind": "text",
  "preview": "SELECT * FROM users WHERE id = 42",
  "createdAt": "<ISO-8601>",
  "expiresAt": "<ISO-8601>",
  "redacted": false
}
```

`snip.get(handle)` 在摘要之外再返回：

```json
{
  "text": "SELECT * FROM users WHERE id = 42",
  "sourceApp": "psql",
  "sensitivity": "normal"
}
```

`get()` 接受 raw id 或完整的 `clipboard://` handle；两者等价。handle 是
不透明字符串，不要解析或自己拼。

## 3. 把句柄交给 agent：一个自定义工具

插件可以注册一个只接收 handle 的工具，让 agent 按需读取：

```js
export const name = 'clipboard-demo'
export const inject = ['tools', 'snip']

export function apply(ctx) {
  const snip = ctx.get('snip')

  ctx.tools.register({
    name: 'clipboard_read',
    description: 'Read one Snip clipping by its clipboard:// handle.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'string', description: 'clipboard://<id> or a raw id.' },
      },
      required: ['handle'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ handle }) {
      const entry = snip.get(handle)
      if (!entry) return { ok: false, code: 'E_NOT_FOUND', handle }
      return {
        ok: true,
        handle: entry.handle,
        preview: entry.preview,
        text: entry.text,
        redacted: entry.redacted,
      }
    },
  })
}
```

要点：

- 工具只收 handle，不收全文；handle 可以安全地放进你自己的状态、任务参数或
  会话消息；
- `snip.get` 返回的 `text` 一旦进入工具结果，就会进入 append-only 的会话日志。
  **只读你真正需要的那一条**；
- 找不到/已过期/已 forget 时返回 `null`，工具要把它变成结构化失败，不要抛
  未处理异常。

## 4. Agent 侧的六个工具

Snip 自带这些 plain-object 工具（不需要额外注册）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `snip_add` | `text`（必填）、`kind`、`sourceApp`、`sensitivity` | `{ id, handle, kind, preview, createdAt, expiresAt, redacted }` |
| `snip_search` | `query`（必填）、`limit` | `{ query, entries }`，entries 是摘要 |
| `snip_get` | `id`（id 或 handle，必填） | 完整条目（含 `text`） |
| `snip_list` | `kind`、`limit` | `{ entries }`，最新在前 |
| `snip_forget` | `id`（id 或 handle） | `{ ok, removed }` |
| `snip_clear` | 无 | `{ removed }` |

一次典型往返：

```text
snip_add  { "text": "SELECT * FROM users WHERE id = 42", "sourceApp": "psql" }
       -> { "id": "...", "handle": "clipboard://...", "preview": "...", "redacted": false, ... }

snip_get  { "id": "clipboard://..." }
       -> { "id": "...", "handle": "clipboard://...", "text": "SELECT * FROM users WHERE id = 42", ... }
```

`snip_search` 搜的是**存储的文本**（不是只搜 preview）。被 redaction 的原文
根本不会存下来，所以搜不到；`snip_get` 也只会返回 `[redacted:<reason>]`。

## 5. 生命周期与配置

| 选项 | 默认 | 含义 |
|---|---|---|
| `ttlMs` | `86400000`（24 小时） | 条目寿命；过期条目在访问时清扫 |
| `maxEntries` | `200` | 超出后淘汰最旧条目 |
| `maxBytes` | `65536`（64 KiB） | 单条 `add()` 上限；超出抛 `SNIP_TOO_LARGE` |
| `excludeSecrets` | `true` | 检测到密钥样式时只存 `[redacted:<reason>]` |
| `stateFile` | 未设置 | 可选的 JSON 快照；原子写、模式 `0600` |

- **不是系统剪贴板。** Snip 不会把条目写进 OS 剪贴板，也不会读它；复制到
  系统剪贴板仍由你的客户端/插件负责。
- **默认进程内。** 不配 `stateFile` 时重启即丢；配了以后是明文 JSON，**0.1.x
  不加密**，按本地秘密文件保护。
- **过期或 forget 后 handle 失效。** `get()` 返回 `null`；不要复用旧 handle。
- **同文本不去重。** 每次 `add()` 得到新 id/handle。

密钥排除是 best-effort，不是保证。实测：

```js
const secret = snip.add({ text: 'password=hunter2', sourceApp: 'demo' })
// secret -> { preview: '[redacted:password]', redacted: true, ... }

snip.get(secret.handle).text
// -> '[redacted:password]'
```

`sourceApp` 也会被同样的密钥样式筛查；命中时 `add()` 直接抛
`SNIP_BAD_SOURCE_APP`，不会把标签存进去。`sensitivity: 'secret'` 是调用方
显式覆盖，始终 redact。

## 6. 排错

| 现象 | 原因 | 修复 |
|---|---|---|
| `snip_get` 抛 `SNIP_NOT_FOUND` / `snip: clipping not found` | handle 过期、已 forget、或用了别的账本的 id | 用 `snip_list` / `snip_search` 重新拿 handle |
| `SNIP_EMPTY_TEXT` | `text` 为空或全空白 | 传非空字符串 |
| `SNIP_TOO_LARGE` | 单条超过 `maxBytes`（默认 64 KiB） | 分条存，或调大 `maxBytes` |
| `SNIP_BAD_KIND` | `kind` 不是 `text`/`html`/`link`/`color` | 用支持的 kind |
| `SNIP_BAD_SOURCE_APP` | 标签非字符串、有控制字符、超过 80 字符或像密钥 | 用短、纯文本的应用名 |
| `SNIP_STATE_WRITE_FAILED` | `stateFile` 目录不可写 / rename 失败 | 修目录权限；失败时内存和磁盘都保留旧状态 |
| `SNIP_STATE_INVALID` | 快照损坏/不可读 | 先备份再检查；不要直接删掉唯一副本 |
| 明明不是密钥却被 redact | 文本命中了密钥样式（如 `token=...`） | 看 `preview`；不要为这一条关闭全局 `excludeSecrets` |

下一步：写动作如何产生内容并交给 Snip，见
[`agent-write.md`](agent-write.md)；把 CI 门禁接起来见 [`ci-gate.md`](ci-gate.md)。
