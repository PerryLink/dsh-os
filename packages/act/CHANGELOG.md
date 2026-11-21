# Changelog

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
