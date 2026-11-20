# DSH 客户端 UI 接入调研（`@perrylink/dsh-os-shell` 0.2.0）

> 基线：DSH checkout `/home/yy/deepseek-harness` = `0.2.2-rc.4` / `ca33fd6`（2026-11-17）。下文 `路径:行` 均指该 checkout。
> 结论：**能做一个真实可用的页面，且不改 DSH、不引入构建链**。用 `ui/client.js` 手写一个 `window.__ModuleLoader__.load(...)` bundle，以 `React.createElement` 把 `main` 页 + `sidebar.panellist` 图标注册进 DSH Web；Host 用 `ctx.connection.fetch.register()` 暴露两条 `/api/os-shell/*` JSON 路由。React 是槽位组件的硬要求；但 JSX/TS/打包不是。

## 1. 客户端插件架构

### 1.1 `dsh.client` manifest

- 类型为 `DshClientManifest { platform; inject?; immediately?; external? }`（`packages/util/package-manifest/src/types.ts:87-100`）。在现有 `dsh` 上新增的客户端声明只有：
  ```json
  "dsh": { "client": { "platform": "web" } }
  ```
- **没有 `entry` 字段**。浏览器入口固定为 `exports["./client"]`；Web 只接受 `platform === 'web'`；声明 `dsh.client` 却没有 `./client` 会在激活时抛错（`packages/client/modules/src/index.ts:928-931`；`.../manifest.ts:182-200`）。扫描对象是**已激活的 Loader entry**，所以同一个包的 `dsh.bundle` patch 必须把该包 insert 成一个 row；客户端 bundle 由 `/plugins/...` 路由提供，不需要额外 Host 代码。
- `inject` 是"包级工厂到达顺序边"，**不是 Cordis 服务注入**（`types.ts:85-86`；`packages/client/modules/src/client/system.ts:272-277`）；服务注入写在 bundle 返回的 `inject` 数组里。
- `external` 只用于非 baseline 的 module-table 请求；React、Cordis、`ui-slots`、`ui-primitives`、`client-store`、`zod` 已在 baseline（`packages/client/web/src/platform.ts:8-15`），本项目一个都不需要。
- `immediately` 只在阶段一预取时需要；本项目不需要。

### 1.2 注册页面/面板/命令/输入触发器

- 入口：bundle 顶层 `window.__ModuleLoader__.load({ id, factory, meta? })`；`factory(require)` 返回 `{ apply, inject }`（`packages/client/ui-trajectory/tests/client-bundle.client.spec.ts:20-27,55`）。`id` 必须等于包名（`packages/client/modules/src/client/system.ts:221`）。
- 页面：`main` 是 keyed/root 槽，`key` 即页面 id；`AppFrame` 按 `usePanelInfo.activePanelId` 或 `'conversation'` dispatch（`packages/client/ui-layout/src/client/index.ts:75`；`AppFrame.tsx:46-49`）。`sidebar.panellist` 是 list/root，`id` 要与 `main` 的 key 相同才有页面；Sidebar 把每个条目同步成可点击的全局面板（`packages/client/ui-sidebar/src/client/contract/slots.ts:47`；`ui-sidebar/src/client/index.ts:55-70`）。
- 所有注册都必须包在 `ctx.slots.inject(key, () => ctx.slots.register(...))` 里：槽位只有 owner 挂载时才存在，直接注册未声明的 key 会 throw，owner 重挂载后 callback 会重跑（`docs/subsystems/slots.md:29`）。
- 面板：`conversation.session.panel.section`（会话右侧栏 section，`ui-jobs/src/client/index.ts:41-59`）；`sidebar.right.pane.tab`（右侧独立 tab，需同时注册 tab 类型）；`conversation.input.dock`（composer 上方）；`shell.overlay`（浮层 toast）。
- 命令：`ctx.commandUi.register({ name, available, ui: { kind: 'action' | 'popupSelect', ... } })` 注册 `/` 命令（`ui-commands/src/client/contract.ts:135`；示例 `ui-model-selection/src/client/index.ts:129`）。`ctx.shortcuts.register({...})` 注册键位（`ui-layout/src/client/index.ts:206`；`packages/client/shortcuts/README.md:30`）。
- 输入触发器：`ctx.inputTriggers.registerSource({ trigger, name, candidates, onPick, ... })`（`ui-input-trigger/src/client/contract.ts:18`；示例 `ui-reference/src/client/index.ts:198`）。MVP 不需要。
- **React 是否必须**：槽位组件类型是 `(props) => ReactNode`（`ui-slots/src/index.ts:441`），renderer 用 `react-dom/client`（`ui-renderer/src/client/renderer.ts:2-4`），没有注册 HTML 字符串或 DOM 节点的 API。in-GUI 必然有 React 运行时；但可以只用 `React.createElement`，不写 JSX、不装 React 构建链。

