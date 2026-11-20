# Stage · 窗口 / 显示器拓扑与布局

> npm `dsh-stage`（拟）｜CLI `dsh-stage`｜Host seam `ctx.stage`｜目标 DSH `0.2.2-rc.4`（checkout `ca33fd6`）
> **Not affiliated with DeepSeek.** 名字与 Apple Stage Manager 无关；本文件不声称任何官方关系。
> 产品线：Act（动作）/ Allow（授权）/ Snip（剪贴板）/ **Stage（窗口）** / Trigger（触发）。Stage 是桌面拓扑与布局层，不执行点击与截图。

## 0. 结论
- **补的是 window server 层，不是窗口管理器**：Display / Window / Space 一等对象 + `ctx.stage` seam + zone 布局 + 验证/撤销/审计；agent 先摆好舞台，再观察和操作。
- **缺口经源码复核**：CUA 有 per-app window 对象（bounds/title/onCurrentSpace/activate/show），但无显示器、DPI、全局枚举、move/resize、layout、Space 写；`ctx.computerUse` 只有 `register(name)`，第三方插件**无法复用** CUA 的窗口对象（`capability-seams.md:719`：“no common action API”）。
- **生态只有单点**：`dsh-window-locator` 仅 Win、仅前台、0★、无 npm；Windows-MCP 只到**单窗口** move/resize；dsh-click（26★、7,414/月）与 dsh-locator（8,911/月）有审批/审计与存量用户，但都不做布局。
- **名字可用**：`dsh-stage` npm 404（2026-11-20 实测）；`dsh-screen`（macOS 屏幕记忆 0.1.0）与 `dsh-layout`（DSH Web UI 布局 0.9.1）已被占，`dsh-view` 404 但语义过泛 ⇒ 采用 Stage。
- **MVP 4 周，但与 04 号文档的 Windows-first 结论相反**：按产品线口径 macOS 优先；理由与止损见 §8。
- **最大风险**：macOS 辅助功能 / 屏幕录制授权 + AX 逐应用不稳定，会把“布局成功率”压到不可交付；第二风险是官方 CUA 直接吸收 display/window ops。

## 1. 名字与可用性（2026-11-20 实测）
| 候选 | npm | GitHub | 结论 |
|---|---|---|---|
| **`dsh-stage`** | **404 ✅** | `PerryLink/dsh-stage` 404；全站搜索 API 未认证限流，未完成 | **采用**（舞台 = 窗口摆放） |
| `dsh-screen` | 0.1.0 ❌ williamjinq | macOS 屏幕记忆，语义相邻 | 冲突，弃 |
| `dsh-layout` | 0.9.1 ❌ LINGTIAN303 | DSH Web UI 左/右栏布局 | 冲突，弃 |
| `dsh-view` | 404 ✅ | 未发现 | 备选，但“view”与 dsh-locator 的视图概念撞车 |
| `@perrylink/dsh-stage` | 404 ✅ | — | 兜底（scoped 降低发现度） |

- **Stage 的语义边界**：窗口的“舞台调度”，不是 macOS Stage Manager，也不是 Web UI 布局；README 首行必须写清，并写 “Not affiliated with DeepSeek”。
- **抢注**：npm 404 不等于永久可用；发布前 24h 再核一次，先发 0.0.1 占名。GitHub 全站可能有私有同名仓，但不影响 npm 标识。

## 2. 一句话 / 问题 / 用户
**一句话**：把桌面当舞台——一次调用看清显示器/窗口/Space 拓扑，把一组窗口摆到命名 zone，验证成功后返回可撤销 token。
**问题**：CUA 只能逐 app 授权枚举窗口，且只给 bounds；没有 display/DPI/全局列表/前台/z-order，也没有 move/resize/layout。多显示器 + 混合 DPI 下，agent 的坐标与点击天然错位；用户手工摆窗不可复现；企业无法标准化与审计。
**用户**：① CUA/agent 用户（dsh-click 7,414/月、dsh-locator 8,911/月的存量盘）；② 多显示器专业用户（设计/开发/金融/视频）；③ 企业 IT（固定工位布局、策略、审计）；④ 插件作者（消费 `ctx.stage`，把布局写进 recipe）。

