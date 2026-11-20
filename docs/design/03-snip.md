# Snip — 剪贴板账本（产品设计稿）

> 2026-11-20 · 对象：PerryLink（个人开发者，非官方）· 基线 DSH `0.2.2-rc.4` @ `ca33fd68` · 本地优先 · not affiliated with DeepSeek。

## 0. 一句话

**把每次复制变成一条本地加密、默认排除秘密、可检索、可审计的记录，让 Agent 通过 `clipboard://<id>` 引用，而不是把整段秘密贴进上下文。**

三个判断：① 需求被 Win+V / Raycast / Paste / Maccy 反复验证；② DSH **没有宿主剪贴板 seam**——这既是最大集成成本，也是 Snip 的差异化（谁先定义契约谁定标准，§4.0）；③ 生态 8 个专用剪贴板/收件箱插件多为 0–2★、最高 4★，`dsh-clipboard-history` 近 30 天 87 次下载，无成熟者。

## 1. 名字与可用性

| 候选 | npm（2026-11-20 实测） | GitHub | 判断 |
|---|---|---|---|
| **`dsh-snip`** | **404 = 未注册** | `PerryLink/dsh-snip` 404；但 3 个第三方同名截图插件：`XXP-AI-SPACE/dsh-snip` 1★、`hezhaochao/dsh-snip` 0★、`qinguan-0813/dsh-snip` 0★ | **采用**；风险是语义混淆，不是名称占用 |
| `dsh-clip` | 200，`0.0.1`，描述 "name reserved"（2026-10-10） | — | 占用 |
| `dsh-copy` | 200，`0.1.2`，文案长度校验 | — | 占用且语义不同 |
| `dsh-clipboard` | 200，`0.1.0`，只写系统剪贴板 | — | 占用 |
| `dsh-hold` | 404 | `TetraSsky/dsh-hold` 等 | 不干净，且语义弱于 Snip |

**决定**：`Snip`（package/bundle `dsh-snip`，bin `snip`，标题固定 "Snip · 剪贴板账本 / Clipboard Ledger"）。README 首段写明与截图插件无关；npm keywords 加 `clipboard-history`。若截图侧同名插件做大，1.0 前改 `dsh-snip-ledger`（预 1.0 改名成本最低）。

## 2. 问题与用户

今天 DSH 里"读剪贴板"只有三条旁路：`bash`/`pwsh` 调 `pbpaste`/`Get-Clipboard`、CUA 的 `paste()`（写路径；读回旧值只为恢复，不是 Agent 读接口，`packages/experimental/cua/src/guidance.ts:56`）、人手动粘贴。后果：只有最后一条可用；无来源/时间/格式；无策略；秘密一旦贴进会话就进 append-only 会话日志（`packages/session/session-telemetry-otel/tests/loader-composition.e2e.ts:92` 的测试名就是 "canonical log keeps the secret"）。

| 用户 | 场景 | 现在怎么做 | 付费点 |
|---|---|---|---|
| 个人（写作/研究/运营） | 复制资料→切回 DSH→问"这条" | 手动粘贴，重复找原窗口 | 无限历史、图片/OCR |
| 开发者 | 复制报错/路径/JSON/代码片段 | 粘贴后让模型"看上面" | 检索、句柄、CLI |
| 企业 | 合规剪贴板：禁云同步、保留期、排除清单、审计导出 | 禁用工具 or 容忍 | 团队策略/审计 |

## 3. 范围与非目标

**做（v1）**：text / html / link / color 账本；策略；FTS；`clipboard://` 句柄；4 个 Agent 工具；4 个动作；审计；CLI；面板；导出。
**做（v1.1）**：image / file 元数据、OCR（可选）、跨设备 opt-in、深度搜索。
**不做**：输入法/片段扩展（TextExpander）；密码管理器（不生成、不填充、不保管密码，只做"不入库"）；系统级划词/悬浮动作条（另一条产品线）；替代 Win+V（不接管系统历史）；默认云同步；后台截图/OCR（v1）；移动端；浏览器扩展；键盘记录；团队管理台（v1.1+）。

## 4. 架构

### 4.0 没有宿主 seam：契约归 Snip

