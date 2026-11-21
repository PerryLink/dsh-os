# Changelog

## 0.5.0

- Add the first-party `trace` provider: when dsh-trace is mounted, `ctx.trace`
  is auto-detected and records map to `dsh://trace/<record-id>`. Search calls
  `trace.search(query, { limit })`; resolve finds the record by id through
  `trace.list`/`trace.search`, returns `{ found, status, source, title, text? }`
  (a found record is `status: "unknown"`), and the normalized result forwards
  `text`.
- Mark every merged `seek_search` hit with `tainted: true` and
  `taintSource: "<provider>"` (file and memory sources alike); a provider
  cannot opt out. This is a minimal label, not taint tracking: no token is
  minted and a caller can still omit it.
- Auto-register `locator`, `memento` and `trace`; `seek_providers`,
  `seek_search` and `seek_resolve` retry registration so a provider mounted
  after Seek becomes ready on the next call. An auto-registered built-in
  provider may be replaced by a manual registration of the same name.
- Rewrite the real-eval `seek-evidence` scenario to use Trace memory
  (`trace_remember` -> `seek_search "user-trust"` -> `seek_resolve` two refs ->
  `evidence.json`) instead of depending on dsh-locator having indexed the
  temporary workspace. Add a trace-focused `node --test` suite.

## 0.4.0

- Add an `os.result/v1` envelope to `seek_search`:
  `{ schema, ok, tool, summary, items, page, truncated, next, error }` next to
  the unchanged `{ query, hits, total, errors }`. `items` and `hits` are the
  same page; `summary` reports the merged hit count (≤200 chars).
- Default limit is 10 and is capped at 50; add the optional `offset` argument.
  `page` reports `{ limit, offset, returned, total, hasMore }`; `next` suggests
  the next `seek_search` page, `seek_resolve` for the top hit, or
  `seek_providers` when no provider returned a hit.
- Add `SeekService.searchPage()` with an `offset` window and one-hit probe so
  `page.hasMore` is honest; `SeekService.search()` still returns exactly
  `{ query, hits, total, errors }`.
- Documented argument errors still throw with their existing codes; unexpected
  failures return `{ ok: false, code, error }` without changing the code.
- Ship the zero-dependency helper `lib/result.js`; add envelope tests for the
  default limit, the 50 cap, offset paging, truncation, legacy fields and the
  failure path.

## 0.3.0

- Add `SeekService.resolve(ref, { signal, timeoutMs, cwd, agentKey, agent })`.
  It validates `dsh://<source>/<id>` refs (`E_INVALID_ARGUMENT` otherwise),
  routes by `<source>` to that provider's optional `resolve`, and returns
  `{ ref, found, status, source, checkedAt, title?, freshness? }`. A missing
  provider or a search-only provider returns `status: "unsupported"`; a
  provider timeout/failure is isolated into `status: "timeout"`/`"error"`.
- Add the read-only `seek_resolve` agent tool (`{ ref }`). It forwards the
  caller's signal, cwd and `agentKey`, and is the first built-in way to verify a
  Seek ref (`evals/BASELINE.md` evidence-chain gap).
- `seek_search` hits now carry `resolvable: true` when the hit's source has a
  `resolve` provider, false otherwise. The ref format was already validated
  before the marker is set.
- `locator` provider gains `resolve`: it rebuilds the locator-native
  `ref://file?path=<absolute>` from the workspace-relative ref id and the
  caller cwd, calls `locator_resolve` in `mode: "meta"`, and maps
  `fresh|stale|missing|tombstoned|unknown`. Missing cwd refuses with
  `E_UNAUTHORIZED`; a locator without `locator_resolve` reports
  `E_UNAVAILABLE`; resolver errors map locator denials to `E_UNAUTHORIZED`.
- `memento` provider gains `resolve`: it queries only `user-global` with the
  caller `agentKey`, matches the ref id, and reports a found entry as
  `found: true, status: "unknown"` (memory has no verifiable snapshot). A miss
  is `status: "missing"`; no service/caller refuses closed.
- `registerProvider` accepts an optional `resolve` function and rejects a
  non-function value with `invalid_provider`.
- Keep the entry small: plain-object tools moved to `lib/tools.js`, resolve
  helpers to `lib/resolve.js` (no new runtime dependencies).
