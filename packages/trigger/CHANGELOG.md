# Changelog

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
