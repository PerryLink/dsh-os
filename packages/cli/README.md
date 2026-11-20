# @perrylink/dsh-os-cli

`dsh-os` is a **zero-dependency** CLI for the [dsh-os](../../README.md) module
family. It is a local catalog, a read-only health check, and a safe command
printer for `dsh plugin`.

- **No marketplace.** It does not search, rank, fetch or recommend packages.
- **No network.** Every fact comes from the repository or from the packaged
  `catalog.json`; the CLI never contacts a registry.
- **No configuration writes.** It never edits a DSH profile, credentials,
  sessions, settings or any other user file.

## Requirements

Node.js `>=22.19.0`.

## Install

```sh
npm install -g @perrylink/dsh-os-cli
dsh-os list
```

From this checkout, without installing:

```sh
node packages/cli/bin/dsh-os.js list
```

## Commands

| Command | What it does |
|---|---|
| `dsh-os list [--json] [--all]` | List the product modules present in the checkout (all 11 outside one), merging live `packages/*/package.json` data. `--all` adds the 5 optional/planned modules. |
| `dsh-os info <module> [--json] [--profile <name>]` | Show details and the install/update commands for one module. |
| `dsh-os doctor` | Check Node, catalog versions, `engines.dsh` upper bounds and `dsh.os` manifests. |
| `dsh-os install <module...> [--profile <name>] [--run]` | Print `dsh plugin --profile <name> add <pkg>` for each module. `--run` also executes it. |
| `dsh-os update [--profile <name>]` | Print `dsh plugin --profile <name> add <pkg>@latest` for every product module. |

`--profile` defaults to `web`.

### list

```console
$ dsh-os list
NAME                  PRODUCT  SERVICE       VERSION  STABILITY     DESCRIPTION
dsh-act               Act      ctx.act       0.1.1    experimental  Typed action registry and ...
@perrylink/dsh-check  Check    ctx.check     0.1.1    experimental  Paired-environment regression canary ...
...
```

`--json` emits an array with `name`, `product`, `service`, `version`,
`stability` and `description`. Optional entries also carry `"optional": true`.

### info

```console
$ dsh-os info act
Act
  package:     dsh-act
  service:     ctx.act
  version:     0.1.1
  stability:   experimental
  description: Typed action registry and natural-language action panel ...
  install:     dsh plugin --profile web add dsh-act
  update:      dsh plugin --profile web add dsh-act@latest
```

Modules can be referenced by package name (`dsh-act`, `@perrylink/dsh-root`),
product (`Act`, `Root`) or service (`act`, `ctx.env`).

### doctor

Checks, in order:

1. Node satisfies the workspace `engines.node` (falling back to the CLI range
   outside a checkout).
2. Every product module declares a valid, bounded `engines.dsh` range. A range
   without an upper bound is an **error**.
3. Every product module has a `dsh.os` manifest with a consistent
   `dsh.os.service`/`stability`. A missing manifest is a **warning** while the
   manifests workstream lands.
4. Workspace package versions are valid semver and match `catalog.json`.

Warnings do not change the exit code; any error exits `1`.

### install

By default the command only prints what it would run:

```console
$ dsh-os install act allow --profile web
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
```

`--run` opts in to executing the same commands with `spawnSync('dsh', argv,
{ shell: false })`: fixed argument vector, no shell interpolation. The dsh exit
code is propagated. Optional/planned modules are refused because they are not
published yet.

### update

```console
$ dsh-os update
dsh plugin --profile web add dsh-act@latest
dsh plugin --profile web add dsh-allow@latest
...
```

`update` only prints; it never executes anything.

## Repository mode vs catalog mode

- **Repository mode:** when the current directory is inside a dsh-os checkout
  (a `packages/*` workspace whose root is `dsh-os`, or that contains catalog
  modules), `list` shows the product modules checked out there, with every
  `packages/*/package.json` version, description and `dsh.os` field overlaid
  onto the catalog. `info` and `install` can still name any catalog module.
  Non-product packages (contract, shell, this CLI, tooling) are ignored.
- **Catalog mode:** everywhere else, the packaged `catalog.json` is used, so
  `list` shows all 11 product modules.

Both modes are offline.

## catalog.json

`catalog.json` contains the 11 product modules plus 5 optional/planned modules
(`dsh-help`, `dsh-context`, `dsh-cost`, `dsh-backup`, `dsh-notify`). Each entry
has `name`, `product`, `service`, `version`, `stability`, `description` and
`install`; optional entries add `"optional": true` and use version `0.0.0`.

Regenerate it after changing package versions or descriptions:

```sh
node packages/cli/scripts/build-catalog.mjs
```

Product and service names are contract metadata
([`docs/module-contract-v1.md`](../../docs/module-contract-v1.md) §3), so they
are maintained in the generator rather than derived from package names.

## Boundaries

- **Not a marketplace.** There is no search, download, rating, telemetry or
  recommendation feature. It knows only the curated dsh-os catalog.
- **Not networked.** The CLI performs no HTTP requests at all.
- **Read-only for user data.** It does not write profiles, credentials,
  sessions, DSH configuration or any file outside its own package.
- The only external process it can start is `dsh`, and only for
  `install --run`, with a fixed argument list and `shell: false`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success; `doctor` warnings are still success. |
| `1` | Usage error, unknown module, doctor error, or `dsh` failed to start. |

For `install --run`, a non-zero `dsh` exit code is returned as-is.

## Tests

```sh
cd packages/cli
node --test
```

The tests build throwaway fixture repositories under the OS temp directory, run
the CLI as a child process, and never touch a real DSH profile or the network.

## License

MIT.
