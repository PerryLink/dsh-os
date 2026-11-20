# Ring · `dsh-ring`

> **Approval SLA, not a notification app.** Raise a blocking approval, page on a
> fixed t0–t3 schedule, stop on ack, record every step as a local receipt.

**Status: 0.1.1 — SLA state machine MVP.** Cases advance only through explicit
`tick(now)` calls, and every delivery is recorded locally. **No notification is
actually sent.** IM (webhook) and voice channels are planned for **0.2.0**.
**v0 only acknowledges; it never approves remotely** — ack is not approval, and
the final decision still comes from the Web/host approval seam.

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
ctx.ring.tick(Date.now())                                  // t0: pending -> notified
ctx.ring.ack(kase.id, { by: 'alice@example.com' })         // ack, not approve
ctx.ring.resolve(kase.id, { decision: 'allowed-once' })    // final decision
const receipts = ctx.ring.receipts(kase.id)
```

| Method | Purpose |
|---|---|
| `raise({ source, risk = 'write', ttlMs?, escalationChain? })` | Create a `pending` case. `source` is free-form (`approval`, `job`, `hook`, `act`, `manual`, …). `ttlMs` defaults to 60 minutes. |
| `tick(now?)` | Advance every open case to `now`. Returns `{ now, receipts, cases }`; at most one catch-up escalation per case per call. |
| `ack(id, { by })` | Claim the case (`acked`), stop escalation, keep a receipt. |
| `escalate(id, { to? })` | Move to `escalated` at a chain level (`1`, `"t2"`) or record a free-form target label. Omit `to` to advance one level. |
| `resolve(id, { decision })` | Record the human outcome (`resolved`). An expired case must be re-paged first; a decision recorded after expiry is marked `late`. |
| `list({ status? })` | Case snapshots, optionally filtered by one status or an array of statuses. |
| `receipts(id)` | All receipts for a case, in insertion order. |

`raise`, `ack`, `escalate` and `resolve` return a defensive copy of the case;
`get(id)` is also available for a single snapshot.

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
- Nothing is sent over a network, spawned, or written to the session log.

## Receipts

```js
{ id, caseId, kind, at, channel?, by?, to? }
```

`kind` is one of `delivery` (t0), `escalation` (t1–t3), `ack`, `decision` or
`expiry`. `channel` is the recorded target channel; `by` is the acknowledging
principal; `to` is the SLA level or explicit escalation target.

Receipts are immutable, append-only evidence: stored entries are frozen and
never rewritten, and every read (and every `tick()` result) returns defensive
copies, so mutating a returned receipt cannot change the ledger. Receipts prove
what the ledger recorded, not that a channel delivered anything.

## Agent tools

| Tool | Arguments |
|---|---|
| `ring_raise` | `source`, optional `risk`, `ttlMs`, `escalationChain` |
| `ring_ack` | `id`, `by` |
| `ring_escalate` | `id`, optional `to` |
| `ring_list` | optional `status` |
| `ring_receipts` | `id` |

Tools are plain `ToolDefinition` objects and return `{ case }`, `{ cases }` or
`{ receipts }`. There is deliberately no model-facing `ring_resolve`: the model
can raise, list, page and acknowledge, but only the human/approval seam records
the decision.

## Errors

| Code | Meaning |
|---|---|
| `E_STATE` | Illegal state transition (e.g. acking a resolved case, auto-escalating an expired one) |
| `E_NOT_FOUND` | Unknown case id |
| `E_INPUT` | Invalid argument, risk, status, timestamp or escalation target |
| `E_TTL` | Invalid `ttlMs` |
| `E_CHAIN` | Invalid or duplicate escalation chain |

## License

MIT.
