# Changelog

## 0.1.0

- Implement the in-memory Trigger protocol MVP: `ctx.triggers` with
  `register` / `unregister` / `list` / `fire` / `runs`.
- Add exact-event matching, function and `{ field, op, value }` DSL conditions,
  per-trigger cooldown and a bounded in-memory run ledger.
- Record action failures in the run instead of throwing; report cooldown and
  condition skips alongside fire results.
- Add built-in demo actions `record` and `echo`.
- Add the `trigger_register`, `trigger_list`, `trigger_fire` and `trigger_runs`
  agent tools and a `node --test` suite.

## 0.0.1

- Reserve the `dsh-trigger` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
