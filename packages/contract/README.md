# `dsh-os-contract`

> Canonical service names, capabilities, error codes, refs, result/error/audit
> protocol helpers and thin validators shared by the dsh-os module family.

**Status: 0.2.0 (experimental).** Implements the v1 contract described in
[`docs/module-contract-v1.md`](../../docs/module-contract-v1.md), plus the
`OsResult` / `OsError` v1 helpers.

## This is a contract, not a framework

The package contains **JSDoc types, frozen constants and a few small
validators/helpers**. It does not register plugins, open Host services, perform
I/O, read the environment or start anything. Importing it is side-effect free;
the only process state is the optional cursor signing key, which defaults to a
random per-process key.

Modules stay independently installable, replaceable and removable: they copy
this vocabulary, they do not inherit a runtime from it. There is no DI
container, no base class and no shared event bus here.

- Zero runtime dependencies, plain ESM, no build step.
- Node.js `^22.19.0 || >=24.9.0`.
- **Not a DSH plugin or bundle.** `package.json` deliberately has no
  `dsh.bundle`, and its `dsh.os.service` is `null`. Do not install it with
  `dsh plugin add`.
- `assertManifest()` is a minimal hand-written check, not a JSON Schema
  implementation. Use `docs/schemas/dsh-os-manifest.schema.json` when full
  schema validation is needed.

## Install

```sh
npm install dsh-os-contract
```

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `SERVICES` | frozen object | Product → canonical Host seam (`ctx.<service>`) |
| `CAPABILITIES` | frozen array | Declarable `dsh.os.capabilities` values |
| `ERROR_CODES` | frozen object | Legacy stable `err.code` values |
| `OS_OBJECT_KEYS` | frozen array | Keys of the dsh-os object base |
| `isOsObject(value)` | function | Shape guard for persisted objects |
| `makeRef(kind, id)` | function | Build a canonical `dsh://<kind>/<id>` ref |
| `parseRef(ref)` | function | Parse a ref back into `{ kind, id }` |
| `assertManifest(manifest)` | function | Minimal v1 manifest validation |
| `defineTool(tool)` | function | Validate and return a plain host tool definition |
| `RESULT_SCHEMA` / `HANDLE_KINDS` | frozen values | OsResult schema id and handle kinds |
| `ok(data, options)` | function | Build a bounded `OsResult` success envelope |
| `page(items, options)` | function | Slice a page and issue a signed `nextCursor` |
| `setCursorKey(key)` | function | Inject the process cursor key (`null` resets) |
| `makeHandle(kind, id)` / `parseHandle(ref)` | functions | `dsh://<kind>/<id>` handle helpers |
| `ERROR_CLASSES` | frozen array | The nine `OsError` classes |
| `OsError` / `err(code, options)` | class / function | Build a protocol error |
| `isRetryable(code, subcode?)` | function | Class/subcode retry default |
| `toToolError(error)` | function | `{ ok: false, error }` failure envelope |
| `AUDIT_SCHEMA` / `auditEvent(input)` | frozen string / function | Minimal in-memory audit event |

`isOsObject`, `makeRef`, `parseRef`, `assertManifest` and `defineTool` throw
`Error` with `.code === 'E_INVALID_ARGUMENT'` on bad input. The protocol
builders (`ok`, `page`, `makeHandle`, `parseHandle`, `auditEvent`) do the same.

## Usage

```js
import {
  CAPABILITIES,
  ERROR_CODES,
  SERVICES,
  assertManifest,
  defineTool,
  isOsObject,
  makeRef,
  parseRef,
} from 'dsh-os-contract'

SERVICES.trigger // 'triggers' → the module provides ctx.triggers
CAPABILITIES[0] // 'fs.read'
ERROR_CODES.E_NOT_FOUND // 'E_NOT_FOUND'

makeRef('memory', 'm-1') // 'dsh://memory/m-1'
parseRef('dsh://memory/m-1') // { kind: 'memory', id: 'm-1' }

isOsObject({ id: 'm-1', createdAt: Date.now() }) // true

assertManifest(pkg) // returns pkg, or throws E_INVALID_ARGUMENT

const tool = defineTool({
  name: 'snip_search',
  description: 'Search snippets.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args) {
    return { items: [] }
  },
})
```

## Result protocol (`OsResult` v1)

`ok(data, options)` returns a bounded success envelope. `data` is tool-owned
scalar data (an array is treated as `items`):

```js
import { makeHandle, ok, page, RESULT_SCHEMA } from 'dsh-os-contract'

const first = page(entries, { limit: 20 })
// { items, limit, returned, total, hasMore, nextCursor }

const result = ok(
  { snapshotId: 'bkp_1' },
  {
    tool: 'backup_snapshot',
    summary: `Snapshot bkp_1: ${first.total} entries.`,
    page: first,
    handles: [{ ref: makeHandle('backup-entries', 'bkp_1'), kind: 'list', bytes: 259335 }],
    next: [{ tool: 'backup_diff', why: 'compare with the previous snapshot' }],
  },
)
// result.schema === RESULT_SCHEMA
```

- `summary` is clipped to 200 characters, `items` to 20 and `handles` to 5;
  `truncated` is set automatically and a
  `{ code: 'E_LIMIT', subcode: 'result_budget' }` warning is appended when a
  field was cut.
