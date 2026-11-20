# 03 · dsh-trigger 0.2.0 事件源：fs / webhook / agent

> 基线：DSH `0.2.2-rc.4`（`/home/yy/deepseek-harness`，`ca33fd6`，2026-11-17）；`dsh-trigger` 0.1.0（`packages/trigger/index.js`）。2026-11-20 只读复核，未改宿主。
> 结论：**最稳的两个 source 是 agent（`session/event`）和 fs（本地 watch）**；webhook 可以真接，但只在注入 `ctx.webServer` 的 web profile，且安全面最大。
> 本文是 0.2.0 的接入设计与可行性评估；`dsh-trigger` 侧 API 为拟新增，宿主侧均为 0.2.2-rc.4 源码事实。

## 0. 结论先行

- `fs.watch` **不是文件事件流**：回调只有 `(error?) => void`，没有路径、没有 add/change/unlink，也不递归；必须“快照 → 失效 → 再快照 → diff”合成事件（`packages/fs/fs/src/index.ts:117`）。
- **agent source 最稳**：`ctx.on('session/event', (session, event) => …)` 是核心事件、所有 profile 可用、post-commit 观察、带 `event.seq` 可精确去重（`docs/event-producer-consumer.md:77`）。
- webhook 真接的硬前提是 `ctx.webServer`（web bundle 注入，`packages/bundle/web-app/src/index.ts:52`）；没有该服务的 profile（headless，以及不挂 web server 的 desktop 组合）只能 interface + unavailable。
- “111 个事件”要纠正：目录共 111 行 = **100 条已声明**（`docs/event-producer-consumer.md:11-112`）+ **11 条未声明/internal**（`:117-131`）；观察型声明事件 77 条（66 emit + 9 parallel + 2 serial；parallel/serial 会被 await，listener 必须快/同步），22 条 waterfall + 1 条 bail **不能**当事件源订阅。
- `agent.run` 能从触发器启动：`ctx.agents.create` + `followup`（`packages/core/agent/src/index.ts:421`、`packages/core/agent/src/runtime-types.ts:252`），但要 6 个服务且默认只读；否则 0.2.0 只做接口 + mock。

## 1. DSH 事实

### 1.1 `ctx.fs.watch`

- 契约：`watch(target, changed, signal): Promise<() => Promise<void>>`；ready 后返回异步 close，signal 只取消初始化；不支持 watch 的 provider 直接 reject `FS_IO_ERROR`（`packages/fs/fs/src/index.ts:117-125`）。
- 本地实现：chokidar，`depth: 0`、`ignoreInitial: true`；文件监视父目录并按目标路径过滤，目录监视**直接子项**；无轮询、无递归（`packages/fs/fs-local/src/index.ts:76-93`、`packages/fs/fs-local/README.md:59`）。
- 文件 watch 覆盖原地写、原子替换、删除、同路径重建（`packages/fs/fs-local/README.md:59`）；目录不覆盖子目录内部。
- 元数据只有 `{ version, type, size? }`，**没有 mtime**（`packages/fs/fs/src/types.ts:76-83`）。本地 `version = dev:ino:size:mtimeNs:ctimeNs`（`packages/fs/fs-local/src/fsio.ts:76-77`）⇒ 去重键用 `path + size + version`，不要解析 version。
- `resolve` / `listDir` 是快照来源（`packages/fs/fs/src/index.ts:149,269`）；SSH provider 明确不支持 watch（`packages/ssh/fs-ssh/README.md:70`）。
- 平台风险：网络盘、WSL `/mnt/*`、容器 bind mount 可能丢事件；chokidar 是 OS 事件，不保证跨平台完全一致。目录被 rename/删除后 watcher 失活，需重挂。

### 1.2 webhook / `ctx.webServer`

