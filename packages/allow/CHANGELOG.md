# Changelog

## 0.1.1

- Security: only `allow_check` is registered by default. `allow_issue`,
  `allow_revoke` and `allow_list` require `exposeAdminTools: true` for a
  human-facing client; exposing them to the model allowed an agent to mint its
  own Grant and bypass Act's write gate.
- `check()` accepts an omitted scope (any active grant) and no longer rewrites
  the state file on every read.
- Persisted grants with invalid fields (for example a non-numeric `expiresAt`)
  are dropped, and unsupported state versions fail with `E_STATE`.
- `issue()` and `revoke()` roll back in-memory state when persistence fails.

## 0.1.0 — 2026-11-20

First functional MVP.

- Add `GrantStore` and `AllowService` with `issue`, `check`, `revoke`, `list`
  and `audit`.
- Grant lifecycle: `active`, `revoked`, `expired`; default TTL 24h, hard maximum
  30 days; expiry evaluated against the service clock.
- Scope matching: `*`, `prefix:*`, exact strings and arrays of patterns.
- Successful checks refresh `usedAt`; issue, allowed, denied, revoked and
  automatic expiry events are appended to the audit log.
- Optional JSON persistence via `config.stateFile` with temp-file + rename
  atomic writes (mode `0600`); memory-only by default.
- Host seam `ctx.provide('allow', service)` and four plain-object agent tools:
  `allow_issue`, `allow_check`, `allow_revoke`, `allow_list`.
- Input validation with stable error codes; no runtime dependencies and no build
  step.
- Tests: 10 cases via `node --test`.

## 0.0.1

- Reserve the `dsh-allow` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
