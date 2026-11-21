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
     `E_DENIED` with `remediation` and `nextTools: [os_request]`; writes of
     previously-seen taint-source text also need the `:tainted` Grant (below);
   - `os_request({id, args, reason, tainted?})` → `ctx.allow.request` for
     capability `cap:<descriptor.id>` (or `cap:<id>:tainted` when
     `tainted:true`; `E_UNAVAILABLE` when Allow is absent);
   - `os_observe({requestId?, jobId?, handle?})` → refreshes a request from
     Allow, and when approved consumes the Grant once and caches it;
   - `os_help({task})` → 4 steps + candidate capabilities + risks;
   - `os_status({})` → modules, `legacy` / `capabilities` counts, health,
     version.

## Permission bridge

One name crosses the bridge in both directions: `cap:<descriptor.id>` (for
example `cap:act.fs.write`). `os_request` asks Allow for it, `allowedByHost`
checks it, and the grant cached by `os_observe` is issued for it. A plain
`<id>` grant does not match; module-owned grants stay separate (Act uses
`act:invoke:<action>`).

The recovery loop is closed inside the kernel:

1. `os_do` on a gated capability returns `E_DENIED` + `nextTools: [os_request]`.
2. `os_request` creates a one-use Allow Request and records the subject and an
   args fingerprint in memory (never the args).
3. `os_observe` pulls the latest request from Allow; when `approved`, it calls
   `allow.check` once, consumes the Grant and caches it (`grantAvailable`).
4. The next `os_do` with the same id, args and subject uses that cache — no
   host injection. The approval is gone, so a replay or exhausted Grant stays
   `E_DENIED`. The cache is bound to `subject + id + args fingerprint`, and
   the Allow check omits `scope` so a narrowed approval still works.

## Content-hash taint gate (0.4.0)

`tainted: true` is a claim, not evidence. The gateway instead records the
SHA-256 of every `text`/`content` field returned by a taint source —
`snip_get`, `seek_resolve`, `trigger_runs` — and of text in any result that
carries a `taintToken`. Only the digest, source id, token and timestamps are
kept; the text is hashed and discarded, and no plaintext is logged.

For `act.fs.write` (or `legacy.act_invoke` with `args.id === "fs.write"`), the
gateway hashes `args.text` / `args.content` (nested under `args.args` for
`act_invoke`). If the digest is registered, the write needs **the base Grant
plus one of**:

- `ctx.allow.check({ subject, capability: "cap:act.fs.write:tainted" })`,
  normally through `os_request({ id, args, reason, tainted: true })` →
  `os_observe` → `os_do`; or
- a fresh `taintToken` returned with that exact text — single use, bound to
  the digest, valid for five minutes.

Otherwise `os_do` returns `E_DENIED` with `subcode: "grant_required"`,
`details.permission: "cap:act.fs.write:tainted"` and `nextTools:
[os_request]`. Taint evidence is stripped before the handler runs. The digest
stays registered after its token is used or expires, so later writes still
need the tainted Grant. The registry is in-process and bounded to 256
digests.

**Limit: exact-text reuse only.** Rewriting the content, copying a substring,
or re-fetching it through another path yields a different digest and passes
this gate. Full provenance needs host-supplied source metadata carried with
the content; the kernel does not inspect model reasoning, and a module remains
callable outside the gateway. The gate raises the cost of replaying a
prompt-injected snippet; it is not a sandbox. Ordinary reads such as
`act.fs.read` do not seed the registry.

## Idempotency journal

`os_do` reuses `idempotencyKey` in memory; `config.stateFile` makes it survive
a restart:

```js
apply(ctx, { stateFile: '/absolute/path/kernel-idempotency.json' })
```

The journal stores `{ argsHash, result }` per subject + capability + key,
writes atomically with mode `0600`, and is bounded to 500 entries. Args are
never stored. A replay returns the original `OsResult` before consuming a new
grant; different args under the same key return `E_CONFLICT`. A write failure
keeps the result and appends a warning instead of claiming persistence.

## Gateway-only mount

`config.gatewayOnly: true` hides every inherited non-`os_*` tool for one agent
scope via `ctx.tools.restrict({ deny: [...] })`. It requires a scoped mount (an
agent preset or `agent.ctx`); a global mount fails closed because it would mask
every agent. The legacy bridge keeps enumerating the global view, so hidden
tools remain reachable as `legacy.<tool>` capabilities through
`os_find`/`os_do`.

See [`docs/presets/os-gateway.md`](../../docs/presets/os-gateway.md) and
[`docs/presets/os-gateway.cordis.yml`](../../docs/presets/os-gateway.cordis.yml).
DSH presets are plugin lists; `toolFilter` (`ToolRestriction`) is the
subagent-level restriction, not a preset YAML key.

## Mount

```js
import { apply } from '@perrylink/dsh-os-kernel'
// ctx.tools must exist (inject: ['tools']); apply() provides ctx.kernel
const kernel = apply(ctx)          // six tools registered into ctx.tools
// Optional: apply(ctx, { gatewayOnly: true }) inside an agent preset,
// or apply(ctx, { stateFile: '/abs/kernel-idempotency.json' }).
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
`legacy.*` id does the same. Under `gatewayOnly` the bridge enumerates the
global view instead, because the agent's own tool view is intentionally
restricted to the six verbs. After that the gateway searches descriptors and
legacy tools together, so `os_find` returns top-k cards from both surfaces and
`os_status` reports `{ legacy: N, capabilities: M, total }`.

Legacy payloads are normalized through the kernel's local `ok()` / `err()`
pair (the same `os.result/v1` / OsError envelope as the contract): a returned
`{ ok: true, ... }` is unwrapped, `{ ok: false, error }` becomes an `OsError`,
and raw values are wrapped. Unknown error codes are aliased to the nine
classes with `details.legacyCode`.

## Boundary

- **Kernel is thin.** It has no business modules and no network. The only
  optional persistence is the idempotency journal above.
- **Modules stay independent.** A module may register a descriptor when the
  kernel is present (`ctx.get('kernel')?.register`) and must still work when it
  is absent. The kernel never imports a module.
- **Zero runtime dependencies**, plain ESM. `lib/state.js` uses only Node
  built-ins (`node:fs`, `node:path`) and only when `config.stateFile` is set;
  `lib/envelope.js` mirrors `@perrylink/dsh-os-contract`'s `ok()`/`err()`
  helpers instead of importing them, so the package stays standalone. Its
  success schema remains the published `os.result/v1`.
- **No publish** in this package's scripts; release is owned by the monorepo.

## Tests

```sh
node --test
```

Covers descriptors, registry CRUD/conflict/search/lazy invoke, `fromTool`,
the six verbs, legacy bridge and envelopes, the permission bridge against the
real `dsh-allow` service (`cap:<id>`, observe refresh, one-shot grant, args
binding), the content-hash taint gate (blocked/dual-grant/token/forged/expired/
ordinary/recovery loop), idempotency across a restart, `gatewayOnly` and the
shipped preset.