- `register(route)` 加命名路由并返回 disposer；重复 `(kind, path)` 直接 throw（`packages/host/webserver/src/index.ts:520`、`docs/subsystems/web-server.md:120`）。
- `kind: 'prefix'` 匹配 `p` 与 `p/<anything>`（`docs/subsystems/web-server.md:12`）；`auth` 默认 `required`，webhook 必须 `anonymous` + HMAC（`packages/host/webserver/src/index.ts:123-124`、`packages/experimental/webhook-github/src/index.ts:50-52`）。
- 官方 GitHub adapter 是正确模板：405/415 → 有界 body → 验 HMAC → 202（`packages/experimental/webhook-github/src/handler.ts:88-122`）；body 先看 Content-Length、流式累计、UTF-8 fatal、abort 检测（`packages/experimental/webhook-github/src/body.ts:36-68`）。
- 宿主 webhook runtime **明确没有** queue / retry / dedupe / execution status / crash replay（`docs/subsystems/webhook.md:23`）⇒ 这些必须由 `dsh-trigger` 自己做。
- `ctx.webServer.host` / `protocol` 可读（`packages/host/webserver/src/index.ts:486,495`）；`isLoopbackHost()` 已导出、`webserver/authorize` 是 bail、`dsh web` 默认 loopback（`packages/host/webserver/src/index.ts:60,276`、`docs/subsystems/web-server.md:114`）。

### 1.3 事件目录与订阅

- `ctx.on(name, listener)` 返回 disposer，随 fiber 自动卸载（`vendor/cordis/src/events.ts:96`）。dispatch 模式是公开契约（`docs/cordis-primer.md:21-25,31`）。
- 100 条声明事件按模式：66 `emit`、9 `parallel`、2 `serial`、22 `waterfall`、1 `bail`（逐行统计 `docs/event-producer-consumer.md:11-112`）。
- 声明事件 namespace 分布：`agent/*` 11、`workflow/*` 6、`tools/*` 6、`cordis/*` 6、`webserver/*` 5、`plugin-manager/*` 5、`api-session/*` 5、`workspace/*` 4、`subagent/*` 4、`session/*` 4、`fs/*` 4；其余 1–3。
- **只订阅 `emit`/`parallel`/`serial`**；`waterfall` 必须调 `next()`、`bail` 会短路，触发器监听会改变宿主语义。尤其 `approval/request` 是 waterfall（`docs/event-producer-consumer.md:32`），要观察审批请用 `session/event` 内的 `approval/asked`。
- `session/event` 是 post-commit、fire-and-forget 的追加事件源；监听器异常被收纳，不阻塞 agent（`packages/core/session/src/index.ts:79`、`docs/event-producer-consumer.md:77`）。
- `session/event` 的内层词表 64 种（`packages/core/session/src/known-event-types.ts:22-87`）：`turn/start`、`turn/end`、`approval/asked`、`approval/decided`、`tool/call`、`tool/result`、`user/message`、`assistant/message`、`step/start`、`step/end` 等。
- 11 条 `agent/*` 中可作源的：`agent/error`、`agent/status`（`docs/event-producer-consumer.md:18,24`）、`agent/disposed`、`agent/inbox/*` 等 `emit`；`agent/created`/`agent/turn-stopping` 是 `serial`（监听器必须同步、不得 throw/await）；`agent/pre-step`、`agent/request-error` 是 waterfall，禁止订阅。
- 根 context 的 `session/event` 监听接收本进程全部会话；agent-scoped 挂载只收该 agent 的会话（`packages/core/session/src/index.ts:79` 的 scope-filtered 说明）。

### 1.4 从触发器启动 Agent 运行

