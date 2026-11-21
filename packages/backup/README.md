# Backup · `dsh-timecapsule`

> Read-only, allowlisted filesystem snapshot manifests and restore plans for
> DeepSeek Harness.

**Status: 0.2.0 (safety boundary). A read-only inventory, not a backup engine.**
Backup records a manifest of file metadata, compares two manifests, and prints
the paths a restore *would* add, overwrite or delete. **It never copies, moves
or deletes anything, and it never writes to the restore target.**
Executing a restore is still future work.

0.2.0 adds the boundaries that 0.1.0 lacked: every snapshot root and restore
target must sit inside `allowedRoots` (default: `process.cwd()`), sensitive
paths are excluded by default, hard caps cannot be raised by callers, and each
snapshot leaves an audit record without file names.

**Backup is not Time Machine.** It has no scheduler, no incremental block
store, no versioned disk image, no purge policy and no restore execution. It
is the validated manifest that a later restore executor can consume.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

> The name `dsh-backup` on npm belongs to another project. This module is
> published as `dsh-timecapsule`; the product name is **Backup**.

## Install

```sh
dsh plugin --profile web add dsh-timecapsule
```

The bundle patch mounts the plugin and provides `ctx.backup`. No runtime
dependencies, Node 22.19+ (or Node 24.9+), no build step.

## Host service

```js
const backup = ctx.get('backup')

const manifest = backup.snapshot({
  root: '/work/acme',                 // required, inside allowedRoots
  include: ['src/**', 'package.json'], // optional
  exclude: ['**/*.log'],               // added to sensitive defaults
})

backup.list()                     // summaries, newest first
backup.get(manifest.id)           // full manifest, or null
backup.audit()                    // snapshot audit records, newest first
backup.diff(olderId, newerId)     // added / removed / changed
backup.planRestore(manifest.id, { target: '/work/acme-restored' })
backup.forget(manifest.id)        // true when it existed
```

`BackupService` is exported for direct, host-free use:

```js
import { BackupService, DEFAULT_SENSITIVE_EXCLUDES, HARD_LIMITS }
  from 'dsh-timecapsule'

const backup = new BackupService({
  allowedRoots: ['/work/acme'],   // default: [process.cwd()]
  maxFiles: 10_000,                // hard cap: 10,000
  maxBytes: 100 * 1024 * 1024,     // hard cap: 100 MiB
  maxFileBytes: 10 * 1024 * 1024,  // hard cap: 10 MiB
  excludeSensitive: true,          // default sensitive exclusions
  exclude: ['**/*.tmp'],           // extra exclusions for every snapshot
  hash: 'sha256',                  // optional; omitted by default
})
```

`allowedRoots` must be a non-empty array of absolute directories. Each entry is
canonicalized; `/` and the home directory are rejected as allowed roots with
`E_FORBIDDEN_ROOT`. Glob config (`defaultExclude`, `exclude`) and snapshot
arguments (`include`, `exclude`) are validated as relative globs.

The snapshot ledger and the audit trail are **in process memory** and are not
persisted; both disappear when the host process exits.

## `snapshot({ root, include?, exclude? })`

Recursively reads metadata under an allowed absolute `root` and returns:

