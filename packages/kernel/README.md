# @perrylink/dsh-os-kernel

**A thin capability kernel for dsh-os.** It is a routing and protocol layer,
not an OS implementation: it stores no clipboard, opens no window, runs no
check and writes no file. Modules keep their own services, storage and tests;
they remain independently installable and removable.

```
descriptor  ->  registry  ->  six agent verbs
                  |                |
            modules register   os_find / os_do / os_request
            (or fromTool)      os_observe / os_help / os_status
```

## What it owns

1. **Descriptor protocol** — `validateDescriptor()` / `normalizeDescriptor()`
   over the architecture §2 fields (`id`, `title`, `summary`, `whenToUse`,
   `whenNotToUse`, `inputSchema`, `outputSchema`, `risk`, `permissions`,
   `cost`, `idempotency`, `examples`, `returns`, `errors`, `version`, `tags`,
   `handler`, `ui`, `aliases`, `deprecated`, `audience`).
2. **Registry** — `register` / `list` / `search` / `resolve` / `invoke`;
   filters by namespace (`capability`), `risk` and `tags`; lazy
   `{ id, meta, load }` entries; `E_CONFLICT` on id/alias/version collisions;
   handler errors normalized to the nine `E_*` classes.
3. **Gateway** — six plain host `ToolDefinition`s:
   - `os_find({intent, riskMax?, limit?})` → compact capability cards;
   - `os_do({id, args, preview?, idempotencyKey?, grant?})` → `os.result/v1`;
     `write`/`execute`/`destructive` capabilities without a grant return
     `E_DENIED` with `remediation` and `nextTools: [os_request]`;
   - `os_request({id, args, reason})` → `ctx.allow.request` (or
     `E_UNAVAILABLE` when the Allow service is absent);
   - `os_observe({requestId?, jobId?, handle?})`;
   - `os_help({task})` → 4 steps + candidate capabilities + risks;
   - `os_status({})` → modules, health, version.

## Mount

```js
import { apply } from '@perrylink/dsh-os-kernel'
// ctx.tools must exist (inject: ['tools']); apply() provides ctx.kernel
const registry = apply(ctx, {
  legacyTools: [someExistingToolDefinition],   // adapted as legacy.<name>
})
registry.register({
  id: 'snip.search', title: 'Search clippings', summary: 'Find a copied item.',
  whenToUse: ['The user refers to something copied earlier.'],
  whenNotToUse: ['The user wants the current clipboard.'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
  risk: 'read', handler: async ({ query }) => ctx.snip.search(query),
})
```

`apply()` does **not** enumerate `ctx.tools`: DSH has no such API. Pass legacy
tools explicitly through `config.legacyTools`; `fromTool()` marks them
`legacy: true`, keeps the old execute path and infers `read` / `write` /
`execute` from the tool name and description.

## Boundary

- **Kernel is thin.** It has no business modules, no persistence and no network.
- **Modules stay independent.** A module may register a descriptor when the
  kernel is present (`ctx.get('kernel')?.register`) and must still work when it
  is absent. The kernel never imports a module.
- **Zero runtime dependencies**, plain ESM, no Node built-ins in `lib/`.
- **No publish** in this package's scripts; release is owned by the monorepo.

## Tests

```sh
node --test
```

Covers descriptor validation, registry CRUD/conflict/search/lazy invoke,
`fromTool` against two real dsh-os tools, and the six gateway verbs including
deny → request recovery and help/status.
