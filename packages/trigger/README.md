# Trigger · `dsh-trigger`

> Event-to-action trigger fabric for DeepSeek Harness: **when X happens and Y
> holds, run Z and keep a receipt.** This is an event-trigger fabric, not a
> `dsh-hooks`-style lifecycle hook.

**Status: 0.2.0 ships three real event sources** — agent (`session/event`),
fs (`ctx.fs.watch` invalidation + snapshot diff) and webhook (loopback HTTP
when `ctx.webServer` exists). It still keeps the 0.1.0 seam (`ctx.triggers`), the
condition DSL, per-trigger cooldown and the in-memory run ledger. Everything is
in memory: a restart loses triggers, runs and dedupe state. Delivery is
at-least-once with a bounded dedupe window, **not** exactly-once.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-trigger
```

The package has **zero runtime dependencies** and works under Node 22.19+.
`agent` and `fs` sources work in every profile; `webhook` needs the web bundle
that provides `ctx.webServer`.

## Real event sources

A source subscribes once and feeds `fire()`: every emitted payload carries its
trigger event name in `type`, so match it exactly when registering.

```js
const source = await service.startSource('fs', { path: '/work/inbox', debounceMs: 300 })
service.register({
  id: 'tg_pdf',
  event: 'fs.change',
  condition: payload => payload.path.endsWith('.pdf'),
  action: payload => ({ seen: payload.path }),
})
await service.stopSource(source.id)
```

| Source | Host surface | Trigger events | Dedupe key | Boundary |
|---|---|---|---|---|
| `agent` | `ctx.on('session/event')`, `agent/error`, `agent/status` | `session/turn-end`, `session/approval-asked`, `session/tool-result`, `agent/error`, `agent/status` | `<sessionId>:<seq>` (session events) | metadata only; no backfill |
| `fs` | `ctx.fs.stat` / `listDir` / `watch` | `fs.change` with `{ path, kind }` | `path\|kind\|size:version` | **non-recursive**; no file content |
| `webhook` | `ctx.webServer.register` | `webhook/received` | `X-GitHub-Delivery`, else `sha256(body)` | loopback only; ≤256 KB |

Every source is started idempotently per id, is listed by `sources()` with live
counters (`events`, `skipped`, `dropped`, `rejected`) and is torn down by
`stopSource(id)`, `dispose()`, or the plugin's Cordis effect.

### `agent`

```js
await service.startSource('agent', { sessionId: 'ses_optional_filter' })
```

- Subscribes to the post-commit `session/event` feed and to `agent/error` /
  `agent/status`; all three listeners are removed by `stop()`.
- Whitelist: `turn/end`, `approval/asked`, `tool/result`. Other session events
  (`step/*`, `assistant/*`, …) are ignored. Never subscribes to waterfall or
  bail events such as `approval/request`.
- Dedupe is per `sessionId:seq`, so a re-delivered batch runs once.
- Payloads are **metadata projections**, never message bodies or tool output:
  `turn/end` → `{ turn, reason }`; `approval/asked` → `{ id, toolName, callId }`;
  `tool/result` → `{ turn, step, callId, isError, error }`; `agent/error` →
  `{ turn, step, error: { name, code, message } }` (message capped at 500);
  `agent/status` → `{ status }`.
- Only sessions already loaded in this process are observed; there is no
  historical backfill.

### `fs`

```js
await service.startSource('fs', { path: '/abs/file-or-dir', debounceMs: 300, cwd: '/optional/relative/base' })
```

- `ctx.fs.watch(target, changed, signal)` delivers only an invalidation signal
  (no path, no event kind), so the source takes a `stat`/`listDir` snapshot after
  every signal and diffs it. Identity is `path + size + version`; classify
  absent→present as `add`, present→absent as `unlink`, both present with a
  changed size/version as `change`.
- Watching a file covers in-place writes, atomic replacement, deletion and
  same-path recreation. Watching a directory covers its **direct children only**
  (`depth: 0`) — nested changes never emit.
- Invalidations are merged with `debounceMs` (default 300, `0` allowed) so a
  write storm yields one diff. Timers are `unref()`ed and cleared by `stop()`.
- Payloads are `{ type: 'fs.change', path, kind }`; no content and no `mtime`.
  Actions that need bytes call `ctx.fs.readText` themselves under the provider's
  permissions.
- Missing `ctx.fs` or a provider that rejects `watch()` (for example SSH) returns
  `E_UNAVAILABLE`, never a silent no-op.

### `webhook`

```js
await service.startSource('webhook', {
  token: 'optional-8-128-chars',       // default: 16 random bytes, hex
  secretEnv: 'GITHUB_WEBHOOK_SECRET',  // recommended; or `secret: '…'` in code
  maxBodyBytes: 262_144,
  replayWindowMs: 300_000,
})
// → info.path = '/os-trigger/<token>'
```

Registers one exact route `POST /os-trigger/<token>` with `auth: 'anonymous'`
on `ctx.webServer`. `E_UNAVAILABLE` is returned when the profile has no
`ctx.webServer`, when `ctx.webServer.host` is not loopback, or when the route is
already registered. `allowNonLoopback: true` is the explicit (discouraged)
opt-out of the host and per-request loopback checks.

Requests are machine deliveries, not a browser API:

| Check | Behavior |
|---|---|
| Method | only `POST`; anything else `405` |
| Peer | `req.socket.remoteAddress` must be `127.0.0.0/8` or `::1`; otherwise `403` |
| Body | streaming cap `maxBodyBytes` (256 KiB); over the cap `413` |
| Timestamp | when a secret is configured: `x-dsh-trigger-timestamp` (unix seconds) must be within `±replayWindowMs` (300 s); otherwise `401` |
| Signature | when a secret is configured: `x-dsh-trigger-signature-256: sha256=<hex>` over `` `${timestamp}.${rawBody}` ``, compared with `crypto.timingSafeEqual`; otherwise `401` |
| JSON | body must parse as JSON; otherwise `400` |
| Dedupe | `x-github-delivery` (fallback `sha256(rawBody)`) is remembered in a bounded set; a repeat returns `202` plus `x-dsh-trigger-duplicate: 1` and does **not** fire |
| Success | `202 { ok: true, deliveryId }` |

The secret is read once at `startSource` time from `secretEnv` (or the inline
`secret`) and never appears in `sources()`, run records or errors. **Without a
secret there is no authentication**: the source still checks loopback, the URL
token, the body cap and delivery dedupe, but any local process that knows the
token can post. Use a secret for anything that matters, and remember that behind
a reverse proxy `remoteAddress` is the proxy — the HMAC is the real boundary.

## Service API

```js
const service = apply(ctx)                       // provides ctx.triggers
await service.startSource(type, opts)            // → { id, type, startedAt, …, info }
service.sources()                                // running sources, newest counters
await service.stopSource(id)                     // false when no such source
await service.dispose()                          // stop every source
```

- `startSource` validates the type (`agent` / `fs` / `webhook`) and options,
  throws `invalid_source`, `E_UNAVAILABLE` or `source_exists`, and rolls back a
  partially started adapter on failure.
- Emitted events call `fire(type, payload)` without ever blocking the host
  listener, watcher or HTTP handler; action failures stay in the run ledger.
- A source event only runs triggers registered for its exact event name — it is
  not a global `fire()` of every trigger.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `trigger_register` | `id`, `event`, `actionId` (`record`/`echo`) | `{ trigger }` |
| `trigger_list` | — | `{ triggers }` |
| `trigger_fire` | `event`, optional `payload` | `{ event, runs, skipped, results }` |
| `trigger_runs` | optional `limit` | `{ runs }`, newest first |
| `trigger_sources` | — | `{ sources }` |
| `trigger_source_start` | `type`, optional `id`, `path`, `sessionId`, `token`, `secretEnv` | `{ source }` |
| `trigger_source_stop` | `id` | `{ id, stopped }` |

The tools never accept a raw secret; use `secretEnv` or start the source from
code. Tool-started sources live until stopped or the host process exits.

## Core API (0.1.0)

```js
service.register({ id, event, condition?, action, cooldownMs? })  // frozen record
await service.fire(event, { … })                                  // { event, runs, skipped, results }
service.list(); service.unregister(id); service.runs(limit)
```

- `event` matching is exact; matching triggers run sequentially in registration
  order; one run per execution. `cooldownMs` starts with the attempt (also when
  it fails); a fire inside the window is reported in `skipped`.
- `action` is a function or a built-in id (`record` / `echo`). Action failures
  become `run.ok = false` + `run.error`; a throwing condition fails closed as
  `reason: 'condition-error'`.
- Conditions are `(payload) => boolean` or `{ field, op, value }` with `eq`,
  `neq`, `in`, `nin`, `exists`, `gt`, `gte`, `lt`, `lte`, `contains`,
  `startsWith`. Fields are dotted payload paths; no expression evaluation.
- `runs(limit?)` returns the newest entries (default cap 1,000 in memory).

## Limits and 0.3.0

- In-memory only: restart loses definitions, the ledger and dedupe windows; there
  is no JSONL persistence, retry/backoff, dead-letter ring or replay yet.
- No fs recursion, no fs watcher re-arm after a provider error (the error is
  counted, and callers should restart the source), and no agent backfill.
- Webhook events are not queued by the host: each accepted delivery is fired
  immediately and independently; the dedupe set is bounded (4,096 keys).
- Next: persistence, retries/dead letters, `trigger_explain`, `agent.run`.

## License

MIT.
