# Changelog

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
