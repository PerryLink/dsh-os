# dsh-os release policy

This policy applies to every package under `packages/*` and to anyone with
release rights in [`MAINTAINERS.md`](../MAINTAINERS.md). It is normative: a
release that does not follow it is not a dsh-os release, even if the tarball is
on npm.

## 1. Independent semver

- Every package has its own `version`, `CHANGELOG.md` and git tag. There is no
  lockstep release train and no shared "project version".
- A change to one package never forces a version bump in another package. The
  kit declares compatible ranges, not exact pins; it gets its own bump only
  when those ranges change.
- The version in `package.json`, the git tag and the published tarball must
  match. A package that has a `CHANGELOG.md` must also have its top entry for
  that version.
- Tag format: `<directory>-v<version>`, for example `act-v0.1.2` or
  `check-v0.1.1`. Tags are annotated and point at the exact commit that passed
  the gates. After a publish a tag is immutable: never move or delete it.
- Pre-releases use `X.Y.Z-rc.N` and are published with `--tag next`, never as
  `latest`. Promotion is an explicit `npm dist-tag add <pkg>@<version> latest`
  after all four gates and the post-publish checks pass.

## 2. The 0.x rules

- `0.0.x` is name reservation and scaffolding only. No support promise.
- `0.1.0` is the first functional MVP.
- Before `1.0.0`, a **minor** bump may contain a breaking change, but only when
  the PR and `CHANGELOG.md` contain a `### Breaking` section with a migration
  recipe. "It broke" without a migration note is a release blocker.
- A **patch** release in 0.x must not break documented behavior. If a user has
  to change code, config or stored state, it is at least a minor.
- `1.0.0` requires all of the following, from
  [`module-contract-v1.md`](module-contract-v1.md) §9: the package passes
  conformance, has at least 10 external installs, and has had no P0/P1 issue
  for 30 consecutive days.
- After `1.0.0`, normal semver applies: breaking changes only in a major.

## 3. Patch, minor or major

| Bump | Use for | Never use for |
|---|---|---|
| **patch** | bug fix that restores documented behavior; crash, data-corruption or denial fix with no new configuration; docs/typos; tests; internal refactor with no exported shape or behavior change; performance work with identical results | a new tool, view, capability, manifest field or optional dependency; a behavior change users must adapt to; a changed error code, service name, required parameter, storage format or supported Node/DSH range |
| **minor** (0.x) | new tool, view, capability, optional manifest field or optional `requires`; additive storage field with a migration; deprecating (not removing) a tool or service; behavior change, including a breaking change documented under `### Breaking`; widening a supported Node/DSH range | a change that fits a patch (bug fix, docs, internal refactor); an incompatible storage change without a migration |
| **minor** (1.0+) | backwards-compatible addition only: new tool/view/capability/optional field, deprecation, widening a supported range | any change that requires a user code, config or state change |
| **major** (1.0+) | rename or remove a service or tool; new required parameter; change an error code's meaning; incompatible storage change without migration; remove a capability; narrow or drop a Node/DSH range; break the manifest schema; break the contract | additive changes that can ship in a minor |
| **major** before 1.0 | only `1.0.0` itself | using `2.0.0` for an ordinary 0.x breaking change — use a minor |

In 0.x, removing or renaming a service, tool or required parameter is a minor
with a `### Breaking` section. After 1.0 it is a major.

Rules of thumb:

- If a user must edit code, configuration or stored data, it is at least a
  minor in 0.x and a major after 1.0.
- A security fix follows the same rules. Never hide a breaking change in a
  patch because it is "security".
- If two people disagree about the bump, take the higher one and note the
  decision in the release issue.
- Batching is allowed only when every package has its own version, changelog,
  tag and gate run. "Publish every package because one changed" is forbidden.

## 4. `engines.dsh` and Node

- Every mountable bundle (`dsh.bundle.patch`) must declare a bounded
  `engines.dsh`. A library that declares it must also bound it.
- The upper bound is the next DSH minor: on the 0.2 line the range is
  `>=0.2.1-rc.2 <0.3.0-0`. Never publish `*`, `>=0.2.1`, `latest` or an empty
  range; `check-versions` rejects a range without an upper bound.
- Bump `engines.dsh` when DSH changes minor. Record the test matrix in the
  release issue: current DSH and the previous supported minor, on Node 22 and
  Node 24.
