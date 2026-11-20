# Ring · `dsh-ring`

> **Approval SLA, not a notification app.** Raise a blocking approval, page on a
> fixed t0–t3 schedule, stop on ack, record every step as a local receipt.

**Status: 0.2.0 — opt-in notification channels.** Cases advance only through
explicit `tick(now)` calls. By default every step is a local receipt and
**nothing leaves the process**: no channel is enabled, no URL is configured and
no network socket is opened. When a human calls
`ctx.ring.configureChannels({ webhook, ntfy, console })`, `tick()` and
`notify()` may POST through those channels. **v0 still does not approve
remotely** — ack is not approval, `ring_notify` only alerts, and the final
decision still comes from the Web/host approval seam.

This is the approval-paging package, not the unrelated zero-star `dsh-ring`
sound-effect plugin that may occupy the same npm name. A `@perrylink/dsh-ring`
mirror is planned.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-ring
# or
npm install dsh-ring
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies.

## Service

The bundle provides `ctx.ring`:

```js
const kase = ctx.ring.raise({ source: 'approval', risk: 'write' })

// Explicit opt-in. This call performs no network I/O.
ctx.ring.configureChannels({
  webhook: { url: 'https://hooks.example.com/ring', secret: process.env.RING_HMAC_SECRET },
  ntfy: { topic: 'ring-alerts', baseUrl: 'https://ntfy.sh', priority: 'high' },
})

await ctx.ring.tick(Date.now())                            // t0: pending -> notified
await ctx.ring.notify(kase.id, { channel: 'webhook' })     // explicit one-off page
ctx.ring.ack(kase.id, { by: 'alice@example.com' })         // ack, not approve
ctx.ring.resolve(kase.id, { decision: 'allowed-once' })    // final decision
const receipts = ctx.ring.receipts(kase.id)
```

| Method | Purpose |
|---|---|
| `raise({ source, risk = 'write', ttlMs?, escalationChain? })` | Create a `pending` case. `source` is free-form (`approval`, `job`, `hook`, `act`, `manual`, …). `ttlMs` defaults to 60 minutes. |
| `configureChannels({ webhook?, ntfy?, console? })` | Replace the configured channels and return `{ channels }`. Omitted entries are disabled; `{}` clears all. Configuration alone does no network I/O. |
| `channels()` | Configured provider names in registry order. Empty by default. |
| `notify(caseOrId, { channel? })` | Deliver one notification through a configured channel and resolve `{ delivery }`. Omit `channel` to use the case's current chain label. A missing provider or failed request rejects with `E_UNAVAILABLE`. |
| `tick(now?)` | Async. Advance every open case to `now`; returns a Promise of `{ now, receipts, cases, deliveries }`. At most one catch-up escalation per case per call. Configured channels are called best-effort. |
| `ack(id, { by })` | Claim the case (`acked`), stop escalation, keep a receipt. |
| `escalate(id, { to? })` | Move to `escalated` at a chain level (`1`, `"t2"`) or record a free-form target label. Omit `to` to advance one level. |
| `resolve(id, { decision })` | Record the human outcome (`resolved`). An expired case must be re-paged first; a decision recorded after expiry is marked `late`. |
| `list({ status? })` | Case snapshots, optionally filtered by one status or an array of statuses. |
| `receipts(id)` | All receipts for a case, in insertion order. |

`raise`, `ack`, `escalate` and `resolve` return a defensive copy of the case;
`get(id)` is also available for a single snapshot.

## Notification channels

**Default: offline.** The channel registry starts empty. `tick()` then writes
the same local receipts as 0.1.x and performs no fetch. There is no implicit
discovery of environment variables, no default ntfy topic and no default
webhook. Passing `channels` in the plugin config is also explicit and has the
same semantics as calling `configureChannels()`.

| Provider | Transport and limits |
|---|---|
| `webhook` | `POST` one JSON document to `url` with `AbortSignal.timeout(5000)` (override with `timeoutMs`). With `secret`, signs the exact request body and sends `X-Ring-Signature: sha256=<hex>`. A non-2xx response, timeout or network failure rejects with `E_UNAVAILABLE`. The URL may carry a token; it is never put into the payload, receipts, errors or logs, and `url` must not embed a username/password. |
| `ntfy` | `POST <baseUrl>/<topic>` (default `baseUrl` `https://ntfy.sh`) with ntfy's `Priority`, `Title` and optional `Actions` headers. A topic is a bearer secret: it must be 1–64 URL-safe characters and must not contain credential syntax or a password. `baseUrl` must not embed a username/password. Default off. |
| `console` | Append one `[dsh-ring] …` line to `process.stdout`. Local only, for tests and self-hosted setups; inject `write` to capture lines. Default off. |

