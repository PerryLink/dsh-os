# dsh-os module contract v1

The contract is intentionally small: **types, names, error codes and two hooks**
(manifest + UI contribution). It is not a framework, a DI container or a shared
runtime. A module must remain independently installable, replaceable and
removable.

## 1. Module rules

1. ≤ 450 lines of runtime code, zero runtime dependencies (split before 1.0).
2. One Host service + ≤ 6 agent tools; UI is optional.
3. Own storage; no global singleton.
4. Depend on seams (`ctx.*`), never import another module's package.
5. Declare capabilities in `dsh.os.capabilities`.
6. Independent semver; never lockstep with other modules.
7. Must pass the conformance suite.
8. Removing the module must not break any other module (except an explicitly
   declared optional dependency).
9. UI only through the shell contribution; no module opens its own window.
10. No network, telemetry or secret collection unless declared and opt-in.

## 2. `package.json` manifest

```jsonc
{
  "name": "dsh-act",
  "version": "0.1.1",
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "os": {
      "service": "act",
      "provides": ["act"],
      "requires": ["allow"],
      "capabilities": ["fs.read", "fs.write", "spawn"],
      "tools": ["act_list", "act_invoke"],
      "ui": { "entry": "./ui/index.js", "views": ["act.panel"] },
      "stability": "experimental",
      "since": "0.1.0",
      "replaces": ["dsh-actions"]
    }
  }
}
```

- `service`: the Host seam name (`ctx.<service>`), or `null` for CLI-only.
- `provides` / `requires`: seam names, not package names. `requires` is optional
  and must degrade gracefully when absent.
- `capabilities`: `fs.read`, `fs.write`, `net`, `secret`, `spawn`, `model`,
  `clipboard`, `ui`, `notify`.
- `tools`: exact agent tool names.
- `ui`: optional; `entry` exports `views`.
- `stability`: `experimental` | `stable` | `frozen` | `archived`.
- `since`: first version with this manifest.
- `replaces`: optional list of package names this module supersedes.

## 3. Service names (canonical)

| Product | Service | Tools prefix |
|---|---|---|
| Act | `ctx.act` | `act_` |
| Allow | `ctx.allow` | `allow_` |
| Snip | `ctx.snip` | `snip_` |
| Check | `ctx.check` | `check_` |
| Nest | `ctx.nest` | `nest_` |
| Trigger | `ctx.triggers` | `trigger_` |
| Seek | `ctx.evidence` | `seek_` |
| Trace | `ctx.trace` | `trace_` |
| Stage | `ctx.stage` | `stage_` |
| Ring | `ctx.ring` | `ring_` |
| Root | `ctx.env` | `root_` |

The service name is part of the public contract; renaming requires a major
version and a conformance update.

## 4. Object base

Every persisted object should carry:

```ts
interface OsObject {
  id: string
  owner?: string
  scope?: string
  createdAt: number
  updatedAt?: number
  expiresAt?: number | null
  auditRef?: string
}
```

## 5. Tool definition

Use a plain `ToolDefinition` (no `@deepseek-ai/dsh-tools` dependency):

```js
{
  name: 'snip_search',
  description: '...',
  parameters: { type: 'object', additionalProperties: false, properties: { ... }, required: [...] },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  async execute(args, exec) { return { ... } }
}
```

- Tool names: `<prefix>_<verb>`.
- `output.schema` must stay within the host's supported JSON Schema subset.
- Forward `exec.signal` for work that can be cancelled.
- Prefer returning structured failures over throwing for expected denials; throw
  `Error` with a stable `.code` for invalid input/state.

## 6. Error codes

Use these codes (module-specific aliases are allowed only with a mapping):

| Code | Meaning |
|---|---|
| `E_INVALID_ARGUMENT` | bad input shape/type |
| `E_NOT_FOUND` | object does not exist |
| `E_CONFLICT` | duplicate id/version |
| `E_DENIED` | policy/Grant/approval denied |
| `E_UNAVAILABLE` | optional dependency or provider missing |
| `E_STATE` | corrupt/unreadable persisted state |
| `E_LIMIT` | quota/limit exceeded |

## 7. UI contribution (optional)

```js
// ui/index.js
export const views = [
  { id: 'act.panel', title: 'Act', mount(ctx, container) { /* ... */ } },
]
```

- The shell owns routing, keyboard shortcuts and theme.
- A module may ship no UI; the shell must still work.
- UI code is loaded lazily; it must not be imported by the Host entry.

## 8. Conformance (must pass)

1. `package.json` validates against `docs/schemas/dsh-os-manifest.schema.json`.
2. `dsh.bundle.patch` exists and references the package name.
3. Service name matches the canonical table.
4. Every tool in `dsh.os.tools` is registered by `apply()` and uses the prefix.
5. Removing the module leaves other modules' tests green.
6. `node --test` passes; no network in tests.
7. A malformed state file fails closed (`E_STATE`), never authorizes.
8. No secret is written in plaintext by default.
9. `engines.dsh` is a bounded range.
10. `npm pack --dry-run` includes `index.js`, patch, README, LICENSE.

## 9. Versioning

- `0.x`: experimental; breaking changes allowed with a minor bump, documented.
- `1.0`: only after conformance + 10 external installs + no P0/P1 for 30 days.
- Independent versions; the kit declares compatible ranges, not exact pins.
- DSH 0.3: bump `engines.dsh` and run the version matrix before releasing.
