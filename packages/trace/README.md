# Trace · `dsh-record`

> Auditable long-term memory governance for DeepSeek Harness: provenance, expiry,
> conflict, forget, and a read-only `dsh-memento` bridge.

**Status: 0.3.0 adds optional `dsh://` ref verification to `trace_remember` on
top of the 0.2.0 memento bridge and the 0.1.0 governance ledger.**

**memento 是前代 / 可迁移源；Trace 是治理层。** memento is the predecessor and
migration source; Trace is the governance layer on the same protocol. Trace
imports memento memories read-only, exports a memento-consumable payload, and
never writes into memento or bypasses its approval gate.

0.3.0 ships an in-memory, dependency-free governance ledger with the
`trace_remember` / `trace_search` / `trace_forget` / `trace_list` tools, plus
`trace_import_memento` / `trace_export_memento` / `trace_adapter_status`.
When `dsh-seek` is mounted, a `dsh://` source passed to `trace_remember` is
resolved through `ctx.evidence.resolve` before the claim is stored
(`verifyRefs`, enabled by default). Records are process-local and disappear
when the host restarts. There is no SQLite, vector database or network access.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-record
```

Plain ESM, Node.js 22+, no runtime dependencies and no build step.

## Service

The plugin exposes `ctx.trace` (protocol `dsh-memory-protocol/v1`, profile
`trace/1`):

```js
const trace = ctx.get('trace')

const record = trace.remember({
  key: 'repo:dsh/pkg',
  text: 'The workspace uses pnpm, not npm.',
  source: 'user',          // provenance label; default 'user'
  scope: 'workspace',      // user | workspace | preset | team; default 'workspace'
  confidence: 0.8,         // 0..1; default 0.5
  ttlMs: 86_400_000,       // optional lifetime in milliseconds
  sensitivity: 'normal',   // normal | public | internal | private | secret
})