- 可行：`ctx.agents.create({ sessionId, signal, meta:{cwd, agentPreset}, setup })`（`packages/core/agent/src/index.ts:421`，options 见 `:66-135`），`handle.agent.followup(message)` 入队并唤醒（`packages/core/agent/src/runtime-types.ts:252`）；factory 由 agent-loop 注册，缺 factory 时 `create()` reject。
- 完整范式在 webhook session：`permissionPresets.resolve` → `agentPresets.resolve/acquireScope` → `workspaceRegistry.create` → `agents.create` + `mount` → `attachSession` → `permissionPresets.set` → `sessionTitle.rename` → `followup`（`packages/experimental/webhook/src/session.ts:100-139`）。
- 依赖 6 个服务：`agents`、`agentDefaultModel`、`agentPresets`、`permissionPresets`、`sessionTitle`、`workspaceRegistry`（`packages/experimental/webhook/src/index.ts:59-66`）。缺任一 ⇒ 0.2.0 标 `action-unavailable`。
- 一条硬约束：`approval.request()` 无 open turn 直接 throw（`packages/interaction/user-approval/src/index.ts:243-254`）。所以 `agent.run` 的 `permissionPreset` 必须是部署里 **sandbox=`read-only`、approval=`never`** 的 preset；启动时用 `permissionPresets.resolve(name)` 取 spec 并校验 sandbox/approval（`packages/interaction/permission-presets/src/index.ts:441-447`），默认表只有 `workspace-write`/`danger-full-access`（`:190-201`），没有就禁用 `agent.run`，绝不进入审批路径。
- `UserMessage` 的 `source.kind` 只要求非空字符串（`packages/core/session/src/index.ts:355-360`）⇒ 零依赖即可构造 `{id: randomUUID(), role:'user', content:[…], source:{kind:'trigger', triggerId, runId, sourceKind}}`，用于溯源与防自触发。

## 2. 三个 source adapter

### 2.1 统一契约（0.2.0 新增）

```js
// 每种 source 一个共享 adapter，trigger 只是其中的订阅者
class SourceAdapter {
  kind // 'fs' | 'webhook' | 'agent'
  async start() {}                 // 幂等；拿共享资源（route / listener / watcher）
  async stop() {}                  // 幂等；释放全部，等待 in-flight
  async add(trigger) {}            // 校验 source spec；返回 detach
  emit(triggerId, event, payload, meta) // dedupe -> queue -> service.fireOne
}
```

- `register()` 保持同步：先写注册表，再异步 `add()`；失败只写 `availability`，不让插件装载失败（`trigger_list` 显示原因）。
- 新增 `service.fireOne(triggerId, event, payload, meta)`：**只跑该 trigger**。绝不能对 source 事件调全局 `fire()`，否则同事件的其它 webhook/路径 trigger 会被误触发。
- `unregister` 先 stop 该 trigger 的订阅，再删记录；`ctx.effect` 里 `await service.dispose()` 停全部 adapter、清定时器、断 watcher/route。
- `runs` 扩展：`status: 'succeeded'|'failed'|'dead'|'dropped'`、`attempt`、`source`、`dedupeKey`、`payloadDigest`；保持 `ok` 字段向后兼容。

### 2.2 `fs` adapter

- spec：`{ kind:'fs', path, glob?, events?:['add','change','unlink'], debounceMs=300 }`；`path` 0.2.0 要求绝对路径（相对路径需显式 `cwd`），`glob` 只匹配相对被监视根、统一 `/` 分隔符，用零依赖的 `node:path.matchesGlob`（Node ≥22.5）。
- start：`resolve` → `stat` 基线 → `watch` → ready 后再 `stat` 一次并 diff（补 ready 窗口的竞态）；同一 `targetKey` 共享一个 watcher（引用计数），每个 trigger 保留自己的 glob/事件过滤。
- 失效回调：文件用 `stat` 前后对比分类：absent→present=`add`、present→absent=`unlink`、都 present 且 `version`/`size` 变化=`change`；目录用 `listDir` 的 `name→{type,size,version}` diff；rename 记为 `unlink`+`add`。
- 合成事件名 `fs/changed`，payload：`{ eventKind, path, name, type, size, version }`；**不带文件内容**，动作需要时用 `ctx.fs.readText`（受 provider 权限约束）。
- 共享 watcher 的 `changed(error)`：记日志 + 指数退避重挂（1s/5s/30s，最多 3 次）；仍失败则 `availability:'watch-broken'`，不静默。
- 目录条目上限 10k、每 flush 最多 1000 条；`recursive` 0.2.0 **不支持**（见 §6），只收直接子项。

### 2.3 `webhook` adapter