### 1.3 与 Host 通信

- `ctx.remote.<ns>` 只包含**静态装配**的 Typert 贡献；`@deepseek-ai/dsh-api-remotes` 的 `/remote` import 列表是手写的，外部包的标准做法必须改 DSH 装配（`docs/api-gateway.md:80`）。自己 `$mount` 则要自带 Typert 生成产物，未文档化。所以**实际选择是不走 Remote**。
- 可用且公开的替代：Host `ctx.connection.fetch.register({ path: '/api/<ns>/<op>', methods, requestBody, fetch })`（`packages/client/connection/src/rpc.ts:146-168`；示例 `packages/client/ui-deliverables/src/present-open.ts:21-27`）。路径必须以 `/api/` 开头（`rpc-host.ts:335-337`）。
- 浏览器直接 `fetch('api/<ns>/<op>')`，同源带 Cookie；exact route 只允许 owner Peer，其他 principal 直接 403（`rpc-host.ts:148-161`）。路由 `fetch` 不拿 peer 参数，内部用 `Request` + Host 服务。
- 另有通用 RPC 通道：Host `ctx.connection.rpc.handle('/os-shell', handler)`（`rpc.ts:162-168`；channel 必须是单段，`CHANNEL_PATTERN` 在 `rpc-host.ts:30`），客户端 `ctx.connection.rpc.call('/os-shell', 'state', payload)`（`packages/client/connection/src/rpc.ts:256-270`）；但要自己处理结果包络，MVP 用 exact Fetch 更小。
- 若需要 server push，可让 route 返回 `ReadableStream`（SSE）或轮询；MVP 用 tab 激活时拉取 + 手动刷新。

## 2. 最小样例（实际代码路径）

| 样例 | package/manifest | 入口 | 注册 |
|---|---|---|---|
| `ui-schedule`：整页 + 侧栏图标 | `packages/client/ui-schedule/package.json:21-38` | `src/client/index.ts:106` | `main` key + `sidebar.panellist`（`src/client/index.ts:223-252`） |
| `ui-jobs`：会话面板 section | `packages/client/ui-jobs/package.json:63-73` | `src/client/index.ts:35` | `conversation.session.panel.section`（`:41-59`） |
| `ui-goal`：dock + 命令 + jsdom 测试 | `packages/client/ui-goal/package.json:29-41` | `src/client/index.ts:70` | `conversation.input.dock`；测试 `tests/browser-plugin.client.spec.tsx:1-14` |

`ui-schedule` 是本次的直接模板：`main` 页 + `sidebar.panellist` 同 id，是 DSH 里"加一个全局页面"的标准做法。`ui-jobs` 说明 session 级面板可以更小，但它依赖 `ctx.jobs`（in-tree client service）；外部包没有这个，回到 §1.3 的 fetch。

## 3. Shell 最小 UI 设计

### 3.1 形态

一个 `main` 页（key `os`）+ 一个 `sidebar.panellist` 图标（id `os`, order 30, label `OS`）。页面内三个 tab：Act / Snip / Check，各自状态在组件内；页面是 root scope，不依赖当前 Session。

### 3.2 Host JSON 协议（两条 exact route）

```text
GET  /api/os-shell/state?view=act&q=...
  -> { ok, view, data }             // act: {actions:[{id,title,risk,description?}]}
                                    // snip: {entries:[summary...]}
                                    // check:{last: report|null, exitCode: 0|1|2|null}
POST /api/os-shell/command  { op, ... }
  act.invoke    { id, args }         -> act.invoke(id,args,{subject:'ui:os-shell'})
  snip.get      { id }               -> { text } | null
  check.compare { old, new, allowFlaky? } -> { report, exitCode }
  shell.open    { id }               -> osShell.open(id)   // 可选，记历史
```

Host 侧每次按 `ctx.get('act'|'snip'|'check'|'osShell')` 取服务；缺服务返回 `{ok:false,code:'service_unavailable'}` + 503，不要因可选模块缺失让整个 shell 挂掉。所有响应 `cache-control: no-store`；`act.invoke` 的 result 若不是 JSON-safe，route 捕获后返回 500 `serialization_failed`。`check.last` 放闭包/`OsShellService` 内存，进程重启丢失（MVP 可接受）。

