# Changelog

## 0.1.2

- Reject secret-looking `vars` values instead of storing them: `sk-...`,
  `ghp_...` / `github_pat_...`, `AKIA...` / `ASIA...`, PEM private keys and
  `password=...` now fail with `secret_in_vars` and point at `secretRefs`.
- Reject proxy URLs with embedded userinfo (`http://user:pass@host`) with
  `invalid_proxy`.
- Reject control characters in `vars`, `secretRefs`, proxy values and
  `pathPrepend` entries; `pathPrepend` keeps rejecting empty strings. `deny`
  continues to allow only `A-Z a-z 0-9 _ . * -` up to 128 characters and now
  reports malformed patterns with a clearer `invalid_deny` message.
- Add regression tests for secret-ish vars, proxy userinfo, newline/NUL
  `pathPrepend`, malformed deny patterns and read-only `stateFile` rollback.

## 0.1.1

- Agent-facing `root_set` always stores `trust: agent`, `scope: agent`.
- `root_resolve` and `root_explain` use the agent visibility ceiling and no
  longer accept a caller-supplied layer.
- Layer rank fixed: user-trust profiles are hidden from agent callers.

## 0.1.0

- Add `RootService` exposed as the Host service `ctx.env` with
  `set` / `get` / `list` / `remove` / `resolve` / `explain`.
- Validate profile shape, trust/scope layers, proxy fields, PATH entries, deny
  patterns and variable names (`^[A-Z_][A-Z0-9_]*$`).
- Compose inheritance chains with cycle and missing-parent detection; merge
  vars and secret references in one namespace, proxy fields and PATH prepends.
- Apply case-insensitive deny globs, remove matching keys and report them in
  `resolve().denied`.
- Return per-key provenance through `resolve().sources` and `explain()`.
- Support an optional atomically written JSON `stateFile` (version 1) with
  rollback when a write fails; corrupt state fails with `state_invalid`.
- Register the `root_set`, `root_get`, `root_list`, `root_resolve` and
  `root_explain` agent tools using plain tool definitions.
- Add `node --test` coverage for inheritance, deny, secret references,
  provenance, validation, cycles, layers, persistence and tool wiring.
- 0.1.0 is a ledger/interpreter only: it never reads or writes `process.env`.
  Environment injection is planned for 0.2.0.

## 0.0.1

- Reserve the `dsh-runtime-env` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
