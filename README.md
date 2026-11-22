# dsh-os

A family of **OS-level primitives for DeepSeek Harness**: 11 core modules
(Act, Allow, Snip, Check, Nest, Trigger, Seek, Trace, Stage, Ring, Root), 5
optional modules (Help, Context, Cost, Backup, Notify), plus a thin contract,
an optional UI shell, a catalog CLI and a dependency-only kit.

The modules stay small and independent: one Host service, ≤6 agent tools,
zero runtime dependencies, independent semver, no cross-module imports. The
contract (`dsh-os-contract`) and the optional shell are the only
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
[AI handbook](docs/ai-handbook.md) ·
[Real-model eval](docs/eval-real.md) (5/5 real run) ·
[Web approval bridge](docs/presets/web-approval.md) ·
[Architecture 0.3](docs/architecture-0.3.md) ·
[AI capability cards](docs/ai-capability-cards.md) ·
[Validation plan](docs/validation/PLAN.md) ·
[Validation status](docs/validation/STATUS.md) ·
[Local smoke (0.2.0)](docs/validation/SMOKE.md) ·
[Recipes](docs/recipes/) (CI gate, agent writes, clipboard) ·
[Troubleshooting](docs/troubleshooting.md).

## Packages

| Product | Package | Status | Design |
|---|---|---|---|
| **Act** | `dsh-act` | 0.7.0 (one-approval proof) | [design](docs/design/01-act.md) |
| **Allow** | `dsh-allow` | 0.4.0 (one-time grants) | [design](docs/design/02-allow.md) |
| **Snip** | `dsh-snip` | 0.4.0 (capture + taint) | [design](docs/design/03-snip.md) |
| **Check** | `dsh-canary` | 0.4.0 (runner + envelope) | [design](docs/design/04-check.md) |
| **Nest** | `dsh-nest` | 0.1.0 MVP | [design](docs/design/05-nest.md) |
| **Trigger** | `dsh-trigger` | 0.4.0 (payload + taint) | [design](docs/design/06-trigger.md) |
| **Seek** | `dsh-seek` | 0.5.0 (trace + taint) | [design](docs/design/07-seek.md) |
| **Trace** | `dsh-record` | 0.3.0 (memento + ref verify) | [design](docs/design/08-trace.md) |
| **Stage** | `dsh-stage` | 0.2.0 (macOS/Windows adapters) | [design](docs/design/09-stage.md) |
| **Ring** | `dsh-ring` | 0.4.0 (Grant-gated delivery) | [design](docs/design/10-ring.md) |
| **Root** | `dsh-runtime-env` | 0.1.2 MVP | [design](docs/design/11-root.md) |
| **Help** | `dsh-help` | 0.1.0 optional | install doctor / first run |
| **Context** | `dsh-scene` | 0.1.0 optional | context provider protocol |
| **Cost** | `dsh-price` | 0.1.0 optional | adapter for `dsh-cost-meter` |
| **Backup** | `dsh-timecapsule` | 0.2.0 optional | allowlisted snapshot / restore plan |
| **Notify** | `dsh-buzz` | 0.1.0 optional | channel registry / attention router |
| **Shell** | `dsh-os-shell` | 0.4.0 optional | injection-safe approvals/activity |
| **CLI** | `dsh-os-cli` | 0.2.0 tool | `dsh-os list/doctor/install/approvals` |
| **Contract** | `dsh-os-contract` | 0.2.0 library | result/error/handle protocols |
| **Kit** | `dsh-os-kit` | 0.10.0 meta bundle | installs 6 latest modules |
| **Kernel** | `dsh-os-kernel` | 0.6.0 core | clean one-approval bridge |
| **MCP** | `dsh-os-mcp` | 0.2.0 tool | read-only default + write approval path |
| **A2A** | `dsh-os-a2a` | 0.1.0 tool | agent card + task protocol prototype |

