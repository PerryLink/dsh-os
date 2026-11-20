# dsh-os

A family of **OS-level primitives for DeepSeek Harness**: 11 core modules
(Act, Allow, Snip, Check, Nest, Trigger, Seek, Trace, Stage, Ring, Root), 5
optional modules (Help, Context, Cost, Backup, Notify), plus a thin contract,
an optional UI shell, a catalog CLI and a dependency-only kit.

The modules stay small and independent: one Host service, ≤6 agent tools,
zero runtime dependencies, independent semver, no cross-module imports. The
contract (`@perrylink/dsh-os-contract`) and the optional shell are the only
shared layers; the kit contains no business code.

> **Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are
> trademarks of their respective owners. These are independent community
> packages, published under MIT.

[![Terminal card: dsh-check prints "Check REGRESSION" and exits 1](docs/assets/check-demo.svg)](examples/os-kit/README.md)

**Runnable in 10 minutes:** [`examples/os-kit`](examples/os-kit/README.md) has
two dependency-free demos — Allow + Act + Snip (deny → 30-minute Grant → allow
→ revoke → deny) and the Check regression gate. `node examples/os-kit/demo.mjs`
needs only Node 22+; nothing is installed or published.

**Docs:** [Quickstart](docs/quickstart.md) ·
[Recipes](docs/recipes/) (CI gate, agent writes, clipboard) ·
[Troubleshooting](docs/troubleshooting.md).

## Packages

| Product | Package | Status | Design |
|---|---|---|---|
| **Act** | `dsh-act` | 0.1.1 MVP | [design](docs/design/01-act.md) |
| **Allow** | `dsh-allow` | 0.1.2 MVP (security hardening) | [design](docs/design/02-allow.md) |
| **Snip** | `dsh-snip` | 0.1.1 MVP | [design](docs/design/03-snip.md) |
| **Check** | `@perrylink/dsh-check` | 0.1.1 MVP (diff engine; runner in 0.2.0) | [design](docs/design/04-check.md) |
| **Nest** | `dsh-nest` | 0.1.0 MVP | [design](docs/design/05-nest.md) |
| **Trigger** | `dsh-trigger` | 0.1.0 protocol MVP | [design](docs/design/06-trigger.md) |
| **Seek** | `dsh-seek` | 0.1.1 protocol MVP | [design](docs/design/07-seek.md) |
| **Trace** | `@perrylink/dsh-trace` | 0.1.0 protocol MVP | [design](docs/design/08-trace.md) |
| **Stage** | `dsh-stage` | 0.1.1 protocol MVP | [design](docs/design/09-stage.md) |
| **Ring** | `dsh-ring` | 0.1.1 protocol MVP | [design](docs/design/10-ring.md) |
| **Root** | `@perrylink/dsh-root` | 0.1.2 MVP | [design](docs/design/11-root.md) |
| **Help** | `dsh-help` | 0.1.0 optional | install doctor / first run |
| **Context** | `@perrylink/dsh-context` | 0.1.0 optional | context provider protocol |
| **Cost** | `@perrylink/dsh-cost` | 0.1.0 optional | adapter for `dsh-cost-meter` |
| **Backup** | `@perrylink/dsh-backup` | 0.1.0 optional | snapshot manifest / restore plan |
| **Notify** | `@perrylink/dsh-notify` | 0.1.0 optional | channel registry / attention router |
| **Shell** | `@perrylink/dsh-os-shell` | 0.1.0 optional | view registry + minimal HTML card |
| **CLI** | `@perrylink/dsh-os-cli` | 0.1.0 tool | `dsh-os list/doctor/install` |
| **Contract** | `@perrylink/dsh-os-contract` | 0.1.0 library | constants, refs, manifest/tool validation |
| **Kit** | `dsh-os-kit` | 0.1.0 meta bundle | installs Act + Allow + Snip + Check |

`Check`, `Trace`, `Root`, `Context`, `Cost`, `Backup`, `Notify`, `Shell`, `CLI`
and `Contract` use the `@perrylink/` scope where npm's name-similarity rules
require it; the product names stay bare.

