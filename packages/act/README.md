# Act · `dsh-act`

> Typed action registry and agent-facing action bus for DeepSeek Harness.

**Status: 0.3.0 — real filesystem actions, previews and undo**

0.3.0 turns Act from a demo registry into a usable action bus: the 0.1
`echo` / `now` / `list` actions stay compatible, and four filesystem actions
(`fs.read` / `fs.write` / `fs.list` / `fs.undo`) execute real work behind one
grant, preview and undo pipeline. The action panel and `dsh-act` CLI are still
planned for a later release.

Act is an **action bus**, not a repository task runner such as `dsh-actions`:
plugins register typed `ActionDescriptor`s once, and humans, agents and future
front-ends invoke the same actions through one registry and one grant check.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-act
```

Plain ESM, Node.js 22+, no runtime dependencies and no build step.

## Configuration

Pass an optional config object when the plugin is mounted:

```js
apply(ctx, {
  workdir: '/home/me/project', // absolute allowlist root, default process.cwd()
  maxReadBytes: 256 * 1024,    // default 256 KiB
  maxWriteBytes: 1024 * 1024,  // default 1 MiB
})
```

`workdir` is canonicalized with `realpath` at mount time and must exist and be a
directory. Every filesystem action is restricted to that tree.

## Built-in actions

| id | risk | arguments | result |
| --- | --- | --- | --- |
| `echo` | read | `{ text }` | `{ text }` |
| `now` | read | `{}` | `{ now }` — ISO 8601 |
| `list` | read | `{ query? }` | `{ actions }` — id, title, risk, description? |
| `fs.read` | read | `{ path, maxBytes? }` | `{ path, size, text }` |
| `fs.write` | write | `{ path, text, create? }` | `{ path, bytes, undoToken }` |
| `fs.list` | read | `{ path, recursive?, limit? }` | `{ entries: [{ path, type, size }] }` |
| `fs.undo` | write | `{ undoToken }` | `{ path, restored, bytes }` |

- `fs.read` caps output at `maxReadBytes` (256 KiB by default). A per-call
  `maxBytes` can lower the cap but never raise it. `size` is the full file size;
  `text` is the first `min(size, cap)` bytes decoded as UTF-8.
- `fs.write` replaces the whole file (`create: false` requires an existing
  file). It writes a sibling temporary file and renames it into place, so a
  reader never observes a half-written file. Text over `maxWriteBytes` is
  rejected with `E_TOO_LARGE`.
- `fs.list` returns absolute paths. `limit` defaults to 200 and is clamped to
  1000. `recursive: true` descends into real subdirectories only; symlinks are
  reported as `symlink` and are never followed.
- `fs.undo` is described below. `echo` / `now` / `list` keep their 0.1
  behaviour and ids.

`act_list` returns every action's `risk` so a caller can see which ids need a
grant before invoking them.

## Path safety

Every `path` argument must satisfy all of:

1. Be an absolute path (relative paths fail with `E_PATH`).
2. Contain no NUL and no `..` segment — even one that would resolve back inside
   the workdir is rejected.
3. Canonicalize, via `realpath`, to a target under the workdir. For a write to a
   new file, the deepest existing parent is canonicalized and the remaining tail
   is appended; a symlinked parent that escapes the workdir is rejected.
4. For an existing target, symlinks are resolved first. A symlink that points
   outside the workdir fails with `E_PATH_OUTSIDE`, so reads and writes cannot
   use a link as an escape hatch.

Containment uses `path.relative`, so Windows comparisons follow the platform's
case rules. A rejected path is never opened, written or listed.

This is containment, not an OS sandbox: another plugin in the same process can
still call `node:fs` directly, and the host's built-in `read` / `write` / `bash`
tools bypass Act unless a deployment routes or disables them. Act guarantees
that actions invoked through it are checked, not that the whole process is
isolated. Path checks are also best-effort against concurrent filesystem
mutation (classic TOCTOU); the atomic temp-file-and-rename write narrows, but
does not eliminate, that window.

## Grants

`read` actions run directly. `write` and `danger` actions call the optional
Allow service first:

```js
const allow = ctx.get('allow')
const decision = await allow.check({
  subject: meta?.subject ?? meta?.sessionId,
  capability: 'act:invoke:fs.write',
})
```

If Allow is absent, the check throws, the decision is not affirmative, or no
`subject` is available, `invoke()` returns `grant_required` and does **not**
execute the action (fail closed). When the Allow service exposes a `request`
method, the denial also carries:

```js
{ hint: 'Call allow_request for capability "act:invoke:fs.write" …' }
```

`allow.check` calls carry no scope, so a narrow grant can still authorize the
capability. Affirmative decisions are `true`, `'allow'`, or an object with
`granted` / `allowed` / `allow` / `permitted === true`, or `decision` /
`status === 'allow'`.

## Preview

A write can be previewed before any grant is requested:

```js
await act.invoke('fs.write', { path: file, text: next }, { preview: true })
// { ok: true, preview: { path, bytes, diff } }

