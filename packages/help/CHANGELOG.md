# Changelog

## 0.1.0

- Add `HelpService` at `ctx.help` with `doctor()`, `firstRun()` and
  `installPlan(modules)`.
- Add the three read-only tools `help_doctor`, `help_first_run` and
  `help_install_plan`.
- `help_doctor` checks Node against `^22.19.0 || >=24.9.0`, reads the DSH
  version from `ctx.get('dshVersion')` then `DSH_VERSION` (else `unknown`), and
  probes the 11 dsh-os seams through `ctx.get` to report installed modules,
  missing modules and install commands.
- `help_first_run` returns the five-step quickstart: Check, run, diff,
  Act/Allow, `--dump-config`.
- `help_install_plan` returns deterministic `dsh plugin --profile web add ...`
  commands: Allow before Act, Check independent, aliases deduped, and an empty
  plan (with a hint) for an empty array.
- Read-only by construction: Help never installs, spawns, writes files or
  contacts a network. Plans carry `executes: false`.
- Reserve the unscoped npm name `dsh-help`; it was available at release time.
