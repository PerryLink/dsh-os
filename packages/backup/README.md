# Backup · `@perrylink/dsh-backup`

> Filesystem snapshot manifests and restore plans for DeepSeek Harness.

**Status: 0.1.0 (MVP). A read-only inventory, not a backup engine.**
Backup 0.1.0 records a manifest of file metadata, compares two manifests, and
prints the paths a restore *would* add, overwrite or delete. **It never copies,
moves or deletes anything, and it never writes to the restore target.**
Executing a restore is scoped for **0.2.0**.

**Backup is not Time Machine.** It has no scheduler, no incremental block
store, no versioned disk image, no purge policy and no restore execution. It
is the validated manifest that a later restore executor can consume.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

> The name `dsh-backup` on npm belongs to another project. This module is
> published as `@perrylink/dsh-backup`; the product name is **Backup**.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-backup
```

The bundle patch mounts the plugin and provides `ctx.backup`. No runtime
dependencies, Node 22.19+ (or Node 24.9+), no build step.

## Host service

```js
const backup = ctx.get('backup')

const manifest = backup.snapshot({
  root: '/work/acme',
  include: ['src/**', 'package.json'],
  exclude: ['node_modules', '.git', '**/*.log'],
})

backup.list()                     // summaries, newest first
backup.get(manifest.id)           // full manifest, or null
backup.diff(olderId, newerId)     // added / removed / changed
backup.planRestore(manifest.id, { target: '/work/acme-restored' })
backup.forget(manifest.id)        // true when it existed
```

`BackupService` is exported for direct, host-free use:

```js
import { BackupService } from '@perrylink/dsh-backup'

const backup = new BackupService({
  maxFiles: 10_000,          // default 10,000
  maxBytes: 256 * 1024 * 1024, // default 256 MiB
  hash: 'sha256',            // optional; omitted by default
})
```

The ledger is **in process memory** and is not persisted; manifests disappear
when the host process exits. Persistence and restore execution are 0.2.0
scope.

## `snapshot({ root, include?, exclude? })`

Recursively reads metadata under an absolute `root` and returns:

```js
{
  schema: 'dsh.backup.snapshot/v1',
  id: 'bkp_...',
  root: '/work/acme',
  createdAt: 1760000000000,
  hash: 'sha256',              // or null
  include: ['src/**'],
  exclude: ['node_modules'],
  limits: { maxFiles: 10000, maxBytes: 268435456 },
  counts: { files: 3, dirs: 2, symlinks: 0, bytes: 11 },
  entries: [
    {
      path: '/work/acme/src/a.js',
      rel: 'src/a.js',
      type: 'file',            // file | dir | symlink
      size: 5,
      mtimeMs: 1760000000000,
      mode: 420,               // permission bits only (0o644)
      hash: '…',               // sha256, only when enabled
    },
  ],
}
```

- `entries` are sorted by POSIX relative path. `rel` is used for comparison;
  `path` is absolute.
- Directories are included so a restore planner can create them. Directory
  metadata is **presence-only** in `diff`/`planRestore` because directory
  timestamps change constantly.
- Symlinks are recorded (with `target`) and never followed.
- Sockets, FIFOs and other special files are skipped.
- `hash: 'sha256'` is opt-in per service/snapshot; hashing reads file bytes
  but does not modify them.

### Paths and patterns

- `root` and `target` must be **absolute** and must not contain a literal
  `..` segment. Relative paths, NUL bytes and `..` are rejected with
  `E_INVALID_ARGUMENT`.
- `include` / `exclude` are arrays of relative globs. Absolute globs and `..`
  globs are rejected.
- Patterns match the full relative path from the root: `*` matches within one
  path segment, `**` crosses `/`, `?` matches one non-`/` character. Use
  `**/node_modules` for a directory at any depth. A literal pattern (`src`,
  `node_modules`) also matches everything underneath it.
- `exclude` prunes directories before descent. `include` filters files;
  required parent directories are kept and empty ones are pruned.

### Limits

- `maxFiles` counts regular files **and symlinks**; `maxBytes` sums regular
  file sizes. Both are checked against the whole walk (not only entries that
  survive `include`) and fail closed with `E_LIMIT`; no partial manifest is
  stored.
- A missing `root` is `E_NOT_FOUND`; a non-directory `root` is
  `E_INVALID_ARGUMENT`; unreadable paths are `E_UNAVAILABLE`.

## `diff(idA, idB)`

Compares entries by `rel` (not absolute path, so snapshots of different roots
are comparable). Returns `added`, `removed` and `changed` relative paths plus a
`changes` array with the changed fields and their old/new values. For files and
symlinks the compared fields are `type`, `size`, `mtimeMs`, `mode`, `hash` and
`target` (the symlink target); directories only compare presence/type. Nothing
is written.

## `planRestore(id, { target })`

Returns the absolute target paths a 0.2.0 restore would touch:

```js
{
  schema: 'dsh.backup.plan/v1',
  id: 'bkp_...',
  source: '/work/acme',
  target: '/work/acme-restored',
  createdAt: 1760000000000,
  execute: false,              // 0.1.0 never executes
  counts: { add: 2, overwrite: 1, delete: 1, unchanged: 4 },
  add: ['/work/acme-restored/src/new.js', /* … */],
  overwrite: ['/work/acme-restored/src/changed.js'],
  delete: ['/work/acme-restored/stray.txt'],
}
```

- `add`: in the manifest, absent from `target`.
- `overwrite`: present in both but metadata differs.
- `delete`: present under `target` but absent from the manifest (the
  target-only paths a mirror restore could remove). The manifest's
  `include`/`exclude` scope the target scan, so out-of-scope files are not
  proposed for deletion.
- A missing `target` is treated as empty; it is **not created**. A
  non-directory target is `E_INVALID_ARGUMENT`.
- `planRestore` only reads. It does not create directories, copy files,
  change modes or delete anything.

## Agent tools

Three plain-object tools are registered (no `@deepseek-ai/dsh-tools`
dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `backup_snapshot` | `root` (required), `include?`, `exclude?` | the snapshot manifest |
| `backup_diff` | `idA`, `idB` (required) | the `diff()` report |
| `backup_plan_restore` | `id`, `target` (required) | the `planRestore()` report |

Tools only read the source tree and the target tree. They never write files.

## Error codes

| Code | Meaning |
| --- | --- |
| `E_INVALID_ARGUMENT` | relative/`..` path, bad pattern, bad limit, bad id |
| `E_NOT_FOUND` | source root or snapshot id does not exist |
| `E_LIMIT` | `maxFiles` / `maxBytes` exceeded |
| `E_UNAVAILABLE` | filesystem path cannot be read or statted |

## What 0.1.0 does not do

- No restore execution: plans are data only; writing target files is 0.2.0.
- No copying, moving, deleting, chmod or archive creation.
- No scheduler, retention policy, deduplication or block storage.
- No persistence, encryption or multi-machine sync; manifests live in memory.
- No UI contribution and no network I/O.
- **Not a Time Machine**: no filesystem snapshots, no history browser, no
  point-in-time recovery.

## Roadmap

- **0.1.0 (this release):** recursive metadata manifests, include/exclude,
  hard limits, optional SHA-256, `list`/`get`/`diff`/`planRestore`/`forget`,
  `ctx.backup`, three agent tools.
- **0.2.0:** execute restore plans (copy/overwrite/delete), atomic writes,
  optional on-disk manifest ledger, incremental snapshots.

## Development

```sh
cd packages/backup
node --test
```

## License

MIT. See [LICENSE](./LICENSE).