## 3. 范围与非目标
**范围**：显示器/work area/DPI/scale 枚举；全局窗口列表（z-order、前台、最小化/最大化/全屏、Space 归属只读）；窗口 move/resize/snap；命名 zone 与布局预设；批量 apply + dry-run + 验证 + 撤销；布局 profile；6 个 action（含 2 个只读）；5 个工具；CLI；Client 拓扑面板；本地审计导出。
**非目标**：常驻平铺 WM / 每应用规则引擎 / 窗口装饰 / 手势热键产品；截图、OCR、点击、输入合成（CUA、dsh-click、Snip 的领地）；AX 内容索引（`ui_find` 是另一条线，04 号文档排第二）；显示模式/分辨率/排列修改（`SetDisplayConfig` 会黑屏，风险过高）；Space 写入与 Stage Manager 控制（私有 SPI + SIP，见 §7）；Wayland 全局控制；Linux（v0.3）；远程桌面/多用户会话。

## 4. 架构
### 4.1 分层
```
Client (React)                Host (Cordis)                     Native helper
拓扑图 / zone 覆盖 / diff  ⇄RPC  ctx.stage Service           ⇄JSONL  macOS: Swift .app (AX + CG)
undo 倒计时 / 策略提示           对象 / zone / 布局引擎 / policy / 审计     Windows: PS1 + C# (Win32)
                                 tools + actions + CLI(bin)
```
Host 只做编排与校验，OS 调用全部在 helper；helper 可替换（fake adapter 用于单测），不把 native 代码塞进内核。

### 4.2 对象模型（均继承基类）
```ts
interface StageObject { id; owner; scope: 'global'|'workspace'|'session'; createdAt; updatedAt; expiresAt?; auditRef? }
type Rect = { x; y; w; h; unit: 'pt'|'px'; displayId; scale }      // 不做隐式换算
interface Display extends StageObject { nativeId; name; bounds: Rect; workArea: Rect; scale; rotation; primary; mirror; topologyHash }
interface Space extends StageObject { displayId; index; current; kind: 'desktop'|'fullscreen'|'stage-manager' }
interface WindowRef extends StageObject { nativeId; pid; appId; bundleId?; exePath?; processStart; titleHash?; rect: Rect; displayId; spaceId?; z; focused; minimized; maximized; fullscreen; resizable; generation }
interface Zone extends StageObject { profileId; name; displayId?; rectPct: {x,y,w,h}; gap? }
interface LayoutProfile extends StageObject { name; zones: Zone[]; bindings?: { appId, zone }[] }
interface Placement extends StageObject { windowId; before: Rect; after: Rect; verified; undoToken?; failure? }
```
- `WindowRef` 是**观察快照**：`expiresAt = observedAt + 2s`，`generation` 每次观察 +1；身份 = `pid + processStart + bundleId/exe + nativeId`，防 hwnd/CGWindowID 复用。
- `Zone` 永远相对 **workArea**（macOS 菜单栏/Dock、Windows 任务栏之外），不相对 bounds；profile workspace-scoped 可随仓库共享，持久化在 profile state 的 `stage/profiles.json`。
- `Space` 是 best-effort：只给“已知窗口的归属 + 当前 Space”，不承诺枚举空 Space；私有 SPI 缺失时返回 `null`（未知），不是空数组。
- 只读对象（Display/Window/Space）也带 `auditRef`；TTL 过期即拒绝写入，强制重新观察。

