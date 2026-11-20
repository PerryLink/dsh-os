# Stage · `dsh-stage`

> **Topology before action.** Read displays, windows and spaces, describe layouts
> as display-relative zones, and apply them as recorded, undoable intent.

**Status: 0.1.1 is the topology protocol MVP.** Stage validates and records
topology and layout intent only. It never calls a native window API and cannot
move a window yet. The **macOS AX adapter and Windows Win32 adapter are planned
for 0.2.0**. Until an adapter ships, a host integration supplies observations
through `ctx.stage.setTopology()`.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners. "Stage" here means arranging windows as a stage; it
is unrelated to Apple Stage Manager.

## Install

```sh
dsh plugin --profile web add dsh-stage
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies.

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
  units. 0.1.x reports `dpi` as metadata but does not rescale coordinates, so
  mixed-DPI setups never get an implicit conversion.

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
decimal places. No OS call is made: the record is intent for a future adapter.

`history(limit = 20)` returns the newest entries first. Entries have an `id`,
an ISO `at` and a `type` of `topology`, `layout`, `apply` or `undo`; `limit`
must be an integer from 1 to 200, and history keeps at most 200 entries.

`undo()` reverses the most recent apply that has not already been undone. Every
apply records the `topologyHash` it was computed against; undo compares that
hash with the current topology before doing anything:

- **Same topology** — the apply's history entry is reported with `undone: true`
  (history itself is append-only), an `undo` entry is appended, and the call
  returns `ok: true` plus the receipt below.
- **Topology changed** — the recorded rectangles are stale, so undo does not
  execute. It returns `{ ok: false, code: 'stale_topology', applyId,
  recordedTopologyHash, topologyHash }`, records no `undo` entry and leaves the
  apply un-undone. Re-apply the layout on the current topology and undo that
  new record instead; raising a new layout definition is not required.

```json
{
  "ok": true,
  "schema": "dsh.stage.undo/v1",
  "undone": {
    "id": "h3",
    "at": "2026-11-20T12:00:00.000Z",
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
}
```

With no undoable apply, `undo()` throws `nothing_to_undo`. A stale apply stays
undoable in principle (it will succeed if the topology returns to the recorded
hash), but until then it returns `stale_topology` rather than a rectangle.
Error codes for apply are `no_topology`, `unknown_layout`, `unknown_display`
and `invalid_layout` (bad name); history uses `invalid_limit`.

Because 0.1.x performs no native writes, undo is a ledger reversal only.
Restoring window rectangles, verifying placement and handling user-moved
windows are adapter concerns for 0.2.0.

## Agent tools

| Tool | Input | Returns |
|---|---|---|
| `stage_topology` | — | `{ schema, displays, windows, spaces, topologyHash, observedAt }` |
| `stage_layout_set` | `name`, `displayId`, `zones[]` | `{ layout }` |
| `stage_layout_apply` | `name` | `{ layout, assignments }` |
| `stage_layout_list` | — | `{ layouts }` |
| `stage_undo` | — | undo receipt |

All five are plain-object tool definitions with JSON Schema parameters and text
renderers; they do not depend on `@deepseek-ai/dsh-tools`. The `StageService`
methods can be used directly without the tool registry, which is how tests and
future adapters exercise the protocol.

## Scope

0.1.x does **not** enumerate the real desktop, move or resize windows, request
accessibility or screen-recording permissions, read Spaces through private
APIs, persist layouts or emit events. Those belong to the macOS AX and Windows
Win32 adapters, verification and storage work scheduled for 0.2.0.

## License

MIT.