// Agent tool: same switch at the tool level, so fs.write's argument schema stays clean.
await act_invoke({ id: 'fs.write', args: { path: file, text: next }, preview: true })
```

Preview validates the path, text and caps, reads the current content, and
returns a line diff. It **never writes, creates or renames anything**, and it
does not consume a grant. Files whose current content exceeds 1 MiB return a
size note instead of a diff, because the old bytes are not retained.

## Undo

A successful `fs.write` returns a single-use `undoToken`:

```js
const { result } = await act.invoke('fs.write', { path: file, text: 'next' }, { subject })
await act.invoke('fs.undo', { undoToken: result.undoToken })
```

- Existing file: restores the previous content atomically.
- New file: removes the file.
- The token is a random UUID, valid for 5 minutes, single use, and held only in
  memory (a restart drops it). The ledger is bounded to 16 entries / 1 MiB per
  entry.
- Before restoring, `fs.undo` re-validates containment and compares the current
  file hash with the content written by `fs.write`. If the file changed in the
  meantime it fails with `E_UNDO_STALE` and leaves the file alone.
- If the old content exceeded the 1 MiB undo cap, no token is issued:
  `{ path, bytes, undoToken: null, undoable: false, reason: 'undo_limit' }`.
- The single-use token is the capability for this meta action, so `fs.undo`
  does not require a second grant; requiring one would make recovery
  impossible after a grant expires.

## Service API

The plugin exposes `ctx.act`:

```js
const act = ctx.get('act')

const dispose = act.register({
  id: 'workspace.open',              // ^[a-z][a-z0-9_.-]{1,63}$
  title: 'Open workspace file',
  description: 'Open one file in the editor.',
  risk: 'write',                     // read | write | danger
  parameters: { type: 'object', additionalProperties: true },
  async preview(args, meta) { /* optional, used by meta.preview */ },
  async execute(args, meta) {
    return { opened: args.path, session: meta?.sessionId }
  },
})

act.get('workspace.open')            // descriptor | undefined
act.list('open')                     // substring filter over id/title/description
act.list({ text: 'open', riskMax: 'write' })
await act.invoke('echo', { text: 'hi' }, { subject: 'session-42' })
dispose()
```

`register()` validates the id, title, risk, `execute`, and the optional
`description` / `parameters` / `preview` / `authorize` / `undo` fields.
Duplicate ids throw `action_exists`. `authorize: false` opts an action out of
the Allow check; it is reserved for actions that are themselves capability
tokens, such as `fs.undo`.

Results never throw for expected failures:

| Outcome | Value |
| --- | --- |
| Success | `{ ok: true, actionId, result }` |
| Preview | `{ ok: true, actionId, preview }` |
| Unknown id | `{ ok: false, code: 'action_not_found', actionId }` |
| Missing grant | `{ ok: false, code: 'grant_required', actionId, capability, hint? }` |
| Action threw | `{ ok: false, code: 'action_failed', message, reason? }` |

Filesystem `reason` codes: `E_INVALID_ARGUMENT` (wrong type, unknown field,
bad `maxBytes` / `limit`), `E_PATH` (relative, NUL, `..`, or missing),
`E_PATH_OUTSIDE` (allowlist or symlink escape), `E_TOO_LARGE`,
`E_NOT_FILE`, `E_NOT_DIR`, `E_NOT_FOUND`, `E_UNDO_TOKEN`,
`E_UNDO_STALE`, `E_WORKDIR`. Host `fs` errors that are not remapped (for
example `ENOENT` for a missing parent directory or `EACCES`) keep their
original `reason`.

## Agent tools

- `act_list` — read-only; optional `query` string; returns `{ actions }` with
  `id`, `title`, `risk` and optional `description`.
- `act_invoke` — `id` required, `args` optional object, `preview` optional
  boolean. The effective risk is the target descriptor's risk; `write` /
  `danger` actions still go through the Allow check above.

## Test

```sh
cd packages/act
node --test
```

The suite covers reads, writes, listing, path traversal and symlink escapes,
missing grants and hints, previews that do not touch disk, undo (restore,
created-file removal, stale detection), read/write caps and `act_list` risks.

## License

MIT.
