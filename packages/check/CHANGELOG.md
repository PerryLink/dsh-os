# Changelog

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
