# Maintainers

This file is the source of truth for **module ownership, release rights and
the contributor ladder**. Access is granted only when the conditions below are
met and this file records it.

**Current state (2026-11-20): PerryLink is the only maintainer and the only
release manager for all 20 components. The bus factor is 1.**

**Co-maintainer target: one co-maintainer for each of three modules (3 modules
× 1 co-maintainer). Candidates: Act, Allow and Check.** A module counts as
staffed only when a non-PerryLink owner is listed in the table below *and* that
person has at least three merged PRs in that module. Until then the target is
open and the `backup` cell stays `open`.

## 1. Module owners

`owner` is accountable for design, reviews, tests and the module's contract.
`backup` is the second person who can triage security reports and approve
releases when the owner is unavailable. `release rights` is the maximum right
for that module; the person must also hold the matching rank in §2.

| Module | Owner | Backup | Release rights |
|---|---|---|---|
| Act — `dsh-act`, `ctx.act` | PerryLink | open | publish |
| Allow — `dsh-allow`, `ctx.allow` | PerryLink | open | publish |
| Snip — `dsh-snip`, `ctx.snip` | PerryLink | open | publish |
| Check — `@perrylink/dsh-check`, `ctx.check` | PerryLink | open | publish |
| Nest — `dsh-nest`, `ctx.nest` | PerryLink | open | publish |
| Trigger — `dsh-trigger`, `ctx.triggers` | PerryLink | open | publish |
| Seek — `dsh-seek`, `ctx.evidence` | PerryLink | open | publish |
| Trace — `@perrylink/dsh-trace`, `ctx.trace` | PerryLink | open | publish |
| Stage — `dsh-stage`, `ctx.stage` | PerryLink | open | publish |
| Ring — `dsh-ring`, `ctx.ring` | PerryLink | open | publish |
| Root — `@perrylink/dsh-root`, `ctx.env` | PerryLink | open | publish |
| Help (optional) — `dsh-help`, `ctx.help` | PerryLink | open | publish |
| Context (optional) — `@perrylink/dsh-context`, `ctx.context` | PerryLink | open | publish |
| Cost (optional) — `@perrylink/dsh-cost` | PerryLink | open | publish |
| Backup (optional) — `@perrylink/dsh-backup` | PerryLink | open | publish |
| Notify (optional) — `@perrylink/dsh-notify` | PerryLink | open | publish |
| Contract — `@perrylink/dsh-os-contract` | PerryLink | open | publish |
| CLI — `@perrylink/dsh-os-cli` | PerryLink | open | publish |
| Shell — `@perrylink/dsh-os-shell`, `ctx.osShell` | PerryLink | open | publish |
| Kit — `dsh-os-kit` | PerryLink | open | publish |

`publish` means the person is a release manager (§2.5) and may run `npm
publish` for that module after every gate passes. A module owner without
release-manager rank has `pack only` rights: they may run the gates, `npm pack`
and attach a review artifact, but cannot publish, deprecate or access the npm
token. `Cost`, `Backup` and `Notify` are the optional workstreams #18–#20 in
`docs/WORKSTREAMS.md`; if a package is renamed before its first release, this
table follows the name in that package's `package.json`.

## 2. Contributor ladder

A level is earned by evidence, not by time served. All counts refer to the
default branch and are verified by a maintainer before nomination. A
"substantive review" is a review that changed code, tests, docs or a decision —
not an "LGTM".

### 2.1 User

- **Conditions:** none. Anyone who installs a published package or files an
  issue is a user.
- **Permissions:** read the repository; open issues and discussions; comment
  on PRs.
- **Obligations:** follow `CODE_OF_CONDUCT.md`; report vulnerabilities
  privately; search existing issues before filing; put no secrets or personal
  data in a report.
- **GitHub access:** read.

### 2.2 Contributor

- **Conditions:** at least one PR merged into `main` (code, tests or docs),
  merged by a maintainer (a reviewer may recommend the merge).
- **Permissions:** everything a user can do, plus being assigned issues and
  opening PRs from a fork.
- **Obligations:** single-topic PRs; run all four gates; keep the manifest and
  `CHANGELOG.md` current; respond to review within 14 days or the PR may be
  closed; disclose conflicts of interest.
- **GitHub access:** read (no triage or write role).

### 2.3 Reviewer