- When DSH 0.3 ships, every bundle either bumps and passes the matrix, or is
  marked `stability: "frozen"` / `"archived"` before the 0.3 window. Never
  publish a package whose `engines.dsh` still claims the old line.
- Node support is `^22.19.0 || >=24.9.0`. Dropping a Node line is a major
  change after 1.0; adding one is a minor.

## 5. The four gates (no release without all four)

Run on the exact commit that will be tagged, on a clean checkout:

| # | Gate | Command | Pass condition |
|---|---|---|---|
| 1 | Tests | `node scripts/test-all.mjs` | exit 0; every package suite plus the root `test/` suite |
| 2 | Conformance | `node scripts/conformance.mjs` | exit 0; every applicable contract check passes; after all packages declare `dsh.os`, run with `--strict` |
| 3 | Pack smoke | `node scripts/pack-smoke.mjs` | exit 0; every tarball has the required files and no package fails `npm pack` |
| 4 | Version invariants | `node scripts/check-versions.mjs` | exit 0; semver, bounded `engines.dsh`, npmjs registry, empty `dependencies`, unique names |

`npm run verify` runs all four. CI (`.github/workflows/ci.yml`) runs the same
four on Node 22 and 24; `.github/workflows/release.yml` runs them on Node 24
before it packs the selected packages.

- No gate is waived by a release manager, a deadline or a security fix. A
  flaky test blocks the release until it is fixed or quarantined in its own
  PR with an issue link.
- A gate failure on `main` blocks every release, not just the package whose
  check failed.
- The release manager re-runs the commands; a screenshot or a previous green
  run on a different commit is not evidence.
- The packed tarball is inspected before publishing: expected files only, no
  `.npmrc`, no `*.tgz`, no secrets, no test fixtures with real data.

## 6. Release procedure

1. **Open a release issue** with: package(s), current version, target version
   and bump type, reason, breaking-change/migration link, gate owner, publish
   owner, and planned tag.
2. **Open a release PR per package** that bumps `version`, moves the
   `## Unreleased` changelog entries under `## <version>` (the existing
   changelog style), and updates `engines.dsh` / `engines.node` if needed. The
   release PR contains no feature code.
3. **Verify the clean commit:** `git status --porcelain` is empty, `npm run
   verify` exits 0, and CI is green on Node 22 and 24.
4. **Pack the reviewed source:** `npm pack ./packages/<dir> --pack-destination
   artifacts`. Record the tarball name and `sha256` in the release issue.
5. **Install smoke:** in a fresh temporary `DSH_HOME`, install the tarball
   (`dsh plugin --profile web add ./artifacts/<tarball>.tgz`) and run the
   package README's smoke command. A failed load is a failed release.
6. **Tag:** `git tag -a <dir>-v<version> -m "<pkg> <version>"`, push the tag,
   and confirm the tag resolves to the gated commit (`git rev-parse
   <tag>^{commit}`).
7. **Publish** the reviewed tarball with provenance (§7), or under the 0.1.x
   exception if it applies.
8. **Verify the registry artifact** within 24 hours (§8).
9. **Create the GitHub release** from the changelog, link the tag, the
   tarball hash and the provenance URL, then close the release issue.
10. **Announce only after step 8 passes.** A broken release is fixed forward
    with a patch; it is not silently replaced.

## 7. npm provenance

From **0.2.0** onward, every publish must be provenance-attested:

- Publish from GitHub Actions, not a laptop, with a job that has
  `permissions: { contents: read, id-token: write }` and an approval-protected
  `release` environment.
- Run `npm publish <reviewed-tarball>.tgz --provenance --access public`.
- The repository must be public and each package's `repository` field must
  point at `github.com/PerryLink/dsh-os` with the correct `directory`; otherwise
  npm cannot attest the source.
- The attestation must name the release tag's commit. If the provenance URL
  does not resolve to that commit, the release is void: deprecate it and
  republish a new patch version.
- `NPM_TOKEN` is a granular token allowed to publish only `dsh-*` and
  `@perrylink/*`, stored only in the protected `release` environment, with 2FA
  on the account. Rotate it every 90 days and immediately after any exposure.
- Local `npm publish` is forbidden from 0.2.0. In particular,
  `scripts/publish.mjs` publishes from a directory and cannot produce
  provenance; it must not be used for a public release after 0.2.0.

