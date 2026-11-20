# Changelog

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