### 4.3 `ctx.stage` seam / tools / CLI / UI
```ts
interface StageService extends Service {
  displays.list(): Promise<Display[]>
  windows.list(q?: { display?, app?, visible? }): Promise<WindowRef[]>
  spaces.list(): Promise<Space[]>
  resolve(ref: string): Promise<WindowRef | null>
  place(ref, target: { zone } | { rect }, opts?): Promise<Placement>
  layout.apply(a: Assignment[], opts?: { dryRun?, verify? }): Promise<LayoutResult>
  undo(token: string): Promise<UndoResult>
  doctor(): Promise<Diagnostics>
}
```
- **Tools**：`stage_displays`、`stage_windows`（read，免审批）；`stage_layout_apply`、`stage_layout_undo`（exec/write，走 approval + Grant）；`stage_doctor`（read）。
- **CLI**：`dsh-stage displays|windows|spaces|apply <json>|undo <token>|export --since 7d`；`apply` 支持 `--dry-run`，退出码区分 `DENIED / UNSUPPORTED / PARTIAL`。
- **Client UI**：`Mod+Shift+L` 面板（W3 实测冲突，冲突则降级 CLI）——显示器拓扑 + zone 覆盖层 + 窗口 chip + 前后 rect diff + undo 倒计时；**不显示截图、默认不显示标题**（隐私）。
- **事件**：`stage/topology-changed`、`stage/layout-applied`、`stage/undo`，写 session plugin record，供 Trace/Act 回执引用。

### 4.4 平台适配
| 能力 | macOS | Windows 10/11 | Linux X11（v0.3） | Wayland |
|---|---|---|---|---|
| 显示器/DPI | NSScreen / CGDisplay；`backingScaleFactor` | `EnumDisplayMonitors` + `GetDpiForMonitor` | RandR / Xinerama | `wl_output`，无全局坐标 |
| 窗口枚举 | `CGWindowListCopyWindowInfo`；标题需屏幕录制 | `EnumWindows` + `DWMWA_EXTENDED_FRAME_BOUNDS` | EWMH `_NET_CLIENT_LIST` | ✗（仅 wlr-foreign-toplevel 等 per-compositor） |
| move/resize | AX `kAXPositionAttribute` / `kAXSizeAttribute` | `SetWindowPos` + `SWP_NOACTIVATE` / `SWP_NOZORDER` | `XMoveResizeWindow` / EWMH | ✗ xdg-shell 无 set_position |
| Space | 只读：私有 SkyLight SPI（与 CUA 同源） | `IVirtualDesktopManager` 只读 | EWMH `_NET_CURRENT_DESKTOP` | ✗ |
| focus | `AXRaise` / activate（可能切 Space） | `SetForegroundWindow`（前台锁） | EWMH `_NET_ACTIVE_WINDOW` | ✗ |
| 权限 | 辅助功能 + 屏幕录制（仅为标题） | 无提示；UIPI/提权边界 | 无隔离（写默认关闭） | n/a |

- macOS 的 Space 读取依赖 `SkyLight` 私有符号 `SLSManagedDisplayGetCurrentSpace` 等（`WindowSpaces.swift:39-50`），SPI 缺失时 `spaceId=null`，**绝不猜**；写 Space 不做（yabai 需关 SIP，[证据](https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection)）。
- Windows 复用 dsh-click 的 PS1+C# helper 协议（55KB，已含审批/审计），不引入 native binary、不写注册表；枚举前 `SetThreadDpiAwarenessContext(PMv2)`。

### 4.5 布局与 zone
- 预置：left/right/top/bottom、thirds、quadrants、2×2 grid、center-80%、自定义百分比 rect；`gap` 按显示器 scale 取整。
- `plan(assignments, topology, zones) → { placements, warnings }` 是**纯函数**：同 zone 冲突、窗口不在目标 Space、显示拓扑变化都在这里报；`dryRun` 与 `preview` 共用，单测无需 OS。
- 取整：整数 native 单位，最后一列/行吸收余数，避免 1px 缝；验证以“实际 rect 与 plan 差 ≤1 native 单位”为准。