```js
ctx.ring.configureChannels({
  webhook: { url: 'https://hooks.example.com/ring', secret: 'shared-secret' },
  ntfy: { topic: 'ring-alerts', priority: 'high', actions: 'view, Open, https://example.com/inbox' },
  console: true,
})
```

Escalation labels map to providers: `local` → `console`, `webhook` → `webhook`,
`voice` → `ntfy`. A tick step whose provider is not configured is receipt-only;
it does not fall back to an unrelated channel. `tick().deliveries` contains one
safe record per attempted send (`{ caseId, channel, ok, error?, status?, at }`)
and a failed send never rolls back the case state. `notify()` is the explicit
operator/model path and throws `E_UNAVAILABLE` on failure.

No channel is a remote approval path: payloads contain the case id, source,
risk, state, level and a short generated body. They carry no reason text, tool
arguments, paths, diffs, webhook URL or signing secret, and no channel accepts
an `allow` or `deny` response.

## SLA and states

Default chain: **t0 = 0 s (local), t1 = 3 min (local), t2 = 10 min (webhook),
t3 = 30 min (voice)**. A case expires after 60 minutes. The chain is a full
replacement when passed to `raise`; entries may be numbers (`afterMs`) or
`{ level?, afterMs, channel? }`.

```
pending --t0--> notified --ack--> acked --decision--> resolved
   |               |                |
   +--t1..t3------> escalated ------+ (ack stops further escalation)
any open state --expiresAt--> expired --escalate(to)--> escalated --decision--> resolved
```

- `expired` and `resolved` are not touched by later ticks.
- Acking, escalating or resolving a closed case throws `E_STATE`.
- Expired is terminal for direct decisions: `ack()` and `resolve()` on an
  expired case throw `E_STATE`. The only in-place way to reopen it is an
  explicit late page — `escalate(id, { to })` — after which a decision is
  accepted (and marked `late`); otherwise raise a new case. `tick` never
  revives an expired case.
- An acked case is never escalated automatically. A late page is never
  repeated by `tick`; later ticks leave that page open for a decision.
- Every tick records at most one escalation receipt — the highest due level —
  so jumping straight to t3 emits t0 plus one t3 catch-up instead of a burst.
- Tick delivery is best-effort: a slow or failing channel does not mutate the
  SLA state, and one failed case does not stop other cases in the same tick.

## Receipts

```js
{ id, caseId, kind, at, channel?, by?, to? }
```

`kind` is one of `delivery` (t0), `escalation` (t1–t3), `ack`, `decision` or
`expiry`. `channel` is the recorded SLA label; `by` is the acknowledging
principal; `to` is the SLA level or explicit escalation target. Receipts record
the state machine, not a remote service's acceptance: HTTP results are returned
by `notify().delivery` and `tick().deliveries`.

Receipts are immutable, append-only evidence: stored entries are frozen and
never rewritten, and every read (and every `tick()` result) returns defensive
copies, so mutating a returned receipt cannot change the ledger.

## Agent tools

| Tool | Arguments |
|---|---|
| `ring_raise` | `source`, optional `risk`, `ttlMs`, `escalationChain` |
| `ring_ack` | `id`, `by` |
| `ring_escalate` | `id`, optional `to` |
| `ring_list` | optional `status` |
| `ring_receipts` | `id` |
| `ring_channels` | — |
| `ring_notify` | `id`, optional `channel` |

Tools are plain `ToolDefinition` objects and return `{ case }`, `{ cases }`,
`{ receipts }`, `{ channels }` or `{ delivery }`. `ring_notify` can only send
through channels that a human already configured; it cannot approve, deny or
ack. There is deliberately no model-facing `ring_resolve`: the model can raise,
list, page and acknowledge, but only the human/approval seam records the
decision.

## Errors

| Code | Meaning |
|---|---|
| `E_STATE` | Illegal state transition (e.g. acking a resolved case, auto-escalating an expired one) |
| `E_NOT_FOUND` | Unknown case id |
| `E_INPUT` | Invalid argument, risk, status, timestamp, escalation target or channel configuration |
| `E_TTL` | Invalid `ttlMs` |
| `E_CHAIN` | Invalid or duplicate escalation chain |
| `E_UNAVAILABLE` | The requested channel is not configured, or its delivery failed/timed out |

## Scope

0.2.0 adds opt-in webhook, ntfy and console delivery. It remains an SLA ledger:
no persistence, no telemetry, no inbound web server, no remote approval and no
automatic network access. The `net` capability is declared in the manifest but
is inert until `configureChannels()` receives a channel. Handler failures are
bounded (default 5 s) and never become an approval decision.

## License

MIT.
