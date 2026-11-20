# dsh-stage 0.2.0：macOS / Windows / Linux 窗口适配调研

> 2026-11-20 · 基线 DSH `0.2.2-rc.4`（`ca33fd68`）· 目标：0.2.0 先做 macOS 的 `displays/windows/move/resize`（不做 Space），Windows 次之；Linux 留 X11 方案，Wayland 明确不支持；**默认 mock，native 调用必须显式开启**。
> 结论：macOS 可做但依赖双 TCC（辅助功能 + 自动化），Windows 可做但 DPI/可见边框/UIPI 三个坑必须处理；两者都不引入 native binary，先以 `osascript` / `powershell.exe` 子进程落地。
> 验证边界：Windows 只读探针已在本机（WSL→PS 5.1）跑通；macOS 未实机，代码路径基于公开 API/社区实证，M2 必须复测。

## 0. 平台结论

| 平台 | 0.2.0 | 读 | 写 | 权限/门槛 | 结论 |
|---|---|---|---|---|---|
| macOS | **先做** | JXA+AppKit 读屏；JXA+System Events（或 AX）读窗 | System Events `position/size` | 辅助功能 + 自动化；免屏幕录制 | 可做，TCC 是主风险 |
| Windows | 次之 | PowerShell 5.1 + `Add-Type` 调 user32 | `SetWindowPos` + DWM 边框补偿 | 同完整性级别，无需管理员；UIPI/UWP 受限 | 可做，DPI/边框是主坑 |
| Linux X11 | 0.3 | `wmctrl -lpG` / `xdotool` | `wmctrl -ir -e` / `xdotool` | 无隔离，写默认关闭 | 可做但不进 0.2.0 |
| Wayland | 不做 | 仅 XWayland 窗口且不完整 | ✗ | — | 明确 `wayland_unsupported` |

## 1. macOS：AXUIElement 通过 JXA / osascript

**可行性：可做，但“读”和“写”要分开走。** 读窗/读屏有公开 API；写窗用 System Events 的脚本属性（底层仍是 AX），直接 `AXUIElementSetAttributeValue` 作为后备实验。

