# Changelog

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
