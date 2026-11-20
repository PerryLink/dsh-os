# Changelog

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