- **Conditions:** at least 3 merged PRs, including one test change and one in
  the module they will review; at least 5 substantive reviews on other people's
  PRs; nominated by the module owner; approved by two maintainers; no open
  conduct or security case.
- **Permissions:** GitHub `triage`; label, assign and close stale issues;
  review PRs and request changes. A reviewer's approval is advisory — a
  maintainer must approve before merge. Reviewers cannot merge, push to
  protected branches or publish.
- **Obligations:** review within 5 business days; recuse from any PR they
  authored or have a commercial interest in; never self-approve; report
  security issues privately.
- **GitHub access:** `triage`.

### 2.4 Maintainer

- **Conditions:** at least 6 months since the first merged PR; at least 10
  merged PRs (at least 6 in the owned module, or across at least 2 modules); at
  least 20 substantive reviews; completed one release drill (all four gates,
  `npm pack` and a temp-`DSH_HOME` install) with a release manager; nominated
  by the module owner; approved by two thirds of maintainers and all current
  release managers; ownership scope recorded in §1.
- **Permissions:** GitHub `write`/`maintain`; merge PRs in owned modules;
  manage labels, milestones and module issues; bump versions and prepare the
  release PR; request a release from a release manager.
- **Obligations:** acknowledge security reports within 72 hours; review within
  5 business days; keep the module's four gates green; keep `CHANGELOG.md`,
  `README.md` and `dsh.os` current; never self-merge; never publish; update
  this file when ownership changes; disclose conflicts of interest.
- **GitHub access:** `write` or `maintain` on owned paths.

### 2.5 Release manager

- **Conditions:** maintainer for at least 3 months; ran at least 2 releases
  end-to-end with a release manager and zero gate bypasses; npm account with
  2FA enabled; able to access the protected `release` environment; approved by
  all current release managers; recorded here.
- **Permissions:** publish, deprecate and unpublish through
  `docs/release-policy.md`; manage npm tokens and the `release` environment;
  approve release PRs; grant or revoke `pack only` rights.
- **Obligations:** run all four gates on the tagged commit; publish the
  reviewed tarball with provenance; verify the registry artifact within 24
  hours; never publish an unreviewed commit; rotate the npm token every 90 days
  and after any exposure; acknowledge security reports within 72 hours; use the
  two-person rule for unpublish; never let an agent or CI publish.
- **GitHub access:** `maintain` plus the protected `release` environment.

### 2.6 Inactive and emeritus

- No review, PR, issue or release action for 180 days → moved to *emeritus*:
  write and publish rights are removed, credit is kept, and the table lists
  them as emeritus.
- Returning requires one merged PR and owner approval. Publish rights are not
  restored automatically; §2.5 applies again.
- A confirmed Code of Conduct or security violation can demote a person
  immediately, bypassing the normal ladder.

## 3. Release rights matrix

| Right | Who | May do | Must not do |
|---|---|---|---|
| `none` | users, contributors, agents, CI on pull requests | open PRs, comment, run tests locally | merge, tag, publish, read npm tokens |
| `pack only` | maintainers without release-manager rank | run all gates, `npm pack`, attach the artifact to a release issue | `npm publish`, `npm deprecate`, `npm unpublish`, read `NPM_TOKEN` |
| `publish` | release managers listed in §2.5 | publish, deprecate, unpublish (two-person rule), manage the `release` environment | bypass a gate, publish from a laptop after 0.2.0, publish an unreviewed commit |

Agents, subagents and CI never publish. `scripts/publish.mjs` is not a
substitute for the release policy; from 0.2.0 it must not be used for a public
release because it publishes from a directory instead of the reviewed tarball
and does not generate provenance.

## 4. Changing this file

- Any change is a PR to `MAINTAINERS.md` and needs two maintainer approvals.
- An owner change needs written acknowledgement from the outgoing and incoming
  owner, plus two maintainer approvals.
- A release-rights change needs two release-manager approvals.
- An emergency removal (compromised account, active harassment) can be made by
  any release manager; the change must be recorded here and announced to the
  other maintainers within 24 hours.

## 5. Security contact

Security reports go through the private channel in
[`docs/release-policy.md`](docs/release-policy.md#10-security-response-72-hours),
never a public issue. The backup security contact is the release manager not
handling the report; while §1 lists only PerryLink, PerryLink is the sole
contact and the 72-hour clock starts when the report is opened.
