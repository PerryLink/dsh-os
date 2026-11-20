# Changelog

## 0.1.0

- Implement `NestService` with `set`, `get`, `list`, `remove`, `diff` and
  `resolve`; expose it as `ctx.nest`.
- Validate absolute workspace paths (plus the reserved `global` base key),
  array fields, `defaults`/`lifecycle` keys, day counts and versions.
- Add optimistic, monotonic versioning: create at 1, advance by one on every
  overwrite, reject stale versions with `E_VERSION`.
- Add one-step inheritance in `resolve`: scalars and nested objects from
  `global` are overridden/merged by the workspace; arrays are unioned.
- Add side-effect-free field-level `diff` previews, including the would-be
  profile and next version.
- Add optional atomic JSON persistence via `stateFile` (temporary file plus
  `rename`, mode `0600`, `E_STATE_INVALID` on bad snapshots); memory-only by
  default.
- Register five plain-object agent tools: `nest_set`, `nest_get`, `nest_list`,
  `nest_diff`, `nest_remove`.
- Document that 0.1.0 is a profile ledger only: applying profiles to DSH
  workspaces, sessions, sandboxes and environments is 0.2.0 scope.
- Add `node --test` coverage for set/get, versioning, inheritance, diff,
  remove, invalid input, persistence and tool registration.

## 0.0.1

- Reserve the `dsh-nest` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
