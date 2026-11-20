# dsh-os

A family of **OS-level primitives for DeepSeek Harness**. Eleven 0.1.0 MVPs
(protocol/service implementations; native adapters land in 0.2.0): actions, grants, clipboard, workspace
profiles, environment profiles, regression canaries, triggers, evidence
search, memory governance, window topology and approval escalation.

> **Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are
> trademarks of their respective owners. These are independent community
> packages, published under MIT.

## Packages

| Product | Package | Status | Design |
|---|---|---|---|
| **Act** | `dsh-act` | 0.1.0 MVP | [design](docs/design/01-act.md) |
| **Allow** | `dsh-allow` | 0.1.0 MVP | [design](docs/design/02-allow.md) |
| **Snip** | `dsh-snip` | 0.1.0 MVP | [design](docs/design/03-snip.md) |
| **Check** | `@perrylink/dsh-check` | 0.1.0 MVP (diff engine; runner in 0.2.0) | [design](docs/design/04-check.md) |
| **Nest** | `dsh-nest` | 0.1.0 MVP | [design](docs/design/05-nest.md) |
| **Trigger** | `dsh-trigger` | 0.1.0 protocol MVP | [design](docs/design/06-trigger.md) |
| **Seek** | `dsh-seek` | 0.1.0 protocol MVP | [design](docs/design/07-seek.md) |
| **Trace** | `@perrylink/dsh-trace` | 0.1.0 protocol MVP | [design](docs/design/08-trace.md) |
| **Stage** | `dsh-stage` | 0.1.0 protocol MVP | [design](docs/design/09-stage.md) |
| **Ring** | `dsh-ring` | 0.1.0 protocol MVP | [design](docs/design/10-ring.md) |
| **Root** | `@perrylink/dsh-root` | 0.1.0 MVP | [design](docs/design/11-root.md) |

`Check`, `Trace` and `Root` use the `@perrylink/` scope because npm's
name-similarity protection rejects the unscoped names.

## Install

```sh
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
dsh plugin --profile web add 'https://registry.npmjs.org/@perrylink%2Fdsh-trace/-/dsh-trace-0.1.0.tgz'
```

> `@perrylink/dsh-trace` is scoped because npm rejects the unscoped `dsh-trace`
> as too similar to `dd-trace`. If pnpm cannot resolve its tarball from your
> configured mirror, use the encoded tarball URL above.


## Repository layout

```
packages/    one npm package per primitive
docs/        design notes and the implementation contract
scripts/     scaffold, test and publish helpers
```

## Status

All eleven packages ship a 0.1.0 MVP: services, agent tools, tests and a
bundle manifest. Native/OS adapters (AX/Win32, real clipboard capture, DSH
headless runner, fs/webhook/agent trigger sources, locator/library/memento
providers) are scheduled for 0.2.0. `node scripts/test-all.mjs` runs 102 tests
across 12 suites.

## Development

```sh
node scripts/scaffold.mjs
node scripts/test-all.mjs
node scripts/publish.mjs act allow   # requires NPM_TOKEN
```

## License

MIT.
