# Seek · `dsh-seek`

> Cross-source evidence search for DeepSeek Harness: one query, many providers,
> verifiable `dsh://` refs, ref resolution, and partial results when a provider
> fails.

**Status: 0.3.0 adds ref resolution.** `ctx.evidence.resolve` and the
`seek_resolve` tool route one `dsh://<source>/<id>` ref to its provider, bound
the call with a deadline, and report `found`/`status` without inventing
freshness. `locator` resolves through dsh-locator's `locator_resolve`;
`memento` looks the entry up by id through `ctx.memory`. `seek_search` hits now
carry a `resolvable` marker. Both providers are still optional and auto-detected;
`seek_providers` reports which sources are ready and why a missing source is
unavailable.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-seek
```

The bundle patch mounts the plugin and provides `ctx.evidence`. The built-in
providers have no package dependencies: install/enable `dsh-locator` and/or
`dsh-memento` separately and they are picked up at mount. If a plugin is mounted
after Seek, call the `seek_register_defaults` tool to retry registration; missing
plugins are reported, never fatal.

## Built-in provider matrix

| provider | corpus | search call | resolve call | ref | default | ACL enforced before returning hits |
| --- | --- | --- | --- | --- | --- | --- |
| `locator` | indexed file bodies and session messages | dsh-locator tool `locator_find`, `mode:"content"` | dsh-locator tool `locator_resolve`, `mode:"meta"`, native `ref://file` rebuilt from the caller cwd | `dsh://locator/<workspace-relative-path>` | on when `locator_find` exists | `pathPrefix=<caller cwd>`; no cwd → `E_UNAUTHORIZED` |
| `memento` | approved memory entries | dsh-memento `ctx.memory.query({ text, limit, scope:"user-global" }, { agentKey })` | `ctx.memory.query({ scope:"user-global", limit:1000 }, { agentKey })` then match by id | `dsh://memento/<entry-id>` | on when `ctx.memory` exists | only `user-global` + caller `agentKey`; workspace scope is never queried |

Not built in yet: `library`, `capability`, `web` and `session-query`. Register
them through the provider protocol below.

### `locator` details

- Only **content** mode is used. dsh-locator 0.20.x `mode:"names"` ignores
  `scope`/`pathPrefix`, so Seek does not call it.
- `pathPrefix` is always the caller's cwd (from `exec.agent.session.header.cwd`
  in `seek_search`). This is the locator's fail-closed root ACL. A direct caller
  that omits `cwd` gets `E_UNAUTHORIZED`; Seek never calls `locator_find`
  without a prefix.
- Refs are normalized to a workspace-relative id: backslashes become `/`, the
  caller cwd prefix and leading slashes are stripped, `.` segments are removed,
  `..` segments are refused, and each segment is percent-encoded (so spaces and
  `#`/`?` cannot break the `dsh://` grammar). Refs longer than 512 characters are
  dropped.
- `freshness` is the locator's own `{ state, observedAt?, mtime? }` object (or
  `{ state }` from `refStatus`). A hit whose `permissions.read` is `denied` is
  not returned.
- `content-path-denied` responses surface as `E_UNAUTHORIZED`; other locator
  failures as `E_UNAVAILABLE`/`E_STATE`. The content index is built lazily, so
  the first query may be slow; the normal per-provider timeout applies.
- Resolve rebuilds the locator-native `ref://file?path=<absolute>` from the ref
  id and the caller cwd, then calls `locator_resolve` in `mode:"meta"`. The
  locator applies its root ACL to that path before reading metadata. No cwd →
  `E_UNAUTHORIZED`; a missing `locator_resolve` (older locator) → `E_UNAVAILABLE`.
  The rebuilt ref carries no mtime/size/hash snapshot, so locator compares the
  file with its own index: `fresh`/`stale` mean found, `missing`/`tombstoned`
  mean not found, and `unknown` is kept as unverified.

### `memento` details

- Only `scope:"user-global"` entries are queried. `workspace` entries are
  deliberately excluded: dsh-memento's `ctx.memory.query` filters by `agentKey`
  but not by `workspaceKey`, so querying workspace scope would require
  fetch-then-filter, which Seek refuses. Workspace support waits for an upstream
  `query({ workspaceKey })`.