事实：宿主无 `ctx.clipboard` 服务（`grep -rn "super(ctx, 'clipboard')" packages` 无命中）；CUA 只有 `paste()` 写路径（旧值读回仅用于恢复，`packages/experimental/cua/src/guidance.ts:56`）；Desktop 未暴露插件级 clipboard API，主进程只有内建 UI 的零散写/读（登录 URL `apps/desktop/src/main.ts:1424`、更新地址 `apps/desktop/src/mandatory-update-window.ts:384-385`）；Web client 只有 `writeClipboard`（`packages/client/ui-primitives/lib/types/clipboard.d.ts:10`，浏览器 `navigator.clipboard.writeText`）。`docs/tool-catalog.md` 无剪贴板工具。

因此 Snip **自己定义并持有契约**：
- `ctx.clipboard`：最小**能力 seam**（`watch/read/write/status`），只放跨插件消费面；注册前 `ctx.get('clipboard') === undefined` 才注册，避免与未来官方冲突。
- `ctx.snip`：产品面（ledger / history / policy / audit / `clipboard://` 解析），始终注册。
- 契约类型单独导出（`dsh-snip/contract`），第三方插件依赖类型而非实现。
- 上游提案：给 `deepseek-harness` 提 RFC，最小面 = `onChange(listener)` + `read(types)` + `write(item, {ttl, concealed})` + `status()`；Snip 作为参考实现。官方采纳后，Snip 关闭 `ctx.clipboard` 注册、退化为 adapter + 账本层，`ctx.snip` 不变。
- Desktop 缺口：Electron 主进程有 `clipboard`，但只有内建 UI 的零散用法；Snip 走 helper，或推动上游暴露 change 事件 IPC。

### 4.1 对象模型

所有对象继承基类：`id`（ULID）、`owner`（user/agent/plugin）、`scope`（global/workspace/session）、`createdAt`、`updatedAt`、`expiresAt?`、`auditRef`（最近一条审计行 id）。

`Clip`：`kind: text|html|image|link|color|file`、`text?`、`html?`、`blobRef?`、`link?`、`color?`、`preview`、`hash`、`size`、`sourceApp`、`sourceWindow`、`sourceConfidence`、`sensitive`、`pinned`、`policy`、`meta`。图片/文件内容只在 `blobs/` 加密存放；`file` 只存路径 + size + mtime，**不复制文件内容**。`link`/`color` 由文本归一化派生，不单独采集。

### 4.2 捕获适配器（后台捕获经 `ctx.subprocess`）

| 平台 | MVP | v1.1 |
|---|---|---|
| Windows | 常驻 `pwsh` helper：`Get-Clipboard -Raw` + `GetClipboardSequenceNumber`（P/Invoke），NDJSON 输出 `{seq,ts,text,fgApp}`；700ms 自适应轮询；seq 去重 | WinRT `GetHistoryItemsAsync()` 快路径 + 原生 helper（格式/图片） |
| macOS | **只手动捕获**（文本框 Ctrl+V）；`pbpaste` 轮询默认关 | Swift helper 到位后才开后台监听：`changeCount` + `NSPasteboard.accessBehavior` + `org.nspasteboard.*` 标记 |
| Linux | `wl-paste --watch`（Wayland）/ `xclip` 轮询（X11） | 同左 + 图片 |

- 平台顺序：**Windows 首发**（本机可验证）；macOS MVP 只做手动捕获，因为 `pbpaste` 读不到 `ConcealedType` 与来源 app，后台轮询会直接违反"默认排除秘密"——宁可不采集。
- 只有**本机 Web/Desktop**启动 host 侧捕获；经远程地址访问时，host 剪贴板是服务器机器的，不是用户的——此时只保留"浏览器手势捕获"（用户点按钮 → `navigator.clipboard.readText()` → RPC 入库），绝不后台轮询。
- WSL 视为跨机：默认关闭，v1.1 用 `clip.exe`/`powershell.exe Get-Clipboard` 桥。
- 来源应用：Windows 取前台窗口进程；macOS MVP 标 `unknown`，v1.1 helper 用 `org.nspasteboard.source` 或前台 app。拿不到就标 `sourceConfidence: 'unknown'`，**不拿它单独做安全决策**。

### 4.3 存储、加密、检索