trace.search('pnpm', { limit: 5 })  // active records, best match first
trace.list({ limit: 20 })           // active records, newest update first
trace.get('repo:dsh/pkg')           // one active record, or null
trace.forget('repo:dsh/pkg')        // true when the key existed
trace.export()                      // trace-export-v1 envelope
```

A record is a plain object:

```js
{
  id: '1f0c…',                     // stable UUID
  key: 'repo:dsh/pkg',
  text: 'The workspace uses pnpm, not npm.',
  scope: 'workspace',
  confidence: 0.8,
  sensitivity: 'normal',
  status: 'active',                // active | superseded | expired
  supersedes: [],                  // ids of the immediately replaced record
  provenance: {
    source: 'user',
    createdAt: 1795182000000,      // epoch milliseconds
    updatedAt: 1795182000000,
  },
  expiresAt: 1795268400000,        // only when ttlMs/expiresAt was set
}
```

### Conflict and confidence

The ledger holds one active record per key.

- A newer `remember` for the same key replaces the active record. The new
  record gets `supersedes: [old.id]`; the old version is retired with
  `status: 'superseded'` and `supersededBy: new.id`.
- If the active record has **higher** confidence, the write is refused with a
  `trace_confidence_too_low` error (`error.current` carries the active record).
  Pass `force: true` to replace it anyway.
- Imports use `trace.restore()`, which deliberately has **no `force`** option:
  a memento import can never overwrite a higher-confidence Trace record.
- Superseded versions stay in `export()` (`trace-export-v1`) so the chain is
  auditable. They never appear in `search()` or `list()`.

### Migration API

`trace.restore(input)` is the timestamp-preserving write path used by the
memento bridge. It accepts the ordinary draft fields plus `createdAt` and an
absolute `expiresAt`, applies the same supersede/confidence rule as
`remember()`, and still redacts `sensitivity: 'secret'`.

```js
trace.restore({
  key: 'memento:0b6f…',
  text: 'Adopt pnpm workspaces.',
  source: 'memento',
  scope: 'user',
  confidence: 0.5,
  createdAt: 1795182000000,
  expiresAt: 1795268400000,
})
```

### Expiry

`ttlMs` sets `expiresAt = createdAt + ttlMs`. Every read and write sweeps
expired records out of the active ledger; they disappear from `search()` and
`list()` and appear in `export()` with `status: 'expired'`. Expiry does not
rewrite `confidence`.

### Secret redaction

`sensitivity: 'secret'` stores the literal text `[redacted]` and marks the
record `redacted: true`. The original string is never written to the record,
the archive or the export. Keep actual credentials in a credential store;
Trace only records that a secret exists (for example under `credential:api`).

### Forget and export

`forget(key)` deletes the active record **and every archived version of that
key**, then keeps a text-free tombstone (`key`, `forgottenAt`, `versions`).
`forget` returns `false` when there was nothing to remove.

`export()` returns a deep copy of the ledger:

```js
{
  format: 'trace-export-v1',
  protocol: 'dsh-memory-protocol/v1',
  profile: 'trace/1',
  exportedAt: 1795182000000,
  records: [/* active, superseded and expired records */],
  tombstones: [{ key: 'gone', forgottenAt: 1795182000000, versions: 2 }],
}
```

Tombstones contain no claim text. Deleting a key therefore also removes the
old text from all exported superseded versions.

## memento bridge (0.2.0)

Trace detects the optional memento services at apply time and on every bridge
call:

- `ctx.get('memory')` — memento's synchronous `query(filter, opts)` read seam;
- `ctx.get('memoryAdapters')` — the protocol v1 adapter registry.

Missing memento is not an error: the local ledger and its first four tools keep
working, and the bridge tools return `{ ok: false, code: 'E_UNAVAILABLE' }`.
Trace **never calls memento's write methods** (`add` / `replace` / `remove` /
`consolidate` / `seed`). Import is read-only; export is a local data
conversion; memento's approval gate is untouched.

### Import (`trace_import_memento`)

```js
trace.memento.importFromMemento({ scope: 'user', limit: 20, agentKey: 'preset:web' })
```

- Defaults to `scope: 'user'` (memento `user-global`). Pass
  `scope: 'workspace'` explicitly to import the workspace layer; the result
  then carries a `warning` because memento v1's `query()` has **no
  `workspaceKey` filter** — it cannot prove the entries belong to the current
  cwd.
- `agentKey` is forwarded to memento's `query(filter, { agentKey })`
  visibility filter when provided.
- Mapping: `id`/`trace.key` → Trace `key` (`memento:<id>` when absent),
  `text` → `text`, `source` → provenance source, memento `scope` (or a valid
  `trace.scope` extension) → Trace `scope`, `confidence` (or
  `trace.confidence`) → Trace confidence (default `0.5`), `createdAt` →
  `provenance.createdAt`, `expiresAt` (or `trace.expiresAt`) → `expiresAt`
  (only when after `createdAt`).
- Re-importing an identical entry is a no-op (`unchanged`), not a new version.
- A higher-confidence existing record is reported in `skipped` with
  `code: 'trace_confidence_too_low'`; it is never overwritten.

Result:

```js
{
  ok: true,
  imported: 3,
  unchanged: 1,
  skipped: [{ id: '…', key: 'tool:pnpm', code: 'trace_confidence_too_low', message: '…' }],
  total: 5,
  truncated: false,
  scope: 'user',
  warning: '…',          // only for scope: 'workspace'
}
```

### Export (`trace_export_memento`)

```js
trace.memento.exportToMemento({ scope: 'workspace' }) // scope optional
```

Exports **active** records only (superseded/expired history stays in
`trace.export()`), as a memento-consumable JSON envelope:

```js
{
  plugin: 'dsh-trace',
  format: 'trace-memento-v1',
  protocol: 'dsh-memory-protocol/v1',
  exportedAt: 1795182000000,
  entries: [
    {
      id: '1f0c…',
      track: 'agent',                     // user -> user track, everything else -> agent
      scope: 'workspace',                 // memento vocabulary
      text: 'The workspace uses pnpm.',
      source: 'user',
      tags: [],
      confidence: 0.8,
      createdAt: 1795182000000,
      updatedAt: 1795182000000,
      expiresAt: 1795268400000,           // only when set
      trace: { key: 'repo:dsh/pkg', scope: 'workspace' },
    },
  ],
}
```

The `trace` object and `confidence`/`expiresAt` are optional Trace extensions.
memento's protocol v1 has no confidence or expiry field, so importing this
payload into memento is intentionally lossy for those two fields; the
`trace` extension lets Trace round-trip keys, scopes and timestamps.

### Adapter (opt-in, not registered by `apply()`)

`lib/memento.js` exports a protocol v1 adapter (`id: 'trace'`, format
`trace-memento-v1`) that converts Trace exports to memento entry inputs and
back. Trace treats memento as **read-only**, so `apply()` only probes the
registry and `trace_adapter_status` reports `registered: false` with
`mode: 'read-only'`. Registration is explicit:

```js
const trace = ctx.get('trace')
trace.memento.registerAdapter()          // installs ctx.memoryAdapters.register(...)
```

After that, memento's own `/memory adapters`, `/memory export
--adapter=trace` and `/memory import --adapter=trace <file>` work; the import
still goes through memento's single approval + `seed` transaction.

### Status (`trace_adapter_status`)

```js
{
  ok: true,
  protocol: 'dsh-memory-protocol/v1',
  available: true,
  services: { memory: true, memoryAdapters: true },
  adapter: {
    id: 'trace',
    registered: false,
    mode: 'read-only',
    importFormats: ['trace-memento-v1', 'trace-export-v1'],
    exportFormat: 'trace-memento-v1',
  },
}
```

## Agent tools

All seven tools are plain `ToolDefinition` objects (no
`@deepseek-ai/dsh-tools` dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `trace_remember` | `key`, `text`; optional `source` (free text or `dsh://` ref), `scope`, `confidence`, `ttlMs`, `sensitivity`, `force` | `{ record, verification? }`, `{ record, warning? }` in warn mode, `{ ok: false, code: 'E_REF_NOT_FOUND', ... }` for an unverified ref, or `{ ok: false, code: 'trace_confidence_too_low', message, current }` |
| `trace_search` | `query`; optional `limit` | `{ results }` |
| `trace_forget` | `key` | `{ forgotten }` |
| `trace_list` | optional `limit` | `{ records }` |
| `trace_import_memento` | optional `scope` (`user`/`workspace`), `agentKey`, `limit` | import summary, or `{ ok: false, code: 'E_UNAVAILABLE' }` |
| `trace_export_memento` | optional `scope` | `trace-memento-v1` envelope, or `{ ok: false, code: 'E_UNAVAILABLE' }` |
| `trace_adapter_status` | — | availability report |

