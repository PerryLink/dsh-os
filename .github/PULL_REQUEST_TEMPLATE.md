<!--
  Keep this template. Fill in every section that applies; write "n/a" where it does not.
  One pull request should do one thing. If you are fixing two unrelated problems,
  open two pull requests.
-->

## Summary

<!-- What changed, and why? Two or three sentences. -->

## Related issue

<!-- "Closes #123" or "Refs #123". If there is no issue, say why this is small enough. -->

## Type of change

- [ ] Bug fix
- [ ] New capability or tool
- [ ] Contract / manifest / conformance change
- [ ] Documentation, demo or example
- [ ] Security hardening
- [ ] Release / packaging

## Affected packages

<!-- e.g. dsh-allow, dsh-act, docs/..., .github/... -->

## Verification

**Environment**

- DSH version: <!-- `dsh --version`, e.g. 0.2.2-rc.4 -->
- Node.js version: <!-- `node --version` -->
- Install method used: <!-- npm `dsh plugin add`, GitHub source, release tarball, local checkout -->
- OS: <!-- Windows 11 / WSL2 / macOS / Linux -->

**Commands run**

- [ ] `node scripts/test-all.mjs`
- [ ] `node scripts/conformance.mjs`
- [ ] `node scripts/pack-smoke.mjs`
- [ ] `node scripts/check-versions.mjs`
- [ ] `npm pack --dry-run` on changed packages (if packaging changed)
- [ ] Clean-profile install of changed packages (if install behaviour changed)

**Logs / output**

<!--
  Paste the smallest relevant output. Reproduce failures with a temporary DSH_HOME,
  not your real profile. Redact tokens, cookies, usernames and private paths.
-->

```text

```

**Reproduction (for bug fixes)**

<!--
  The exact steps that failed before this change and pass after it.
  1. ...
  2. ...
  3. ...
-->

## Compatibility and data

- [ ] No new runtime dependency, or the reason is explained above.
- [ ] No network access and no telemetry by default. If telemetry is involved, it is opt-in and `docs/telemetry.md` is updated.
- [ ] No secret is logged, returned or written in plaintext.
- [ ] `docs/module-contract-v1.md` is updated if a seam, service name, tool name or error code changed.
- [ ] `engines.dsh` remains a bounded range; the version matrix still applies.
- [ ] Removing the changed package does not break another package's tests (unless a declared optional dependency says otherwise).

## Not affiliated with DeepSeek — required disclosure

This project is an independent community project. **It is not affiliated with,
endorsed by, or sponsored by DeepSeek.** DeepSeek and DeepSeek Harness are
trademarks of their respective owners.

- [ ] I have read the disclosure above and this contribution does not claim
      official status, partnership, certification or endorsement.
- [ ] I am not acting on behalf of DeepSeek, and this is not an official
      DeepSeek submission.
- [ ] Any use of "DeepSeek", "DeepSeek Harness" or "DSH" in this change is
      nominative — it describes compatibility, not origin or approval.
- [ ] I did not add a DeepSeek logo, wordmark, official screenshot or brand
      asset, and I did not register a name, domain or account that implies
      affiliation.
- [ ] If this change touches user-facing text (README, package description,
      docs, UI, demo), it keeps a clear "Not affiliated with DeepSeek." notice.

## Checklist

- [ ] The change is focused; it does not bundle unrelated edits.
- [ ] Tests cover the happy path and at least one failure/denial path.
- [ ] Documentation is updated for user-visible behaviour.
- [ ] I did not edit another contributor's entry, generated file or release artefact by hand.
- [ ] I understand that releases are published manually by a maintainer; merging this PR does not publish a package.