- spec：`{ kind:'webhook', secretRef, maxBodyBytes=262144, replayWindowMs=300000, loopbackOnly=true, allowNonLoopback=false, secretEnvFallback=false }`。
- 路由：**一条 prefix** `/dsh-trigger/hook`，每 trigger 的 URL 为 `/dsh-trigger/hook/<triggerId>`；`auth:'anonymous'`；route 注册失败（重复/无 webServer）只标 unavailable，不抛。
- 请求：POST + `application/json`（UTF-8，最多一个 charset）→ 有界读完 raw body → HMAC 验证 → JSON.parse → delivery 去重 → enqueue → **202**；错误码 400/401/404/405/413/415/429/503。
- HMAC 头：`x-dsh-trigger-timestamp`（unix 秒，±`replayWindowMs`）、`x-dsh-trigger-signature-256: sha256=<hex>`，签名对象 `` `${timestamp}.${rawBody}` ``，`crypto.timingSafeEqual`；`x-dsh-trigger-delivery` 去重，缺省用 `sha256(rawBody)`。body 只在验签后解析。
- 去重：LRU 4096 + TTL 10min；**enqueue 成功后才写 dedupe**；重复返回 202 + `x-dsh-trigger-duplicate: 1`，不再跑。语义是“接收成功 ≠ 执行成功”；动作失败由内部 retry 处理，外部用同一 delivery id 重投不会重跑。
- 密钥：`secretRef` 每请求 `credentials.resolve`（不缓存，`docs/subsystems/credentials.md:23`）；无 credentials 服务时仅当 `secretEnvFallback` 用 `process.env[secretRef]`；空/缺失 503；日志/run 永不出现密钥。
- loopback：注册时看 `ctx.webServer.host`，`loopbackOnly` 且非 loopback ⇒ 不注册；每请求再看 `request.socket.remoteAddress`（去掉 `::ffff:`），非 loopback 403。反向代理下 remoteAddress 是代理，loopback 检查不等于外部隔离，**HMAC 才是唯一认证**。
- 事件名 `webhook/received`；payload：`{ deliveryId, event, body, remote }`；`event` 取 `x-dsh-trigger-event`（可选），供条件过滤。队列满返回 429（且不写 dedupe，允许重试）。

### 2.4 `agent` adapter

- spec：`{ kind:'agent', events:[...], sessionId?, agentPreset?, cwd? }`；`events` 是白名单，未列出的不订阅、不投影。
- 订阅：`session/event` 用一个共享 listener，按 `events` 过滤内层 `event.type`；`agent/error` / `agent/status` / `agent/disposed` 各一个 `ctx.on`；`agent/created` 如启用必须是同步 listener（serial）。
- 事件名归一：`turn/end`→`session/turn-end`、`approval/asked`→`session/approval-asked`、`tool/result`→`session/tool-result`、`user/message`→`session/user-message`；`agent/*` 原样。
- payload 只投影元数据：`{ sessionId, seq, type, cwd, agentPreset, data }`，`data` 是按类型的投影；`tool/result` 只给 `{callId,isError,contentBytes}`（要 toolName 用 `tool/call` 的 `callId→name` 映射），不带工具输出；`user/message`/`assistant/message` 只给 role/长度/hash，不带正文；`turn/end` 给 `{turn, reason:{kind}}`；`agent/error`/`agent/status` 用 `agent.session.id` 归一成 `sessionId`，错误只给 `{name,message,code}`。
- 过滤：`sessionId` 精确；`agentPreset` 精确；`cwd` 精确或前缀。去重：`${sessionId}:${seq}`（LRU 4096）；`agent/status` 无 seq，不硬去重，靠 cooldown。
- 0.2.0 不做回填/assistant-stream/瀑布事件：`agent/assistant-stream` 默认关闭（高频），`agent/pre-step`、`agent/request-error` 禁止。
- 自触发环：`agent.run` 记录创建的 `sessionId` + depth（同时 UserMessage 写 `source.kind='trigger'` 溯源）；adapter 对同 trigger 派生会话的 `turn/end` 默认忽略，depth ≤3。

## 3. 可靠性

