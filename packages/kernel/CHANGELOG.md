# Changelog

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
