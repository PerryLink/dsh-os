# Changelog

## 0.3.0

- Add the human oversight surface: an approval inbox and an activity feed
  alongside Act, Snip and Check (five tabs on the existing `os` page).
- Add `ctx.osShell.approvalList(status?)`, `approve(id, { by, scope? })`,
  `deny(id, { by, reason })` and `activity(limit?)`; projections live in
  `oversight.js` so the runtime entry stays inside the 450-line contract.
- Add owner-only routes when `ctx.webServer` exists:
  `GET /api/os-approvals`, `POST /api/os-approvals/:id/approve`,
  `POST /api/os-approvals/:id/deny` and `GET /api/os-activity`. List/decide
  return 503 `service_unavailable` without Allow; activity returns an empty
  feed because Allow and Act are both optional.
- Require a human `by` on every decision, reject `agent:`, `session:`, `tool:`,
  `plugin:` and `ui:` identities, reject self-approval when Allow can answer,
  require a deny reason, and forward optional scopes to Allow without widening
  them in the shell. No model-facing tool can approve or deny.
- Map approval cards to exactly `{ id, subject, capability, scope, reason,
  createdAt, expiresAt, risk }`; activity merges `allow.audit` with
  `act.audit` (or `act.list`) newest first.
- Add the approval/activity UI: requester, capability, scope, reason, expiry
  and risk on each card, explicit Approve/Deny buttons, empty/error states and
  no automatic approval.
- Tests: fake-webServer and fake-Allow coverage for list/approve/deny, missing
  Allow, invalid ids, missing `by`, machine identities and self-approval;
  activity merging; `node --check` plus tab/API markers for the client bundle.

## 0.2.0

- Add `ctx.osShell.snapshot()`: aggregate Act actions, Snip entries and the
  last Check report per optional peer service (`{ available: false }` when the
  peer is not installed).
- Add an owner-only Host JSON bridge (`bridge.js`) with four exact routes when
  `ctx.webServer` exists, and no-op activation when it does not:
  `GET /api/os-shell/snapshot`, `POST /api/os-shell/act/invoke`,
  `GET /api/os-shell/snip/search`, `GET /api/os-shell/check/last`.
- Route Act invocations with the fixed subject `ui:os-shell`; preserve
  `grant_required`, map missing services to 503 and bad input to 400.
- Include full Snip text in owner-only search results so the page can copy it;
  redacted entries only expose their `[redacted:*]` placeholder.
- Add the hand-written React client bundle `ui/client.js` (no JSX, no build,
  no React dependency): a root `main` page with Act / Snip / Check tabs plus a
  `sidebar.panellist` OS icon. React is provided by the DSH host.
- Declare `dsh.client.platform = "web"` and export `./client`; keep the
  existing `dsh.os.ui` descriptor list unchanged.
- Document that the shell is optional, that every dsh-os module works without
  it, and that the client bundle follows DSH's internal artifact contract.
- Tests: fake-webServer Host API coverage and a `node --check` plus slot
  registration contract for the client bundle.

## 0.1.0

- Add the optional Host seam `ctx.osShell`: `registerView`, `unregisterView`,
  `listViews`, `open`, `close`, plus the last-50 open `history`.
- Add a framework-free HTML `render()` with escaping.
- Add the lazy client entry `ui/index.js` exporting an empty `views` list.
- Register the plain-object tools `os_shell_views`, `os_shell_open` and
  `os_shell_close`.
- Validate ids (`^[a-z][a-z0-9_.-]+$`), title length, module names and mounts.
- Document that the shell is optional and does not implement eleven Apps.
