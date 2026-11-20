# Changelog

## 0.2.0

- Add the `dsh-memory-protocol/v1` bridge to `dsh-memento` in `lib/memento.js`:
  detect `ctx.get('memory')` / `ctx.get('memoryAdapters')`, read memento entries
  with the synchronous `query()` seam, and map
  `id`/`text`/`source`/`scope`/`confidence`/`createdAt`/`expiresAt` into Trace
  records.
- Add `TraceService.restore()` (timestamp-preserving migration write; no
  `force`) and `TraceService.get(key)`; imports obey the existing supersede
  rule and never overwrite a higher-confidence record.
- Add `trace.memento.importFromMemento()`: defaults to memento's `user-global`
  layer with an optional `agentKey` filter, reports per-entry conflicts instead
  of forcing them, and is idempotent for unchanged entries. Workspace import is
  an explicit, warned opt-in because memento v1's `query()` has no
  `workspaceKey` filter.
- Add `trace.memento.exportToMemento()`: active records only, emitted as a
  memento-consumable `trace-memento-v1` envelope that preserves keys, scopes,
  confidence, `createdAt` and `expiresAt` (the last three as Trace extensions).
- Add the `trace` protocol adapter (`trace-memento-v1` ⇄ protocol v1 entries).
  `apply()` only probes memento and never registers the adapter (read-only
  posture); registration is explicit via `trace.memento.registerAdapter()`.
- Add the `trace_import_memento`, `trace_export_memento` and
  `trace_adapter_status` tools (seven total). Bridge tools return
  `{ ok: false, code: 'E_UNAVAILABLE' }` when memento is absent; the local
  ledger and the first four tools keep working.
- Document memento as the predecessor/migration source and Trace as the
  governance layer, including the lossy confidence/expiry boundary of protocol
  v1 and the workspace-ACL caveat.
- Add `node --test` coverage with a mock `ctx.memory` / `ctx.memoryAdapters`:
  import mapping, user-global default, explicit workspace import, conflict
  reporting, idempotent re-import, export, adapter round-trip, explicit
  registration and missing-service `E_UNAVAILABLE`. No real memento call is
  made.

## 0.1.0

- Add `TraceService` exposed as the Host service `ctx.trace` with
  `remember` / `search` / `forget` / `list` / `export`.
- Store immutable provenance `{ source, createdAt, updatedAt }` and validate
  key, scope, sensitivity, confidence and TTL inputs with stable error codes.
- Make same-key writes supersede the active record while retaining the
  `supersedes` / `supersededBy` chain in `trace-export-v1`; refuse writes with
  lower confidence than the active record unless `force: true`.
- Sweep expired records (`ttlMs`) out of search/list and retain them as
  `status: 'expired'` audit entries in exports.
- Redact `sensitivity: 'secret'` records to `[redacted]` before storage; the
  original text never reaches the ledger, archive or export.
- Make `forget(key)` remove every version of the key and leave a text-free
  tombstone.
- Register the `trace_remember`, `trace_search`, `trace_forget` and
  `trace_list` agent tools using plain tool definitions (no
  `@deepseek-ai/dsh-tools` dependency).
- Add `node --test` coverage for memory/search, supersede and confidence,
  expiry, secret redaction, forget/export and input validation.

## 0.0.1

- Reserve the `@perrylink/dsh-trace` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
