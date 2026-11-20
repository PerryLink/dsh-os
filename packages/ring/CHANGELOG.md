# Changelog

## 0.1.0

- Add `RingService` at `ctx.ring`: `raise`, `tick`, `ack`, `escalate`, `resolve`,
  `get`, `list` and `receipts`.
- Add the SLA state machine: `pending -> notified -> acked -> resolved`, with
  `escalated` and `expired` branches. Illegal transitions throw `E_STATE`.
- Add the deterministic SLA clock (`tick(now)`): t0 0s, t1 3m, t2 10m, t3 30m,
  and a 60-minute default case TTL. Missed steps collapse into one catch-up
  escalation per case per tick.
- Record delivery, escalation, ack, decision and expiry receipts locally. No
  notification, IM or voice channel is contacted in this release; those land in
  0.2.0.
- Add plain tool definitions `ring_raise`, `ring_ack`, `ring_escalate`,
  `ring_list` and `ring_receipts`.
- Ack is explicitly not approval: v0 never approves remotely.

## 0.0.1

- Reserve the `dsh-ring` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
