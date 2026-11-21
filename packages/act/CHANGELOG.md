# Changelog

## 0.5.0

- Add a minimal tainted-write gate. When `meta.tainted === true` or
  `meta.taintToken` is a non-empty string, every non-read action that is not
  `authorize: false` needs `act:invoke:<id>:tainted` **after** the normal
  `act:invoke:<id>` Grant. A missing tainted Grant returns `grant_required` with
  that capability, `tainted: true` and an `allow_request` hint; nothing is
  executed.
- `act_invoke` accepts optional `tainted` and `taintToken` arguments and
  forwards them to `meta`. `meta.tainted` is supplied by the caller/host, never
  inferred from action arguments; `preview` and `read` calls are unchanged.
- Act does not verify tokens: a token is a taint claim that raises the gate, so
  a forged token can neither authorize nor downgrade a call. An omitted claim
  falls back to the normal single-Grant path.
- Document the limit: this is a minimal gate, not taint tracking; the durable
  fix is host-produced result metadata.
- Tests: normal write needs only the base capability; tainted write needs both
  Grants in order; forged and empty tokens; tool forwarding; preview/read
  exemptions.

## 0.4.0

- Add a bounded `os.result/v1` envelope to `act_list`:
  `{ schema, ok, tool, summary, items, page, truncated, next, error }`.
  `summary` is `"N actions"` (≤200 chars), `page` reports
  `{ limit, offset, returned, total, hasMore }`, and `next` suggests
  `act_invoke` (plus `allow_request` for a write/danger action).
- Keep the legacy `actions` array byte-for-byte compatible; it still carries
  each action's `id`, `title`, `risk` and optional `description`.
- Return failures as `{ ok: false, code, error }` without changing the original
  `code`; `error` carries `{ code, message, retryable, remediation, nextTools }`.
- Ship the zero-dependency helper `lib/result.js`; add envelope tests for
  fields, filtering, `next`, and failure compatibility.

## 0.3.0

- Add four real filesystem actions:
  - `fs.read` (read) — `{ path, maxBytes? }` → `{ path, size, text }`; read cap
    defaults to 256 KiB and a per-call value can only lower it.
  - `fs.write` (write) — `{ path, text, create? }` → `{ path, bytes, undoToken }`;
    writes a sibling temp file and renames it into place.
  - `fs.list` (read) — `{ path, recursive?, limit? }` →
    `{ entries: [{ path, type, size }] }`; symlinks are reported, not followed.
  - `fs.undo` (write) — `{ undoToken }` restores the previous content (or removes
    a created file) after re-validating path and content hash.
- Confine every path to the workdir allowlist (`config.workdir`, default
  `process.cwd()`): absolute only, no NUL, no `..` segment, `realpath`
  canonicalization, no symlink escape.
- Gate `fs.write` through `allow.check({ subject, capability:
  'act:invoke:fs.write' })`; denials include an `allow_request` hint when the
  Allow service exposes `request`.
- Add write previews via `meta.preview` / the `preview` tool flag: return
  `{ ok: true, preview: { path, bytes, diff } }` without touching disk.
- Add bounded in-memory undo (16 entries, 1 MiB per entry, 5 minutes, single
  use); over-limit or otherwise irreversible writes return `undoToken: null`
  with `undoable: false`.
- Keep `echo` / `now` / `list` ids and result shapes compatible; `act_list`
  keeps exposing each action's `risk`.
- Bump `dsh.os.capabilities` to `fs.read` and `fs.write`; ship
  `fs-actions.js`.
- Add `node --test` coverage for read/write/list, caps, traversal and symlink
  rejection, missing grants and hints, side-effect-free previews, undo
  restoration, stale undo and read/write limits.

## 0.1.1

- Missing subject fails closed instead of falling back to a shared `anonymous`
  identity.
- Grant decisions no longer treat `{ ok: true }` as allow (fail closed).
- `allow.check` is called without a scope, so narrow grants can authorize.

## 0.1.0

- Add `ActService` (`register` / `unregister` / `get` / `list` / `invoke`) exposed
  as the Host service `ctx.act`.
- Validate action ids (`^[a-z][a-z0-9_.-]{1,63}$`), risk and `execute`, and reject
  duplicate ids.
- Gate `write` and `danger` actions through the optional Allow service
  (`check({ subject, capability: 'act:invoke:<id>', scope })`); return
  `grant_required` instead of throwing when the service is absent or denies.
- Return `{ ok: true, actionId, result }` on success and `{ ok: false,
  code: 'action_failed', message }` when `execute` throws.
- Add built-in `echo`, `now` and `list` read actions.
- Register the `act_list` and `act_invoke` agent tools using plain tool
  definitions (no `@deepseek-ai/dsh-tools` dependency).
- Add `node --test` coverage for registration, filtering, invocation, denial,
  authorized writes, execution failures and duplicate ids.

## 0.0.1

- Reserve the `dsh-act` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
