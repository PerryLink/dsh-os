# Check · `dsh-canary`

> **Upgrade canary, not an update checker.** Compare two paired runs across
> result, trajectory, cost and approvals, then fail CI only on a real regression.

**Status: 0.4.0 — result envelopes on `check_compare`.** 0.4.0 keeps the
`dsh.check.diff/v1` report unchanged and adds a bounded `os.result/v1`
envelope: `summaryText` (≤200 chars), `regressions`/`warnings` detail arrays,
`page`, `truncated`, `next` and `error`; the legacy `summary` counts object,
`verdict`, `tasks` and `allowFlaky` are untouched. `dsh-check run`
launches `dsh --profile headless --json "<task>"` once per task, maps the four
dimensions, and writes one diffable `run-<id>.json` per task. A real runner
needs a **DSH checkout (or installed CLI) and a model key**; CI should pin
`--profile headless` (the default). The agent tool `check_run` now requires an
Allow Grant, is budget-limited, gets a sanitized environment and is audited.
（真 runner 需要 DSH checkout 与模型 key；`check_run` 需 Grant，有预算/审计。）

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
npm install --save-dev dsh-canary
npx dsh-check --help
```

As a Cordis bundle:

```sh
dsh plugin --profile web add dsh-canary
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies.

## CLI

```sh
# Run a real headless suite. Needs a DSH checkout/CLI and a model key.
# Writes one run-<id>.json per task under --out.
dsh-check run --tasks check.tasks.json --out runs/baseline \
  --dsh-bin /home/me/deepseek-harness/apps/cli/lib/bin.js

# CI: profile headless is the default; --timeout is milliseconds (default 600000).
dsh-check run --tasks check.tasks.json --out runs/candidate \
  --dsh-bin node_modules/.bin/dsh --profile headless --timeout 600000 --json

# Diff a baseline run against a candidate run.
dsh-check diff --old baseline.json --new candidate.json
dsh-check diff --old baseline.json --new candidate.json --json

# Allow a known-flaky task: its diffs stay in the report but do not gate.
dsh-check diff --old baseline.json --new candidate.json --allow-flaky flaky-id
dsh-check diff ... --allow-flaky id-a,id-b --allow-flaky id-c

# Scaffold a tasks file with three example golden tasks.
dsh-check init
dsh-check init ./evals

# List the tasks in a suite.
dsh-check list --file check.tasks.json
dsh-check list --file check.tasks.json --json
```

`--dsh-bin` is the JavaScript entry you would pass to `node` (for example
`node_modules/.bin/dsh` or `apps/cli/lib/bin.js`), not the tool name `dsh`.
Without it, `run` prints `需要 DSH checkout` and exits `2` before spawning
anything. `--json` prints a `dsh.check.run-summary/v1` summary; the per-task
files stay on disk.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | `pass` / `warning`, or every `run` task succeeded |
| `1` | `regression`, or at least one `run` task failed |
| `2` | usage or input error (missing flag, unreadable file, invalid JSON, invalid run shape, no `--dsh-bin`) |

`init` refuses to overwrite an existing `check.tasks.json`.

## Runner

`run` executes each task in its own `dsh` process:

```sh
node <dsh-bin> --profile <profile> --json "<task.prompt>"
```

It captures stdout/stderr, parses the NDJSON event stream, and maps:

| Field | Source |
|---|---|
| `result.text` | the `final.text` event (empty when no `final` arrived) |
| `trajectory.steps` | number of `status` events with `phase: "step_end"` |
| `trajectory.toolCalls` | number of `tool_call` events |
| `trajectory.errors` | `tool_result.status: "error"` + out-of-turn `error` events + an error `final.reason` |
| `cost.tokens` | sum of `step_end.usage.totalTokens` (falling back to input + output) |
| `cost.usd` | always `0`: DSH reports tokens, not USD; bring your own pricing |
| `approvals` | `--json` does not project approval events, so counts stay `0` (or `rejected` is inferred from `SANDBOX_ESCALATION_REJECTED` / `APPROVAL_REJECTED` tool results, with `raw.approvalsSource: "inferred"`) |

Timeout is owned by the runner because headless `dsh` has no `--timeout`: on
timeout (or an aborted `AbortSignal`) it sends `SIGINT`, waits a 5 s grace
period, then sends `SIGKILL`. `SIGTERM` is deliberately not used — a DSH process
can exit `0` on `SIGTERM`, which would look like success.

