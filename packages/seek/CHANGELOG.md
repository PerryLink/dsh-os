# Changelog

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