- `node:sqlite` `DatabaseSync`（DSH 自身 `packages/storage/storage-sqlite/src/schema.ts:66` 与 `packages/session/session-persistence-sqlite/src/sqlite.ts:203` 都 `new DatabaseSync`；locator 内容索引也是 SQLite FTS5 + trigram，[README 设计](https://github.com/PerryLink/dsh-locator#设计)）。**不用 `ctx.storage`**：那是 document-per-row KV，没有 FTS（`packages/storage/storage-sqlite/src/index.ts:1-5`）。
- 路径 `$DSH_HOME/snip/{ledger.db,blobs/,key.wrapped}`，目录 0700、DB 0600、WAL。
- 加密：每条 payload（含 `preview`）用 AES-256-GCM（随机 12B nonce，AAD=`id|kind|createdAt`）；主密钥 32B 随机，**用 OS keychain 包裹**（Windows DPAPI，pwsh `ConvertFrom-SecureString`/`Export-Clixml`；macOS `security` 经 stdin；Linux `secret-tool`），失败退化为 0600 keyfile 并在 UI 明示。`ctx.credentials` 只存 key 的引用名，**不存原始密钥**——`credentials-local` 是明文 YAML（`packages/credentials/credentials-local/src/index.ts:2-6`）。
- 检索：复用 FTS5 栈，但索引里**只放 HMAC-SHA256 词元**（blind index：拉丁词 + CJK bigram + 可选字符 trigram，HMAC 截断 96-bit），明文只存在 GCM 密文里。这样加密与搜索不互斥；代价是无前缀/子串（除词元内），排序弱于明文 FTS。W1 spike 对比 SQLCipher（`better-sqlite3-multiple-ciphers`）+ 明文 FTS；若预编译包在 Windows/macOS 通过，v1.1 可换。
- 清除：删行 + 删 blob + VACUUM；SSD 上"安全擦除"不可承诺，UI 如实说明。导出：JSONL（明文，需二次确认）+ 加密归档（scrypt + AES-GCM）。

### 4.4 策略（默认关）

- 安装后**默认不采集**；显式开关 + 一页说明（仅本机/加密/默认忽略秘密）。
- 三层排除，按精度排序：① 来源 app（1Password / Bitwarden / KeePassXC / Keychain Access / SecurityAgent 等进程与 bundle）；② 标记（macOS `ConcealedType`/`TransientType`/`AutoGeneratedType`；Windows `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory=0`、`CanUploadToCloudClipboard=0`）；③ 内容（JWT / AWS / 私钥块 / 银行卡 Luhn / 证件 + 熵阈值）。macOS 标记依赖 v1.1 原生 helper：MVP 手动捕获只走内容检测 + 用户确认。
- 命中秘密 → **不入库**；用户强制保存 → 1h TTL + 掩码预览 + 每次读都要 Grant + 审批。歧义时宁可不存。
- 保留：默认 7 天 / 500 条（免费 200）/ 单条 256KB 文本、2MB 图片；pin 例外（≤50）；TTL 后台清扫。
- 暂停/恢复/一键清空/单条遗忘；按 app 暂停。

### 4.5 工具、句柄、CLI、Client UI

- 工具（4 个）：`clipboard_read(id, {format})`、`clipboard_write(text, {ttl, concealed})`、`clipboard_history({kind,app,from,to,cursor})`、`clipboard_search(query, {kind,from,to})`。`read` 返回 `clipboard://<id>` 与 `sensitive` 标记；秘密内容默认掩码。
- 句柄 `clipboard://<ulid>`：稳定、可跨会话引用；**不是权限**——解析时仍查 Grant。Act/其他插件通过 `ctx.clipboard` 解析。
- CLI：`snip status|enable|pause|history|search|get|write|forget|export|audit|policy`，`--json` 供脚本。
- Client：状态条（监听中/已暂停/未授权）+ 面板（搜索/过滤/pin/删除/清空/授权引导）+ "插入输入框/作为引用/问这条"。插入走 composer 契约 `insertQuote`/`insertText`（`packages/client/ui-conversation/src/client/contract/input.ts:192,293`）或 `slash/input-insert-*`（`input/hub.ts:211-216`）；W2 先验证插件可见入口，不可见则退化为"复制引用文本"。
- 单包 host+client：`exports["./client"]` + `dsh.client.platform=web`（`docs/subsystems/client-modules.md:96`；dsh-locator 同款）；Host→Client 由 `api-snip` 控制器投影为 `ctx.remote.snip`（模式同 `ctx.workspaceController`）。

### 4.6 跨设备（v1.1，opt-in）

二维码配对（设备公钥 + 一次性码）；X25519 ECDH → HKDF → AES-256-GCM；中继只见密文；仅文本；按条手动"发到设备"，24h TTL；可撤回/吊销；秘密类永不参与；企业可一键禁用。MVP 只留接口，不实现中继。

## 5. 与 Act / Allow / Trace 的组合

| 产品 | 协议 | Snip 用法 | 缺失时 |
|---|---|---|---|
| **Act** | `ActionDescriptor`：`id,title,icon,argsSchema,risk,availability,preview,execute,undo` | 注册 4 个：`snip.pasteAs`、`snip.translate`、`snip.summarize`、`snip.saveToMemory`；`preview` 显示将被插入/发送的**全文**与目标；translate/summarize 另需 `clipboard.export` Grant（内容出本机边界），preview 标出模型路由；`undo` 对写剪贴板恢复旧内容，对记忆写返回"不可撤销" | 面板内置菜单，不依赖 Act |
| **Allow** | `Grant = subject × capability × scope × expiry × approver × evidence` | capability：`clipboard.read/write/delete/export/sync`；scope：`{ids?, kinds?, apps?, includeSensitive?: false, from?, to?}`。每次 Agent 读写、导出、同步前 `check`；`includeSensitive` 必须显式 Grant + 逐次确认 | turn 内用 `ctx.approval`；out-of-turn 只允许用户手势（面板确认），不开放给 Agent |
| **Trace** | 底层是 `dsh-memory-protocol/v1`：`ctx.memory`（`add/replace/remove/consolidate/seed`）+ `ctx.memoryAdapters`；Trace 在 v1 之上做治理 | `saveToMemory` 调 provider 的 `add`，`source:'snip'`，tag `clip-<id>`（31 字符，≤32），正文 = 用户确认过的摘要，**不是原始 clip**；由 provider 内部审批门/写门把关 | 导出 `.md` + 句柄，不静默丢 |

**out-of-turn 关键约束**：`ctx.approval.request` 要求会话在 open turn 内（`docs/subsystems/approval.md:86`）。因此清空/删除/导出/同步这些**可能来自面板或后台**的动作，不能依赖一次性审批，必须走 Allow 的 Grant（预授权、可撤销、带 expiry）；记忆写走 provider 自己的写门（memento 协议 §6 的 `via write gate`）；面板手势也生成 60s 一次性 Grant（approver=user, evidence=ui-confirm），保证每条写都有 Grant 证据。两者都不可用 → 结构化失败 `SNIP_GRANT_REQUIRED`，不降级放行。
**审计三联**：`clip_audit` 行 ←→ Act 的 execution id ←→ Grant id；导出的每条都带三者，可回答"谁在何时读了哪条、凭什么"。

## 6. 隐私与安全

- **macOS 15.4+**：程序化读 general pasteboard 默认 `.ask`，用户主动粘贴始终放行；用户可在系统设置改为 `.alwaysAllow/.alwaysDeny`（[Apple](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum)）。所以：v1.1 后台监听首次启用必须解释并请求授权；拒绝后提供文本框让用户 Ctrl+V 手动捕获（用户发起的粘贴不受限），不循环重试（每次读都可能弹窗）。MVP 只走手动捕获，不提权。
- **秘密过滤**：来源 app > 标记 > 内容检测；宁可误杀。被忽略时只提示"已跳过 1 条可疑内容"，不显示内容。
- **加密/密钥**：见 §4.3；密钥丢失 = 数据不可读，导出时提供恢复口令，文档写清。
- **零外发**：默认无网络；语义搜索只用当前会话模型，且只发用户选中的 top-N 掩码摘要（v1.1）。
- **审计**：Agent 每次 `read/search/write/export` 都落 `clip_audit(id, actor, action, ts, grantId, execId, result)`；面板可见；JSONL/CSV 导出；保留 30 天（可配置），审计本身不可被 Agent 删除。
- **会话日志**：把 clip 内容送进对话就等于写进 append-only 日志（§2 证据）。所以默认**只给句柄与摘要**；`clipboard_read` 的结果页明确警告"内容将进入会话记录"；sensitive 需逐次确认。
- **威胁模型（如实写）**：能防备份/同步/他人账户/误导出；**不能**防同用户恶意软件、屏幕录制、其他不守规矩的剪贴板读取者、OS 级键盘记录。Windows 三个 opt-out 格式是协作协议，不是强制（[Microsoft](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)）。

## 7. 失败模式

| 失败 | 触发 | 处理 |
|---|---|---|
| 轮询触发系统提示（v1.1 后台监听） | macOS 每次程序化读、用户选 `.ask` | 一次授权引导；拒绝则手动捕获；退避不重试 |
| 秘密泄漏 | 来源 app 未识别、图片里的密码、用户强制保存 | 三层排除；图片 v1.1 且默认不 OCR；强制保存 1h TTL + 掩码 + Grant |
| 远程/服务器剪贴板错位 | Web 经远程地址访问 | 检测连接来源；远程只允许浏览器手势捕获 |
| 格式兼容 | HTML/RTF/图片、Windows 历史单条上限、延迟渲染 | 统一降级为纯文本 + 保留原格式引用；超限截断并标记 |
| 来源误判 | 复制瞬间前台窗口不是来源 | `sourceConfidence:unknown`；不用于安全决策 |
| 跨设备 | 中继被攻破/重放/设备丢失 | E2E、每设备密钥、nonce+序号、吊销列表、24h TTL |
| 密钥丢失/DB 损坏 | 换机/磁盘故障 | `snip doctor` + 恢复口令导出；文档写清不可恢复 |
| `node:sqlite` 不可用 | webworker 运行时把它 stub 掉（`packages/experimental/webworker-runtime/src/node/builtin_modules/mock/sqlite.ts:11`） | Host 服务只跑宿主进程；W1 在 Desktop/Web 两种宿主各验一次 |
| 上游加 `ctx.clipboard` | DSH 0.3+ | 检测到官方 seam 就切 adapter，停止注册 alias，避免双采集 |

## 8. MVP 5 周

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | `ctx.snip` + `ctx.clipboard`；SQLite/GCM/blind FTS；Windows helper；去重；CLI status/enable/pause | Windows 复制 100 条不丢不重；库里无明文；app/标记排除生效 |
| W2 | 面板 + 状态条 + 搜索/过滤/pin/删除/清空 + 首次启用引导 + composer 插入 | 安装→启用→搜索→插入 ≤3 步；macOS 手动捕获可用 |
| W3 | 策略（三层排除/TTL/上限）+ 4 工具 + Grant 检查 + 审计 | 秘密语料 0 入库；无 Grant 的 Agent 读被拒 |
| W4 | Act 4 动作（preview/undo）+ Trace `add` + 导出 | 每个动作可预览；审计三联可查；记忆写入带 `source/tag` |
| W5 | macOS 手动捕获 + 打包/签名/文档 + 10–20 beta + 修复 | 崩溃率 <1%；0 P0 隐私问题；beta 周召回 ≥3 次/人 |

跨设备不在 MVP；W5 只冻结接口（配对/信封格式）。**范围红线**：W3 结束若秘密过滤误杀 >5% 或 p95 搜索 >200ms，砍图片/深度搜索，不砍策略。

## 9. 指标与验证

- 北极星：**每周被召回（read/search/插入）的 clip 数 / 活跃用户**。
- 规模：首发 3 个月 DAU ≥100、WAU ≥300（与 OS-PRIMITIVES 的剪贴板验收线一致）。
- 漏斗：安装→启用（目标 ≥60%）→首捕→首次召回；D7 留存 ≥25%；搜索→打开 ≥30%；召回 ≥5 次/周。
- 质量：p95 搜索 <100ms @10k 条；捕获保真 ≥99.5%（文本逐字）；崩溃率 <1%；**隐私事故 = 0**（秘密语料入库 0、外部披露 0、未掩码日志 0）。
- 验证：5 个设计伙伴（2 开发者/2 写作者/1 企业安全）30 分钟访谈；20 个 Pro 意向；自己 dogfood 7 天；遥测只报计数不报内容（opt-in）。
- kill 线：4 周后启用率 <40% 或周召回 <5% → 砍账本，退化为"Agent 剪贴板工具 + 策略"单点。

## 10. 打包与变现

- npm `dsh-snip` 单包（host + `exports["./client"]` + bundle patch）；`dsh plugin add dsh-snip`；Apache-2.0；README 首段"非官方、不与 DeepSeek 关联"。
- 免费：200 条 / 7 天 / 文本+链接+颜色 / 4 工具 / 本地。
- Pro：**¥68 买断**（首发）或 ¥18/月——无限保留、图片+OCR、深度搜索、加密导出、跨设备 3 台（v1.1 上线后）。
- 团队：按 seat/年——策略模板（排除清单/保留期/禁同步）、审计导出；SSO 后置。
- 成本：本地零服务端；只有跨设备需要 relay（按 Pro 限额）。不卖数据、不做广告。

## 11. 风险与开放问题

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| macOS 后台监听授权摩擦（v1.1） | 高/高 | 手动捕获降级 + 清楚解释 + v1.1 原生 helper；先 Windows 首发 |
| 秘密误入库（一次即致命） | 中/致命 | 默认排除 + 来源优先 + 掩码 + 1h TTL + 审计 + 红队语料 |
| 无宿主 seam 的集成脆性/性能 | 高/中 | 常驻 helper，不逐次 spawn；W1 双宿主验证；上游 RFC |
| 上游自己做 `ctx.clipboard` | 中/中 | 主动提案 + 做其上层的账本/策略；alias 可退出 |
| 同名截图插件混淆 | 低/中 | 副标题、README、keywords；必要时 1.0 前改名 |
| 单人 5 周范围过大 | 高/中 | W3 红线；跨设备/图片后置 |
| Windows helper 被杀软误报 | 中/中 | 纯 pwsh、无二进制、签名文档；v1.1 原生 helper 走签名 |
| 同步 relay 的安全/合规责任 | 低/高 | v1.1 才做；E2E + 最小字段 + 企业禁用 |

开放问题：① `ctx.clipboard` alias 现在就注册，还是只留 `ctx.snip`？② blind FTS vs SQLCipher，W1 用真实 1 万条测；③ 敏感条目是否允许"强制保存"？④ 图片进 v1 还是 v1.1？⑤ Act 若晚于 Snip 发布，4 个动作是否先以命令形式存在？⑥ 买断 vs 订阅；⑦ 是否把契约包独立发布给第三方插件；⑧ 企业 relay 要不要做 on-prem。

## 12. 证据

- **无宿主 seam**：`grep -rn "super(ctx, 'clipboard')" packages` 无命中；命中的都是写/粘贴侧——`apps/desktop/src/main.ts:1424`（登录 URL 写入）、`apps/desktop/src/mandatory-update-window.ts:384-385`（更新地址写/读回校验）、`packages/experimental/cua/src/guidance.ts:56`（`paste()` 写路径）、`packages/client/ui-primitives/lib/types/clipboard.d.ts:10`（`writeClipboard`）；`docs/tool-catalog.md` 无剪贴板工具。
- **审批仅 open turn**：`docs/subsystems/approval.md:86`。
- **加密与搜索可共存**：`node:sqlite` FTS5 本机实测通过（Node 24.22.1）；DSH 自用 `node:sqlite`（`packages/storage/storage-sqlite/src/schema.ts:66`、`packages/session/session-persistence-sqlite/src/sqlite.ts:203`）；locator 用 FTS5+trigram（[README 设计](https://github.com/PerryLink/dsh-locator#设计)）。
- **会话日志保留秘密**：`packages/session/session-telemetry-otel/tests/loader-composition.e2e.ts:92`。
- **凭据文件是明文 YAML**：`packages/credentials/credentials-local/src/index.ts:2-6`。
- **macOS 授权**：[NSPasteboard.AccessBehavior](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum)（macOS 15.4+）。
- **标记类型**：[nspasteboard.org](https://nspasteboard.org/)（Concealed/Transient/AutoGenerated）。
- **OS/竞品基线**：`01-research/dsh-os-primitives-2026-11-20/03-clipboard-selection.md` §1（Win+V、Raycast、Paste、Maccy、Alfred、PopClip；§3 插件星数/下载）。
- **Windows opt-out 格式**：[Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)。
- **1Password 90 秒清空**：[1Password Support](https://support.1password.com/copy-passwords/)。
- **记忆协议 v1**：`dsh-memento@0.5.32`，[protocol-v1.zh.md](https://github.com/PerryLink/dsh-memento/blob/main/docs/protocol-v1.zh.md)（entry schema `additionalProperties:false`，无 `sourceRef`，故用 `source`+tag）。
- **记忆协议命名**：npm `dsh-memory-protocol@0.3.2` 是另一款 opencode-memory MCP 桥（与 memento 的 v1 规范无关）；Trace 侧勿用该 npm 名发布协议。
- **命名实测**：npm `dsh-snip` 404、`dsh-clip` 0.0.1 reserved、`dsh-copy` 0.1.2、`dsh-clipboard` 0.1.0；GitHub 3 个 `dsh-snip` 截图仓；`dsh-clipboard-history` 30d 87 次下载（npm API 2026-10-21..11-19）。