Captured stdout is capped at **2 MiB** (`raw.stdoutBytes`,
`raw.stdoutTruncated`); stderr at 64 KiB. The child environment is allowlisted
to `PATH`, `HOME`, `DSH_*` and `NODE_*`; host API keys and `NODE_OPTIONS` are
dropped. Explicit `env` config is trusted and merged last; `allowedDshBins` pins
`dshBin`.

Programmatic use:

```js
import { CheckRunner } from 'dsh-canary/runner'

const runner = new CheckRunner({
  dshBin: '/home/me/deepseek-harness/apps/cli/lib/bin.js', // default: DSH_BIN or node_modules/.bin/dsh
  profile: 'headless',
  timeoutMs: 600_000,
})
const record = await runner.run({ id: 'repo-status', prompt: 'Report git status.' })
// { ok, code, taskId, result, trajectory, cost, approvals, exitCode, raw }
```

`run` never throws for a failed task: it resolves `{ ok: false, code }` with
`code` one of `invalid_task`, `aborted`, `spawn_error`, `timeout`, `signaled`,
`exit_nonzero`, `invalid_json`, `no_final` or `not_completed`. On success
`ok: true` and `code: null`. `raw` carries `sessionId`, `finalReason`, event
counts, stderr, duration, `timedOut`, `usageComplete` and provenance flags.

Known runner limits: the child inherits allowlisted `DSH_*`/`NODE_*` variables
(including `DSH_HOME`) and the host cwd, with no per-task isolation yet; provider
keys must come from DSH config or explicit `env` config. No `--session-id`
replay (it appends a new turn and bills again); no `--max-steps` (wrap the call
in your own timeout); approvals are not in the `--json` stream; and DSH reports
no USD price. Requires
`dsh >= 0.2.2-alpha.2` (the version this runner is tested against; `--json`
itself landed in `0.2.0-rc.2`).

## Safety defaults

`check_run` is an agent tool that spends money and starts a child process, so
0.3.0 gates it:

- **Grant first.** The tool resolves the calling subject
  (`exec.agent.session.id`) and asks Allow for capability `check:run` (or the
  Act alias `act:invoke:check.run`). A missing service, subject or active Grant
  fails closed with `E_DENIED` and `nextTools: [{tool: "allow_request", ...}]`;
  nothing is spawned. The `ctx.check.run()` host seam is trusted code and is not
  Grant-gated.
- **Budget.** A rolling-hour `maxRunsPerHour` cap (default 10) always applies.
  `maxCostUsd` (default 5) applies only when `costMeter` is configured, because
  DSH reports tokens, not USD; without a meter only the run count is limited.
  An exhausted budget returns `E_LIMIT` before spawning.
- **Environment.** Only `PATH`, `HOME`, `DSH_*` and `NODE_*` are inherited;
  API keys are not. `NODE_OPTIONS` is dropped. Explicit `env` config is trusted
  and merged last, so a host can deliberately pass a key.
- **Executable.** `allowedDshBins` (absolute or cwd-relative) must contain
  `dshBin` when set. The CLI `--dsh-bin` flag and plugin `dshBin` config are
  explicit host decisions.
- **Audit.** Every run appends `{runId, taskId, profile, exitCode, durationMs,
  costUsd?}` to `ctx.check.audit()` (last 200 entries). Prompts are never
  recorded.

## Run JSON

A run is one environment's execution of the same task suite:

```json
{
  "schema": "dsh.check.run/v1",
  "environment": {
    "label": "dsh 0.2.2-rc.4 / deepseek-chat",
    "dsh": "0.2.2-rc.4",
    "model": "deepseek-chat"
  },
  "tasks": [
    {
      "id": "session-token-summary",
      "result": { "text": "Usage by model: deepseek-chat 18.3k tokens." },
      "trajectory": { "steps": 6, "toolCalls": 4, "errors": 0 },
      "cost": { "usd": 0.12, "tokens": 18300 },
      "approvals": { "asked": 0, "rejected": 0 }
    }
  ]
}
```

`dsh-check run` writes this shape with exactly one task per
`run-<id>.json`, plus `ok`, `code` and `exitCode` metadata. Those extra
top-level fields are ignored by the diff engine, so a `run-*.json` file can be
passed straight to `diff`.

- `tasks` is required and task ids must be unique and non-empty. `environment`
  is optional metadata and does not affect the verdict.
- `result` is any JSON value and is compared by deep equality. Object key order
  is ignored; an omitted result compares as missing. `run` omits `result` when
  no `final` event arrived.
- `trajectory.steps`, `trajectory.toolCalls` and `trajectory.errors` are
  non-negative numbers, default `0`.
- `cost.usd` is a non-negative number, default `0`. `cost.tokens` is
  informational and does not gate. The runner always writes `usd: 0`.