### 3.3 每个 view

| view | 数据来源 | 交互 | 权限/失败 |
|---|---|---|---|
| Act | `ctx.act.list({text:q})`；`act.invoke(id,args,{subject:'ui:os-shell'})` | 搜索框过滤；每行 risk 徽标；`read` 直接 Run；`write/danger` 点 Run 先 confirm；args 用 JSON textarea；结果 `<pre>` | `invoke` 内部查 Allow；`grant_required` 显示 `capability`，不重试；UI 不伪造 subject |
| Snip | `snip.list({limit:50})`；`snip.search(q)`；`snip.get(id)` | 搜索；列表 preview；Copy 取全文后 `navigator.clipboard.writeText`；redacted 行只复制 `[redacted:*]` 并提示 | 只读；无 Allow；不提供 add/clear（写操作留 0.2.x） |
| Check | `ctx.check.compare(old,new,{allowFlaky})`；`last` | 两个 `<input type=file accept=.json>` 读文本；Compare 后展示 verdict、summary、每 task diffs、exit code；页面重开显示 last | 纯函数、无 Host FS/无 grant；非法输入 exit 2；若加 runner，再按 `check:run` Grant |

**Check 缺口（必须写进 0.2.0 计划）**：0.1.1 的 `CheckService` 只有 `compare()`，没有历史/退出码（`packages/check/index.js:186-190`）。所以 UI 的"最近 diff + 退出码"有两个来源：① MVP：Host 闭包保存最后一次 compare 的 report，exit code 由 `verdict` 映射（regression→1，pass/warning→0，输入错误→2；与 CLI 表一致，`packages/check/README.md:49-54`）；② 0.2.0 正式版：给 `CheckService` 加 `record/last`（内存 ring 即可），`check_compare` 也写入，UI 只读。不要把它做成客户端本地存储。

### 3.4 权限

- 路由层：owner-only，未登录/非 owner 403（`rpc-host.ts:157`）；同源 Host/Origin 检查由 Connection 统一做。
- Act：`write/danger` 必须过 Allow；UI 的固定 subject 是 `ui:os-shell`（root 页面没有当前 Session，不能拿 sessionId 冒充）；Grant 由 `allow_issue`（opt-in）或后续 Allow UI 签发，`scope` 默认 `*` 或 `act:invoke:*`。
- Snip：UI 只读；`get` 返回的是本地剪贴板明文，owner-only 路由是边界；redaction 在 `snip.add` 时已完成。
- Check：UI 只传用户选的文件内容，不读 Host 文件系统；若后续做 runner，按设计文档 `check:run` / `check:baseline:write` Grant（`docs/design/04-check.md:135`）。

### 3.5 客户端骨架（`ui/client.js`，classic script，无构建）

```js
window.__ModuleLoader__.load({
  id: '@perrylink/dsh-os-shell',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    function Page() { /* useState/useEffect + fetch('api/os-shell/state?...') + 3 tabs */ }
    function Icon() { return h('span', { 'aria-hidden': true }, 'OS') }
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'os' }, Page))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'os', order: 30, label: 'OS' }, Icon))
    }
    return { apply, inject: ['slots'] }
  },
})
```

`Page` 内：`fetch('api/os-shell/state?view='+tab+'&q='+encodeURIComponent(q))`；POST 用 `fetch('api/os-shell/command', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,...})})`。样式用 `style` 对象 + `var(--dsw-alias-*)` token；不要写死颜色；要过 DSH UI review 时把 CSS 放进 `meta.stylesheets` 的静态字符串（仍无需构建，形状见 `ui-trajectory/tests/client-bundle.client.spec.ts:23-27`）。**`ui/client.js` 是 classic script：顶层不能写 `import`/`export`，只能通过 `factory(require)` 取模块**（否则 `/plugins` 的 `<script>` 直接语法错误）。

### 3.6 `package.json` 变更

```json
"exports": { ".": "./index.js", "./ui": "./ui/index.js", "./client": "./ui/client.js", "./package.json": "./package.json" },
"files": ["index.js", "ui/index.js", "ui/client.js", "cordis.patch.yml", "README.md", "CHANGELOG.md"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" }, "os": { "...": "..." } }
```

不需要 `dsh.client.inject`，不需要 `external`：bundle 只 `require('react')`（baseline），槽位服务由 `inject: ['slots']` 等待。现状 `dsh.os.ui.entry` 已指向 `./ui/index.js`、`views: []`（`packages/shell/package.json:60-62`；`packages/shell/ui/index.js:11`）；0.2.0 保留该 dsh-os 自有协议，同时新增 `./client` 指到 `ui/client.js`，两者不要混用。

