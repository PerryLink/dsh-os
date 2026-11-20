# Stage · `dsh-stage`

> **Topology before action.** Read displays, windows and spaces, describe layouts
> as display-relative zones, and apply them as recorded, undoable intent.

**Status: 0.2.0 adds experimental native adapters.** Stage can now observe a
real desktop and move/resize explicit window ids on macOS and Windows, or run
the same code paths against an in-memory mock. Native calls are **opt-in**: a
fresh mount selects the mock adapter and `stage_live_*` refuses with
`E_UNAVAILABLE` until `useAdapter()` or the `adapter` config arms one.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners. "Stage" here means arranging windows as a stage; it
is unrelated to Apple Stage Manager.

## Platform matrix

| Platform | Displays | Windows | Move / resize | Permission | 0.2.0 |
|---|---|---|---|---|---|
| macOS 13+ | JXA + AppKit `NSScreen` | System Events (AX) | System Events `position` / `size` | Accessibility **and** Automation (TCC); no Screen Recording | experimental |
| Windows 10/11 | `EnumDisplayMonitors` | `EnumWindows` + DWM visible frame | `SetWindowPos` with PMv2 DPI awareness | same integrity level; no admin; UIPI/UWP can deny | experimental |
| Linux X11 | — | — | — | — | not in 0.2.0 (0.3 X11) |
| Wayland | — | — | — | — | not supported |
| mock | fixtures | fixtures | in-memory | none | default / tests |

The macOS adapter talks to System Events through `osascript -l JavaScript`.
The Windows adapter runs one `powershell.exe` process that compiles a small
C# P/Invoke surface with `Add-Type`; it sets
`SetProcessDpiAwarenessContext(-4)` (PMv2) before any window or monitor API.
Neither adapter ships a native binary, and neither reads window titles.

## Install

```sh
dsh plugin --profile web add dsh-stage
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies; the native
scripts are fixed strings inside `lib/adapters/`.

## Adapters

```js
const stage = ctx.get('stage')

stage.adapters()
// [{ name: 'mock', available: true, active: true, ... },
//  { name: 'macos', available: false, ... },
//  { name: 'windows', available: false, ... }]

stage.useAdapter('macos')          // explicit opt-in and availability check
await stage.topologyLive()         // observe displays + windows, then setTopology()
await stage.moveLive('mac:1234:0', { x: 0, y: 25, w: 800, h: 950 })
await stage.resizeLive('mac:1234:0', { w: 1200, h: 900 })
```

Adapters are also listed by the `adapters()` method with `capabilities()`
(`displays`, `windows`, `move`, `resize`, `focus`, `spaces`, `permission`).
The registry is importable from the `dsh-stage/adapters` subpath
(`createAdapter`, `listAdapters`, `StageAdapterError`).
`useAdapter()` throws `E_UNAVAILABLE` for an unknown or unavailable adapter;
on Linux/Wayland only `mock` is usable. `apply(ctx, { adapter: 'macos' })`
arms an adapter at mount time; omitting `adapter` leaves the mock un-armed.

### macOS

- Requires **Accessibility** (AX read/write) and **Automation** permission for
  the process that runs Node (Terminal, iTerm2 or the DSH app) to control
  System Events. Grant both in System Settings → Privacy & Security. Screen
  Recording is not requested and no window title is read.
- Display frames come from `NSScreen` and are converted from AppKit's
  bottom-left origin to the global AX top-left origin (`yAX = primaryH - y - h`).
  `visibleFrame` becomes `workArea`; negative coordinates are preserved.
- Coordinates are points. `dpi` is metadata (`96 * backingScaleFactor`); Stage
  never silently multiplies coordinates by the scale factor.
- Window ids are `mac:<pid>:<index>`. Writes re-read the window and abort with
  `stale_window` when the cached bounds changed. Minimized and fullscreen
  windows are skipped. Spaces are not enumerable without private APIs, so
  `spaces()` returns `[]` and capabilities report `spaces: false`.

### Windows

- No administrator prompt. A medium-integrity process cannot control an
  elevated window (`SetWindowPos` fails, mapped to `E_DENIED`), and UWP
  `ApplicationFrameHost` proxies are skipped.
- The process opts into per-monitor-v2 DPI awareness first; coordinates are
  physical pixels. Window bounds use `DWMWA_EXTENDED_FRAME_BOUNDS` (what the
  user sees). `SetWindowPos` writes the outer window frame, so Stage measures
  the per-window border inset and expands the target before writing; the
  write is read back and verified within 1 px.
- Window ids are `win:<hwnd>` (decimal or `0x` hex). Minimized windows are
  skipped rather than restored. Focus is best-effort and not enabled in
  0.2.0. Spaces are not exposed.
- Corporate policy may block `Add-Type` or script execution; that surfaces as
  `E_UNAVAILABLE` (the adapter does not retry or elevate).

## Safety and privacy

- **Explicit, observed targets only**: `stage_live_move` / `stage_live_resize`
  take one id returned by `stage_live_topology`. `all`, `*`, empty ids and
  malformed ids are rejected with `E_DENIED`; a well-formed id that was never
  observed is refused as `unobserved_window`, both before a process is
  spawned.
- **No title enumeration**: the scripts never call a title API, return no
  `title` field, and errors/logs carry only stable codes and reasons. macOS
  avoids Screen Recording for the same reason.
- **Fixed scripts, no shell**: the JXA/PowerShell programs are constants;
  requests go through a dedicated environment variable as JSON; spawn uses an
  argument array with `shell: false` and a minimal environment. Timeouts are
  5 s (macOS) and 8 s (Windows).
- **Read before write**: the last observed bounds are sent as `expect`; a
  changed window is refused as stale instead of being re-resolved by title.
  Success is reported only after a read-back within 1 native unit.
- **Failure codes**: `E_UNAVAILABLE` (unsupported/unavailable/timeout/process
  failure) and `E_DENIED` (permission, wildcard/implicit target, access
  denied). Live placement results are `{ ok, id, before, after, verified,
  code?, reason? }`.

## Host seam

The bundle provides `ctx.stage`:

```js
const stage = ctx.get('stage')