### 4.6 与 CUA 的坐标 / DPI 对齐
- **坐标系**：平台全局窗口空间（macOS 主屏左上、y 向下、允许负坐标；Windows 虚拟屏），每个 rect 必带 `unit/scale/displayId`；不假设全屏 2×。
- macOS 的 AX/CG 窗口 bounds 是 **points**，截图是 **pixels**（`cua-macos/README.md:187`）；Stage 同时返回 `native`（points）、`physical`（px）与 `captureScale`，消费方不得自行乘 2。
- Windows 用 PMv2 + `DWMWA_EXTENDED_FRAME_BOUNDS`（可见边框，`Windows.cs:59-61`），与用户所见/截图一致；不用 `GetWindowRect` 的隐形边框。
- 跨屏混合 DPI 的窗口：标 `SPANS_DISPLAYS`，按重叠面积归主屏，严格容差只对完全落在单屏的窗口生效。
- Stage 的 ref 与 CUA 的 windowId **不互通**；Act 用 `{kind:'window', ref}` 引用 Stage，CUA 目标仍由 CUA 自己解析。

## 5. 与 Act / Allow 的组合
| action | risk | Grant capability | undo |
|---|---|---|---|
| `stage:window-place` | exec | `stage.window.move`（scope: app/display） | ✅ 10 分钟 |
| `stage:layout-apply` | exec | `stage.layout.apply`（scope: display 集合） | ✅ 整批 |
| `stage:layout-undo` | write | `stage.layout.undo` | — |
| `stage:window-focus` | exec | `stage.window.focus` | 尽力恢复，不承诺 |
| `stage:display-list` / `stage:window-list` | read | — | — |

- **一次布局 = 一个 action = 一次审批**，不是每窗一次；`preview` 返回 dry-run 的 before/after 表与不可放置原因；回执里带 `undoToken`，Act 的 undo 直接调 `layout_undo`。
- **写前必查 Grant**：`ctx.grants.check({capability, scope})`；无 Grant → 请求或拒绝（`never` 不弹窗）；standing Grant 必须带 `expiresAt`，只对显式 app/display allowlist 生效。
- **Stage 给 Act 提供目标对象**：`WindowRef → {kind:'window', ref, appId, displayId, bounds, observedAt}`；Act 调 `ctx.stage.resolve(ref)`，过期/身份不符 → `STALE_REF`，**绝不按标题重新猜窗口**。
- **反向要求**：Stage Client UI 的“应用布局”按钮走 `ctx.actions.invoke('stage:layout-apply')`，共享审批/回执；Act 缺失时降级为内置一次性确认，并在 UI 标注“无 Act，无持久授权”。
- **跨文档修正**：`01-act.md:121,148` 写的是 `ctx.windows` 且“只有 focus 可 undo”；本设计以 `ctx.stage` 为准，place/layout 可 undo、focus 不承诺。实现期给 `ctx.windows` 一个 minor 别名，并回改 Act 文档（不要两边各写一套）。
- **事件联动**：`stage/layout-applied` 供 Trace 写审计、供 Trigger 做“任务结束还原布局”的触发源；Stage 不自己发通知。

