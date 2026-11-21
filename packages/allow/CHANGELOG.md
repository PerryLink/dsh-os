# Changelog

## 0.4.0

- Grants are now consumable: each Grant carries `maxUses` (default `Infinity` for
  backward compatibility), `uses` and `lastUsedAt`. A successful `check`
  consumes one use in the same synchronous turn; the last use moves the Grant to
  `status: 'used'`, records an `exhausted` security event, and later checks are
  denied with `reason: 'grant_exhausted'`. `check` returns `remainingUses`
  (`null` for an unlimited Grant).
- Requests carry a use budget: `request({ maxUses? })` defaults to 1 and caps at
  100. `approve({ maxUses? })` also defaults to 1 and may only lower the
  requested value (`E_MAX_USES`); a human cannot use an approval to widen the
  budget, and `approve` rejects `subject`/`approver` fields. The legacy
  `allow_issue` path stays unlimited unless `maxUses` is given.
- Idempotency and replay: approving the same request twice returns the same
  Grant and adds no audit row; re-approving cannot revive an exhausted Grant.
  Replaying the same `act_invoke` call after the budget is spent is denied.
  Finite consumption is persisted, so a restart cannot restore spent uses;
  interleaved checks in one process cannot overdraw a Grant.
- Persistence stays on state version 2 (the standalone approvals CLI reads it).
  Version 1/2 grants without the new fields load as `uses: 0`,
  `maxUses: Infinity`; `null` is the JSON form of `Infinity`. A Grant written by
  the CLI (which predates `maxUses`) adopts its request's finite budget on load.
  Requests with `maxUses > 1` must be approved through the service; the 0.3 CLI
  hashes only the five legacy fields and refuses them with `E_REQUEST_HASH`.
- Tools: `allow_check` consumes and reports `remainingUses`; `allow_request`,
  `allow_issue` and `allow_approve` accept `maxUses`; `allow_list` accepts
  `status: 'used'`.
- Packaging: include `lib/` in the published tarball (0.3 omitted it).
- Tests: 34 cases, including one approval → exactly one real `act_invoke` write,
  replay denial, `remainingUses`, legacy multi-use Grants, restart persistence,
  CLI-style Grant adoption and single-threaded concurrent checks.

## 0.3.0

- Add the `Request` object (`pending | approved | denied | expired`) and the
  request → approval → Grant protocol. `requestHash` binds the exact subject,
  capability, scope, TTL and reason; approval refuses a mismatch with
  `E_REQUEST_HASH`.
- Service API: model-callable `request({ subject, capability, scope?, ttlMs?,
  reason? })`, human `approve({ id, by, scope? })` and `deny({ id, by, reason })`,
  plus `requests({ status?, subject? })` and polling `wait(id, { timeoutMs?,
  subject? })` (5s default, 25s cap). Approval creates the Grant in the same
  atomic save and records `requestId`/`requestHash` on it.
- Security: approval can only narrow scope (`E_SCOPE_NARROW`), idempotent repeat
  approval returns the same Grant, expired/denied requests cannot be approved,
  and `request()` rejects server-owned fields (`approver`, `id`, state, hashes)
  with `E_PRIVILEGED`.
- Tools: default surface is now `allow_request`, `allow_wait`, `allow_requests`
  and `allow_check`. `allow_approve` and `allow_deny` join `allow_issue`,
  `allow_revoke` and `allow_list` behind `exposeAdminTools: true`; the legacy
  `allow_issue` path is unchanged.
- State version 2 persists requests alongside grants, counters and audit; version
  1 files still load. Invalid/tampered requests and approved requests without a
  Grant are dropped fail-closed on load.
- CLI: `dsh-os approvals list|approve|deny --state <file>` edits the same state
  format (no shell, no network, no profile writes).
- Tests: 27 cases, including the full request lifecycle, hash mismatch, expiry,
  duplicate approval/denial, privilege rejection, scope narrowing, wait polling,
  persistence and cross-subject tool scoping.

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
