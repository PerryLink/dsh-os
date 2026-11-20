# Trace · `@perrylink/dsh-trace`

> Auditable long-term memory governance for DeepSeek Harness: provenance, expiry, conflict and forget.

**Status: 0.1.0 是记忆治理协议 MVP；memento v1 适配器在 0.2.0。**
(0.1.0 is the memory-governance protocol MVP; the memento v1 adapter lands in 0.2.0.)

0.1.0 ships an in-memory, dependency-free governance ledger and the
`trace_remember` / `trace_search` / `trace_forget` / `trace_list` agent tools.
It does **not** connect to memento, a vector database, SQLite or the network.
Records are process-local and disappear when the host restarts.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-trace
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
  expiresAt: 1795268400000,        // only when ttlMs was set
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
- Superseded versions stay in `export()` (`trace-export-v1`) so the chain is
  auditable. They never appear in `search()` or `list()`.

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

## Agent tools

All four tools are plain `ToolDefinition` objects (no `@deepseek-ai/dsh-tools`
dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `trace_remember` | `key`, `text`; optional `source`, `scope`, `confidence`, `ttlMs`, `sensitivity`, `force` | `{ record }`, or `{ ok: false, code: 'trace_confidence_too_low', message, current }` |
| `trace_search` | `query`; optional `limit` | `{ results }` |
| `trace_forget` | `key` | `{ forgotten }` |
| `trace_list` | optional `limit` | `{ records }` |

`limit` defaults to 20 and is capped at 100. Search is a case-insensitive
substring match over key and text; key matches rank above text matches, then
confidence and recency break ties.

## Test

```sh
cd packages/trace
node --test
```

## Scope and limitations

0.1.0 is deliberately a **governance contract**, not a storage engine: explicit
writes only, no automatic capture, no embedding, no multi-tenant isolation and
no persistence. The next release will add the `dsh-memento` v1 import/adapter
and SQLite-backed persistence while keeping `trace-export-v1` stable.

## License

MIT.
