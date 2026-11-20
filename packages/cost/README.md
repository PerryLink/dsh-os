# Cost · `@perrylink/dsh-cost`

> An optional cost **adapter** for DeepSeek Harness: meter passthrough plus a
> local USD budget ledger and a pre-flight gate.

**Status: 0.1.0 (MVP). An adapter, not a meter.**

**本模块是适配器，不是计费器（adapter, not a meter）。先安装 `dsh-cost-meter`；
本模块只做本地预算与门禁（budgets and the pre-flight gate），不数 token、不算价格、
不写费用账本、不发网络请求。**

Cost never counts tokens, prices calls, stores a spend history or talks to a
provider. It reads the meter that already does that and answers three questions:
*what is the cost summary*, *what is the local budget*, and *may this estimated
spend go ahead*.

> The name `dsh-cost` on npm belongs to another project. This module is published
> as `@perrylink/dsh-cost`; the product name is **Cost**.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-cost-meter          # the meter (optional but required for summary)
dsh plugin --profile web add @perrylink/dsh-cost     # this adapter
```

No runtime dependencies, no build step, Node 22.19+ (or Node 24.9+).

## What it is / is not

| | `dsh-cost-meter` | Cost |
|---|---|---|
| Owns token counting, pricing, spend ledger | yes | **no** |
| Reads a meter | — | yes, through `ctx.costMeter` / `ctx.cost` |
| Stores local USD budgets | optional built-in | **yes** (`ctx.cost`) |
| Pre-flight budget gate (`E_LIMIT`) | — | **yes** |
| Network / telemetry | own policy | **none** |

Without a meter, `summary()` reports the meter as unavailable but the budget
ledger and the gate still work.

## Host service `ctx.cost`

```js
const cost = ctx.get('cost')

await cost.summary()
// { available: true, source: 'costMeter', method: 'summary', summary: { ... } }
// { available: false, reason: 'no cost meter installed; ...' }

cost.setBudget({ scope: 'session:42', limitUsd: 2, period: 'session' })
// { id: 'budget:session:42:session', scope, period, limitUsd, createdAt, updatedAt }

cost.listBudgets()                       // [{ ...budget }]

cost.check({ scope: 'session:42', estimatedUsd: 1.5 })
// { allowed: true, remainingUsd: 0.5, checked: [...] }

cost.check({ scope: 'session:42', estimatedUsd: 9 })
// { allowed: false, code: 'E_LIMIT', limitUsd: 2, period: 'session', ... }
```

### `summary()`

Looks up `ctx.costMeter` first, then `ctx.cost`, skipping itself (the service is
registered as `ctx.cost`, so the self-check prevents recursion). A provider is
read through the first available method of `summary()`, `status()`, `usage()`,
`getState()` or `getLocalState()`.

`dsh-cost-meter` exposes `getState()`; Cost projects that client snapshot down to
`today`, `month`, `total` and `budgetUsed` so the agent tool does not receive the
whole meter state. A missing meter, an unsupported provider or a throwing read
returns `{ available: false, reason }` — never an exception.

### Budgets

A budget is one record per `(scope, period)`; setting the same pair again
replaces it and keeps `createdAt`. `scope` is an exact name such as
`session:42`, or `global` / `*` to apply to every scope. `period` must be
`session`, `day`, `month` or `total` and labels the window; Cost does not reset
spend by itself because it does not track spend.

`check({ scope, estimatedUsd, spentUsd?, period? })` evaluates **every** budget
that applies to the scope (exact, plus global wildcards) and is strict: the
first failing budget denies the check. `spentUsd` is the amount already spent in
the period, read from the meter by the caller (default `0`). `period` narrows
the check to one window; omitting it checks all matching windows. No matching
budget means no local limit, so the check is allowed. Denials are structured:

```js
{ allowed: false, code: 'E_LIMIT', scope, estimatedUsd, spentUsd, limitUsd, period, remainingUsd, reason, checked }
```

Invalid amounts (`0`/negative/`NaN`/`Infinity`/strings for `limitUsd`, negative
or non-finite `estimatedUsd`/`spentUsd`), bad scopes and unknown periods throw
`Error` with `code: 'E_INVALID_ARGUMENT'`.

The ledger is in memory by default. Pass `{ stateFile }` as the plugin config to
get an atomically written JSON file (`version: 1`). A malformed or unreadable
state file fails closed with `E_STATE` at mount time; a corrupted ledger never
authorizes anything.

## Agent tools

- `cost_summary` — no arguments; returns `summary()`.
- `cost_budget_set` — `limitUsd` required; `scope?`, `period?`.
- `cost_budget_check` — `estimatedUsd` required; `scope?`, `spentUsd?`, `period?`;
  an over-limit check returns `{ allowed: false, code: 'E_LIMIT' }`.

All three are plain `ToolDefinition` objects (no `@deepseek-ai/dsh-tools`
dependency).

## Test

```sh
cd packages/cost
node --test
```

## License

MIT.
