# Changelog

All notable changes to `@perrylink/dsh-os-mcp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-11-21

### Added

- `--allow-write` write path. It exposes `os_do`, `os_request` and write cards;
  the default remains read-only with exactly the previous six tools.
- `os_request` creates or polls a pending approval request and returns
  `requestId`, `status`, `handles` and `nextTools`.
- Single-use `approvalToken` issuance after approval. Tokens are bound to the
  capability plus a canonical SHA-256 arguments hash, expire after 5 minutes,
  and are consumed atomically on the first successful `os_do`.
- `os_approve` admin tool, exposed only with `--allow-write` and
  `--admin-token`. It approves or denies a pending request; the admin token is
  compared in constant time and never logged.
- `--approve <id>` CLI for local approval, with `--request-store <file>` to
  share pending requests with a running server. The CLI prints request status
  only, never the token.
- File-backed approval store (atomic writes, mode `0600`, 4 MiB limit) in
  addition to the default in-memory store.
- `resources/read` support for `dsh://requests/<id>` handles. Handles are
  redacted: no raw arguments, token hashes or plaintext tokens.
- `-32003` write denials now always include `data.code: "E_DENIED"`,
  `data.subcode` (`grant_required`, `token_invalid`, `token_used`,
  `token_mismatch`, `token_expired` or `admin_required`) and `data.nextTools`.

### Changed

- All resources, including `dsh://` handles, are capped at **32 KiB** (was
  64 KiB for static resources). Truncation happens on a UTF-8 boundary.
- `os_status` reports `mode: "write-approval"` with `--allow-write`, plus
  approval settings (`admin`, `store`, `tokenTtlMs`).
- `os_find` labels write cards with `approval: "os_request_then_os_do"`.
- Write cards remain listed for discovery with `--allow-write`, but direct
  calls still fail with `-32003`; execution must go through `os_do`.
- Server version and package version are now `0.2.0`.
- Published files include this changelog.

### Security

- Write tools and write cards are absent from `tools/list` unless explicitly
  enabled. No approval, token or execution path exists in read-only mode.
- The model cannot approve its own request or extend a TTL. Approvals come from
  the admin tool or the local `--approve` CLI.
- Request-store files contain arguments and reasons, so they must live in a
  private location; only one server process should own a store file at a time.
- Execution is simulated: no host adapter is connected, so a successful
  `os_do` returns `status: "authorized"`, `applied: false`, `simulated: true`.

## [0.1.0] — 2026-11-20

### Added

- Initial read-only stdio MCP prototype: `os_find`, `os_help`, `os_status`,
  three built-in sample capability cards, `dsh-os://readme`,
  `dsh-os://catalog`, `dsh-os://approval`, `--catalog` loading, MCP protocol
  `2025-06-18`/`2025-03-26`, zero runtime dependencies.
