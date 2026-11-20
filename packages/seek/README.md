# Seek · `dsh-seek`

> Cross-source evidence search for DeepSeek Harness: one query, many providers,
> verifiable `dsh://` refs, and partial results when a provider fails.

**Status: 0.1.1 is the provider protocol MVP.** It ships the `ctx.evidence`
registry and search contract, hit normalization, ref validation, cross-provider
deduplication, merged ordering and the two agent tools. It deliberately ships
**no built-in providers**: the locator, library, memento and web adapters land
in **0.2.0**. There is no locator integration, web access, cache or persistence
in 0.1.x.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-seek
```

The bundle patch mounts the plugin and provides `ctx.evidence`.

## Provider protocol

A provider is a plain object with a stable lowercase name and an async (or
sync) `search` function:

```js
const evidence = ctx.get('evidence')

const dispose = evidence.registerProvider({
  name: 'notes',
  async search(query, { limit, signal, timeoutMs }) {
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
```

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

`evidence.search(query, { sources, limit, timeoutMs, signal })`:

- Requires a non-empty string query (trimmed); `limit` is a positive integer,
  default 10, capped at 100.
- `sources` selects providers by name; unknown names are ignored, and an empty
  array returns an empty result without calling any provider.
- Calls every selected provider **in parallel** with
  `(query, { limit, signal, timeoutMs })`. `timeoutMs` is a positive integer
  (default 10000) and bounds each provider individually; an invalid value throws
  `invalid_timeout`.
- `signal` is an optional caller `AbortSignal` (normally the host tool's
  `exec.signal`). Aborting it aborts every provider and rejects the query with
  `code: 'aborted'`.
- A provider gets `signal: AbortSignal.any([AbortSignal.timeout(timeoutMs),
  callerSignal])`, so a cooperative provider can stop its own work, and the
  query races that signal so even a provider that ignores it cannot block the
  result.
- A timed-out provider is reported as `{ code: 'provider_timeout' }`; other
  rejections or malformed results are reported as `provider_failed`.
- Merges hits by `ref`, keeping the highest `score` (missing score sorts as 0).
- Sorts by `score` descending, then by `source` ascending.
- Applies `limit` after deduplication and sorting; `total` is the number of
  returned hits.
- Uses `Promise.allSettled`, so one rejected, timed-out or malformed provider
  only adds an entry to `errors`; the other providers still return hits.

## Agent tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `seek_search` | `query` (required), `sources?`, `limit?` | `{ query, hits, total, errors }`; forwards `exec.signal` |
| `seek_providers` | none | `{ providers: string[] }` |

Both are plain-object tools (no `@deepseek-ai/dsh-tools` dependency) and return
lossless JSON through the host tool pipeline.

## Errors

Expected failures throw an `Error` with a stable `code`:
`invalid_provider`, `provider_exists`, `invalid_query`, `invalid_limit`,
`invalid_options`, `invalid_sources`, `invalid_timeout`, `invalid_signal` and
`aborted`.

Per-query provider problems are returned, not thrown:

```js
{
  source: 'notes',
  code: 'provider_failed', // or 'provider_timeout', 'invalid_hit'
  message: 'boom',
}
```

## Limits of 0.1.x

- No first-party providers: registering locator/library/memento/web adapters is
  the 0.2.0 milestone.
- No `seek_resolve`, permissions, caching or tracing yet; `freshness` is passed
  through from providers unchanged. Per-provider timeouts and caller-signal
  cancellation are implemented in 0.1.1.
- No network I/O and no writes to provider data. Seek only reads.
- Provider callers should still apply their own ACLs before returning hits;
  Seek does not expose a permission model in this release.

## Development

```sh
cd packages/seek
node --test
```

Pure ESM JavaScript, Node 22+, no runtime dependencies and no build step.

## License

MIT. See [LICENSE](./LICENSE).
