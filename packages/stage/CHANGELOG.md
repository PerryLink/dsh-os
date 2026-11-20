# Changelog

## 0.2.0

- Add `lib/adapters/` with a default in-memory `mock` adapter, a macOS JXA
  adapter and a Windows PowerShell/C# adapter. No native binaries and no
  runtime dependencies; the OS programs are fixed strings inside the package.
- macOS: enumerate displays through `NSScreen` (AppKit-to-AX coordinate
  conversion, `visibleFrame` work areas, Retina scale as `dpi` metadata) and
  windows through System Events/AX (`mac:<pid>:<index>`, minimized/fullscreen
  filtered, no titles). Move/resize re-read the window, refuse stale bounds and
  verify the result. Accessibility and Automation failures map to `E_DENIED`.
- Windows: one `powershell.exe` process calls `Add-Type` with user32/
  dwmapi/shcore P/Invoke (`EnumWindows`, `GetWindowRect`, `SetWindowPos`,
  `ShowWindow`, `EnumDisplayMonitors`, DWM extended frame), opts into PMv2
  before any window API, compensates the invisible border inset before
  `SetWindowPos`, and verifies the visible bounds within 1 px. UIPI/UWP access
  denial maps to `E_DENIED`; no UAC.
- Add `StageService.adapters()`, `useAdapter(name)`, `topologyLive()`,
  `moveLive()` and `resizeLive()`. The service keeps the mock selected but
  disarmed by default; `adapter` config or `useAdapter()` is required before
  any live call. Unknown/unavailable adapters fail closed with `E_UNAVAILABLE`.
- Add agent tools `stage_live_topology`, `stage_live_move` and
  `stage_live_resize`. Live writes accept only one explicit id from the
  observed topology; `all`, `*`, empty and malformed ids are `E_DENIED`, and an
  id that was never observed is refused as `unobserved_window`.
- Add adapter tests and fixtures for macOS/Windows parsing, negative
  coordinates, mixed DPI, DWM inset compensation, stale/snapshot handling,
  permission denial, wildcard refusal and the opt-in service/tool paths.
- Document the platform matrix, TCC/UIPI permissions, DPI/coordinate rules,
  privacy boundaries and adapter API in the README.

## 0.1.1

- Make `undo()` topology-aware: every apply already records the `topologyHash`
  it was computed against, and undo now compares it with the current topology.
  If the topology changed, undo refuses with
  `{ ok: false, code: 'stale_topology' }` (including `applyId`,
  `recordedTopologyHash` and the current `topologyHash`) and records/marks
  nothing; re-apply the layout and undo the new record instead.
- Make history append-only: undo state lives in a side table, so past history
  entries are never mutated in place. `history()` still reports `undone` and
  `undoneAt` for apply entries.
- Return `ok: true` on a successful undo and keep all returned history/receipt
  values as defensive copies.
- Lock in zone validation with tests: `NaN`, `Infinity`, `-Infinity`,
  negative values and values above `1` are rejected with `invalid_zone` (the
  guard already used `Number.isFinite` plus a `0..1` range check).

## 0.1.0

- Add the topology protocol MVP: `ctx.stage` with `setTopology()` / `topology()`
  and validated display, window and space snapshots.
- Add named layouts with display-relative `0..1` zones (`setLayout()` /
  `layouts()`), including normalized-zone and bounds validation.
- Add `applyLayout()`: computes focused-first window assignments in native
  display units, records the intent in history and returns
  `{ layout, assignments }` without calling any native window API.
- Add bounded newest-first `history(limit)` for topology, layout, apply and
  undo entries, plus `undo()` for the most recent un-undone apply.
- Register the plain-object agent tools `stage_topology`, `stage_layout_set`,
  `stage_layout_apply`, `stage_layout_list` and `stage_undo`.
- Document that 0.1.0 is the topology protocol MVP and that the macOS AX and
  Windows Win32 adapters are planned for 0.2.0.

## 0.0.1

- Reserve the `dsh-stage` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