stage.setTopology({
  displays: [
    {
      id: 'main',
      bounds: { x: 0, y: 0, w: 1600, h: 1000 },
      workArea: { x: 0, y: 25, w: 1600, h: 950 },
      dpi: 96,
    },
  ],
  windows: [
    {
      id: 'editor',
      displayId: 'main',
      bounds: { x: 40, y: 40, w: 900, h: 700 },
      focused: true,
    },
  ],
  spaces: [{ id: 'desk-1', displayId: 'main', current: true }],
})
```

### Topology

- `displays[]`: `id`, `bounds` (`{x, y, w, h}` with positive `w`/`h`) and a
  positive finite `dpi` are required. `workArea` is optional and defaults to
  `bounds`; it is the origin for zones.
- `windows[]`: `id`, `displayId` and `bounds` are required. `displayId` must
  reference a display in the same call. `focused` is an optional boolean,
  default `false`; at most one window may be focused.
- `spaces[]`: `id` and `displayId` are required; `index` is a non-negative
  integer (default `0`) and `current` is a boolean (default `false`). Spaces
  are best-effort metadata and do not affect layout.
- Ids are non-empty strings and unique within their collection. Bounds may
  have negative `x`/`y` (multi-display global space).
- `topology()` returns the current snapshot:
  `{ schema, displays, windows, spaces, topologyHash, observedAt }`.
  `topologyHash` is a 16-hex-character digest of the three collections.
  Before the first `setTopology()` the collections are empty and both
  `topologyHash` and `observedAt` are `null`.
- Bounds and zone results stay in the adapter's native/global coordinate
  units. `dpi` is metadata only; no implicit pixel conversion is performed.
  `topologyLive()` stores the adapter's display/window observations through
  `setTopology()`; adapters may additionally return `scale`, `frame`, `inset`
  and `spanning` for consumers that call the adapter directly.

Errors carry a stable `code`: `invalid_topology`, `invalid_display`,
`invalid_bounds`, `invalid_window`, `invalid_space`, `unknown_display`,
`duplicate_display`, `duplicate_window`, `duplicate_space`,
`duplicate_focus`.

### Layouts

`setLayout(name, { displayId, zones })` creates or replaces a named layout.
Each zone is `{ x, y, w, h }` normalized to `0..1` relative to the display's
`workArea`. Every coordinate must be a finite number within `0..1` — `NaN`,
`±Infinity`, negatives and values above `1` are rejected with `invalid_zone`.
A zone needs positive `w`/`h` and must fit:
`x + w <= 1` and `y + h <= 1`. A layout holds 1 to 20 zones.

```js
stage.setLayout('halves', {
  displayId: 'main',
  zones: [
    { x: 0,   y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
})
```

`layouts()` lists definitions sorted by name. Setting an existing name
replaces it. Definitions can be created before the display is observed; the
display reference is checked again at apply time.

### Apply, history and undo

`applyLayout(name)` requires an observed topology, a registered layout and the
layout's display. It pairs windows on that display with zones in listed order:
the focused window first, then windows in observation order. Extra zones stay
empty and extra windows are untouched. The call returns exactly
`{ layout, assignments }`:

```json
{
  "layout": {
    "name": "halves",
    "displayId": "main",
    "zones": [
      { "x": 0, "y": 0, "w": 0.5, "h": 1 },
      { "x": 0.5, "y": 0, "w": 0.5, "h": 1 }
    ]
  },
  "assignments": [
    {
      "windowId": "editor",
      "displayId": "main",
      "zone": 0,
      "rect": { "x": 0, "y": 25, "w": 800, "h": 950 }
    }
  ]
}
```

`zone` is the zero-based index into `layout.zones`. `rect` is in the display's
native units, relative to `workArea`, with fractional values rounded to six
decimal places. `applyLayout()` itself records intent only; call
`stage_live_move` / `stage_live_resize` (or the adapter methods) to execute.

`history(limit = 20)` returns the newest entries first. Entries have an `id`,
an ISO `at` and a `type` of `topology`, `layout`, `apply` or `undo`; `limit`
must be an integer from 1 to 200, and history keeps at most 200 entries.

`undo()` reverses the most recent apply that has not already been undone. Every
apply records the `topologyHash` it was computed against; undo compares that
hash with the current topology before doing anything:

- **Same topology** — the apply's history entry is reported with `undone: true`
  (history itself is append-only), an `undo` entry is appended, and the call
  returns `ok: true` plus the receipt.
- **Topology changed** — the recorded rectangles are stale, so undo does not
  execute. It returns `{ ok: false, code: 'stale_topology', applyId,
  recordedTopologyHash, topologyHash }`, records no `undo` entry and leaves the
  apply un-undone. Re-apply the layout on the current topology and undo that
  new record instead; raising a new layout definition is not required.

Because the protocol ledger is separate from native state, `undo()` reverses
the recorded intent; restoring actual window rectangles is an adapter concern
in 0.2.0 and is not automatic.

## Agent tools

| Tool | Input | Returns |
|---|---|---|
| `stage_topology` | — | stored `{ schema, displays, windows, spaces, topologyHash, observedAt }` |
| `stage_layout_set` | `name`, `displayId`, `zones[]` | `{ layout }` |
| `stage_layout_apply` | `name` | `{ layout, assignments }` |
| `stage_layout_list` | — | `{ layouts }` |
| `stage_undo` | — | undo receipt |
| `stage_live_topology` | — | live snapshot; needs an armed adapter |
| `stage_live_move` | `id`, `rect` | `{ ok, id, before, after, verified }` |
| `stage_live_resize` | `id`, `w`, `h` | `{ ok, id, before, after, verified }` |

All eight are plain-object tool definitions with JSON Schema parameters and
text renderers; they do not depend on `@deepseek-ai/dsh-tools`. The
`StageService` methods can be used directly without the tool registry, which is
how tests and host integrations exercise the protocol. The three
`stage_live_*` tools are always registered but fail closed with
`E_UNAVAILABLE` until an adapter is armed.

## Scope

0.2.0 still does **not** write Spaces, restore minimized windows, change
display modes, persist layouts or profiles, emit events, or support Linux/
Wayland. `focus()` is advertised as `false` in every native adapter. Nothing
in Stage requests Screen Recording, reads window titles, or auto-elevates.

## License

MIT.