## 4. 0.2.0 评估

- 工作量：Host `bridge.js` ~80 行；`ui/client.js` ~180 行；测试 ~100 行；`package.json` + README。**零新运行时依赖、零 DSH 改动、零构建**。
- **1 个 view 可行**：只做 Act 时 `ui/client.js` 可压到 ~80 行，仍用 `React.createElement`；纯 DOM 不行（槽位只收 React component），但 Plan B 的 iframe 让真实 UI 纯 DOM。
- 硬门槛：① 目标 DSH 的 stock web 组装含 `ui-layout` / `ui-sidebar` / `ui-renderer`（`packages/client/web/src/boot-client.ts:26-35` 的 required 列表）；② 手写 bundle 遵守 `__ModuleLoader__.load` 产物契约（这是构建产物契约，不是公开 API，需冒烟测试锁住）；③ 非 web profile 不显示 UI，Host 的 `osShell`/tools 仍可用。
- 风险：`main`/`sidebar.panellist` 若被别的 profile 替换，注册只是等待、页面不出现；`ctx.connection` 缺失时 bridge 永不激活；`check` 历史缺口；Act 的固定 subject 需要 Grant 管理入口。

### 降级方案（按顺序）

- **B：Host 渲染 HTML + 15 行 iframe 壳**（React 仍要，但仅作容器）：`GET /api/os-shell/ui` 返回同一套 JSON 的纯 HTML/JS 页面；客户端 bundle 只在 `main` 页渲染 `h('iframe', { src: 'api/os-shell/ui', style:{width:'100%',height:'100%',border:0} })`。同源 iframe 能带 Cookie 调 `/api/os-shell/*`；本 checkout 未设 `X-Frame-Options`/CSP（grep 未命中），理论上可行，**需实测 iframe 导航的 owner 认证**。真实 UI 全是纯 DOM/HTML，React 只出现 15 行。
- **C：独立页**（零客户端插件）：直接把 `/api/os-shell/ui` 当普通网页开；不嵌入 DSH GUI，只作应急。
- 不建议把 `ui-sidebar-browser` 当载体：它明确拒绝 DSH 应用自身 origin（`packages/client/ui-sidebar-browser/README.md:59`），要另起 loopback 端口，部署复杂度反而高。

## 5. 测试

1. **Host（零依赖）**：`packages/shell/test/bridge.test.js` + `node --test`。把 route handler 抽成 `createBridge({getAct,getSnip,getCheck,shell})`，假服务断言：state 过滤、`act.invoke` 透传 `grant_required`、`check.compare` 的 exitCode 映射、未知 op 400、服务缺失 503。
2. **客户端 smoke（零依赖）**：`test/ui-client.test.js`，先设 `globalThis.window = { __ModuleLoader__: { load: h => handoff = h } }`，再 `await import('../ui/client.js')`；用 fake `require('react')` 和 fake `ctx.slots` 调 `apply`，断言注册了 `main`/`os` 与 `sidebar.panellist`/`os`、`inject=['slots']`。不测 DOM，只锁契约。本次调研已用该模式在临时目录验证 load→factory→apply 注册 2 个槽位。
3. **DOM 行为**：官方是 jsdom 路线——feature spec 首行 `// @vitest-environment jsdom`，用 `@testing-library/react`（`packages/client/ui-goal/tests/browser-plugin.client.spec.tsx:1-14`）；或 `@deepseek-ai/dsh-client-test-runtime` 的 `SlotTestRuntime.create()/declare()/mount()/renderSlot()`（`packages/test-support/client-runtime/README.md:36-42`）。外部包注意它的 peer 版本要贴 DSH。
4. **集成**：`mktemp -d` 做临时 `DSH_HOME`，`dsh plugin add ./packages/shell` 后启动 web，确认页面出现、两条 route 可调；不要动真实 `~/.dsh`。

## 6. 待确认

- `ui/client.js` 手写 bundle 是否被 DSH 团队视为稳定扩展方式？当前证据是 `clientBundle` 产物 + `ui-trajectory` 的 artifact 测试；建议在 0.2.0 README 标 "artifact contract, pin DSH"。
- Act 的固定 subject `ui:os-shell` 是否与 Allow 的 grant 管理流程一致；若不一致，0.2.0 只做 `read` 动作的 UI，`write/danger` 留到 Grant UI 之后。
- Check 0.2.0 是否真的提供 `last`/history；若没有，MVP 的"最近"只是当前进程最后一次 compare。