**All packages are unscoped.** Where the exact bare name was already taken or blocked by npm's name-similarity rule, the package uses a nearby bare name: **Check → `dsh-canary`**, **Root → `dsh-runtime-env`**, **Trace → `dsh-record`**, **Context → `dsh-scene`**, **Cost → `dsh-price`**, **Backup → `dsh-timecapsule`**, **Notify → `dsh-buzz`**. Product names stay Check/Root/Trace/Context/Cost/Backup/Notify.

## Install

```sh
# one-shot: core four + Kernel + Shell
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
dsh plugin --profile web add dsh-canary
dsh plugin --profile web add dsh-runtime-env
dsh plugin --profile web add dsh-record

# AI gateway kernel (capability registry + os_* verbs)
dsh plugin --profile web add dsh-os-kernel

# optional small modules
dsh plugin --profile web add dsh-help
dsh plugin --profile web add dsh-scene
dsh plugin --profile web add dsh-price
dsh plugin --profile web add dsh-timecapsule
dsh plugin --profile web add dsh-buzz
dsh plugin --profile web add dsh-os-shell

# catalog CLI (no network, prints install plans)
npm i -g dsh-os-cli
dsh-os list
dsh-os doctor
dsh-os approvals list --state ~/.dsh/allow.json

# read-only MCP server prototype
npm i -g dsh-os-mcp
dsh-os-mcp --help

# A2A agent-card/task prototype (stdio)
npm i -g dsh-os-a2a
dsh-os-a2a --help
```

## Repository layout

```
packages/    one npm package per primitive
examples/    dependency-free runnable demos
docs/        design notes and the implementation contract
scripts/     scaffold, test and publish helpers
```

## Status

Twenty-three packages ship a 0.1.x–0.4.x MVP: services, agent tools, tests and a bundle
manifest (libraries/CLI where applicable). 0.2.0 added real adapters; 0.3.0 adds the kernel + permission request flow + Act fs actions + human oversight:
Check headless runner, Snip clipboard capture, Trigger agent/fs/webhook sources,
Seek locator/memento providers, Stage macOS/Windows windows, Trace memento
adapter, Ring webhook/ntfy/console channels and the React shell.
0.4.0 adds one-time/use-budgeted grants (Allow 0.4), the kernel legacy-tool bridge,
MCP write approval, safer Check runs and the four-module `dsh-os-kit` 0.4.
`node scripts/test-all.mjs` runs 21 suites; `npm run verify` runs the full
four-gate release check. See [0.4 release notes](docs/community/release-notes-0.4.md)
for what is installable and what is still a known limitation.

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
publish `dsh-*`), an approval-protected environment, and an
explicit `npm publish` of the reviewed tarballs. The workflow never runs
`npm publish`.

## Community / Validation

- **Submission package (prepared, not sent):** [awesome-dsh-plugin PR](docs/community/awesome-pr.md)
  — exactly one entry (`dsh-allow`); [dsh-market readiness](docs/community/dsh-market.md)
  — waits for the awesome merge. [launch.md](docs/community/launch.md) is kept as
  historical notes.
- **0.4 release notes:** [中文 / English](docs/community/release-notes-0.4.md).
- **Validation:** [STATUS](docs/validation/STATUS.md) — **0/10 design partner
  calls, 0/3 active external installs, 0/1 Check POC** as of 2026-11-21; maintainer
  smoke is separate in [SMOKE.md](docs/validation/SMOKE.md). No invented data.
- **Official Discussions showcase:** **not posted** — a user-stopped action. The
  only active path is awesome → dsh-market.
- **Upstream RFCs (suggestions, not requirements):**
  [`ctx.actions`](docs/rfcs/ctx-actions.md),
  [`ctx.grant`](docs/rfcs/ctx-grant.md),
  [`ctx.triggers`](docs/rfcs/ctx-triggers.md).
- **Telemetry:** [docs/telemetry.md](docs/telemetry.md) — off by default; the
  default runtime ships no telemetry or network code.
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md),
  [issue templates](.github/ISSUE_TEMPLATE/) and the
  [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
- **Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are
  trademarks of their respective owners.

## License

MIT.