- The caller's `agentKey` is normalized from `session.header.agentPreset` the
  same way dsh-memento does (trim; lowercase on Windows) and passed as the
  second argument to `query`. Empty `agentKey` means the shared layer.
- Entries whose `scope` is not `user-global`, whose non-empty `agentKey` differs
  from the caller's, or whose id is empty/`.`/`..` are dropped defensively.
- `freshness` is `{ state: "unknown" }`: memory entries have no verifiable
  snapshot. The title is the first line of `text`; the snippet is the full text
  capped at 2000 characters.
- **Side effect:** dsh-memento increments `recallCount`/`lastRecalled` for query
  hits even when no session id is passed. Seek does not pass `sessionId`, so it
  does not create a memento `recalled` audit event. Resolve performs one
  caller-scoped query (up to 1000 entries) and therefore has the same recall
  side effect.
- Resolve has no get-by-id API to call: it queries `user-global` with the
  caller's `agentKey`, then matches the id. A found entry is `found: true` with
  `status: "unknown"` because memory has no verifiable snapshot; it is never
  reported as `fresh`.

## Provider protocol

A provider is a plain object with a stable lowercase name and an async (or
sync) `search` function:

```js
const evidence = ctx.get('evidence')

const dispose = evidence.registerProvider({
  name: 'notes',
  async search(query, { limit, signal, timeoutMs, cwd, agentKey, agent }) {
    return [{
      ref: 'dsh://notes/retry-policy',
      source: 'notes',
      title: 'Retry policy',
      snippet: `...${query}...`,
      score: 0.8,          // optional
      freshness: 'fresh',  // optional, passed through
    }]
  },
})

await evidence.search('retry policy', { sources: ['notes'], limit: 10 })
// { query, hits, total, errors }

dispose()                                  // unregister this registration
evidence.unregisterProvider('notes')       // or remove by name
evidence.providers()                       // ['notes']
evidence.sources()                         // ready + unavailable-with-reason
```

`search` receives `{ limit, signal, timeoutMs, cwd, agentKey, agent }`. `agent`
is the host tool's `exec.agent` (opaque to Seek); `cwd` and `agentKey` are
derived from it so providers can put ACL parameters into their upstream call.

### Refs

Every hit must carry `ref: 'dsh://<source>/<id>'`:

- `source` is lowercase, starts with a letter and matches
  `[a-z][a-z0-9._-]{0,63}`.
- `id` is one or more non-empty path segments (`dsh://notes/src/index.js`).
- Query strings, fragments, whitespace, empty segments and `.`/`..` segments
  are rejected.
- A ref must be at most 512 characters (`MAX_REF_LENGTH`); empty and overlong
  refs are rejected.
- If a hit supplies `source`, it must equal the source inside its ref.
  Otherwise the hit is dropped.

Invalid or mismatched hits are omitted from the result and reported as one
`invalid_hit` error per provider; they never poison the rest of the query.

### Search semantics

`evidence.search(query, { sources, limit, timeoutMs, signal, cwd, agentKey, agent })`:

- Requires a non-empty string query (trimmed); `limit` is a positive integer,
  default 10, capped at 100.
- `sources` selects providers by name; unknown names are ignored, and an empty
  array returns an empty result without calling any provider.
- Calls every selected provider **in parallel** with
  `(query, { limit, signal, timeoutMs, cwd, agentKey, agent })`. `timeoutMs` is a
  positive integer (default 10000) and bounds each provider individually; an
  invalid value throws `invalid_timeout`.
- `signal` is an optional caller `AbortSignal` (normally the host tool's
  `exec.signal`). Aborting it aborts every provider and rejects the query with
  `code: 'aborted'`.
- A provider gets `signal: AbortSignal.any([AbortSignal.timeout(timeoutMs),
  callerSignal])`, so a cooperative provider can stop its own work, and the
  query races that signal so even a provider that ignores it cannot block the
  result.
- A timed-out provider is reported as `{ code: 'provider_timeout' }`; provider
  errors with a stable `E_*` code keep it (`E_UNAVAILABLE`, `E_UNAUTHORIZED`,
  `E_STATE`); other rejections or malformed results are reported as
  `provider_failed`.
