# Changelog

## 0.4.0

- Add a bounded `os.result/v1` envelope to `check_compare` while leaving the
  `dsh.check.diff/v1` report fields untouched: `schema`, `ok`, `tool`,
  `summaryText` (≤200 chars), `regressions`, `warnings`, `page`, `truncated`,
  `next` and `error`. The legacy `summary` counts object, `verdict`, `tasks`
  and `allowFlaky` keep their existing shape and values.
- `regressions`/`warnings` flatten the per-task diffs with `taskId`,
  `dimension`, optional `metric` and `message` (full `old`/`new` stay in `tasks`);
at most 20 of each
  are returned and `page.hasMore`/`truncated` report the cut.
- `next` suggests `check_run` for a regression and `check_compare` with
  `allowFlaky` for warnings; a clean pass returns `next: []`.
- Validation failures (for example an invalid run shape) return
  `{ ok: false, code, error }` without changing the original `code`; missing
  `old`/`new` arguments still throw as before.
- Ship the zero-dependency helpers `lib/result.js` and
  `lib/compare-envelope.js`; add envelope tests for pass/regression/warning,
  field compatibility and the failure path.

## 0.3.0

- Gate the `check_run` agent tool behind an Allow Grant for capability
  `check:run` (or `act:invoke:check.run`); missing Grant/service/subject returns
  `E_DENIED` with an `allow_request` hint and spawns nothing. The trusted
  `ctx.check.run()` host seam is not gated.
- Add a rolling-hour budget: `maxRunsPerHour` (default 10) always applies;
  `maxCostUsd` (default 5) applies when `costMeter` is configured, otherwise
  only the run count is limited. Over-limit returns `E_LIMIT` before spawning.
- Sanitize the child environment: inherit only `PATH`, `HOME`, `DSH_*` and
  `NODE_*` (dropping `NODE_OPTIONS`); host API keys are no longer passed
  through. Explicit `env` config is still trusted and merged last.
- Add `allowedDshBins` to pin `dshBin` to an executable allowlist.
- Cap captured stdout at 2 MiB (`raw.stdoutBytes`, `raw.stdoutTruncated`);
  forward `AbortSignal` from `check_run` through SIGINT → SIGKILL.
- Record one prompt-free audit entry per run (`runId`, `taskId`, `profile`,
  `exitCode`, `durationMs`, optional `costUsd`) in `ctx.check.audit()`.

## 0.2.0

- Add the real headless runner: `lib/runner.js` spawns
  `node <dsh-bin> --profile <profile> --json "<prompt>"`, parses the NDJSON
  stream, and maps result, trajectory, cost, approvals, exit code and raw
  metadata. The spawn function is injectable for tests.
- Add `dsh-check run --tasks <file> --out <dir> --dsh-bin <path>
  [--profile headless] [--timeout ms] [--json]`; writes one diffable
  `run-<id>.json` per task and exits `1` if any task fails. Without `--dsh-bin`
  it prints `需要 DSH checkout` and exits `2`.
- Timeouts send `SIGINT`, wait a grace period, then `SIGKILL` (never `SIGTERM`,
  which can exit `0`); failures resolve `{ ok: false, code }` instead of throwing.
- Add `ctx.check.run(task, opts)` with injectable runner, and the optional
  `check_run` agent tool when the host supplies `dshBin`/`runner`.
- Declare the `spawn` capability and raise the `engines.dsh` floor to
  `>=0.2.2-alpha.2`.
- Document that a real run needs a DSH checkout and a model key, that CI should
  use `--profile headless`, and the runner limitations (approvals/USD/step cap).

## 0.1.1

- CLI labels warning findings as `WARN` instead of `REGRESSION`; warnings keep
  exit code 0.

## 0.1.0

- Add the dependency-free four-dimension diff engine: result, trajectory,
  cost and approvals.
- Add the `dsh-check` CLI with `diff`, `init` and `list`; `--json`,
  `--allow-flaky`, and exit codes `0` / `1` / `2`.
- Provide `ctx.check.compare(old, new, options)` and register the plain-object
  `check_compare` agent tool.
- Define the `dsh.check.run/v1` run shape and `dsh.check.tasks/v1` tasks file.
- Document that the paired runner is planned for 0.2.0.

## 0.0.1

- Reserve the `@perrylink/dsh-check` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
