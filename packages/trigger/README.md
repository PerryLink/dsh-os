# Trigger · `dsh-trigger`

> Event-to-action trigger fabric for DeepSeek Harness: **when X happens and Y
> holds, run Z and keep a receipt.** This is an event-trigger fabric, not a
> `dsh-hooks`-style lifecycle hook.

**Status: 0.1.0 is an in-memory protocol MVP.** It provides the `ctx.triggers`
seam, a condition DSL, per-trigger cooldown, a run ledger and four agent tools.
The fs/webhook/agent source adapters, retries/dead letters and persistence are
planned for **0.2.0**. The MVP does not subscribe to the host event catalog
(the 111 known events), does not run cron and does not start model turns.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-trigger
```

## Seam: `ctx.triggers`

```js
import { apply } from 'dsh-trigger'

const service = apply(ctx)          // or new TriggerService({ now, maxRuns })
service.register({
  id: 'tg_report',
  event: 'file/changed',
  condition: { field: 'payload.name', op: 'startsWith', value: 'report' },
  cooldownMs: 5_000,
  action: async (payload, { event, trigger, run }) => ({ seen: payload.name }),
})

await service.fire('file/changed', { name: 'report.pdf' })
service.list()
service.unregister('tg_report')
service.runs(20)
```

- `register({ id, event, condition?, action, cooldownMs? })` validates and
  returns the frozen trigger record. `action` is a function or a built-in id
  (`record` / `echo`). Duplicate ids throw `trigger_exists`.
- `event` matching is exact. All matching triggers run sequentially in
  registration order; one run is recorded per execution.
- `cooldownMs` defaults to `0`. A fire inside the window is reported in
  `skipped` instead of queued or run. The window starts with the attempt, even
  when the action fails.
- `fire(event, payload)` never rejects because an action failed; the failure
  becomes `run.ok = false` plus `run.error`. A condition that throws fails
  closed and appears as `reason: 'condition-error'`.
- It returns `{ event, runs, skipped, results }`:
  `runs` are the ledger entries `{ id, triggerId, event, ok, error, startedAt,
  durationMs }`, `skipped` is `[{ triggerId, reason }]`, and `results` carries
  `{ triggerId, runId, result }` for successful action returns.
- `runs(limit?)` returns the ledger newest first. It is capped at 1,000 entries
  in memory (`maxRuns` in the service options).

## Conditions

A function `(payload) => boolean`, or a declarative node:

```json
{ "field": "payload.meta.size", "op": "gt", "value": 10 }
```

Supported ops: `eq`, `neq`, `in`, `nin`, `exists`, `gt`, `gte`, `lt`, `lte`,
`contains`, `startsWith`. Fields are dotted payload paths; a leading `payload.`
is accepted. `in` / `nin` require an array; `exists` ignores `value`. Missing
fields make `eq`/`in`/comparisons false and `neq`/`nin` true. No expression
evaluation or `eval` is involved.

## Built-in actions

- `record` — demo action whose only effect is the run entry written by
  `fire()`; returns `{ recorded, runId, event, payload }`.
- `echo` — returns the payload.

## Agent tools (plain ToolDefinitions)

| Tool | Arguments | Result |
|---|---|---|
| `trigger_register` | `id`, `event`, `actionId` (`record`/`echo`) | `{ trigger }` |
| `trigger_list` | — | `{ triggers }` |
| `trigger_fire` | `event`, optional `payload` | `{ event, runs, skipped, results }` |
| `trigger_runs` | optional `limit` | `{ runs }`, newest first |

## 0.2.0

fs/webhook/agent source adapters, JSONL run persistence, retries/backoff, dead
letters and `trigger_explain` are next. See the
[design notes](https://github.com/PerryLink/dsh-os/blob/main/docs/design/06-trigger.md).

## License

MIT.