## 6. 权限与安全
- **macOS 双 TCC**：辅助功能（AX 读写）+ 屏幕录制（仅窗口标题；无权限则只给 owner/几何）。Stage helper 默认是独立 `.app`，**CUA helper 的授权不会自动继承**——这是 onboarding 的第一道坎，必须做 `stage_doctor` 引导 + 稳定签名 + 公证 + 企业 MDM PPPC。
- **Windows**：同用户会话即可，不需要管理员；UIPI 挡住提权窗口（`ELEVATED`），UWP/packaged 可能拒绝；绝不请求提权。
- **X11**：任何客户端都能控制任何窗口，没有 per-app 授权；写操作默认关闭，需 `--allow-x11-write` + Grant，并在 UI 明示。
- **Wayland**：明确拒绝 `WAYLAND_UNSUPPORTED`；portal 不提供任意窗口 move，不假装支持。
- **跨应用控制**：默认不抢焦点——不用 `activate` / `AXRaise` / `SetForegroundWindow`，`SetWindowPos` 加 `SWP_NOACTIVATE`；仅 `stage:window-focus` 可显式前台，且审批里写明“可能切 Space”。
- **误操作回滚**：`UndoRecord` 存 before rect + 原 show 状态，TTL 10 分钟；撤销前校验身份 + 当前 rect 是否仍等于 after（容差内），用户已移动 → `SKIPPED_USER_MOVED`，窗口已关 → `WINDOW_GONE`；只撤几何，不承诺应用内容。
- **审计**：`stage/audit.jsonl` 本地落盘，记录 actionId、grantId、appId、displayId、before/after、verified、token；标题默认只存 hash（allowlist 可存明文）；`dsh-stage export` 导出；无网络、无遥测。
- **限额**：单次 ≤20 窗、≤10 次/分钟、settle 预算 500ms；helper 崩溃后 pending 标 `UNKNOWN`，不自动重试。

## 7. 失败模式
| 场景 | 检测 | 响应 |
|---|---|---|
| AX 拒绝/不支持 | `kAXErrorAttributeUnsupported` / `kAXErrorCannotComplete` | `AX_UNSUPPORTED`，跳过并给 app 级 recipe 建议，不静默 |
| 全屏 / Stage Manager | 全屏标记、AX 与可视 frame 不一致 | `FULLSCREEN` / `TRANSFORMED`，不移动；提示人工退出 |
| 窗口动画竞态 | 轮询 bounds 至连续 2 次稳定或 500ms | `VERIFY_TIMEOUT`，重试 1 次后报实际 rect，不谎报成功 |
| DPI 取整/混合缩放 | 与 plan 差 >1 native 单位 | `VERIFY_MISMATCH` + 实际值；跨屏窗口按 `SPANS_DISPLAYS` 处理 |
| 最小化/最大化 | show 状态 | 默认拒绝（`MINIMIZED`）；显式 `--restore` 才还原，记录原状态供 undo |
| 句柄复用 | 身份四元组 + generation 不符 | `STALE_REF`，要求重新观察 |
| 显示热插拔/排列变化 | `topologyHash` 变化 | `TOPOLOGY_CHANGED`，中止整批，重读后再来 |
| 应用退出 | 窗口消失 | `WINDOW_GONE`，返回 partial + 已应用部分的 undo token |
| helper 崩溃/超时 | 心跳/JSONL 超时 | `HELPER_TIMEOUT`，kill + 退避重启；pending 标 `UNKNOWN` |
| Space SPI 缺失 | 私有符号加载失败 | `spaceId=null`，不推断；Space 写入 → `SPACE_UNSUPPORTED` |
| Wayland | `XDG_SESSION_TYPE` | `WAYLAND_UNSUPPORTED`，给 X11/受支持 compositor 说明 |
| 提权/UWP | 访问拒绝/包身份 | `ELEVATED` / `PACKAGED`，批量中跳过并如实报告 |

## 8. MVP 4 周（macOS 优先，Windows 次之）
**与 04 号文档的冲突要说清**：04 号建议 Windows-first（复用 dsh-click helper、4 周可发）；本设计按产品线口径 macOS 优先，理由：① 多显示器/混合 DPI/Spaces 的痛点在 macOS 专业用户更集中，Rectangle/Magnet 证明这是成熟品类（Magnet 付费、Rectangle 免费 + Pro）；② Windows 已有 Windows-MCP（单窗口）、dsh-pilot、dsh-click，正面更卷；③ macOS 没有 DSH 原生布局插件。**代价**：Stage 需自建 Swift helper + TCC/公证，前两周风险最高。

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | 对象/seam 骨架 + fake adapter + macOS 只读（displays/windows/doctor） | 2 屏 Retina、负坐标、20 窗；p95 <200ms；无屏幕录制时标题优雅降级 |
| W2 | Swift `.app` helper：AX place/verify/undo；TCC 引导；失败分类 | 5 app × 3 zone 成功率 ≥95%；可撤销样本 undo 100%；拒绝路径全部有码 |
| W3 | zone/布局引擎 + dry-run + profile；Client 面板；6 个 action + Grant；CLI | 2 屏 3 窗整批布局；dry-run 与实摆一致；未授权写 = 0 |
| W4 | Windows adapter（只读 + 非提权 place，experimental flag）；3 屏混合 DPI E2E；文档/demo；0.1.0；上游 RFC | 3 屏（100/150/200%）误差 ≤1px；安装/卸载干净；RFC 发出 |

