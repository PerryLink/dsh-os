# Changelog

## 0.2.0

- Add a root allowlist: `snapshot` roots and `planRestore` targets must be
  inside `allowedRoots` (default `[process.cwd()]`); outside paths fail with
  `E_OUTSIDE_ROOT`. Allowed roots, roots and targets are canonicalized, so a
  symlink cannot escape the allowlist.
- Reject the filesystem root, the home directory root and `..` traversal with
  `E_FORBIDDEN_ROOT` / `E_INVALID_ARGUMENT`, including for `allowedRoots`.
- Add default sensitive exclusions at any depth: `.ssh`, `.env*`,
  `credentials*`, `*.pem`, `*.key`, `id_rsa*`, `.git` and `node_modules`.
  Hosts can override them explicitly with `defaultExclude` or
  `excludeSensitive: false`; per-call `exclude` only adds patterns.
- Make the caps hard: 10,000 files, 100 MiB total and 10 MiB per file.
  Service and per-call options may lower them but not raise them (`E_LIMIT`);
  the single-file cap is checked before optional hashing.
- Add an in-memory snapshot audit trail (`audit()`): root, file count, bytes,
  duration and outcome, with no file-name lists, retained up to 200 entries.
- Confine `planRestore`: the target must be inside `allowedRoots`, must not be
  `/` or the home directory, and a target symlink on a restore path is refused.
  Plans remain read-only (`execute: false`) and never create the target.
- Apply the effective exclusions to the `planRestore` target scan so a restore
  plan never proposes deleting sensitive paths.
- Record the effective `exclude` list and `maxFileBytes` in the manifest.
- Keep zero runtime dependencies and three agent tools; tool arguments cannot
  widen `allowedRoots`, disable sensitive exclusions or raise limits.

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
  writes, no restore execution and not a Time Machine.
- Add `node --test` coverage for counts, limits, traversal rejection, hashing,
  include/exclude, symlinks, diff, plans, forget and the tool surface.