- Tests cover resolve success/missing/tombstoned, bad refs, unsupported
  sources, timeout/failure isolation, caller abort, the `seek_resolve` tool,
  `resolvable` markers, locator native-ref rebuilding/status mapping/ACL
  refusals, and memento lookup/visibility.

## 0.2.0

- Add two real first-party providers, auto-registered at mount when their host
  services exist:
  - `locator`: calls dsh-locator's `locator_find` tool in `content` mode with
    `pathPrefix` set to the caller's cwd, maps file/session hits to
    `dsh://locator/<workspace-relative-path>`, carries the locator freshness
    object, drops `permissions.read === "denied"` hits, and normalizes/encodes
    path segments (backslashes, spaces, `#`, `?`, `.`/`..`).
  - `memento`: calls dsh-memento's `ctx.memory.query` with
    `scope: "user-global"` and the caller's normalized `agentKey`, maps entries
    to `dsh://memento/<id>` with unknown freshness, and never queries workspace
    scope.
- Missing optional plugins are reported as `unavailable` in `seek_providers`,
  not thrown at mount. Add `seek_register_defaults` to retry registration after
  `dsh-locator`/`dsh-memento` mounts later; it is idempotent.
- Pass the caller context (`exec.agent`, cwd, `agentKey`) from `seek_search`
  through `search()` to every provider. Providers without a required cwd/agent
  fail closed with `E_UNAUTHORIZED`; missing tools/services fail with
  `E_UNAVAILABLE`.
- Provider errors with a stable `E_*` code now keep that code in the per-source
  `errors` entry instead of collapsing to `provider_failed`.
- `seek_providers` now returns `{ providers, sources }`, where `sources`
  includes ready providers plus unavailable defaults with a reason. Existing
  `providers` remains.
- `SeekService` gains `noteSource()`/`sources()` for provider availability.
- Tests cover locator/memento hit mapping, empty results, timeouts, missing
  tools/services, ACL refusals, ref normalization/encoding, caller passthrough,
  registration retries and `seek_register_defaults`.
- No new runtime dependencies. `lib/` is now included in the published files.

## 0.1.1

- Add per-provider deadlines. `search(query, { timeoutMs })` defaults to 10 s
  and calls each provider with `(query, { limit, signal, timeoutMs })`, where
  `signal` is `AbortSignal.any([AbortSignal.timeout(timeoutMs), callerSignal])`.
  A provider that times out is reported as `{ code: 'provider_timeout' }` in
  `errors`; it can no longer block the whole query.
- Add caller cancellation: `search(query, { signal })` forwards the caller's
  `AbortSignal` (the tools pass the host `exec.signal`) to every provider and
  rejects with `code: 'aborted'` once aborted. Invalid signals throw
  `invalid_signal`; invalid timeouts throw `invalid_timeout`.
- Harden ref validation: `parseRef` now rejects empty and overlong refs
  (`MAX_REF_LENGTH` = 512) and `.`/`..` path segments, in addition to the
  existing `dsh://<source>/<id>` grammar and source/ref match.
- Add tests for hanging-provider timeouts, abort forwarding, `exec.signal`
  propagation and overlong/dot-segment refs.

## 0.1.0

- Implement `SeekService` and provide it as the `ctx.evidence` host seam with
  `registerProvider`, `unregisterProvider`, `providers` and `search`.
- Fan a query out to selected providers in parallel; a rejected or malformed
  provider only adds an entry to `errors` and never fails the whole query.
- Validate `dsh://<source>/<id>` refs, normalize hits to
  `{ ref, source, title, snippet, score?, freshness? }`, and drop invalid or
  ref/source-mismatched hits with an `invalid_hit` error.
- Deduplicate by `ref` (highest score wins), sort by score descending then
  source, and apply the caller's limit after merging.
- Add plain-object `seek_search` and `seek_providers` agent tools.
- 0.1.0 is the provider protocol MVP only: locator, library, memento and web
  adapters, `seek_resolve`, permissions, caching and timeouts are 0.2.0 work.
- Add `node --test` coverage for fan-out, filtering, deduplication, ordering,
  ref validation, registration and provider failure isolation.

## 0.0.1

- Reserve the `dsh-seek` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
