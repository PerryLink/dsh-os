# Changelog

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
  (`./envelope` export), mirroring `@perrylink/dsh-os-contract` without adding
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