**止损线**：W2 末 macOS AX 成功率 <90%，或 TCC 引导导致 ≥50% 内测用户拿不到权限 ⇒ 按 04 号文档 pivot Windows-first，macOS 只保留只读 0.1。
**MVP 不做**：Space 写、Linux、显示模式、OCR、完整 WM；Windows 全量对齐放 v0.2（第 5–6 周）。

## 9. 指标与验证
- **北极星**：每周“验证通过的布局执行次数”（去重用户）——衡量真实调度，不衡量安装。
- **质量护栏**：verified/applied ≥98%；静默失败 = 0；拒绝精度 100%；可撤样本 undo ≥99%；p95 3 窗 ≤300ms、10 窗 ≤800ms；崩溃自由会话 ≥99.5%；helper 崩溃率 <0.1%（会话）。
- **多显示器**：活跃安装中 ≥40% 使用 ≥2 屏；≥50% 的布局跨屏；混合 DPI 占比单列（企业报表用）。
- **采用**：安装 → 首次布局 <10 分钟 ≥50%；第 4 周留存 ≥25%；人均 ≥3 次布局/周；Mac 辅助功能授权完成率 ≥80%（屏幕录制可选，约 50% 可接受）。
- **验证方法**：布局引擎 fake-adapter 单测 100% 覆盖；3 屏实验室（2560×1440@100 / 1920×1080@150 / 3840×2160@200）+ 8 个 app（Finder/Safari/Terminal/Chrome/VS Code/Excel/Notepad/Explorer）；2 周 dogfood + 10 名外部 beta；对比手工摆窗耗时（目标 3×）。
- **隐私**：指标默认本地，导出需显式 opt-in；审计不含明文标题；不采集截图。

## 10. 打包与变现
- **免费核心（MIT）**：只读拓扑、6 类预置 zone、3 窗布局、10 分钟 undo、CLI、审计导出——足够日常“摆好再操作”。
- **Pro（$29 买断 / $4 月）**：无限窗/屏、自定义 zone、布局 profile、per-app recipe、90 天历史、JSON 导入导出。
- **Team（$8–12/座/月）**：签名共享 profile、策略文件（允许的 app/display、最大窗数）、SIEM 审计导出、MDM PPPC、按角色的审批（复用 Allow Grant）。
- **Enterprise（年费/自托管）**：离线审计归档、私有策略分发、合规报告；不锁核心能力。
- **分发**：npm `dsh-stage` + bundle；DSH Market；macOS 公证 helper + 可选 Homebrew cask；Windows 先随 dsh-click 0.4 分发（7.4k/月存量），稳定后独立；demo GIF 必须一眼看出“多屏 + 混合 DPI + undo”。

