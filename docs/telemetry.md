# Telemetry policy

> **Status: policy only — no telemetry code ships today.**
>
> Every `dsh-os` package currently runs with **no telemetry and no network calls**.
> This document defines the rules any future opt-in telemetry must follow; it
> does not describe an implemented feature, an endpoint, or a data collection
> that is active now.
>
> This is not a legal document. It is the project's own commitment, so users can
> decide whether to opt in before any code exists.

## 1. Default: off

- Telemetry is **off by default** for every package and every install method
  (npm, GitHub source, release tarball, local checkout).
- There is no “anonymous usage” mode that is on unless disabled. No silent
  first-run ping, no install-time beacon, no update check that carries usage
  data.
- A package may not enable telemetry on behalf of another package.
- If a future release adds telemetry, upgrading must not flip an existing
  install from off to on. The user must opt in explicitly after the release
  notes say what changed.

## 2. Opt-in

> The commands below are the **intended interface**, not implemented yet. There is
> nothing to enable today because no telemetry code exists.

Any future telemetry requires **an explicit, persisted local consent record**.
There is no way to turn it on with an environment variable alone.

1. The consent record is created by an explicit command, for example
   `dsh-os telemetry enable`, which prints the exact fields in §3 and the
   retention in §5 before asking for confirmation.
2. A per-run switch can always **disable** telemetry: `DSH_OS_TELEMETRY=0`
   wins over the consent record. `DSH_OS_TELEMETRY=1` is accepted only when a
   consent record already exists; on its own it does nothing.

Suggested rules for the consent flow:

- The confirmation prompt defaults to **No**.
- The consent record stores the policy version, the date, and the exact scope
  (which packages, which event kinds). It never stores a secret.
- Changing the collected fields, the endpoint, or the retention period requires
  a new confirmation for the new policy version.
- A user who declines is not asked again on every run. Re-asking is limited to
  an explicit `dsh-os telemetry status` or a new policy version.
- Headless/CI installs are off unless a consent record was created explicitly
  (for example `dsh-os telemetry enable --non-interactive`, which still prints
  the fields and requires an explicit flag); no interactive prompt is attempted.

## 3. Fields that may be collected (only after opt-in)

The list is intentionally short and coarse. If a field is not in this table, it
must not be added without updating this document and re-confirming consent.

| Field | Example | Why |
|---|---|---|
| Event name | `command_run`, `tool_call`, `install_doctor` | Which feature is used |
| Package name + version | `dsh-allow@0.1.2` | Compatibility and regression triage |
| DSH version | `0.2.2-rc.4` | Version-matrix support |
| Node major version | `22` or `24` | Runtime support |
| OS family | `windows`, `macos`, `linux` | Platform-specific bugs |
| Install source | `npm`, `github`, `tarball`, `local` | Distribution health |
| Command / tool name | `dsh-os doctor`, `allow_check` | Feature usage; no arguments |
| Outcome | `ok`, `denied`, `error` | Reliability |
| Error code | `E_STATE`, `grant_required` | Failure classification; no message text |
| Duration bucket | `<10ms`, `<1s`, `1–10s`, `>10s` | Performance; not exact timing |
| Anonymous install id | random UUID | Count installs and support deletion requests; **not derived** from machine id, MAC, username, or hostname |
| Policy version | `telemetry-v1` | Consent audit |
| Timestamp | UTC date-time, minute precision | Ordering and retention |

Notes:

- The anonymous install id is generated locally with a CSPRNG and can be rotated
  or deleted at any time (`dsh-os telemetry reset-id`). It must not be stable
  across machines.
- Payloads are batched locally and sent only when telemetry is enabled. A failed
  send is dropped, not retried forever; no offline queue that survives disable.
- The client must not attach a user-supplied free-text field. If a future
  feature needs one, it needs a separate opt-in and a redaction review.

## 4. Fields that are never collected

The following must never leave the machine, even with telemetry enabled:

- File paths, workspace names, repository names, project names.
- Prompt text, model messages, completions, tool arguments, tool results.
- Clipboard contents, selection contents, screenshots, window titles.
- Environment variable names or values, `.env` contents, credentials, tokens,
  API keys, cookies, private keys.
- Usernames, hostnames, IP addresses (the client does not send them; the
  receiving service must not persist them), MAC addresses, machine ids.
- Session ids, agent ids, grant ids, action ids, or any identifier that can be
  linked back to a specific user or workspace.
- Exact timings, exact file sizes, or free-form error messages that may contain
  paths or secrets.
- Any data from tests or CI runs; test suites must run with telemetry forced
  off and must not perform network requests.

The server-side pipeline must also avoid deriving these from what it receives
(for example, do not geolocate from IP and store the result).

## 5. Retention

If telemetry is ever implemented, these are the maximum retention periods:

| Data | Retention | Notes |
|---|---|---|
| Local spool (unsent events) | 7 days | Deleted on disable, on uninstall, or when the spool is full |
| Server raw events | 30 days | Then deleted or irreversibly aggregated |
| Aggregated counters | 13 months | No per-install id, no free text, no IP |
| Consent records | Until withdrawn | Local only by default; a server copy (if any) is deleted on withdrawal |
| Deletion request record | 30 days | Only the request id and completion time; no telemetry payload |

Retention is enforced by a scheduled job, not by manual cleanup. Aggregates are
built only from fields in §3 and must not allow reconstructing an individual
install.

## 6. Opting out

> These commands are also the intended interface, not implemented yet. Today there
> is nothing to disable; this section defines the contract for a future release.

A user can disable telemetry at any time:

```sh
dsh-os telemetry disable     # stop sending, delete the local spool, keep no consent
dsh-os telemetry status      # show whether it is on, which policy version, and the id
dsh-os telemetry reset-id    # rotate the anonymous install id
dsh-os telemetry delete      # request deletion of data associated with the current id
```

- `DSH_OS_TELEMETRY=0` disables telemetry for one process even if the consent
  record is enabled; it takes precedence over every config file.
- Disabling must be effective before the next send. There is no “already queued,
  too late” exception beyond the in-flight request.
- Uninstalling a package or deleting the profile directory removes the local
  consent record and spool; the project does not keep a shadow copy.
- A deletion request does not require an account. If the project cannot verify
  the id, it deletes what matches and says so; it must not ask for more personal
  data to complete the deletion.

## 7. Enforcement

These rules are part of the module contract (`docs/module-contract-v1.md`, rule
10: “No network, telemetry or secret collection unless declared and opt-in”).
For any future telemetry change:

- The package manifest must declare the capability (`net`) and the telemetry
  scope; a package without that declaration must not be able to send.
- CI must run the test suite with telemetry forced off and must fail on
  unexpected network calls in tests.
- The review checklist must include: fields match §3, no §4 data, retention is
  enforced, opt-out works offline, and no telemetry is enabled by default.
- A release note must state the policy version and the exact diff to this
  document.

## 8. Current audit (2026-11-20)

For the current `0.1.x` packages:

- `grep` for `fetch(`, telemetry, analytics, and http(s) endpoints in
  `packages/**/*.js` finds no runtime network call; the only matches are test
  fixtures and documentation URLs.
- No package reads or writes a telemetry config, and no package has an endpoint.
- The demo (`examples/os-kit/demo.mjs`) runs without network access and writes
  no files.
- Therefore the correct description today is: **no telemetry, no network,
  nothing to opt out of.** This document exists so that stays true if a future
  release proposes otherwise.
