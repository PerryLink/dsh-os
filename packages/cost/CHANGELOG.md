# Changelog

## 0.1.0

- Add `CostService` (`summary` / `setBudget` / `listBudgets` / `check`) exposed as
  the Host service `ctx.cost`.
- Adapter only: reads `ctx.costMeter` (dsh-cost-meter) or `ctx.cost` through
  `summary()` / `status()` / `usage()`; with no meter it returns
  `{ available: false, reason }`. `getState()` / `getLocalState()` from
  dsh-cost-meter are projected to `today`, `month`, `total` and `budgetUsed`.
- Keep a local USD budget ledger: one budget per `(scope, period)`, `global`/`*`
  wildcards, optional atomically written `stateFile`, malformed state fails
  closed with `E_STATE`.
- Pre-flight gate: an over-limit check returns
  `{ allowed: false, code: 'E_LIMIT' }`; invalid amounts, scopes and periods
  throw `E_INVALID_ARGUMENT`.
- Register the `cost_summary`, `cost_budget_set` and `cost_budget_check` agent
  tools using plain tool definitions (no `@deepseek-ai/dsh-tools` dependency).
- Add `node --test` coverage for the missing meter, a mock meter, allow/deny,
  invalid amounts, persistence/corrupt state and the tools.
