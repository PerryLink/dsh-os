# Notify · `@perrylink/dsh-notify`

> **Route a notification, then prove what happened.** A channel registry and a
> local delivery ledger for DeepSeek Harness — the wiring, not the channels.

**Status: 0.1.0 — routing and ledger only.** `ctx.notify` keeps registered
channels, routes `send()` to them and records every attempt. **No real channel
is implemented and nothing leaves the process.** IM/webhook, desktop and
phone/voice adapters land in **0.2.0**. **Ring can use it to send escalation
notifications** — register an adapter and call `send()` from its tick/escalate
path; until 0.2.0 that path only writes the ledger.

`dsh-notify` on npm is already taken by an unrelated package, so this module
publishes as `@perrylink/dsh-notify`. Product name: **Notify**.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-notify
# or
npm install @perrylink/dsh-notify
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies.

## Service

The bundle provides `ctx.notify`:

```js
ctx.notify.registerChannel({
  name: 'im',
  async send({ id, channel, title, body, priority }) {
    // Adapter owns its transport. 0.1.0 ships no adapters.
  },
})

await ctx.notify.send({
  channel: 'im',
  title: 'Ring escalation t2',
  body: 'Approval case 4f2c is 10 minutes old.',
  priority: 'high',
  dedupeKey: 'ring:4f2c:t2',
})

ctx.notify.history(20)   // newest first
ctx.notify.clear()
```

| Method | Purpose |
|---|---|
| `registerChannel({ name, send })` | Register one adapter and return `{ name }`. `send` must be a function; a duplicate name throws `E_CONFLICT`. |
| `channels()` | Registered channel names in registration order. |
| `send({ channel, title, body?, priority?, dedupeKey? })` | Resolve `{ delivery, deduped }` after routing one notification. `priority` is `low`, `normal`, `high` or `urgent` (default `normal`). An unknown channel rejects with `E_UNAVAILABLE` and writes nothing. |
| `history(limit = 50)` | Delivery records, newest first, at most `limit` (1–1000). |
| `clear()` | Empty the ledger and dedupe memory; returns `{ cleared }`. Registered channels stay mounted. |

Every delivery record is:

```js
{ id, channel, ok, error, at }
```

`ok` is `true` when the adapter resolved; `error` is `null` on success or the
error message when the adapter threw or rejected. Stored records are frozen and
every read returns a copy. **An adapter failure is recorded, not thrown**, so
the ledger keeps the evidence; only routing/input errors reject.

## Dedupe

`dedupeKey` is an idempotency key. Inside the dedupe window (default **5
minutes**) a key is delivered **once**, across channels: the first routed
attempt wins and a repeat returns the original `delivery` with `deduped: true`,
without calling the adapter or appending a record. The window is global rather
than per-channel, and a failed attempt still consumes the key for that window.
`clear()` forgets keys. Dedupe state is process-local and not persisted.

Plugin config: `dedupeWindowMs` (positive number) and `now` (clock function for
tests).

## Agent tools

| Tool | Arguments |
|---|---|
| `notify_send` | `channel`, `title`, optional `body`, `priority`, `dedupeKey` |
| `notify_channels` | — |
| `notify_history` | optional `limit` |

Tools are plain `ToolDefinition` objects. `notify_send` returns
`{ delivery, deduped }`, `notify_channels` returns `{ channels }` and
`notify_history` returns `{ history }`.

## Errors

| Code | Meaning |
|---|---|
| `E_UNAVAILABLE` | The requested channel is not registered |
| `E_CONFLICT` | The channel name is already registered |
| `E_INVALID_ARGUMENT` | Bad config, channel, title, body, priority, key or limit |

## Scope

0.1.0 is deliberately a router and a ledger, not a notification app: it has no
network access, no persistence, no telemetry and no bundled adapters. 0.2.0
adds the IM (webhook), desktop and phone/voice channel implementations. The
ledger proves what was attempted, not that a remote service accepted it.

## License

MIT.
