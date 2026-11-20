# Nest · `dsh-nest`

> Versioned workspace profiles for DeepSeek Harness: context, permissions,
> environment and defaults.

**Status: 0.1.0 (MVP). A profile ledger, not an applier.** Nest 0.1.0 records
and versions workspace profiles, previews changes with `diff`, and resolves a
one-step inheritance chain (`global` → workspace). It does **not** yet read
`nest.profile.yml` from disk or apply a profile to a DSH workspace, session,
sandbox, environment or skill set. Wiring `apply()` into `ctx.workspaceProfile`
and session startup is scoped for **0.2.0**.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

In one sentence: **0.1.0 is the validated, versioned ledger that 0.2.0 will
apply.**

## Install

```sh
dsh plugin --profile web add dsh-nest
```

The bundle patch mounts the plugin and provides `ctx.nest`.

## Host service

```js
import { GLOBAL } from 'dsh-nest'

const nest = ctx.get('nest')

nest.set(GLOBAL, {
  contextFiles: ['AGENTS.md'],
  permissionPreset: 'read-only',
  defaults: { model: 'deepseek-chat', reasoning: 'high' },
  owners: ['team:core'],
})

nest.set('/work/acme', {
  title: 'Acme',
  contextFiles: ['AGENTS.md', 'docs/architecture.md'],
  permissionPreset: 'workspace-write',
  envProfile: 'root:acme-dev',
  defaults: { reasoning: 'max' },
  skills: ['pdf', 'office'],
  lifecycle: { ttlDays: 30, archiveAfterDays: 90 },
  owners: ['team:acme'],
})

nest.get('/work/acme')      // stored record, or null
nest.list()                 // every stored record, sorted by path
nest.resolve('/work/acme')  // effective profile + sources (read-only)
nest.diff('/work/acme', { title: 'Acme 2' }) // field changes, no write
nest.remove('/work/acme')   // true when it existed
```

`NestService` is also exported for direct use:

```js
import { NestService } from 'dsh-nest'

const nest = new NestService({ stateFile: '/path/to/nest-state.json' })
```

With no `stateFile`, everything lives in process memory. A relative
`stateFile` is resolved by Node's `fs` against the current working directory;
an absolute path is recommended.

## Profile schema

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes | Absolute workspace path, normalized; `profile.path` may be omitted. |
| `title` | string | no | Non-empty display title. |
| `contextFiles` | string[] | no (default `[]`) | Paths/globs the profile would inject in 0.2.0. |
| `permissionPreset` | string | no | Intended preset name; not enforced in 0.1.0. |
| `envProfile` | string | no | Reference such as `root:acme-dev`; never a secret value. |
| `defaults` | `{ model?, reasoning? }` | no | Session defaults; unknown keys rejected. |
| `skills` | string[] | no (default `[]`) | Skill names the profile would require. |
| `lifecycle` | `{ ttlDays?, archiveAfterDays? }` | no | Non-negative day counts; declarative only. |
| `owners` | string[] | no (default `[]`) | Owner identifiers such as `team:acme`. |
| `version` | integer ≥ 1 | yes in stored records | Managed by the service; see below. |

Validation rejects relative paths, NULs, non-array array fields, empty array
entries, unknown top-level fields, unknown `defaults`/`lifecycle` keys, negative
day counts and invalid versions. Errors carry a stable `code`.

## Inheritance and `resolve`

The reserved key `GLOBAL` (`"global"`) is the base profile. `resolve(path)`
applies the **one-step** chain `global` → workspace:

- scalar fields (`title`, `permissionPreset`, `envProfile`) are overridden by
  the workspace when present;
- `contextFiles`, `skills` and `owners` are unioned, global entries first,
  duplicates removed;
- `defaults` and `lifecycle` are shallow-merged key by key.

The result is:

```js
{
  path: '/work/acme',
  sources: { global: true, workspace: true },
  profile: { /* effective profile; path is the requested workspace */ },
}
```

`resolve()` never writes. If only `global` exists, an unknown workspace
resolves to the inherited base (`sources.workspace === false`). If neither
exists, it throws `E_NOT_FOUND`. `global` itself is a valid path and resolves
to the stored base.

## Versioning

- A new profile starts at `version: 1` unless an explicit positive version is
  supplied.
- Every overwrite advances exactly one step: `next.version === current.version + 1`.
- `set()` replaces the whole record; it is not a patch. Omitted optional fields
  are removed and omitted arrays reset to `[]`. Use `diff()` to preview this.
- Pass the current version (or omit it) on overwrite. Passing the already-next
  version is also accepted. Any other value, including a stale version, fails
  with `E_VERSION`; the stored record is untouched.

## `diff`

`diff(path, patch)` validates and normalizes `patch` exactly like `set`, but
writes nothing. It returns:

```js
{
  path: '/work/acme',
  created: false,          // true when no record exists yet
  hasChanges: true,
  changes: [{ field: 'title', from: 'Acme', to: 'Acme 2' }],
  current: { /* stored profile, or null */ },
  next: { /* would-be profile, including the next version */ },
}
```

`version` is metadata, not a diffed content field. A new record always reports
`hasChanges: true` even for an empty patch.

## Persistence

Set `stateFile` to enable a JSON snapshot:

```js
new NestService({ stateFile: '/var/lib/dsh/nest.json' })
```

Each mutation writes the whole ledger through a temporary file plus `rename`
(atomic replace on the same filesystem) with mode `0600`; the parent directory
is created with mode `0700`. The snapshot is plain JSON and **not encrypted**.
Malformed snapshots fail with `E_STATE_INVALID` instead of being silently
dropped.

## Agent tools

The plugin registers five plain-object tools (no `@deepseek-ai/dsh-tools`
dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `nest_set` | `path` (required), `profile` (required object) | `{ profile }` |
| `nest_get` | `path` (required) | `{ profile }`; throws `E_NOT_FOUND` |
| `nest_list` | none | `{ profiles }` |
| `nest_diff` | `path` (required), `patch` | the `diff()` result |
| `nest_remove` | `path` (required) | `{ path, removed }` |

Tools accept `"global"` anywhere a path is accepted. They only touch the Nest
ledger; they do not modify the DSH workspace, files, grants or environment.

## What 0.1.0 does not do

- No `nest.profile.yml` discovery or filesystem watching.
- No session/workspace integration, sandbox or permission enforcement.
- No Root, Allow or Check calls; `permissionPreset`, `envProfile`, `defaults`
  and `lifecycle` are stored as declarations only.
- No network I/O, background timers, encryption or multi-machine sync.

Those are 0.2.0+ scope. Until then, treat Nest as the validated source of truth
for profiles, not as an active policy engine.

## Development

```sh
cd packages/nest
node --test
```

Pure ESM JavaScript, Node 22+, no runtime dependencies and no build step.

## License

MIT. See [LICENSE](./LICENSE).