## Install

```sh
# one-shot: the four core modules
dsh plugin --profile web add dsh-os-kit

# or individually
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
dsh plugin --profile web add dsh-snip
dsh plugin --profile web add dsh-nest
dsh plugin --profile web add dsh-trigger
dsh plugin --profile web add dsh-seek
dsh plugin --profile web add dsh-stage
dsh plugin --profile web add dsh-ring
dsh plugin --profile web add @perrylink/dsh-check
dsh plugin --profile web add @perrylink/dsh-root
dsh plugin --profile web add @perrylink/dsh-trace

# optional small modules
dsh plugin --profile web add dsh-help
dsh plugin --profile web add @perrylink/dsh-context
dsh plugin --profile web add @perrylink/dsh-cost
dsh plugin --profile web add @perrylink/dsh-backup
dsh plugin --profile web add @perrylink/dsh-notify
dsh plugin --profile web add @perrylink/dsh-os-shell

# catalog CLI (no network, prints install plans)
npm i -g @perrylink/dsh-os-cli
dsh-os list
dsh-os doctor
```

## Repository layout

```
packages/    one npm package per primitive
examples/    dependency-free runnable demos
docs/        design notes and the implementation contract
scripts/     scaffold, test and publish helpers
```

## Status

All twenty packages ship a 0.1.x MVP: services, agent tools, tests and a bundle
manifest (libraries/CLI where applicable). Native/OS adapters (AX/Win32, real
clipboard capture, DSH headless runner, fs/webhook/agent trigger sources,
locator/library/memento providers, real notification channels) are 0.2.0 work.
`node scripts/test-all.mjs` runs 21 suites; `npm run verify` runs the full
four-gate release check.

## Development

```sh
node scripts/scaffold.mjs
node scripts/test-all.mjs
node scripts/publish.mjs act allow   # requires NPM_TOKEN
```

## CI and release

CI (`.github/workflows/ci.yml`) runs on a Node 22 + 24 matrix with the npm cache
enabled, and executes four gates in order:

```sh
node scripts/test-all.mjs
node scripts/conformance.mjs
node scripts/pack-smoke.mjs
node scripts/check-versions.mjs
```

- `pack-smoke` runs `npm pack --dry-run --json` for every `packages/*` and
  fails if the tarball lacks `package.json`, `index.js`, `cordis.patch.yml`,
  `README.md` or `LICENSE`.
- `check-versions` fails on an invalid `version`, an `engines.dsh` range
  without an upper bound, a `publishConfig.registry` that is not npmjs, or a
  non-empty `dependencies`.

The same sequence, including the package tests, runs locally as
`npm run verify`.

Releases are **never published automatically**. `.github/workflows/release.yml`
is `workflow_dispatch`-only: it takes a comma-separated `package` input
(directory names such as `act,allow` or npm names such as `dsh-act`), runs the
same gates on Node 24, then `npm pack`s only the selected packages and uploads
the tarballs as a build artifact. Publishing is a manual maintainer step: it
needs the `NPM_TOKEN` repository secret (a granular npm token allowed to
publish `dsh-*` and `@perrylink/*`), an approval-protected environment, and an
explicit `npm publish` of the reviewed tarballs. The workflow never runs
`npm publish`.

## Community, RFCs and feedback

- **Launch and support notes:** [docs/community/launch.md](docs/community/launch.md)
  — what works today, what is still 0.2.0, and the official post / directory
  submission drafts.
- **Upstream RFCs (suggestions, not requirements):**
  [`ctx.actions`](docs/rfcs/ctx-actions.md),
  [`ctx.grant`](docs/rfcs/ctx-grant.md),
  [`ctx.triggers`](docs/rfcs/ctx-triggers.md).
- **Telemetry:** [docs/telemetry.md](docs/telemetry.md) — off by default; no
  telemetry or network code ships in 0.1.x.
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md),
  [issue templates](.github/ISSUE_TEMPLATE/) and the
  [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
- **Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are
  trademarks of their respective owners.

## License

MIT.