- **去重**：fs `path+size+version`（本地 version 含 mtimeNs/ctimeNs）TTL 30s；agent `sessionId:seq`；webhook `deliveryId`/body hash TTL 10min。语义 = at-least-once + 窗口内至多一次效果，**不承诺 exactly-once**；重启后内存去重表清空。
- **cooldown**：沿用 0.1.0 的 per-trigger `cooldownMs`（attempt 时起算，失败也占窗口）；fs 额外 300ms debounce 合并风暴；webhook 用 timestamp 窗口防重放；agent 用事件白名单做源侧粗筛。
- **重试/死信**：仅对显式声明 `idempotent:true` 的 action 开启；3 次、1s/5s/30s + jitter，`attempt` 入账；耗尽进内存 dead-letter ring（≤200 条，只存 `payloadDigest` + 错误，不落原文）；`agent.run` 默认 1 次，避免重复会话。0.2.0 只标 `dead`，replay 留 0.3.0。
- **背压**：全局队列 256、webhook 队列 64、每 trigger 并发 1；满时 webhook 429，fs/agent 丢弃并 `dropped++`；永不阻塞 `ctx.on`/watcher/HTTP handler。fs 每 flush 最多 1000 条；所有定时器 `unref()` 并在 stop 清理。
- **loopback 安全**：默认仅 loopback 注册 + 每请求 remoteAddress 检查 + HMAC + ±5min 时间戳 + delivery 去重 + body ≤256KB；`auth:'anonymous'` 只用于机器投递，不暴露浏览器 API；`allowNonLoopback` 必须显式开启并建议 HTTPS/反代白名单。
- **审计**：每次 fire 记 `source`、`dedupeKey`、`payloadDigest`、`attempt`、`status`、`durationMs`；`token|secret|key|authorization` 字段脱敏；dead letter 不含原文。
- **自触发/放大**：`agent.run` 的 `source:{kind:'trigger'}` + depth；fs/agent 都受 per-trigger cooldown 和全局队列约束；0.2.0 不做跨 trigger 图检测。

## 4. 最小实现步骤

1. `packages/trigger/index.js`：加 `source` 校验、`fireOne`、`SourceManager`、`dispose`、`runs` 扩展、`trigger_list` 显示 `availability`；保持 `fire()` 和四个 tool 不变。
2. 加 `apply(ctx, { triggers: [...] })`：从 profile config 注册 source trigger（工具仍只做内存 demo，避免模型直接建 webhook/agent.run）。
3. **先做 agent adapter**（`sources/agent.js`）：无第三方依赖、所有 profile 可测；先覆盖 `session/turn-end`、`session/approval-asked`、`session/tool-result`、`agent/error`。
4. 再做 fs adapter（`sources/fs.js`）：`ctx.inject(['fs'], …)`；共享 watcher + 快照 diff + glob + debounce；unavailable 原因进 `trigger_list`。
5. 最后做 webhook adapter（`sources/webhook.js` + `sources/hmac.js`）：prefix route、bounded body、HMAC、LRU、429；`ctx.inject(['webServer'], …)`；secret 走 `ctx.get('credentials')`。
6. 补 `agent.run` action（可选）：照抄 webhook session 的 6 服务顺序；默认 `read-only`；缺服务返回 `action-unavailable`；`followup` 后只标 `accepted`，turn/end 用 action 内的一次性 `session/event` listener 回填（0.3.0 完整结果判定）。
7. 版本 0.2.0：README/CHANGELOG/`engines.dsh` 更新；`node --test` + web profile 手工冒烟。

## 5. 测试策略

