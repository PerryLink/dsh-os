# Changelog

## 0.1.0

- Add `ActService` (`register` / `unregister` / `get` / `list` / `invoke`) exposed
  as the Host service `ctx.act`.
- Validate action ids (`^[a-z][a-z0-9_.-]{1,63}$`), risk and `execute`, and reject
  duplicate ids.
- Gate `write` and `danger` actions through the optional Allow service
  (`check({ subject, capability: 'act:invoke:<id>', scope })`); return
  `grant_required` instead of throwing when the service is absent or denies.
- Return `{ ok: true, actionId, result }` on success and `{ ok: false,
  code: 'action_failed', message }` when `execute` throws.
- Add built-in `echo`, `now` and `list` read actions.
- Register the `act_list` and `act_invoke` agent tools using plain tool
  definitions (no `@deepseek-ai/dsh-tools` dependency).
- Add `node --test` coverage for registration, filtering, invocation, denial,
  authorized writes, execution failures and duplicate ids.

## 0.0.1

- Reserve the `dsh-act` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
