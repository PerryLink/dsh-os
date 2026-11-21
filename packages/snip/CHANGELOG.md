# Changelog

## 0.3.0

- Add an `os.result/v1` envelope to `snip_search`:
  `{ schema, ok, tool, summary, items, page, truncated, next, error }`.
  `summary` names the full match count (≤200 chars); `page` reports
  `{ limit, offset, returned, total, hasMore }`; `next` suggests the next
  `snip_search` page or `snip_get` for the newest match.
- Default page size is 20 and is capped at 100; add the optional `offset`
  argument. Keep the legacy `query` and `entries` fields unchanged (`items` and
  `entries` are the same page).
- Add `SnipService.searchPage()` (full match count + offset window);
  `SnipService.search()` keeps its array return value.
- Search failures return `{ ok: false, code, error }`; the original `SNIP_*`
  code is preserved and `error` adds
  `{ code, message, retryable, remediation, nextTools }`.
- Ship the zero-dependency helper `lib/result.js`; add envelope tests for the
  default limit, the 100 cap, offset paging, truncation, legacy fields and the
  `SNIP_BAD_QUERY` failure.

## 0.2.0

- Add opt-in OS clipboard capture in `lib/capture.js`: `ClipboardAdapter` with
  `available`, `read`, `watch` and `stop`, plus Windows, macOS and Linux
  adapters. Windows prefers WinRT `Clipboard.GetContent()` through Windows
  PowerShell 5.1 and falls back to `Get-Clipboard -Raw`; macOS uses `pbpaste`;
  Linux uses `wl-paste --no-newline` or `xclip -selection clipboard -o`.
  Every read uses fixed argv, no shell, a 5 s timeout and an environment
  scrubbed of `DSH_*` and token-looking variables.
- Add `SnipService.capture({ sourceApp })`, `watch({ intervalMs })` and
  `stopWatch()`. Capture is **off by default** (`capture.enabled`); mounting
  never reads the clipboard or starts a timer. Captured text goes through the
  existing secret redaction and TTL, and identical content is deduplicated by
  an in-memory SHA-256 hash.
- Add `snip_capture`, `snip_watch_start` and `snip_watch_stop` tools. Capture
  results contain a handle and metadata, never the clipboard text. Watching
  starts only on an explicit `snip_watch_start` call.
- Honor `ExcludeClipboardContentFromMonitorProcessing` on Windows on a
  best-effort basis; classify images/files without reading them.
- Update the bundle manifest (`files` now ships `lib/`, `spawn` capability,
  three new tools), README and platform/permission matrix.
- Add `test/capture.test.js`: fake-runner text/empty/image/file/excluded/
  secret/timeout cases, fixed-argv and environment checks, default-off and
  availability checks, fake-timer watch/dedupe/stop coverage, and tool tests.

## 0.1.1

- Screen `sourceApp` for secrets and validate it: non-strings, control
  characters, labels over 80 characters and secret-looking labels are rejected
  with `SNIP_BAD_SOURCE_APP`; empty labels become `unknown`. Persisted
  snapshots are re-sanitized on load.
- Persist before committing: `add`, `forget`, `clear` and expiry sweeps build
  the next ledger state, write it, and only then replace memory. A failed write
  now throws `SNIP_STATE_WRITE_FAILED` and leaves both memory and disk at the
  previous state instead of letting them diverge.
- Confirm and test the redaction boundary: `search` only scans stored (already
  redacted) text, and `forget` leaves no in-memory index or snapshot residue.
- Add failure-injection tests for a read-only state directory and regression
  tests for `sourceApp`, search-after-redaction and forget-after-reload.

## 0.1.0

- Implement `SnipService` with `add`, `list`, `search`, `get`, `forget` and
  `clear`, plus stable `clipboard://<id>` handles.
- Exclude secrets by default: `sk-...`, `ghp_...` / `github_pat_...`,
  `AKIA...` / `ASIA...`, PEM/PGP private keys, `password=...`, API keys,
  bearer tokens, JWTs and common provider tokens. Matching input is never
  stored; only `[redacted:<reason>]` is kept and `redacted` is `true`.
- Add a 24-hour default TTL, a 200-entry cap and a 64 KiB per-entry cap with
  automatic expiry and oldest-first eviction.
- Add optional atomic JSON snapshots through `stateFile` (temporary file plus
  `rename`, mode `0600`, re-screened on load).
- Provide `ctx.snip` and six plain-object agent tools: `snip_add`,
  `snip_search`, `snip_get`, `snip_list`, `snip_forget`, `snip_clear`.
- 0.1.0 is a ledger only: no OS clipboard polling, no background capture, no
  network access and no encryption yet.
- Add `node --test` coverage for CRUD, handles, redaction, TTL/eviction,
  persistence and tool registration.

## 0.0.1

- Reserve the `dsh-snip` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