- `approvals.asked` and `approvals.rejected` are non-negative numbers,
  default `0`.
- A task present in the old run but missing from the new run is a regression.
  New-only tasks are reported as `added` and are not compared.

## Diff rules

| Dimension | Change | Verdict |
|---|---|---|
| result | any deep difference | **regression** |
| trajectory | `errors` increases | **regression** |
| trajectory | `steps` increases **more than 20%** | warning |
| trajectory | `toolCalls` increases **more than 20%** | warning |
| cost | `usd` increases **more than 25%** | warning |
| approvals | `asked` increases | warning |
| approvals | `rejected` increases | warning |

Thresholds are strict: exactly +20% or +25% is not a warning. An increase from
zero always counts. Warnings do not change the exit code; any non-flaky
regression returns `1`.

## JSON report

`--json` prints a `dsh.check.diff/v1` object:

```json
{
  "schema": "dsh.check.diff/v1",
  "verdict": "regression",
  "summary": {
    "tasks": 2,
    "compared": 2,
    "regressions": 1,
    "warnings": 1,
    "ignored": 0,
    "added": 0
  },
  "allowFlaky": [],
  "tasks": [
    {
      "id": "session-token-summary",
      "verdict": "regression",
      "ignored": false,
      "diffs": [
        {
          "dimension": "result",
          "severity": "regression",
          "message": "result changed",
          "old": { "text": "18.3k tokens" },
          "new": { "text": "usage unavailable" }
        }
      ]
    }
  ]
}
```

`verdict` is `pass`, `warning` or `regression`. A flaky task has
`"verdict": "ignored"`, keeps its `diffs`, and contributes only to
`summary.ignored`. Extra tasks have `"verdict": "added"`.

## Tasks file

`check.tasks.json` is the suite input for the runner:

```json
{
  "schema": "dsh.check.tasks/v1",
  "tasks": [
    {
      "id": "session-token-summary",
      "prompt": "Summarize this session's token usage by model."
    }
  ]
}
```

`init` writes three example tasks (`session-token-summary`, `repo-status`,
`test-failure-triage`). `list` validates ids and prints id plus prompt. `run`
additionally requires a non-empty prompt on every task; `list` keeps accepting
prompt-less tasks for backward compatibility.

## Cordis plugin

The bundle mounts `dsh-check` via `cordis.patch.yml` and provides `ctx.check`:

```js
const report = ctx.get('check').compare(oldRun, newRun, {
  allowFlaky: ['session-token-summary'],
})
```

It also registers the plain-object agent tool `check_compare`, with `old` and
`new` run objects as parameters (optional `allowFlaky` array). The tool returns
the report plus the envelope: `{ ok, schema, summaryText, regressions, warnings,
page, truncated, next, error }`. `summaryText` is a one-line verdict capped at
200 characters; `regressions`/`warnings` flatten the per-task diffs with
`taskId`, `dimension`, optional `metric` and `message` (at most 20 each; the
full `old`/`new` values stay in the legacy `tasks` array); `next`
suggests `check_run` for a regression or `check_compare` with `allowFlaky` for a
warning. A validation failure returns `{ ok: false, code, error }` without
changing the original `code`. The service (`ctx.check.compare`) is unchanged
and usable without the tool registry.

To enable the real runner, give the plugin a DSH binary or an injected runner:

```js
apply(ctx, { dshBin: '/home/me/deepseek-harness/apps/cli/lib/bin.js' })
```

Then `ctx.check.run({ id, prompt }, { timeoutMs })` resolves the runner record
described above, and the optional `check_run` agent tool is registered. A runner
can also be injected: `apply(ctx, { runner: myRunner })` or
`ctx.check.run(task, { runner: myRunner })`. With neither `dshBin` nor a runner,
`run` resolves `{ ok: false, code: 'no_runner' }` and `check_run` is not
registered.

`check_run` requires a Grant for `check:run`; the tool result carries
`E_DENIED` plus an `allow_request` hint when it is missing.

## Roadmap

- **0.1.0 / 0.1.1:** four-dimension diff engine, CLI (`diff`, `init`, `list`),
  `ctx.check`, `check_compare`, exit codes.
- **0.2.0:** real headless runner (`run`, `CheckRunner`, `ctx.check.run`,
  optional `check_run`), NDJSON mapping, SIGINT → SIGKILL timeout, per-task run
  files.
- **Next:** isolated `DSH_HOME`/overlay per task, approvals from the session
  log, optional pricing tables, Markdown/JUnit reports and a GitHub Action.

## License

MIT.