- **读**：JXA 的 ObjC 桥可直连 AX（`AXUIElementCreateApplication` / `AXUIElementCopyAttributeValue`，[summerwind](https://blog.summerwind.jp/posts/20241020/)），但 0.2.0 为少写一套 ObjC 解包，读窗也先用 System Events；屏幕用 `NSScreen.screens`。
- **写**：`AXUIElementSetAttributeValue` 需要 `AXValueCreate` 包 `CGPoint/CGSize`，JXA 的 C 结构桥没有稳定文档；0.2.0 主路径用 System Events：`window.size.set([w,h])` / `window.position.set([x,y])`（[SO 示例](https://stackoverflow.com/questions/72434914/jxa-manipulating-windows-by-their-id)）。
- **权限**：`AXIsProcessTrustedWithOptions` 的 `kAXTrustedCheckOptionPrompt` 异步弹窗（[Apple](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)），授权对象是**负责进程**（通常是运行 node 的 Terminal/iTerm/DSH app，某些场景是 `/usr/bin/osascript`），不是 `.js` 文件；`sudo` 不绕过。TCC 归属绑定可执行体，app 更新/换签名后可能静默失效（[Orca PR](https://github.com/stablyai/orca/pull/12848)）；生产别让用户给 Terminal 长期授权，应给独立签名的宿主 app。
- **双 TCC**：System Events 还触发 **Automation**（“Terminal 想控制 System Events”；headless/launchd 可能直接 `-1743`）。0.2.0 需辅助功能 + 自动化两次授权；不读标题就不需要屏幕录制。
- **坐标**：AX 全局坐标原点 = 菜单栏屏左上角，y 向下，可为负（[kAXPositionAttribute](https://developer.apple.com/documentation/applicationservices/kaxpositionattribute)）；`NSScreen.frame` 是左下原点、y 向上，换算 `yAX = primaryH - yNS - hNS`。`visibleFrame` 已扣菜单栏/Dock，作 workArea；JXA 在副屏取 `visibleFrame` 与 Swift 有差异（[SO](https://stackoverflow.com/questions/79599169/getting-macos-usable-screen-area)），需实测/夹取。
- **DPI**：AX bounds 单位是 point；`backingScaleFactor` 为 1/2；adapter 只报 `dpi = 96*scale` 元数据，不做隐式像素换算。窗口 `displayId` 按与各屏 workArea 的最大重叠面积归属，跨屏标 `spanning`。
- **窗口身份**：公开 API 没有 AXUIElement→CGWindowID；0.2.0 用 `mac:<pid>:<index>` + 快照 bounds + `generation`，写前重读，变了就 `stale_window`；绝不按标题重找。标题默认不取，最多返回 `titleHash`。
- **限制**：System Events 每个属性一次 Apple Event，20 窗可能 1–3s；全屏/最小化/Stage Manager 跳过；Electron 可能要 `AXManualAccessibility`；Focus 只做不抢 Space 的 `AXRaise`，`activate` 默认关。
- **Space**：没有公开可编程 API；读当前 Space 依赖私有 SkyLight SPI，写需关 SIP / 注入 Dock（[yabai](https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection)、[讨论](https://github.com/asmvik/yabai/discussions/2274)）。0.2.0 `spaces()` 返回 `[]`，`capabilities().spaces=false`。

**命令与 JXA 骨架**（脚本文件随包发布，参数走 argv，stdout 只输出 JSON）：

```text
osascript -l JavaScript <pkg>/adapters/macos/jxa/read.js '{"op":"windows"}'
```

```js
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function run(argv) {
  const req = JSON.parse(argv[0] || '{}')
  if (req.op === 'trusted') return JSON.stringify({ trusted: !!$.AXIsProcessTrusted() })
  const primaryH = $.NSScreen.screens.js[0].frame.size.height
  const screens = $.NSScreen.screens.js.map((s, i) => {
    const f = s.frame, v = s.visibleFrame
    return { id: 'nsscreen:' + i, x: f.origin.x, y: primaryH - f.origin.y - f.size.height,
      w: f.size.width, h: f.size.height, wx: v.origin.x, wy: primaryH - v.origin.y - v.size.height,
      ww: v.size.width, wh: v.size.height, scale: s.backingScaleFactor }
  })
  return JSON.stringify({ screens })
}
```

```js
const rows = [], se = Application('System Events')
for (const p of se.applicationProcesses.whose({ backgroundOnly: false })()) {
  for (const [i, w] of p.windows().entries()) {
    const pos = w.position(), sz = w.size()
    rows.push({ id: `${p.unixId()}:${i}`, pid: p.unixId(), x: pos[0], y: pos[1], w: sz[0], h: sz[1] })
  }
}
// 写（同一进程内批量，pid/index 来自快照）：size 先于 position，写完重读
const p = Application('System Events').applicationProcesses.whose({ unixId: pid }).at(0)
const w = p.windows.at(index)
w.size.set([width, height]); w.position.set([x, y])
```

## 2. Windows：PowerShell + `Add-Type` 调 user32

**可行性：可做，同完整性级别无需管理员。** 一个 PowerShell 进程内 `Add-Type` 编译 C# P/Invoke，完成 DPI 设置→屏幕→窗口→写入→验证；批量调用只付一次启动/编译成本。

- **API**：`EnumWindows` / `GetWindowThreadProcessId` / `GetWindowRect` / `DwmGetWindowAttribute`（失败回退 `GetWindowRect`）/ `SetWindowPos`（`SWP_NOACTIVATE / SWP_NOZORDER`）/ `ShowWindow`；屏幕用 `EnumDisplayMonitors` + `GetMonitorInfo`，DPI 用 `GetDpiForMonitor` / `GetDpiForWindow`。
- **DPI**：启动即 `SetProcessDpiAwarenessContext(-4)`（PMv2），必须早于任何窗口/屏幕 API；失败则查 `GetThreadDpiAwarenessContext`，必要时 `SetThreadDpiAwarenessContext(-4)`。否则坐标被 DPI 虚拟化（[文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)）。
- **本机只读探针**（2026-11-20，Win11 26200，PS 5.1）：2 屏 3840×2160 / 2560×1600，均 144dpi；`EnumWindows` 184 个顶层窗、15 个可见；`GetWindowRect` 与 `DWMWA_EXTENDED_FRAME_BOUNDS` 实测某窗口在 150% 下每边差 11px（逐窗/逐样式不同，写前现测 inset）。⇒ 观察用 DWM 可见框，写 `SetWindowPos` 前按当前 inset 外扩补偿，否则布局整体内缩。
- **多屏/坐标**：`GetMonitorInfo.rcWork` 是 workArea；虚拟屏幕坐标可为负；窗口跨屏按重叠面积归主屏。`GetWindowRect`/`SetWindowPos` 用同一“窗口外框”空间，别混客户区；`GetDpiForMonitor` 对 per-monitor aware 线程不是首选，窗口级用 `GetDpiForWindow`。
- **权限**：无需提权；UIPI 使中完整性进程无法改高完整性窗口（`SetWindowPos` 返回 0 / `ERROR_ACCESS_DENIED=5`），不要自动 UAC；UWP/packaged 常见 `ApplicationFrameHost` 代理，标 `packaged` 并跳过；最小化/最大化默认跳过，显式 restore 才 `ShowWindow(SW_RESTORE)`（会激活，需单独授权）。`SetForegroundWindow` 受前台锁限制，`focus()` 只能 best-effort。
- **Space**：`IVirtualDesktopManager` 可读当前桌面，跨虚拟桌面移动是未公开 COM，0.2.0 不做。
- **风险**：PowerShell 启动 + `Add-Type` 约 0.5–1.5s（每进程一次）；企业 GPO 可能禁 `Add-Type`/ConstrainedLanguage/ExecutionPolicy；PS 5.1 用 C# 5 语法。`-EncodedCommand` 有 32K 命令行上限，生产用 `-File`，被策略拦时明确报 `policy_blocked`。
- **命令**：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <pkg>/adapters/windows/win.ps1`；请求 JSON 走环境变量（base64），stdout 只输出 `ConvertTo-Json -Compress`，UTF-8，`$ProgressPreference='SilentlyContinue'`。

## 3. Linux：X11 有路，Wayland 没有

- **X11/EWMH**：`wmctrl -lpG` 按固定 8 列解析 id/desktop/pid/x/y/w/h/host，余下整段 title 立即丢弃，不落日志/不返回；`wmctrl -ir <id> -e 0,x,y,w,h` 移动+resize；`wmctrl -ia <id>` 聚焦；`wmctrl -d` 读桌面。`xdotool getwindowgeometry/windowmove/windowsize/windowactivate`（按窗口 id，不用 `search --name`）可替代，依赖 WM 支持 EWMH（[wmctrl](https://manpages.debian.org/bookworm/wmctrl/wmctrl.1.en.html)、[xdotool](https://manpages.debian.org/bookworm/xdotool/xdotool.1.en.html)）。
- **X11 安全**：没有 per-app 授权，任何客户端可控制任何窗口 ⇒ 写默认关闭，需 `DSH_STAGE_ALLOW_X11_WRITE=1` + 显式目标。
- **Wayland**：`xdg-shell` 的 `move` 是用户交互式移动（需 seat/serial），没有 `set_position`；`wlr-foreign-toplevel` 有 activate/close/maximize/fullscreen，但没有绝对 move/resize（[xdg-shell](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml)、[wlr](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/blob/master/unstable/wlr-foreign-toplevel-management-unstable-v1.xml)）。`xdotool` 只能碰 XWayland 窗口。检测到 `XDG_SESSION_TYPE=wayland`/`WAYLAND_DISPLAY` 直接 `wayland_unsupported`，不静默降级。
- **0.2.0**：不实现 Linux；`linux.js` 只做检测 + `capabilities` 占位，0.3 再做 X11。WSL 的 `process.platform === 'linux'`，即使能调 `powershell.exe` 也绝不能走 Windows 适配器。

## 4. `StageAdapter` 接口

```ts
type Rect = { x: number; y: number; w: number; h: number }
interface DisplayInfo { id: string; bounds: Rect; workArea: Rect; dpi: number; scale: number; primary: boolean }
interface WindowInfo { id: string; pid: number; displayId: string; bounds: Rect; focused: boolean;
  minimized: boolean; fullscreen: boolean; app: string; titleHash?: string }
interface PlacementResult { ok: boolean; id: string; before: Rect; after: Rect; verified: boolean; code?: string }
interface StageAdapter {
  readonly platform: 'mock' | 'darwin' | 'win32' | 'linux'
  capabilities(): { displays: boolean; windows: boolean; move: boolean; resize: boolean; focus: boolean;
    spaces: boolean; permission: string }
  displays(): Promise<DisplayInfo[]>
  windows(opts?: { displayId?: string; titleHash?: boolean }): Promise<WindowInfo[]>
  move(id: string, rect: Rect): Promise<PlacementResult>
  resize(id: string, size: { w: number; h: number }): Promise<PlacementResult>
  focus(id: string, opts?: { activate?: boolean }): Promise<{ ok: boolean; code?: string }>
  spaces(): Promise<Array<{ id: string; displayId: string; index: number; current: boolean }>>
  doctor(): Promise<{ ok: boolean; platform: string; permission: string; dpiAware?: boolean; warnings: string[] }>
}
```

- 失败统一抛 `StageAdapterError`，`code` 至少覆盖 `unsupported / permission_denied / automation_denied / ax_unsupported / timeout / stale_window / window_gone / fullscreen / minimized / elevated / packaged / wayland_unsupported`。
- `move`/`resize` 分离；`focus` 默认 `activate:false`；`spaces` 不支持时返回 `[]`，由 `capabilities` 说明。

## 5. `adapters/` 目录与接线

```text
packages/stage/adapters/
  index.js          createAdapter()：默认 mock；显式 'auto' 才探测平台
  mock.js           内存 fixture，默认；测试/CI 不 spawn
  macos.js          JXA 桥；macos/jxa/{read,place,trust}.js
  windows.js        PowerShell 桥；windows/win.ps1
  linux.js          仅检测 + unsupported（0.3 再做 X11）
```

- `apply(ctx,{ adapter='mock' })`；`StageService` 增加 `refresh()`（displays/windows/spaces → `setTopology`）与 `applyLayout(name,{execute:false})`（`execute:true` 才 move/resize，默认 dry-run）；`undo()` 用 adapter 恢复 before。
- `createAdapter({ platform, spawn = spawnSync, env })` 注入 spawn，便于 mock；`package.json.files` 加 `"adapters"`，脚本随包发布，fixtures 不发布。

## 6. 安全边界

- **只操作显式目标**：`move/resize/focus` 必须传 snapshot 里的 id；拒绝空 id、通配、`all`；单次 ≤20 窗、≤10 次/分，超时 5s（Windows 8s）。
- **不枚举敏感标题**：`windows()` 不返回 title，默认不取 title；只有显式 `titleHash:true` 才算 sha256；日志/审计只存 id/app/rect，不存标题；macOS 不申请屏幕录制。
- **失败回滚**：先存 before + 身份信息（id/pid/app/bounds）；逐窗写、写后重读验证（≤1 native unit）；任一失败按**逆序**恢复已写窗口；恢复失败返回 `rollback_partial`，绝不报整体成功。用户已移动 → `skipped_user_moved`；窗口已关 → `window_gone`。
- **权限提示**：只在 `doctor()` 主动提示；macOS 打开“隐私与安全性→辅助功能”并打印宿主 app 路径；Windows 不弹 UAC；X11 首次写显式警告。
- **注入/提权**：spawn 用参数数组、`shell:false`，JSON 走 env/stdin；id 正则白名单；不自动提权、不按标题重解析、不重试超过 1 次。

## 7. 测试

- `node --test`；`createAdapter({spawn: fakeSpawn})` 注入 `spawnSync`，fake 返回 `{status, stdout, stderr, error}` 并记录 args/env，断言不出现 `shell:true`、不拼接标题。
- fixtures：`test/fixtures/macos-screens.json`、`macos-windows.json`、`windows-monitors.json`、`windows-windows.json`、`linux-wmctrl.txt`、`wayland.txt`；覆盖负坐标、2x/1.5x、11px inset、UIPI/UWP、超时、权限拒绝、回滚顺序、无 title 字段。
- 平台 smoke：`test('...', { skip: process.platform !== 'darwin' || !process.env.DSH_STAGE_SMOKE }, ...)`，只读 displays/windows，不 move；Windows 同；CI 默认 skip。

## 8. 0.2.0 评估与实施步骤

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 2d | `adapters/` + mock + fixtures + `StageService.refresh()`；默认 mock | 现有测试全绿；不配置时零 spawn |
| M2 3d | macOS displays/windows + doctor + NS→AX 换算 | 2 屏 Retina/负坐标/20 窗可读；3 窗布局 p95 <1.5s；无 title |
| M3 3d | macOS move/resize + 验证 + 回滚；focus raise | 5 app × 2 zone 成功率 ≥90%；undo 100%；失败有码 |
| M4 2d | tool 接线（execute 显式开启）+ 文档 + smoke | 未授权写=0；`stage_layout_apply` 默认 dry-run |
| M5 3d | Windows displays/windows/move/resize | 3 屏混合 DPI；可见框误差 ≤1px；UIPI/UWP 跳过 |

**macOS 实施顺序**：① `read.js`（AppKit 屏 + System Events 窗，`pid:index`）；② `place.js`（size→position→重读，失败 size→position 重试一次）；③ `trust.js` + doctor（辅助功能/自动化/屏幕录制三项分别显示）；④ 回滚与 history 对接；⑤ 2 屏实机 + 5 app 冒烟；⑥ 发布 0.2.0 experimental。

**Windows 实施顺序**：① `win.ps1` 单进程完成 DPI→屏→枚举→写；② DWM 可见框 + inset 补偿；③ HWND 白名单 + UIPI/UWP 分类；④ fixture + Windows-only smoke；⑤ 文档标注 experimental。

**止损**：macOS move 成功率 <90%、TCC 引导失败 >30% 或 p95 >2s ⇒ 退回只读 0.1 行为，转 native Swift helper；Windows 可见框误差 >2px 或 GPO 禁 `Add-Type` ⇒ 标 experimental 并只保证读。

## 9. 参考

- Apple：[kAXPositionAttribute](https://developer.apple.com/documentation/applicationservices/kaxpositionattribute) · [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) · [AXUIElementCopyAttributeValue](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue) · [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) · [AXValueCreate](https://developer.apple.com/documentation/applicationservices/1459351-axvaluecreate) · [NSScreen.visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe) · [NSScreen.backingScaleFactor](https://developer.apple.com/documentation/appkit/nsscreen/backingscalefactor)
- JXA/社区：[summerwind JXA+AX](https://blog.summerwind.jp/posts/20241020/) · [JXA window by id](https://stackoverflow.com/questions/72434914/jxa-manipulating-windows-by-their-id) · [副屏 visibleFrame](https://stackoverflow.com/questions/79599169/getting-macos-usable-screen-area) · [TCC attribution](https://github.com/stablyai/orca/pull/12848) · [yabai SIP](https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection)
- Microsoft：[EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows) · [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect) · [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) · [DWM extended frame](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute) · [DPI awareness](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext) · [GetDpiForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getdpiformonitor) · [SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) · [IVirtualDesktopManager](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ivirtualdesktopmanager)
- Linux：[wmctrl](https://manpages.debian.org/bookworm/wmctrl/wmctrl.1.en.html) · [xdotool](https://manpages.debian.org/bookworm/xdotool/xdotool.1.en.html) · [EWMH](https://specifications.freedesktop.org/wm-spec/latest/) · [xdg-shell](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml) · [wlr-foreign-toplevel](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/blob/master/unstable/wlr-foreign-toplevel-management-unstable-v1.xml)
