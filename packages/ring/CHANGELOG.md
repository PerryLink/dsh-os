# Changelog

## 0.1.1

- Make `expired` terminal for direct decisions: `ack()` and `resolve()` on an
  expired case now throw `E_STATE` instead of moving it back to an active state.
  The only in-place way to reopen a case is an explicit `escalate(id, { to })`
  late page; otherwise raise a new case. A case decided after it expired is
  still marked `late`.
- Keep `tick()` from ever re-escalating a `resolved` case (already enforced;
  now covered by a regression test), and never revive a closed case.
- Make receipts immutable evidence: stored entries are frozen, append-only and
  never rewritten; every read and every `tick()` result returns defensive
  copies, so mutating a returned receipt cannot change the ledger.
- Add state-machine tests for expired ack/resolve refusal, late pages, and
  resolved-case ticks.

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
