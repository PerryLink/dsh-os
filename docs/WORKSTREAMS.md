# dsh-os execution board — 20 workstreams

> Contract: `docs/module-contract-v1.md`; schema: `docs/schemas/dsh-os-manifest.schema.json`
> Rule: subagents never publish; root integrates, tests, commits and publishes.

## P0 — foundations

| # | Workstream | Owner (wave) | Scope | Status |
|---|---|---|---|---|
| 1 | **Contract package** | `ws-contract` (1) | `packages/contract`, `@perrylink/dsh-os-contract`; types/schemas/errors/refs/audit; <100 lines runtime | running |
| 2 | **Manifests** | `ws-manifests` (2) | add `dsh.os` to all 11 packages + validator; no code changes | pending |
| 3 | **Conformance** | `ws-conformance` (1) | `scripts/conformance.mjs` + `test/conformance.test.js`; 10 checks | running |
| 4 | **Catalog + CLI** | `ws-catalog` (1) | `packages/cli`, `@perrylink/dsh-os-cli`, bin `dsh-os`: list/doctor/install | running |
| 5a | **Security: Allow** | `ws-sec-allow` (1) | audit persistence, admin tool isolation, load validation, tests | running |
| 5b | **Security: Snip + Root** | `ws-sec-snip-root` (1) | sourceApp secret scan, vars secret detection, proxy userinfo, path newline | running |
| 5c | **Security: Stage + Ring + Seek** | `ws-sec-srr` (1) | undo hash, expired escalation, provider timeout/signal | running |

## P1 — make it usable

| # | Workstream | Owner (wave) | Scope | Status |
|---|---|---|---|---|
| 6 | **UI shell** | `ws-shell` (1) | `packages/shell`, view registry + optional client entry; no module UIs yet | running |
| 7 | **Cross-module integration** | `ws-integration` (2) | Act+Allow+Snip+Check, Trigger+Act+Ring, Seek+Trace, Nest+Root | pending |
| 8 | **Quickstart + recipes** | `ws-docs` (2) | 10-min quickstart + 3 recipes + troubleshooting | pending |
| 9 | **Demo assets** | `ws-demo` (2) | `examples/os-kit`, 90s Check script, SVG/PNG terminal card | pending |
| 10 | **Release automation** | `ws-release` (1) | pack/install smoke, version matrix, provenance, manual publish workflow | running |

## P2 — ecosystem

| # | Workstream | Owner (wave) | Scope | Status |
|---|---|---|---|---|
| 11 | **Kit** | `ws-kit` (2) | `dsh-os-kit`: dependency-only meta bundle, no code | pending |
| 12 | **Official/directory** | `ws-official` (2) | Discussions post, awesome-dsh-plugin PR draft, dsh-market listing; no DM | pending |
| 13 | **Upstream RFC** | `ws-rfc` (2) | `ctx.actions`, `ctx.grant`, `ctx.triggers` proposals | pending |
| 14 | **Feedback loop** | `ws-feedback` (2) | issue templates, opt-in telemetry, install survey | pending |
| 15 | **Co-maintainers** | `ws-maintainers` (3) | CONTRIBUTING/MAINTAINERS, release-rights ladder | pending |

## Optional small modules

| # | Module | Owner (wave) | Scope | Status |
|---|---|---|---|---|
| 16 | **Help** | `ws-help` (2) | install doctor/first-run wizard, ≤300 lines, `ctx.help` | pending |
| 17 | **Context** | `ws-context` (2) | active app/window/selection provider, `ctx.context` | pending |
| 18 | **Cost** | `ws-cost` (3) | adapter for `dsh-cost-meter`, no new meter | pending |
| 19 | **Backup** | `ws-backup` (3) | workspace snapshot/restore, `ctx.backup` | pending |
| 20 | **Notify** | `ws-notify` (3) | attention router, `ctx.notify`; Ring is a client | pending |

## Waves

- **Wave 1 (8):** contract, conformance, catalog, sec-allow, sec-snip-root, sec-srr, shell, release.
- **Wave 2 (8):** manifests, integration, docs, demo, kit, official/RFC/feedback, help, context.
- **Wave 3 (4):** cost, backup, notify, co-maintainers.

## Root duties

1. Review each diff; run `node scripts/test-all.mjs` + `scripts/conformance.mjs`.
2. Run `npm pack --dry-run` and temp `DSH_HOME` install for changed packages.
3. Publish patch/minor versions only after review; never publish from subagents.
4. Update `docs/module-contract-v1.md` if a seam changes; bump contract major.
