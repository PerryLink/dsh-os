# Context · `@perrylink/dsh-context`

> A read-only context provider protocol for DeepSeek Harness: each provider
> supplies any subset of `app`, `window`, `selection`, `clipboard` and `files`,
> and `snapshot()` merges them by provider name with per-provider isolation.

**Status: 0.1.0 (experimental). Provider protocol only.**

**0.1.0 ships only the provider protocol.** It does not read the real active
app, window or selection; real app/window/selection adapters are planned for
**0.2.0**. This release ships the `ctx.context` registry, the snapshot contract
and a clearly marked synthetic demo provider; nothing else.

**Context does not read the clipboard.** It never touches the OS clipboard and
never reads raw clipboard text — clipboard history belongs to **Snip**
(`dsh-snip`). The `clipboard` protocol field is reserved for a future
metadata-only adapter; the demo provider does not supply it.

The unscoped `dsh-context` npm name is already used by a different DeepSeek
Harness plugin (a context dashboard by another author), so this module is
published as `@perrylink/dsh-context`.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-context
```

The bundle patch mounts the plugin and provides `ctx.context`. Requires Node
22.19+ (or Node 24.9+). No runtime dependencies, no build step.

## Service

```js
const context = ctx.get('context')

context.registerProvider({
  name: 'editor',
  get: () => ({ app: { id: 'vscode' }, selection: { chars: 42 } }), // may be async
})

context.providers()                          // [{ name: 'editor' }]
await context.snapshot()                     // every provider
await context.snapshot({ providers: ['editor'] })
context.unregisterProvider('editor')         // true; false when not registered
```

| Method | Result |
| --- | --- |
| `registerProvider(provider)` | `{ name }`; throws `E_INVALID_ARGUMENT` for a bad descriptor and `E_CONFLICT` for a duplicate name |
| `unregisterProvider(name)` | `true` when removed, `false` when not registered |
| `providers()` | Registration descriptors (`{ name }`) in insertion order |
| `snapshot({ providers? })` | A snapshot object (below); rejects with `E_INVALID_ARGUMENT` for bad options and `E_NOT_FOUND` for an unregistered requested name |

### Snapshot

```js
{
  schema: 'dsh.context.snapshot/v1',
  at: 1730000000000,               // provider call completion time
  providers: ['editor'],           // attempted providers, in selection order
  context: {                       // merged by provider name
    editor: { app: { id: 'vscode' }, selection: { chars: 42 } },
  },
  errors: [],                      // isolated failures
}
```

- Every selected provider's `get()` is called **in parallel**; a provider may be
  synchronous or async.
- Each result is merged under its provider name, so provenance never collapses.
  Payloads are deep-cloned; mutating a snapshot does not mutate provider state.
- One provider failing does not fail the snapshot. The failure is recorded as
  `{ provider, code, message }` in `errors`, and the other providers' results are
  still returned. A thrown `error.code` is preserved; anything else becomes
  `E_UNAVAILABLE`. A non-object result becomes `E_STATE`; an unknown field
  becomes `E_INVALID_ARGUMENT`.
- `snapshot()` only calls `get()`. It writes nothing, opens no windows and does
  not modify the system.

## Provider protocol

```js
{
  name: 'editor',                       // ^[a-z][a-z0-9_.-]{0,63}$
  async get() {
    return { app, window, selection, clipboard, files } // any subset
  },
}
```

- `name` and a `get` function are required.
- `get()` takes no arguments and returns an object containing any subset of
  `app`, `window`, `selection`, `clipboard`, `files`. Undefined fields are
  dropped. Values are provider-defined JSON-like data.
- Names are unique within the process. Registering a duplicate throws
  `E_CONFLICT`; it never overwrites an existing provider.
- Providers are caller-supplied. Context performs no OS access and declares no
  capabilities in its manifest; it is a contract, not an adapter.

## Agent tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `context_snapshot` | `providers` (optional array) | The snapshot object above |
| `context_providers` | none | `{ providers: [{ name, demo }] }` |
| `context_register_demo` | none | `{ provider: 'demo', registered, demo: true, note }` |

`context_register_demo` registers a **synthetic** provider named `demo` so the
protocol can be tried with no OS access: its app, window and selection payloads
are marked `demo: true`, its files list is `demo/example.txt`, and it supplies no
clipboard data. Re-running the tool leaves an existing `demo` provider untouched
and returns `registered: false`.

## Scope and 0.2.0

**In 0.1.0:** provider registration, parallel snapshots, failure isolation,
field validation and the three tools.

**Not in 0.1.0:** real active-app detection, window enumeration, text selection
readers, OS clipboard access, background watchers, timers and network I/O.
Those adapters are planned for **0.2.0** and will register through the same
protocol. Clipboard history remains Snip's job.

## Development

```sh
cd packages/context
node --test
```

Plain ESM JavaScript, Node 22+, no runtime dependencies and no build step.

## License

MIT. See [LICENSE](./LICENSE).
