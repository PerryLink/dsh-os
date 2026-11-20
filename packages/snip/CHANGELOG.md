# Changelog

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
