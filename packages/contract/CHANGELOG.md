# Changelog

## 0.2.0

- Add `lib/result.js`: `ok()` (bounded `OsResult` envelope, automatic
  `truncated`), `page()` (opaque `v1.<base64url>.<hmac>` cursors, injectable
  key), `makeHandle()` / `parseHandle()` and `HANDLE_KINDS`.
- Add `lib/error.js`: `OsError`, `err()`, the nine `ERROR_CLASSES`,
  `isRetryable()` and `toToolError()`; legacy `error.code` strings are aliased
  and kept in `details.legacyCode`.
- Add `lib/audit.js`: `auditEvent()` builds a minimal in-memory audit record
  and never persists it.
- Re-export the protocol helpers from the package root.
- Zero runtime dependencies; still no I/O, no Host service and no plugin
  registration. The only process state is the optional cursor signing key.
- Add `node --test` coverage for envelopes, pagination, cursor tampering,
  handle round-trips, error aliases, retryability and truncation.

## 0.1.0

- Initial contract: canonical services, capabilities, `ERROR_CODES`, the
  dsh-os object base, `dsh://` refs, `assertManifest()` and `defineTool()`.
