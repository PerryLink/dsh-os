# Changelog

## 0.4.0 — 2026-11-21

### Added

- **Content-hash taint gate.** The gateway keeps an in-process
  `TaintRegistry` of `sha256(text)` for every `text`/`content` field returned
  by `snip_get`, `seek_resolve` and `trigger_runs`, and for any result that
  carries a `taintToken`. Only digests, source ids, tokens and timestamps are
  stored; the original text is never kept or logged.
- `os_do` on `act.fs.write` (or `legacy.act_invoke` with `args.id ===
  "fs.write"`) hashes `args.text`/`args.content`. A registered digest requires
  the base Grant **and** `cap:act.fs.write:tainted` through `ctx.allow.check`,
  or a fresh `taintToken` bound to that digest. A miss returns `E_DENIED`,
  `subcode: "grant_required"`, `details.permission:
  "cap:act.fs.write:tainted"` and `nextTools: [os_request]`.
- Tokens are single-use, hash-bound and expire after five minutes
  (`TAINT_TTL_MS`). A used or expired token cannot authorize another write,
  but the digest stays registered (bounded to 256 entries) so the tainted
  Grant is still required. Taint evidence is stripped before the handler runs.
- `os_request({ ..., tainted: true })` requests the mapped `:tainted`
  capability, closing the two-approval loop through `os_observe`/`os_do`:
  `legacy.act_invoke` maps to `cap:act.fs.write:tainted`.
- `config.taint` (`{ ttlMs, max, now }`) for hosts/tests; exports
  `TaintRegistry`, `TAINT_TTL_MS`, `MAX_TAINT_RECORDS` and the taint helpers.
- Tests: blocked verbatim reuse, base+tainted Grants, one-shot and stripped
  tokens, forged/expired tokens, ordinary content, `seek_resolve` and legacy
  `snip_get` sources, and the real `dsh-allow` recovery loop.

### Changed

- `VERSION` and the package version are `0.4.0`. `os_do`/`os_request` schemas
  document the taint behaviour; `os_request` gains the optional `tainted`
  field.

### Limit

- The digest gate prevents verbatim reuse only. Rewritten content, substrings
  or a different fetch path produce a different digest and pass. Full
  provenance still requires host metadata; this is not taint tracking.

## 0.3.0 — 2026-11-21

### Added

- **Permission bridge closes the loop.** `os_observe({requestId})` pulls the
  latest request from Allow (`ctx.allow.requests`, then `wait`/`get`), and on
  `approved` calls `ctx.allow.check` once, caches the consumed Grant and
  reports `grantAvailable`. The next `os_do` with the same id, args and subject
  uses it automatically; no host-injected grant is needed. Replays and
  exhausted Grants stay `E_DENIED`. Cached approvals are bound to
  `subject + capability + args fingerprint`; `os_request` records only the
  fingerprint, never the args.
- **Optional idempotency journal.** `apply(ctx, { stateFile })` persists
  `{ argsHash, result }` per subject + capability + key, returns the original
  `OsResult` after a restart, and rejects key reuse with different args as
  `E_CONFLICT`. Atomic writes, mode `0600`, 500-entry bound, no args stored.
- **`config.gatewayOnly`.** In a scoped agent/preset mount it registers the six
  verbs and calls `ctx.tools.restrict({ deny: [...] })` for every inherited
  non-`os_*` tool; a global mount fails closed. The legacy bridge enumerates
  the global view under this mode, so hidden tools remain reachable as
  capabilities.
- `docs/presets/os-gateway.md` + `.cordis.yml`: copyable preset row and the
  `toolFilter` vs. `ctx.tools.restrict` distinction.
- Exports `capabilityName()`, `CAPABILITY_PREFIX`, `createStateStore`,
  `STATE_VERSION`, `MAX_ENTRIES`; tests for the real `dsh-allow` bridge,
  observe refresh, one-shot replay, args binding, restart-safe idempotency,
  gatewayOnly and the preset.

### Changed

- **Capability naming is unified to `cap:<descriptor.id>`.** `os_request` used
  to ask for `<id>` while `allowedByHost` checked `cap:<id>`; both now use
  `cap:<id>`, matching what `os_observe` consumes. Plain `<id>` grants no
  longer match (module grants such as `act:invoke:<action>` are unaffected).
- `os_do` checks the idempotency journal before authorization, so a restart
  replay needs no fresh Grant; entries are scoped by subject + capability + key.
- The Allow check omits `scope`, so a human-narrowed approval still authorizes
  its one use. `isGrant()` rejects `used` or exhausted Grants.
- `VERSION` and the package version are `0.3.0`.

### Compatibility

- The result schema remains `os.result/v1`; `legacyTools`, explicit `grant`
  args and in-memory idempotency are unchanged.
- `stateFile` and `gatewayOnly` are opt-in; without them 0.2.0 behavior is
  unchanged apart from the capability name.

## 0.2.0 — 2026-11-21

### Added

- `KernelService` (extends `CapabilityRegistry`) with `refreshLegacy({scope})`
  and `stats()`. `apply()` now provides it as `ctx.kernel` while returning the
  same object.
- Legacy bridge: enumerates `ctx.tools.schemas(scope)`, fetches definitions
  with `ctx.tools.get(name, scope)`, excludes `os_*`, and registers the rest
  with `fromTool()` as `legacy.<tool name>`. Repeated refreshes are idempotent;
  existing ids and aliases are kept, so descriptors are never shadowed.
- Lazy refresh on the first `os_find`/`os_status` (scope = `exec.agent`), and
  on a direct `os_do` for an unknown `legacy.*` id. Hosts without a
  `schemas`/`get` seam are silently skipped.
- `os_do` normalizes legacy outcomes: unwraps `{ok:true,...}`, converts
  `{ok:false,error}` to an OsError, aliases unknown codes to the nine classes
  and keeps the original in `details.legacyCode`.
- `os_status` now reports `{ legacy, capabilities, total }`; legacy descriptors
  are excluded from `modules`.
- Local `ok()` / `err()` / `legacyOutcome()` envelope helpers
  (`./envelope` export), mirroring `dsh-os-contract` without adding
  a dependency.
- `fromTool()` recognizes `execute` in names/descriptions as execute risk.

### Changed

- `VERSION` is `0.2.0`; the package version is `0.2.0`.
- `os_find`/`os_status` are now async-refresh aware; both still return the
  same shapes as before, apart from the new `os_status` counters.

### Compatibility

- `config.legacyTools` remains supported for hosts that cannot enumerate.
- The published result schema remains `os.result/v1`, not the contract's
  `dsh.os.result/v1`; field shapes are unchanged.