```js
{
  schema: 'dsh.backup.snapshot/v1',
  id: 'bkp_...',
  root: '/work/acme',          // canonical absolute root
  createdAt: 1760000000000,
  hash: null,                  // 'sha256' only when enabled
  include: ['src/**'],
  exclude: [                   // effective list: defaults + config + call
    '**/.ssh', '**/.env*', '**/credentials*', '**/*.pem', '**/*.key',
    '**/id_rsa*', '**/.git', '**/node_modules', '**/*.log',
  ],
  limits: { maxFiles: 10000, maxBytes: 104857600, maxFileBytes: 10485760 },
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
  `path` is absolute under the canonical `root`.
- Directories are included so a restore planner can create them. Directory
  metadata is **presence-only** in `diff`/`planRestore` because directory
  timestamps change constantly.
- Symlinks are recorded (with `target`) and never followed.
- Sockets, FIFOs and other special files are skipped.
- `hash: 'sha256'` is opt-in per service/snapshot. By default **no file content
  is read**; enabling hashing reads the included regular files to digest them.

### Path safety

- `root` and `target` must be **absolute**, non-empty and must not contain a
  literal `..` segment, NUL bytes or an empty value. Violations are
  `E_INVALID_ARGUMENT`.
- The root is canonicalized with `realpath`. A root that is a symlink escaping
  outside `allowedRoots` is rejected with `E_OUTSIDE_ROOT`; an in-tree symlink
  is recorded, not followed.
- The filesystem root (`/`, or a drive root on Windows) and the home directory
  root are **never** valid roots or targets, even if someone puts them in
  `allowedRoots` (`E_FORBIDDEN_ROOT`).
- A root or target outside the configured `allowedRoots` is rejected with
  `E_OUTSIDE_ROOT` before any tree walk.
- `include` / `exclude` are arrays of relative globs. Absolute globs and `..`
  globs are rejected.
- Patterns match the full relative path from the root: `*` matches within one
  path segment, `**` crosses `/`, `?` matches one non-`/` character. A literal
  pattern (`node_modules`) also matches everything underneath it.
- `exclude` prunes directories before descent. `include` filters files;
  required parent directories are kept and empty ones are pruned.

### Sensitive defaults

These patterns are pruned at any depth by default:

| Pattern | Examples |
| --- | --- |
| `**/.ssh` | `~/.ssh`, `home/.ssh` |
| `**/.env*` | `.env`, `.env.local`, `app/.env.production` |
| `**/credentials*` | `credentials.json`, `aws/credentials` |
| `**/*.pem`, `**/*.key` | `server.pem`, `private.key` |
| `**/id_rsa*` | `id_rsa`, `id_rsa.pub` |
| `**/.git` | repository metadata |
| `**/node_modules` | installed dependencies |

The defaults are also applied to the `planRestore` target scan, so a restore
plan never proposes deleting or comparing `.ssh`, `.env*` and similar paths.

**Overriding is explicit and config-only.** The agent tools cannot disable
them. A host may either replace the default list or turn it off:

```js
new BackupService({ allowedRoots: ['/work'], defaultExclude: ['**/.secret'] })
new BackupService({ allowedRoots: ['/work'], excludeSensitive: false })
```

Per-call `exclude` only **adds** patterns; per-call `include` cannot re-include
a path pruned by a sensitive default.

### Limits

| Limit | Hard cap | Counts |
| --- | --- | --- |
| `maxFiles` | 10,000 | regular files **and** symlinks |
| `maxBytes` | 100 MiB | sum of regular file sizes |
| `maxFileBytes` | 10 MiB | any single regular file |

- Service config and per-call options may **lower** a limit; a value above the
  hard cap is rejected with `E_LIMIT`. The tool surface does not expose limits
  at all.
- Limits are checked while walking the tree and apply to entries that pass
  `include` (excluded and sensitive paths never count), failing closed with
  `E_LIMIT`; no partial manifest is stored.
- The single-file cap is checked from `lstat` metadata **before** any optional
  hashing, so a huge file is never read.
- A missing `root` is `E_NOT_FOUND`; a non-directory `root` is
  `E_INVALID_ARGUMENT`; unreadable paths are `E_UNAVAILABLE`.

## `audit(count?)`

Returns newest-first snapshot audit records, capped at 200 retained entries:

```js
{
  at: 1760000000000,
  op: 'snapshot',
  root: '/work/acme',
  fileCount: 42,
  bytes: 123456,
  durationMs: 4,
  outcome: 'ok',
}
```

Failed snapshots add `{ outcome: 'error', code: 'E_…' }` instead of counts.
Records **never include entry paths or file-name lists**, and the plugin does
not write audit records to stdout/stderr or to disk.

## `diff(idA, idB)`

Compares entries by `rel` (not absolute path, so snapshots of different roots
are comparable). Returns `added`, `removed` and `changed` relative paths plus a
`changes` array with the changed fields and their old/new values. For files and
symlinks the compared fields are `type`, `size`, `mtimeMs`, `mode`, `hash` and
`target` (the symlink target); directories only compare presence/type. Nothing
is written.

## `planRestore(id, { target })`

Returns the absolute target paths a later restore would touch:

```js
{
  schema: 'dsh.backup.plan/v1',
  id: 'bkp_...',
  source: '/work/acme',
  target: '/work/acme-restored',   // canonical allowed target
  createdAt: 1760000000000,
  execute: false,                  // always false
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
  effective `exclude` scope the target scan, so sensitive and out-of-scope
  files are not proposed for deletion.
- The target must be inside `allowedRoots` and must not be `/` or the home
  directory. A target symlink component that escapes `allowedRoots` is
  `E_OUTSIDE_ROOT`.
- A missing `target` is treated as empty; it is **not created**. A
  non-directory target is `E_INVALID_ARGUMENT`.
- If the target contains a symlink on the path of a restore entry, the plan is
  refused with `E_OUTSIDE_ROOT` rather than emitting paths that traverse it.
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
Tools cannot raise limits, disable sensitive exclusions, or widen
`allowedRoots`; those are host configuration.

## Error codes

| Code | Meaning |
| --- | --- |
| `E_INVALID_ARGUMENT` | relative/`..` path, bad pattern, bad config, bad limit, bad id |
| `E_NOT_FOUND` | source root or snapshot id does not exist |
| `E_LIMIT` | `maxFiles` / `maxBytes` / `maxFileBytes` exceeded, or a limit above its hard cap |
| `E_OUTSIDE_ROOT` | root/target outside `allowedRoots`, or a symlink escape |
| `E_FORBIDDEN_ROOT` | filesystem root or home directory used as a root, target or allowed root |
| `E_UNAVAILABLE` | filesystem path cannot be read, statted or canonicalized |

## What 0.2.0 does not do

- No restore execution: plans are data only; writing target files is not
  implemented.
- No copying, moving, deleting, chmod or archive creation.
- No scheduler, retention policy, deduplication or block storage.
- No persistence, encryption or multi-machine sync; manifests and audits live
  in memory.
- No UI contribution and no network I/O.
- **Not a Time Machine**: no filesystem snapshots, no history browser, no
  point-in-time recovery.

## Roadmap

- **0.1.0:** recursive metadata manifests, include/exclude, optional SHA-256,
  `list`/`get`/`diff`/`planRestore`/`forget`, `ctx.backup`, three agent tools.
- **0.2.0 (this release):** `allowedRoots` confinement, canonical path checks,
  default sensitive exclusions, hard caps, snapshot audit, confined
  `planRestore`; still zero writes.
- **0.3.0:** execute restore plans (copy/overwrite/delete), atomic writes,
  optional on-disk manifest ledger, incremental snapshots.

## Development

```sh
cd packages/backup
node --test
```

## License

MIT. See [LICENSE](./LICENSE).
