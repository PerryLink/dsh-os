# dsh-os

A family of **OS-level primitives for DeepSeek Harness**. Six functional MVPs
(Act, Allow, Snip, Check, Nest, Root) and five name-reserved packages
(Trigger, Seek, Trace, Stage, Ring): actions, grants, clipboard, workspace
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
| **Trigger** | `dsh-trigger` | 0.0.1 placeholder | [design](docs/design/06-trigger.md) |
| **Seek** | `dsh-seek` | 0.0.1 placeholder | [design](docs/design/07-seek.md) |
| **Trace** | `@perrylink/dsh-trace` | 0.0.1 placeholder | [design](docs/design/08-trace.md) |
| **Stage** | `dsh-stage` | 0.0.1 placeholder | [design](docs/design/09-stage.md) |
| **Ring** | `dsh-ring` | 0.0.1 placeholder | [design](docs/design/10-ring.md) |
| **Root** | `@perrylink/dsh-root` | 0.1.0 MVP | [design](docs/design/11-root.md) |

`Check`, `Trace` and `Root` use the `@perrylink/` scope because npm's
name-similarity protection rejects the unscoped names.

## Install

```sh
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
```

## Repository layout

```
packages/    one npm package per primitive
docs/        design notes and the implementation contract
scripts/     scaffold, test and publish helpers
```

## Development

```sh
node scripts/scaffold.mjs
node scripts/test-all.mjs
node scripts/publish.mjs act allow   # requires NPM_TOKEN
```

## License

MIT.