- `requestId` defaults to `req_<ULID>`, `auditId` to `null`; `next` is capped at
  3 and `warnings` at 20.
- `cost` defaults to zeros with `tokensEstimated: true`; the token estimate is
  `chars / 4`. `provenance.hash` is SHA-256 over a sorted-key JSON projection of
  `items + page + data`.
- Cursors are opaque `v1.<base64url payload>.<hmac-sha256>` strings. The key is
  random per process unless injected with `setCursorKey(key)` or
  `page(..., { key })`; tampered or foreign-key cursors throw
  `E_INVALID_ARGUMENT`. Cursors are therefore not portable across processes
  unless the same key is injected.
- `page()` also returns the selected `items` slice for convenience; `ok()`
  strips it from `result.page`.

## Error protocol (`OsError` v1)

```js
import { err, isRetryable, toToolError } from 'dsh-os-contract'

const error = err('E_DENIED', {
  subcode: 'grant_required',
  message: 'act_invoke needs a grant for window.move.',
  remediation: 'Call allow_request for window.move, then retry once approved.',
  nextTools: [{ tool: 'allow_request', args: { operationId: 'window.move' } }],
  requestId: 'req_01JC8Z3K9Q',
  details: { approvalRequestId: 'arq_1' },
})

isRetryable(error) // true: a pending approval makes the same call safe
toToolError(error) // { ok: false, error: { code: 'E_DENIED', ... } }
```

- `ERROR_CLASSES` is the closed nine-class enum: `E_INVALID_ARGUMENT`,
  `E_DENIED`, `E_NOT_FOUND`, `E_CONFLICT`, `E_UNAVAILABLE`, `E_LIMIT`,
  `E_STATE`, `E_TIMEOUT`, `E_INTERNAL`. It is the new protocol surface;
  `ERROR_CODES` remains for legacy callers.
- `err()` fills `subcode`, `remediation`, `retryable` and `retryAfterMs` from
  class/subcode defaults and enforces the invariant
  `retryable ? 0 <= retryAfterMs <= 600000 : retryAfterMs === null`.
  `E_DENIED/grant_required` with `details.approvalRequestId` is retryable
  (`retryAfterMs: 2000`).
- Legacy `error.code` strings (`E_INPUT`, `grant_required`, `*_not_found`,
  `*_exists`, `E_RATE_LIMITED`, …) are aliased; the original is preserved in
  `error.details.legacyCode`.
- `toToolError()` accepts an `OsError`, a thrown `Error` carrying a legacy
  `code`, or an old `{ ok: false, code | error | reason }` envelope, and always
  returns `{ ok: false, error }` without throwing.

## Audit events

`auditEvent({ actor, tool, capability, argsHash, result, cost })` builds a
minimal **in-memory** record with `schema: 'dsh.os.audit/v1'`, `id: 'aud_<ULID>'`
and `at` (epoch milliseconds). Nothing is written to disk or sent over the
network; persist the returned object yourself if a profile keeps an evidence
trail.

## Canonical services and tool prefixes

| Product | Service | Tool prefix |
|---|---|---|
| Act | `act` | `act_` |
| Allow | `allow` | `allow_` |
| Snip | `snip` | `snip_` |
| Check | `check` | `check_` |
| Nest | `nest` | `nest_` |
| Trigger | `triggers` | `trigger_` |
| Seek | `evidence` | `seek_` |
| Trace | `trace` | `trace_` |
| Stage | `stage` | `stage_` |
| Ring | `ring` | `ring_` |
| Root | `env` | `root_` |

`SERVICES` exposes the middle column. Tool prefixes are enforced by
`assertManifest()` and `defineTool()`.

## What the validators check

`assertManifest(manifest)` requires:

1. `manifest.dsh` is an object and `manifest.dsh.manifestVersion === 1`;
2. `dsh.os.service` is one of the canonical service names, or `null` for a
   CLI-only module;
3. `dsh.os.stability` is `experimental`, `stable`, `frozen` or `archived`;
4. `dsh.os.tools` is an array of `<prefix>_<verb>` names whose prefix matches
   the declared service (when `service` is not `null`).

It returns the same manifest object so it can be used inline:

```js
const pkg = assertManifest(JSON.parse(readFileSync('package.json', 'utf8')))
```

`defineTool(tool)` requires a non-empty string `name` with a canonical prefix,
a non-empty `description`, an object `parameters`, `output` shaped as
`{ schema: object, render: function }`, and a function `execute`. It returns a
shallow plain-object copy, so module code does not need a tool SDK dependency.

`makeRef` accepts kinds matching `^[a-z][a-z0-9-]{0,31}$` and opaque ids with
no whitespace, `/`, `?` or `#`.

## This package's own manifest

```json
{
  "dsh": {
    "manifestVersion": 1,
    "os": {
      "service": null,
      "provides": [],
      "capabilities": [],
      "tools": [],
      "stability": "experimental",
      "since": "0.1.0"
    }
  }
}
```

## License

MIT. Not affiliated with DeepSeek; DeepSeek and DeepSeek Harness are
trademarks of their respective owners.