- Merges hits by `ref`, keeping the highest `score` (missing score sorts as 0).
- Sorts by `score` descending, then by `source` ascending.
- Applies `limit` after deduplication and sorting; `total` is the number of
  returned hits.
- Uses `Promise.allSettled`, so one rejected, timed-out or malformed provider
  only adds an entry to `errors`; the other providers still return hits.

### Resolve semantics

`evidence.resolve(ref, { timeoutMs, signal, cwd, agentKey, agent })`:

- Requires a valid `dsh://<source>/<id>` ref; anything else throws
  `E_INVALID_ARGUMENT` (including overlong refs and `.`/`..` segments).
- Routes by `<source>` to that provider's `resolve`. With no provider, or a
  provider without `resolve`, it returns
  `{ ref, found: false, status: "unsupported", source, checkedAt }` — it never
  falls back to another provider and never fabricates `fresh`.
- Bounds the provider by `timeoutMs` (default 10000) and the caller `signal`,
  exactly like search. A timeout returns `status: "timeout"` with
  `error.code: "provider_timeout"`; another failure returns `status: "error"` and
  the provider's stable `E_*` code. The query is not rejected unless the caller
  itself aborts (`code: "aborted"`).
- Successful results are
  `{ ref, found, status, source, checkedAt, title?, freshness? }`.
  `status` is one of `fresh|stale|missing|tombstoned|unknown`; `unknown` is
  reported as `found: false` unless the provider explicitly says otherwise
  (memento does, because the entry exists but cannot be freshness-checked).

## Agent tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `seek_search` | `query` (required), `sources?`, `limit?` | `{ query, hits, total, errors }`; each hit has `resolvable`; forwards `exec.signal` and the caller's cwd/agentKey |
| `seek_resolve` | `ref` (required) | `{ ref, found, status, source, title?, freshness?, checkedAt }`, or `status: "unsupported"`/`"timeout"`/`"error"` with an `error` block. Read-only |
| `seek_providers` | none | `{ providers: string[], sources: [{ name, status: "ready" or "unavailable", reason? }] }` |
| `seek_register_defaults` | none | retries locator/memento registration, then returns the same report |

All are plain-object tools (no `@deepseek-ai/dsh-tools` dependency) and return
lossless JSON through the host tool pipeline.

## Errors

Expected failures throw an `Error` with a stable `code`:
`invalid_provider`, `provider_exists`, `invalid_query`, `invalid_limit`,
`invalid_options`, `invalid_sources`, `invalid_timeout`, `invalid_signal`,
`aborted`, resolve's `E_INVALID_ARGUMENT`, and provider-side
`E_UNAVAILABLE`/`E_UNAUTHORIZED`/`E_STATE`.
`E_UNAUTHORIZED` is the Seek-specific alias for the module-contract `E_DENIED`
ACL failure.

Per-query provider problems are returned, not thrown:

```js
{
  source: 'notes',
  code: 'provider_failed', // or provider_timeout, E_UNAVAILABLE, E_UNAUTHORIZED, E_STATE, invalid_hit
  message: 'boom',
}
```

## Limits of 0.3.0

- Two first-party providers only: `locator` (content) and `memento`
  (user-global). No `library`, `capability`, `web` or `session-query` adapter.
- `resolve` is provider-routed only. There is no cache, persistence or
  permissions model, and no native-ref carrier in Seek refs: locator resolve
  needs the caller cwd to rebuild the locator-native file ref, and a locator
  file ref cannot pin a historical snapshot (its `fresh`/`stale` compare the
  current file with the locator index).
- `freshness` is either the locator payload or `{ state: "unknown" }` for
  memento; Seek never synthesizes `fresh`.
- Resolution does not grant new read access: locator applies `resolveWithinRoots`
  and memento applies the caller `agentKey` filter before returning metadata.
- No network I/O and no writes to provider data. Seek only reads. memento's
  recall counter is updated by its own `query`, as documented above.
- Provider callers should still apply their own ACLs before returning hits;
  Seek passes the caller context through but does not re-filter third-party
  results.

## Development

```sh
cd packages/seek
node --test
```

Pure ESM JavaScript, Node 22+, no runtime dependencies and no build step. Tests
mock `locator_find`, `locator_resolve` and `ctx.memory`; no real
locator/memento plugin or network is used.

## License

MIT. See [LICENSE](./LICENSE).
