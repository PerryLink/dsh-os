# `@perrylink/dsh-os-contract`

> Canonical service names, capabilities, error codes, refs and thin validators
> shared by the dsh-os module family.

**Status: 0.1.0 (experimental).** Implements the v1 contract described in
[`docs/module-contract-v1.md`](../../docs/module-contract-v1.md).

## This is a contract, not a framework

The package contains **JSDoc types, frozen constants and a few small
validators/helpers**. It does not register plugins, open Host services, own
state, perform I/O, read the environment or start anything. Importing it is
side-effect free.

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
npm install @perrylink/dsh-os-contract
```

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `SERVICES` | frozen object | Product → canonical Host seam (`ctx.<service>`) |
| `CAPABILITIES` | frozen array | Declarable `dsh.os.capabilities` values |
| `ERROR_CODES` | frozen object | Stable `err.code` values |
| `OS_OBJECT_KEYS` | frozen array | Keys of the dsh-os object base |
| `isOsObject(value)` | function | Shape guard for persisted objects |
| `makeRef(kind, id)` | function | Build a canonical `dsh://<kind>/<id>` ref |
| `parseRef(ref)` | function | Parse a ref back into `{ kind, id }` |
| `assertManifest(manifest)` | function | Minimal v1 manifest validation |
| `defineTool(tool)` | function | Validate and return a plain host tool definition |

`isOsObject`, `makeRef`, `parseRef`, `assertManifest` and `defineTool` throw
`Error` with `.code === 'E_INVALID_ARGUMENT'` on bad input.

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
} from '@perrylink/dsh-os-contract'

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