## 11. 风险 / 开放问题
| 风险 | 级别 | 缓解 |
|---|---|---|
| 官方 CUA 直接做 display/window ops | 高 | 不做薄封装：布局/验证/undo/审计/跨平台；先插件后 RFC，随时退为 provider |
| macOS TCC/公证/私有 SPI 卡住上线 | 高 | 写只用公开 AX；私有只做只读且可空；签名/公证预算 2 周；MDM 预案 |
| Wayland/Linux 预期落空 | 中 | 明确 unsupported，X11 v0.3 再做；文档不暗示“跨平台已支持” |
| Windows-MCP / Rectangle 免费替代 | 中 | 卖 agent 原生 + 批量 + 验证 + 审计，不卖热键/动画 |
| AX 逐应用不稳定 | 中 | 失败分类 + recipe 库 + beta 覆盖；绝不静默失败 |
| 审批疲劳 / 权限摩擦 | 中 | 一次批量审批 + allowlist + standing Grant；doctor 引导 |
| undo 反而打断用户 | 中 | 身份 + rect 双校验、10 分钟 TTL、用户已移动则跳过 |
| 与 Act 文档的 seam 命名漂移 | 低 | 以 `ctx.stage` 为准 + 别名，W3 回改 `01-act.md` |
| 企业付费意愿未验证 | 中 | 免费核心先跑量；10 个 beta 访谈再定价 |

**开放问题**：① Space 是否永远只读（写需关 SIP，产品上是否值得）？② 显示模式/排列是否永远不做（企业工位切换可能是真需求）？③ focus 归 Stage 还是 CUA/Act？④ helper 走独立 Swift app 还是做成 CUA provider？⑤ 与 CUA 的坐标契约要不要向上游提 RFC？⑥ 先独立发还是先绑 dsh-click？⑦ Linux 优先级是否低于 Spaces 只读？

## 12. 证据索引
**内部研究**：`01-research/dsh-os-primitives-2026-11-20/04-window-display.md:4-6`（结论）、`:34`（CUA 已有/缺失）、`:53-63`（生态盘点）、`:136`（排序理由）、`:156-168`（原 Windows MVP）；`01-act.md:121,148`（seam 命名与 undo 表述，需对齐）。
**DSH 源码**（`/home/yy/deepseek-harness`，`0.2.2-rc.4`，`ca33fd6`）：`docs/capability-seams.md:719`（computerUse 无公共 action API）；`packages/computer-use/computer-use/README.md:34`（只有 `register(name)`）；`cua-macos/README.md:187`（bounds=points、截图=pixels、show 不切 Space、Stage Manager 几何缩减）；`native/Sources/CuaNative/NativePlatform.swift:133,136,145-154`（AX/屏幕录制门禁 + CGWindowList 枚举）；`WindowSpaces.swift:12,39-50`（私有 SkyLight SPI）；`cua-windows/native/entry/Windows.cs:59-61`（DWMWA_EXTENDED_FRAME_BOUNDS + GetDpiForWindow）；`Protocol.swift:142-154`（onCurrentSpace 可空）。
**npm/GitHub**（2026-11-20）：https://www.npmjs.com/package/dsh-stage（404）｜https://www.npmjs.com/package/dsh-screen（0.1.0，williamjinq）｜https://www.npmjs.com/package/dsh-layout（0.9.1，LINGTIAN303）｜https://www.npmjs.com/package/dsh-click（0.3.31，7,414 last-month）｜https://www.npmjs.com/package/dsh-locator（0.19.4，8,911）｜https://github.com/PerryLink/dsh-stage（404）｜https://github.com/PerryLink/dsh-click（26★）。
**外部 API**：[AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)｜[AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted)｜[Quartz Window Services](https://developer.apple.com/documentation/coregraphics/quartz_window_services)｜[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)｜[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)｜[GetDpiForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getdpiformonitor)｜[xdg-shell（无 toplevel set_position）](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml)｜[wlr-foreign-toplevel（无 move/resize）](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/blob/master/unstable/wlr-foreign-toplevel-management-unstable-v1.xml)｜[yabai: SIP](https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection)｜[Rectangle](https://github.com/rxhanson/Rectangle)｜[Windows-MCP](https://github.com/CursorTouch/Windows-MCP)。
**方法说明**：npm 与目标仓库为直接 404；GitHub 全站搜索因未认证 API 限流（403）未完成，属残留不确定性，发布前再核。
