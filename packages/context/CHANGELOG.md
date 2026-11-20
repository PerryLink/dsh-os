# Changelog

## 0.1.0

- Add `ctx.context` with `registerProvider`, `unregisterProvider`, `providers`
  and a parallel, per-provider-isolated `snapshot`.
- Add the `context_snapshot`, `context_providers` and `context_register_demo`
  agent tools.
- Ship only the provider protocol: real app/window/selection adapters are
  planned for 0.2.0. Context does not read the OS clipboard; Snip owns
  clipboard history.