`limit` defaults to 20 and is capped at 100. Search is a case-insensitive
substring match over key and text; key matches rank above text matches, then
confidence and recency break ties.

### Ref verification (`verifyRefs`)

`apply(ctx, { verifyRefs, refVerifyMode, verifyTimeoutMs })`:

- `verifyRefs` (default **true**): before storing a record, a `source` that
  starts with `dsh://` is passed to `ctx.get('evidence').resolve(ref, { signal,
  timeoutMs, cwd, agentKey, agent })`. `found: false` (missing, tombstoned,
  timeout, error or `unsupported`) refuses the write with
  `E_REF_NOT_FOUND`; the tool returns `{ ok: false, code: 'E_REF_NOT_FOUND',
  message, ref, status, checkedAt?, error? }`. A verified write returns
  `{ record, verification: { ok: true, status, ref, checkedAt? } }`.
- `refVerifyMode: 'warn'` stores the record anyway and returns
  `{ record, warning: { code: 'E_REF_NOT_FOUND', ... } }`. Use it only when the
  caller will re-verify later.
- `verifyTimeoutMs` (default 10000) bounds each resolve call.
- Verification is skipped when `verifyRefs` is false, when `source` is not a
  `dsh://` string (ordinary provenance labels such as `user` or
  `check_compare` are never resolved), or when no `evidence` service with
  `resolve` is mounted. Trace therefore remains a standalone ledger without
  `dsh-seek`; in that configuration a `dsh://` source is stored as free text,
  as in 0.2.0.
- The verifier is lazy: `ctx.get('evidence')` is read at call time, so a Seek
  plugin mounted after Trace is picked up without re-applying Trace.
- `service.remember()` called directly (not through the tool) is not verified;
  the gate belongs to `trace_remember`.

## Test

```sh
cd packages/trace
node --test
```

The memento tests use a mock `ctx.memory` / `ctx.memoryAdapters`; no real
memento process is started and no network call is made. They cover import
field mapping, the user-global default, explicit workspace import, conflicts,
idempotent re-import, export, adapter round-trip and the missing-service
`E_UNAVAILABLE` path.

## Scope and limitations

0.3.0 is still a **governance contract**, not a storage engine: explicit
writes only, no automatic capture, no embedding, no multi-tenant isolation and
no persistence. The memento bridge is intentionally read-only and the adapter
is opt-in. memento v1's workspace layer cannot be filtered by `workspaceKey`,
so importing it is an explicit, warned opt-in and Trace does not claim
cross-workspace isolation for it. Import does not re-run Trace's secret
classification: memento text is stored as `normal` unless the payload supplies
a sensitivity, so review memento content before importing it. A future release
adds SQLite-backed persistence while keeping `trace-export-v1` stable.

## License

MIT.
