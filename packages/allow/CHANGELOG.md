# Changelog

## 0.1.2

- Audit retention is tiered: at most 200 `allowed`/`denied` events are kept,
  while `issued`, `revoked` and `expired` are evicted only after every check
  event under the total 2000-entry cap. `auditStats()` reports cumulative totals
  (counted even after eviction) and what the retained log still holds.
- `save()` now opens the sibling temp file, writes, `fsync`s and closes it
  before the atomic `rename`, and removes the temp file when persistence fails.
  The existing in-memory rollback of `issue()`/`revoke()` is covered by
  read-only-directory and rename-failure tests.
- Admin tools are subject-scoped: `allow_list` requires `subject` (no
  fleet-wide enumeration) and `allow_revoke` requires `id` plus a matching
  `subject` (no cross-subject revocation). Both are still opt-in behind
  `exposeAdminTools: true`.
- `revoke(id, { subject })` accepts an optional owner guard; the service remains
  backward compatible when it is omitted.
- Tests: 18 cases, including 2100-check retention, the 2000-entry cap, check
  no-write, persistence failure rollback and cross-subject tool refusal.

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
