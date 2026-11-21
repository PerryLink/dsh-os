# Changelog

## 0.3.0

- Every run recorded by `fire()` now keeps the event payload and a display
  path, closing the WF3 gap: `{ id, triggerId, event, payload, path, ok, error,
  startedAt, durationMs }`. `path` is relative to `process.cwd()` when the
  event path is inside it, otherwise the final segment; the full value stays in
  `payload.path`. `trigger_runs` therefore tells an agent which file changed.
- Payloads are projected, never stored raw: `sk-…`, `ghp_…`/other `gh*` tokens,
  `AKIA…`, `Bearer …` and PEM private-key blocks are redacted, credential-named
  fields become `[REDACTED]`, each string is shortened, and the JSON form is
  capped at **2 KiB** (`MAX_PAYLOAD_BYTES`). Oversized payloads degrade to a
  redacted `{ truncated, bytes, preview }`. The projection is deep-frozen, so
  readers and late actions cannot rewrite the ledger; the live payload passed
  to conditions and actions is never mutated.
- Add `lib/payload.js` with `sanitizePayload`, `redactText`, `truncateText`,
  `displayPath` and `runFields`; the entry point stays under the 450-line
  conformance cap.
- Add `node --test` coverage for path visibility, tool visibility
  (`trigger_runs`), secret redaction, the 2 KiB cap and payload immutability.
- Manifest: version 0.3.0. No new tools (still seven).

## 0.2.0

- Add three real event sources on top of the existing registry:
  `service.startSource(type, opts)` / `stopSource(id)` / `sources()`, backed by
  `agent`, `fs` and `webhook` adapters under `lib/sources/`.
- `agent` subscribes to `session/event` plus `agent/error` / `agent/status`,
  projects only `turn/end`, `approval/asked` and `tool/result` into
  metadata-only payloads, and dedupes by `sessionId:seq`; `stop()` removes every
  listener.
- `fs` composes the `ctx.fs.watch` invalidation signal with a non-recursive
  `stat` / `listDir` snapshot diff keyed by `path + size + version`, coalesced
  by `debounceMs`, and emits `fs.change` `{ path, kind }` (`add` / `change` /
  `unlink`). No file content and no recursion.
- `webhook` registers one exact loopback-only `POST /os-trigger/<token>` route
  on `ctx.webServer`, with a 256 KiB body cap, HMAC-SHA256 over
  `${timestamp}.${body}` and a ±300 s window when a secret is configured,
  `X-GitHub-Delivery` replay dedupe, and `E_UNAVAILABLE` when the profile has no
  web server or a non-loopback host.
- Add `trigger_sources`, `trigger_source_start` and `trigger_source_stop`
  agent tools. Tool-started sources take `secretEnv`, never a raw secret.
- `apply()` now disposes every running source when the plugin unloads.
- Add a fake-provider `node --test` suite covering agent projection and dedupe,
  fs add/change/unlink/recursion limits, webhook signature, stale timestamp,
  body cap, loopback gate, delivery replay and source lifecycle; no real port
  is opened.
- Manifest: version 0.2.0, `lib` shipped, capabilities `fs.read` / `net`.

## 0.1.0

- Implement the in-memory Trigger protocol MVP: `ctx.triggers` with
  `register` / `unregister` / `list` / `fire` / `runs`.
- Add exact-event matching, function and `{ field, op, value }` DSL conditions,
  per-trigger cooldown and a bounded in-memory run ledger.
- Record action failures in the run instead of throwing; report cooldown and
  condition skips alongside fire results.
- Add built-in demo actions `record` and `echo`.
- Add the `trigger_register`, `trigger_list`, `trigger_fire` and `trigger_runs`
  agent tools and a `node --test` suite.

## 0.0.1

- Reserve the `dsh-trigger` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
