# Contributing to dsh-os

dsh-os is a family of independent DeepSeek Harness bundles. Each package is
plain ESM JavaScript with **zero runtime dependencies**, no build step and its
own semver. The public contract is [`docs/module-contract-v1.md`](docs/module-contract-v1.md);
the execution board is [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md).

> **Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are
> trademarks of their respective owners. These are independent community
> packages, published under MIT.

## 1. Set up (there is no install step)

Requirements:

- Node `^22.19.0 || >=24.9.0` (`node --version`). CI runs Node 22 and 24.
- npm 10+ (bundled with Node); used only by `pack-smoke` and publishing.
- git.

```sh
git clone https://github.com/PerryLink/dsh-os.git
cd dsh-os
node --version            # 22.19+ or 24.9+
npm run verify            # all four gates, no install needed
```

**Do not add a dependency.** Every package must keep `dependencies` empty
(`packages/kit` is the only exception, because it is a dependency-only meta
bundle declared with `"dsh": { "kit": true }`). `check-versions` fails any
other package with a non-empty `dependencies`, and CI has no lockfile.

Do not commit `node_modules/`, `package-lock.json`, `.npmrc`, or `*.tgz`.
`NPM_TOKEN` is only for publishing; tests and all four gates never read it.
Never write a token into a file, test fixture, log, issue or PR.

Repository layout:

```
packages/<name>/   one npm package: index.js, cordis.patch.yml, README.md, test/
examples/          dependency-free demos (no install, no network)
docs/              contract, design notes, release policy
scripts/           test, conformance, pack-smoke, version and publish helpers
test/              cross-package integration tests
```

## 2. Run the tests

Per package (the same command CI uses):

```sh
cd packages/act
node --test
```

All packages plus the root integration suite:

```sh
node scripts/test-all.mjs     # or: npm test
```

`test-all.mjs` runs `node --test` in every `packages/*` directory that has a
`test/` directory, then in the repository root for `test/`.

Test rules:

- Use `node:test` and `node:assert/strict`; no external test runner.
- Tests must be offline, deterministic and isolated. Use `fs.mkdtemp()` under
  `os.tmpdir()`; never point `DSH_HOME` at a real profile.
- Never use real clipboard contents, credentials, session logs or personal
  paths. Use obviously fake values (`test-token-not-real`).
- Cover the happy path, a denied path and one edge case (expiry, scope,
  malformed state or secret handling).
- A bug fix needs a regression test that fails before the fix.

## 3. Run the four gates

Every change must pass these on the commit that would be merged:

| Gate | Command | Passes when |
|---|---|---|
| Tests | `node scripts/test-all.mjs` | exit 0; every package suite and the root suite are green |
| Conformance | `node scripts/conformance.mjs` | exit 0; manifests, service names, tool prefixes, capabilities, 450-line limit, zero deps and required files are valid |
| Pack smoke | `node scripts/pack-smoke.mjs` | exit 0; each `npm pack --dry-run` tarball contains `package.json`, `README.md`, `LICENSE`, plus `index.js` (or a bin entry); bundles also contain `cordis.patch.yml` |
| Version invariants | `node scripts/check-versions.mjs` | exit 0; valid semver, bounded `engines.dsh`, npmjs `publishConfig.registry`, empty `dependencies`, unique names |

`npm run verify` runs all four in that order. The standard is "one command,
zero failures", not "the failing gate is unrelated".

- Run the gates locally before opening a PR; paste the Node version and the
  final line of each gate into the PR body.
- CI (`.github/workflows/ci.yml`) runs the same four gates on Node 22 and 24.
  A change that only passes on one version is not ready.
- Do not skip, comment out or weaken a gate to land a change. If a test is
  flaky, fix it or quarantine it in a dedicated PR with an issue link.
- `conformance.mjs --strict` turns the current Wave-1 legacy warnings into
  errors. Packages that declare `dsh.os` must already pass every applicable
  check.

## 4. Pull request requirements

A PR is ready for review only when every box is true:

- [ ] **Single topic.** One bug, one feature or one docs change. No drive-by
      reformatting, no mixed version bumps, no unrelated README edits. Split a
      multi-topic branch into separate PRs.
- [ ] **Tests.** New or changed behavior has a test; the four gates pass
      locally; the PR body records the commands and Node version.
- [ ] **Manifest.** If the change touches `service`, `provides`, `requires`,
      `capabilities`, `tools`, `ui`, `stability`, `since`, `replaces` or the
      bundle patch, update `package.json` → `dsh.os` in the same commit. The
      service name must match the canonical table in the contract; the patch
      must exist and reference the package name; `engines.dsh` must keep an
      upper bound.
- [ ] **Contract.** A new seam, tool name, error code, capability or manifest
      field also updates `docs/module-contract-v1.md` and, when the vocabulary
      changes, `docs/schemas/dsh-os-manifest.schema.json` and
      `scripts/conformance.mjs`. Renaming a service or tool is a breaking
      change: blocked after 1.0 outside a major, and allowed in 0.x only with a
      documented migration.
- [ ] **Changelog.** Add the user-visible change under `## Unreleased` in the
      package's `CHANGELOG.md`. Do not bump the version; maintainers do that in
      the release PR.
- [ ] **Not affiliated.** Keep the `Not affiliated with DeepSeek` statement in
      the package README. In the PR body, state any employment, commercial
      interest or affiliation with DeepSeek or PerryLink. Do not use DeepSeek
      logos, imply endorsement, or call the package "official".
- [ ] **No secrets.** No tokens, keys, `.npmrc`, cookies, clipboard contents,
      session logs, customer data or personal absolute paths. Tests use fake
      values. If a secret was pushed, rotate it first, then say so in the PR;
      deleting the line is not enough.
- [ ] **Review.** At least one maintainer approval. Two approvals are required
      for `dsh.os` / bundle-patch changes, contract or schema changes, security
      fixes and anything touching release scripts. Authors never merge their
      own PR.

Commit messages follow the existing history: `type(scope): summary`
(`feat:`, `fix:`, `fix(security):`, `docs:`, `test:`), imperative mood, one
logical change per commit. A PR over roughly 400 changed lines (excluding
tests and docs) should explain why it cannot be split.

Useful PR body template:

```md
## What
## Why (issue link)
## Contract impact (manifest/service/tool/error code: none or exact change)
## Verification
- Node:
- `node scripts/test-all.mjs`:
- `node scripts/conformance.mjs`:
- `node scripts/pack-smoke.mjs`:
- `node scripts/check-versions.mjs`:
## Affiliation / conflict of interest
## Secrets check (no tokens, keys, clipboard or session data)
```

## 5. Issues

A bug report includes: package and version (`npm view <pkg> version`), DSH
version, OS, Node version, exact command, expected vs actual result, and a
minimal reproduction. Redact tokens, paths and personal data from logs.

For a vulnerability, **do not open a public issue**. Use the private channel in
[`docs/release-policy.md`](docs/release-policy.md#10-security-response-72-hours);
the project acknowledges reports within 72 hours. Conduct issues follow
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## 6. After merge

Maintainers decide the release version (see
[`docs/release-policy.md`](docs/release-policy.md)). Contributors do not bump
versions or publish; release rights and the contributor ladder are defined in
[`MAINTAINERS.md`](MAINTAINERS.md).
