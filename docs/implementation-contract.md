# dsh-os implementation contract

Every package in `packages/*` is a standalone DeepSeek Harness bundle. The
packages are deliberately **plain ESM JavaScript with no build step and no
runtime dependencies**, so `npm publish` ships exactly what is tested.

## Package layout

```
packages/<name>/
  package.json          # dsh.bundle.patch, engines.dsh, version 0.1.0
  index.js              # Cordis plugin: export name / inject / apply
  cordis.patch.yml      # - insert: [{ id, name }]
  README.md
  CHANGELOG.md
  test/*.test.js        # node --test; no external test runner
```

## Plugin entry

```js
export const name = 'dsh-act'
export const inject = ['tools']

export function apply(ctx, config) {
  const service = new ActService(ctx, config)
  ctx.provide('act', service)
  ctx.tools.register(listTool(service))
  ctx.tools.register(invokeTool(service))
}
```

- `ctx.provide(name, value)` exposes the Host seam; consumers use `ctx.get(name)`.
- Keep the service usable without the `tools` service (tests call it directly).
- Never assume `ctx.approval` is available outside an open turn; model-facing
  writes go through the tool pipeline, human/background writes go through
  `Allow` grants.

## Tool definition (no `@deepseek-ai/dsh-tools` dependency)

The host accepts a plain `ToolDefinition`:

```js
export function makeTool(service) {
  return {
    name: 'act_list',
    description: 'List registered actions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional filter.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { actions: service.list(args.query) }
    },
  }
}
```

- `parameters` is a JSON Schema object accepted by the host.
- `output.schema` is a JSON Schema for the canonical return value.
- `render` returns `[{ type: 'text', text }]`.
- `execute` returns a lossless-JSON value; throw an `Error` with a stable
  `code` property for expected failures.

## Tests

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}
```

- Run `node --test` in the package directory.
- Cover the happy path, a denied path, and one edge case (expiry/scope/secret).

## Versioning

- 0.0.1 = name reservation only.
- 0.1.0 = first functional MVP.
- Do **not** publish from a subagent; the root agent runs `scripts/publish.mjs`.
- Keep `README.md` first line as `# <Product> · \`<package>\`` and include
  `Not affiliated with DeepSeek.`