**0.1.x exception:** while the provenance publish job does not exist, a 0.1.x
release may be published manually only if (a) two maintainers approve the exact
tarball hash in the release issue, (b) the account has 2FA, (c) the tarball is
the one that passed §5, and (d) `npm audit signatures` is run and recorded
afterwards. The exception is written in the release issue and expires at
0.2.0. With only one maintainer this exception cannot be used; the correct path
is to add the provenance publish job before releasing.

## 8. Post-publish tarball verification (within 24 hours)

Verify the artifact users actually download, not the local file:

```sh
npm view <pkg>@<version> version dist.integrity dist.tarball dist.attestations
npm pack <pkg>@<version> --pack-destination /tmp/dsh-verify
# compare the downloaded tarball's sha512 with dist.integrity:
node -e "const c=require('crypto'),f=require('fs');console.log('sha512-'+c.createHash('sha512').update(f.readFileSync(process.argv[1])).digest('base64'))" /tmp/dsh-verify/<tarball>.tgz
tar -tzf /tmp/dsh-verify/<tarball>.tgz
```

Checks, all recorded in the release issue:

- `dist.integrity` equals the computed `sha512-...` of the downloaded tarball
  and the `sha256` recorded in step 4 maps to the same artifact.
- The file list contains the required files for the package kind and no
  `.npmrc`, `*.tgz`, secret, session log or unexpected test fixture.
- A temp-`DSH_HOME` install of the registry version loads the plugin and passes
  the README smoke.
- `npm install <pkg>@<version> --ignore-scripts` in a temp directory followed
  by `npm audit signatures` exits 0, and the attestation names this repository
  and tag commit.

If any check fails: stop, deprecate the version (§9), open a security advisory
if integrity is in doubt, and publish a fixed patch. Do not overwrite or
re-tag the release.

## 9. Yank and deprecate

**Deprecate is the default.** It keeps installs working and tells users what to
do:

```sh
npm deprecate "<pkg>@<version>" "<reason>; upgrade to <pkg>@<fixed-version>"
```

Record the deprecation in `CHANGELOG.md` and the GitHub release, and publish a
fixed patch as soon as possible.

**Unpublish (yank) is the exception.** It is allowed only when all of these are
true:

- the version was published less than 72 hours ago;
- no published package is known to depend on it (check the dependent list and
  search the registry before acting);
- two release managers approve the exact version in the release issue;
- the account has 2FA and the command is scoped to one version:
  `npm unpublish "<pkg>@<version>"`.

After 72 hours, do not unpublish. Deprecate, publish a patch, and contact npm
support only for malware or a confirmed compromise. Never unpublish the latest
version without immediately publishing a replacement, and never reuse a
version number — the next release is a new patch.

A yanked release keeps its git tag. Edit the GitHub release to say `YANKED` and
link the replacement; do not delete history.

If a token or package is compromised: deprecate every affected version,
revoke/rotate the token, open a private security advisory, and follow §10.

## 10. Security response (72 hours)

- **Channel:** GitHub → Security → Advisories → *Report a vulnerability* on
  `PerryLink/dsh-os`. Do not open a public issue, PR or discussion with exploit
  details. If the private form is unavailable, contact a release manager
  privately and say only that you have a security report.
- **Acknowledge within 72 hours** of the report (calendar hours, including
  weekends). If the reporter has no acknowledgement in 72 hours, they may
  escalate to the backup contact in `MAINTAINERS.md`; the 72-hour clock still
  applies to the project.
- **Triage within 7 days:** confirm scope, affected versions, severity (P0/P1)
  and a fix owner. Keep the reporter informed until disclosure.
- **Fix targets:** P0 (remote code execution, secret exfiltration, auth bypass,
  supply-chain integrity) within 7 days; P1 within 30 days. A fix release uses
  the same four gates and the same provenance rules; speed never waives a gate.
- **Supported versions:** the latest minor of each package. Older minors get an
  upgrade path, not a backport, unless the issue is P0 and a backport is
  explicitly approved by two release managers.
- **Disclosure:** publish a GitHub security advisory with affected and fixed
  versions after the fix is on npm, credit the reporter unless they ask
  otherwise, and request a CVE when the impact warrants it. Do not disclose
  before users can upgrade.
- Security reports and their details are never pasted into public issues,
  commit messages, changelogs or release notes before the advisory.

## 11. Records

Every release issue keeps, at minimum: gated commit SHA, tag, gate outputs,
tarball `sha256`, provenance URL, publisher, publish time, post-publish
verification output and any exception. The release is auditable from those
links alone. Missing records mean the release is treated as unverified and the
next patch must re-run the full procedure.
