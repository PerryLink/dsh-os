# @perrylink/dsh-os-kernel

**A thin capability kernel for dsh-os.** It is a routing and protocol layer,
not an OS implementation: it stores no clipboard, opens no window, runs no
check and writes no file. Modules keep their own services, storage and tests;
they remain independently installable and removable.

```
descriptor  ->  registry  ->  six agent verbs
   ^              |                |
modules register  |          os_find / os_do / os_request
or fromTool       |          os_observe / os_help / os_status
                  |
       ctx.tools.schemas/get -> refreshLegacy()
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
3. **KernelService** — the registry plus `refreshLegacy({scope})` and
   `stats()` (see below).
4. **Gateway** — six plain host `ToolDefinition`s:
   - `os_find({intent, riskMax?, limit?})` → compact capability cards;
   - `os_do({id, args, preview?, idempotencyKey?, grant?})` → `os.result/v1`;
     `write`/`execute`/`destructive` capabilities without a grant return
     `E_DENIED` with `remediation` and `nextTools: [os_request]`;
   - `os_request({id, args, reason})` → `ctx.allow.request` (or
     `E_UNAVAILABLE` when the Allow service is absent);
   - `os_observe({requestId?, jobId?, handle?})`;
   - `os_help({task})` → 4 steps + candidate capabilities + risks;
   - `os_status({})` → modules, `legacy` / `capabilities` counts, health,
     version.

## Mount

```js
import { apply } from '@perrylink/dsh-os-kernel'
// ctx.tools must exist (inject: ['tools']); apply() provides ctx.kernel
const kernel = apply(ctx)          // six tools registered into ctx.tools
await kernel.refreshLegacy()       // optional: os_find/os_status do this lazily
kernel.register({
  id: 'snip.search', title: 'Search clippings', summary: 'Find a copied item.',
  whenToUse: ['The user refers to something copied earlier.'],
  whenNotToUse: ['The user wants the current clipboard.'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
  risk: 'read', handler: async ({ query }) => ctx.snip.search(query),
})
```

## Legacy tools (73+)

`KernelService.refreshLegacy({scope})` bridges the old tool surface without
touching any module:

1. Enumerates visible schemas with `ctx.tools.schemas(scope)` and fetches each
   definition with `ctx.tools.get(name, scope)`.
2. Skips `os_*` (the kernel's own verbs) and adapts every other tool with
   `fromTool()` as `legacy.<tool name>` (`risk` inferred from name/description;
   `legacyOptions` overrides it).
3. Is idempotent: repeated refreshes keep the existing entry. An occupied
   `legacy.<name>` id is never overwritten, and an alias already owned by a
   descriptor is not stolen — descriptors always win, the legacy entry keeps
   its `legacy.` namespace.
4. Silently does nothing when `ctx.tools` exposes no `schemas`/`get` (older
   hosts); `config.legacyTools` still works as an explicit fallback.

`apply()` does not enumerate eagerly. The first `os_find` or `os_status` calls
`refreshLegacy({ scope: exec.agent })`; a direct `os_do` on an unknown
`legacy.*` id does the same. After that the gateway searches descriptors and
legacy tools together, so `os_find` returns top-k cards from both surfaces and
`os_status` reports `{ legacy: N, capabilities: M, total }`.

Legacy payloads are normalized through the kernel's local `ok()` / `err()`
pair (the same `os.result/v1` / OsError envelope as the contract): a returned
`{ ok: true, ... }` is unwrapped, `{ ok: false, error }` becomes an `OsError`,
and raw values are wrapped. Unknown error codes are aliased to the nine
classes with `details.legacyCode`.

## Boundary

- **Kernel is thin.** It has no business modules, no persistence and no network.
- **Modules stay independent.** A module may register a descriptor when the
  kernel is present (`ctx.get('kernel')?.register`) and must still work when it
  is absent. The kernel never imports a module.
- **Zero runtime dependencies**, plain ESM, no Node built-ins in `lib/`.
  `lib/envelope.js` mirrors `@perrylink/dsh-os-contract`'s `ok()`/`err()`
  helpers instead of importing them, so the package stays standalone; its
  success schema remains the published `os.result/v1`.
- **No publish** in this package's scripts; release is owned by the monorepo.

## Tests

```sh
node --test
```

Covers descriptor validation, registry CRUD/conflict/search/lazy invoke,
`fromTool` against two real dsh-os tools, the six gateway verbs including
deny → request recovery and help/status, plus the legacy bridge: fake `ctx`
with read/write/execute tools, lazy `os_find`/`os_status`, `os_do` execution
and denied writes, envelope normalization, repeated refresh, missing
`schemas`/`get`, alias/id conflicts and status counts.
