# Changelog

## 0.1.0

- Add `BackupService` with `snapshot`, `list`, `get`, `diff`, `planRestore`
  and `forget`; expose it as `ctx.backup`.
- Add recursive, read-only metadata manifests (`path`, `rel`, `type`, `size`,
  `mtimeMs`, `mode`, optional SHA-256) with sorted, relative-path entries.
- Add include/exclude globs, symlink recording without following, and
  absolute-path / `..` validation for roots, targets and patterns.
- Add fail-closed `maxFiles` and `maxBytes` limits (`E_LIMIT`, no partial
  manifest stored).
- Add relative-path `diff` with added/removed/changed paths and per-field
  changes, plus target-aware `planRestore` that lists add/overwrite/delete
  paths without writing anything.
- Register the three plain-object agent tools `backup_snapshot`,
  `backup_diff` and `backup_plan_restore`.
- Document explicitly that 0.1.0 is inventory-only: no copying, no target
  writes, no restore execution (0.2.0) and not a Time Machine.
- Add `node --test` coverage for counts, limits, traversal rejection, hashing,
  include/exclude, symlinks, diff, plans, forget and the tool surface.
