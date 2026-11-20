# Check · `@perrylink/dsh-check`

> **Upgrade canary, not an update checker.** Compare two paired runs across
> result, trajectory, cost and approvals, then fail CI only on a real regression.

**Status: 0.1.0 MVP — diff engine only.** Check does not launch DSH, call a
model or read session logs yet. A runner (isolated `DSH_HOME`, headless
`--json`, session capture and baselines) is planned for **0.2.0**. In 0.1.0 you
bring two run JSON files produced by any harnessable run of the same tasks.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
npm install --save-dev @perrylink/dsh-check
npx dsh-check --help
```

As a Cordis bundle:

```sh
dsh plugin --profile web add @perrylink/dsh-check
```

Requires Node 22.19+ (or Node 24.9+). No runtime dependencies.

## CLI

```sh
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

Exit codes:

| Code | Meaning |
|---|---|
| `0` | `pass` or `warning` — warnings are advisory, not a gate failure |
| `1` | `regression` — at least one non-flaky task regressed |
| `2` | usage or input error (missing flag, unreadable file, invalid JSON, invalid run shape) |

`init` refuses to overwrite an existing `check.tasks.json`.

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

- `tasks` is required and task ids must be unique and non-empty. `environment`
  is optional metadata and does not affect the verdict in 0.1.0.
- `result` is any JSON value and is compared by deep equality. Object key order
  is ignored; an omitted result compares as missing.
- `trajectory.steps`, `trajectory.toolCalls` and `trajectory.errors` are
  non-negative numbers, default `0`.
- `cost.usd` is a non-negative number, default `0`. `cost.tokens` is
  informational and does not gate in 0.1.0.
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

`check.tasks.json` is the suite seed for the 0.2.0 runner:

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
`test-failure-triage`). `list` validates ids and prints id plus prompt. Running
these prompts is intentionally out of scope for 0.1.0.

## Cordis plugin

The bundle mounts `dsh-check` via `cordis.patch.yml` and provides `ctx.check`:

```js
const report = ctx.get('check').compare(oldRun, newRun, {
  allowFlaky: ['session-token-summary'],
})
```

It also registers the plain-object agent tool `check_compare`, with `old` and
`new` run objects as parameters (optional `allowFlaky` array). The service is
usable without the tool registry, so tests and other plugins can call it
directly.

## Roadmap

- **0.1.0 (this release):** four-dimension diff engine, CLI (`diff`, `init`,
  `list`), `ctx.check`, `check_compare`, exit codes.
- **0.2.0:** paired runner with two isolated `DSH_HOME`s, headless `--json`,
  session-to-task capture, baselines, Markdown/JUnit reports and GitHub Action.

## License

MIT.