- **单测（主力，沿用现有 fake ctx 风格）**：fake `ctx` 提供 `provide/get/tools/on/effect/inject`；fake fs 只实现 `resolve/stat/listDir/watch`，手动触发 `changed()`；fake webServer 只实现 `register/host/protocol`；agent 用数组模拟 `session/event`。
- **fs 集成**：`mkdtemp(join(tmpdir(),'dsh-trigger-'))` + 真 `LocalFileSystem`（devDependency，不随包发布）；覆盖 add/change/unlink/原子替换/同路径重建/glob/目录 diff/close 幂等；Linux CI 上 chokidar 有毫秒级延迟，断言用 `waitFor` 而非固定 sleep。
- **HTTP**：`http.createServer(handler).listen(0,'127.0.0.1')` + `fetch`；用 `createHmac` 生成正确/错误/过期签名；覆盖 202、401、413、415、405、重复 202、队列满 429、非 loopback 403、body 上限。
- **agent/action**：假 `agents.create` 返回 `{agent:{session,followup},dispose}`，断言 `permissionPresets.set`、`agentPresets.mount`、`followup` 的内容/source；断言 `agent/created` listener 同步返回、未 await；断言 stop 后 listener 全部 dispose、无 emit。
- **契约/ soak**：`start/stop` 双调用幂等；stop 后 emit 不执行；100 ev/s × 60s 队列有界、无定时器/监听器泄漏、`runs` 仍 ≤1000；`JSON.stringify(runs)` 不含 secret。
- **不可 mock 的边界**：真 web profile 的 `ctx.webServer` + credentials + 6 个 agent 服务只能手工/集成测试；0.2.0 CI 以 mock 覆盖逻辑，发布前在 web profile 跑一次 `dsh web` 冒烟。

## 6. 0.2.0 可行性评估

| 能力 | 0.2.0 | 说明 |
|---|---|---|
| agent source（`session/event` + `agent/error/status`） | **真接** | 核心事件，所有 profile；只覆盖已加载会话，无回填 |
| fs source（本地/沙箱 provider） | **真接** | 非递归、invalidation+diff；沙箱继承 LocalFileSystem 的 watch |
| webhook source（web profile） | **真接** | 需 `ctx.webServer`；HMAC/限流/loopback 自建，不用宿主 webhookRuntime |
| webhook（无 `ctx.webServer` 的 profile） | interface + mock | headless/未挂 web server 的 desktop；只保留 spec/校验/测试 |
| `agent.run` | 条件真接 | 6 服务齐全时启动；否则 interface + mock；结果判定 0.3.0 |
| fs 递归 / 远程（SSH） | interface only | `depth:0`、ssh 基类 reject（`fs-ssh/README.md:70`）；递归扇出 0.3.0 |
| 持久化去重 / 死信 replay / 崩溃回填 | interface only | 0.2.0 全内存，重启丢 dedupe/DLQ；at-least-once |
| 订阅 waterfall 事件（如 `approval/request`） | **不做** | 会改变宿主语义；改用 `session/event` 的 `approval/asked` |

## 7. 证据索引

- fs：`packages/fs/fs/src/index.ts:117-125,149,269`；`packages/fs/fs-local/src/index.ts:76-93`；`packages/fs/fs-local/src/fsio.ts:76-77`；`packages/fs/fs/src/types.ts:76-83`；`packages/fs/fs-local/README.md:59`；`packages/fs/fs-sandbox/src/index.ts:55`；`packages/ssh/fs-ssh/README.md:70`。
- web：`packages/host/webserver/src/index.ts:60,123-124,276,486,495,520`；`docs/subsystems/web-server.md:12,114,120`；`packages/experimental/webhook-github/src/index.ts:50-52`、`packages/experimental/webhook-github/src/handler.ts:88-122`、`packages/experimental/webhook-github/src/body.ts:36-68`；`docs/subsystems/webhook.md:23`；`packages/bundle/web-app/src/index.ts:52`。
- 事件：`docs/event-producer-consumer.md:11-112,117-131`；`packages/core/session/src/index.ts:79,355-360`；`packages/core/session/src/known-event-types.ts:22-87`；`vendor/cordis/src/events.ts:96`；`docs/cordis-primer.md:21-25,31`。
- agent：`packages/core/agent/src/index.ts:66-135,421`；`packages/core/agent/src/runtime-types.ts:252`；`packages/experimental/webhook/src/session.ts:100-139`；`packages/experimental/webhook/src/index.ts:59-66`；`packages/interaction/user-approval/src/index.ts:243-254`；`packages/interaction/permission-presets/src/index.ts:190-201,441-447`。
- 本包：`packages/trigger/index.js:149,159,183,341`；`packages/trigger/README.md`（0.2.0 计划）；`packages/trigger/package.json`（`engines.dsh`）。
