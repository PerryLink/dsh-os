# OS Gateway preset

The kernel's model-facing surface is six verbs. This preset makes that surface
true per agent: the model sees **only** `os_find`, `os_do`, `os_request`,
`os_observe`, `os_help` and `os_status`, while every capability (including
legacy tools adapted by the kernel) is reached through `os_find` / `os_do`.

## Permission name

One name is used on both sides of the Allow bridge:

```
cap:<descriptor.id>          e.g. cap:act.fs.write
```

`os_request` calls `ctx.allow.request({ capability: 'cap:act.fs.write', ... })`;
`allowedByHost` and the grant cached by `os_observe` call
`ctx.allow.check({ capability: 'cap:act.fs.write' })`. Do not issue or approve a
plain `act.fs.write` grant for the kernel — it will not match. Module-owned
grants stay separate (Act itself uses `act:invoke:<action>`).

## `toolFilter` is not a preset YAML field

DSH agent presets are **plugin lists** (`@deepseek-ai/dsh-agent-preset` rows
with `config.plugins[]`). There is no preset `config.toolFilter` key: that name
is the `ToolRestriction` shape (`{ allow?, deny? }`) applied through
`ctx.tools.restrict()`, and `dsh-tool-subagent` now selects an `agentPreset`
instead of taking it as row config.

Use one of these instead:

1. **Kernel `gatewayOnly` (recommended, implemented here).** Mount the kernel
   inside the preset with `gatewayOnly: true`. It registers its six scoped
   tools and calls `ctx.tools.restrict({ deny: inheritedNonOsToolNames })`.
   `restrict()` needs a **scoped** context (preset or `agent.ctx`); a global
   mount fails closed because it would mask every agent. The legacy bridge
   still reads the **global** view, so hidden tools stay reachable as
   `legacy.<tool>` capabilities behind `os_find` / `os_do`.
2. **Subagent `toolFilter`** (programmatic spawn only): `{ allow: ['os_find',
   'os_do', 'os_request', 'os_observe', 'os_help', 'os_status'] }`. This is a
   child-agent restriction, not a preset definition.

## Copyable preset

`docs/presets/os-gateway.cordis.yml` is a complete `insert` row for
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```sh
dsh plugin add dsh-os-kernel
dsh plugin add dsh-allow
# then merge docs/presets/os-gateway.cordis.yml into the profile patch
```

Keep `dsh-allow` mounted **outside** the preset (its bundle patch
does that in the profile) so the kernel resolves `ctx.allow` and `gatewayOnly`
can hide the inherited `allow_*` tools. If you mount Allow inside the preset
instead, its tools are scope-local and therefore stay visible.

The preset wraps the kernel in a `cordis:group` with `isolate: { kernel: true }`,
so it can coexist with a globally mounted kernel: the preset gets its own
`kernel` service, its scoped verbs shadow the global ones, and the restriction
still hides every inherited non-`os_*` tool. Without that isolation a second
kernel mount would fail with "service kernel has been registered".

## Headless is not a valid test surface

The `headless` bundle does not compose the preset registry and refuses to adopt a
session with `agentPreset` (`packages/bundle/headless/src/index.ts`). Test this
preset in `web`/`tui` or a custom bundle that mounts
`@deepseek-ai/dsh-agent-preset-registry`; `dsh --profile headless` cannot prove
that only six tools are visible.

## Verify

```sh
node --test packages/kernel/test/gateway-only.test.js
node --test packages/kernel/test/permission-bridge.test.js
```

In a session using the preset, `os_status` reports only the six verbs; any
other tool should be indistinguishable from one that does not exist. Approve
pending requests through `dsh-os approvals` or the oversight UI — the model
verbs cannot approve anything.

Limitation: the deny list is a snapshot taken at mount. Mount the kernel after
tool plugins and restart the profile after adding a global tool plugin.
