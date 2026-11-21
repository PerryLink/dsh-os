# Allow · `dsh-allow`

> Revocable capability grants and an audit-ready permission center for DeepSeek Harness.

**Status: 0.3.0.** Host seam `ctx.allow` + model tools for request/wait/list/check,
in-memory by default, optional atomic JSON state with `fsync`. Approvals are a
two-step protocol: a model can create a pending `Request`, but only a human
`approve`/`deny` decides it, and approval creates the `Grant` in the same write.

> **控制面不是沙箱；out-of-turn 授权由 Grant 承担。**
>
> **This is a control plane, not a sandbox. Out-of-turn authorization is carried
> by grants.** A grant records and answers "who approved what, for how long and
> under which scope". It cannot stop same-process code from bypassing the check,
> and it does not replace DSH's approval prompt, permission rules, presets or OS
> sandbox. When a human is not in an open turn, a grant is the authorization
> object to check before acting.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners. This is an independent community package. It is also
unrelated to other projects that happen to use the name `dsh-allow`: Allow issues
capability grants; it does not hand out shell file permissions.

## Install

```sh
dsh plugin --profile web add dsh-allow
```

No runtime dependencies, no build step, Node.js 22+.

## Host seam

```js
import { apply } from 'dsh-allow'

const service = apply(ctx, { stateFile: '/path/to/allow-state.json' })
// or consume the seam:
const allow = ctx.get('allow')
```

`apply` returns the service, calls `ctx.provide('allow', service)` and registers
the tools when `ctx.tools` is available. The service can be constructed without a
tools service.

### Service API

| Method | Result |
|---|---|
| `request({ subject, capability, scope = '*', ttlMs?, reason? })` | pending `Request`; rejects `approver`, ids, states and hashes with `E_PRIVILEGED` |
| `approve({ id, by, scope? })` | `{ request, grant }`; creates the Grant and binds it to `requestHash` in one save |
| `deny({ id, by, reason })` | `{ request }`; denial is terminal and idempotent |
| `requests({ status?, subject? })` | `Request[]` filtered by exact status/subject |
| `wait(id, { timeoutMs?, subject? })` | current `Request` after polling; 5s default, 25s cap |
| `issue({ subject, capability, scope = '*', ttlMs?, approver = 'user', evidence? })` | `Grant` (legacy admin path) |
| `check({ subject, capability, scope })` | `{ allowed, grant?, reason }` |
| `revoke(id, { subject }?)` | updated `Grant`; a supplied `subject` must match the owner; idempotent for revoked/expired grants |
| `list(filter?)` | `Grant[]`, filter by exact `subject`, `capability`, `status` or `approver` |
| `audit(limit = 100)` | newest-first audit events |
| `auditStats()` | `{ totals, retained, limits }` audit counters |

Grant shape (timestamps are Unix milliseconds):

```js
{
  id: 'grant_<uuid>',
  subject: 'agent:planner',
  capability: 'fs.write',
  scope: 'repo:*',
  status: 'active',          // active | revoked | expired
  createdAt: 1700000000000,
  expiresAt: 1700086400000,
  approver: 'user',
  requestId: 'req_<uuid>',   // set when the Grant came from an approved request
  requestHash: '<sha256>',   // the exact ask this Grant is bound to
  evidence: { approvalId: '...' }, // optional
  usedAt: 1700000001000,     // last successful check
}
```

Request shape (a pending ask, never an authorization):

```js
{
  id: 'req_<uuid>',
  subject: 'agent:planner',
  capability: 'fs.write',
  scope: 'repo:src',
  ttlMs: 600000,             // pending window: 10m default, 30m max
  reason: 'edit one file',   // untrusted self-report, never a decision input
  status: 'pending',         // pending | approved | denied | expired
  createdAt: 1700000000000,
  expiresAt: 1700000600000,
  requestHash: '<sha256 of subject/capability/scope/ttlMs/reason>',
  grantId: 'grant_<uuid>',   // approved only
  decidedBy: 'alice',        // approved/denied only
  denyReason: 'not now',     // denied only
}
```

`approve` only narrows: an approval scope must be covered by the requested
scope, so `repo:src` cannot become `repo:*`. It is idempotent — a second
approval returns the same Grant and does not add another audit row. Expired
requests can never be approved, and a request whose content no longer matches
`requestHash` is refused with `E_REQUEST_HASH`. Denial is terminal, so an
approved request cannot be denied afterwards. Approval creates the Grant and the
request transition in one atomic state-file write.

`check` returns `reason: 'allowed' | 'no-grant' | 'expired' | 'revoked' |
'scope-mismatch'`. A successful check updates `usedAt` and records an `allowed`
audit event. Every denial is recorded as `denied`, and elapsed grants/requests
are materialized as `expired` before `check`/`list`/`requests`/`wait`/`revoke`
answer. Checks answer from memory and do not rewrite the state file; only an
expiry transition inside `sweep()` persists.

### Audit retention

Audit events are `requested`, `request-approved`, `request-denied`,
`request-expired`, `issued`, `allowed`, `denied`, `revoked` and `expired`.
Security events (`issued`, request events, `revoked`, `expired`) outlive routine
checks:

- At most `MAX_CHECK_AUDIT_ENTRIES` (200) `allowed`/`denied` events are retained;
  a new check evicts the oldest check event.
- The whole log is capped at `MAX_AUDIT_ENTRIES` (2000). When it is full, the
  oldest `allowed`/`denied` events are evicted first; security events are only
  evicted once no check events are left.
- `audit(limit)` still returns the newest retained events, and `auditStats()`
  reports cumulative totals (counted even after eviction) beside what is
  retained, so a check flood cannot erase an `issued`/`revoked` trail.

### Scope matching

Grant scope may be a string or an array; a requested array must be fully covered.

| Grant scope | Requested | Match |
|---|---|---|
| `*` | anything | yes |
| `repo:*` | `repo:src/a.js` | yes (prefix) |
| `repo:*` | `repositories` | no |
| `repo:src` | `repo:src` | yes (exact) |
| `repo:src` | `repo:src/a.js` | no |
| `['one', 'two:*']` | `two:deep` | yes (any entry) |

### TTL and validation

- Grant TTL is 24 hours by default and 30 days maximum; request TTL is 10
  minutes by default and 30 minutes maximum (a request cannot be used to extend
  a Grant). Non-positive, non-finite or oversized values are rejected with
  `E_TTL`; wait timeouts outside `0..25000` are rejected/clamped with `E_WAIT`.
- `subject` and `capability` must be non-empty strings (256 characters max);
  `scope` entries are at most 512 characters; `approver` is at most 128;
  `reason` is at most 280 characters and has control characters replaced.
- Expiry uses the service clock (`Date.now()` by default); a backwards clock is
  treated as expiry. There is no implicit renewal and no "timeout auto-approve".
- Expected failures throw an `Error` with a stable `code` such as `E_SUBJECT`,
  `E_SUBJECT_MISMATCH`, `E_CAPABILITY`, `E_SCOPE`, `E_SCOPE_NARROW`, `E_TTL`,
  `E_PRIVILEGED`, `E_REQUEST_NOT_FOUND`, `E_REQUEST_HASH`,
  `E_REQUEST_APPROVED`, `E_REQUEST_DENIED`, `E_REQUEST_EXPIRED`,
  `E_GRANT_NOT_FOUND`, `E_STATE`.

## Agent tools

Plain object `ToolDefinition`s, no `@deepseek-ai/dsh-tools` import.

**Default surface: `allow_check`, `allow_request`, `allow_wait`,
`allow_requests`.** These can create a pending ask and inspect it, but they
cannot mint a Grant. Issuing, approving, denying, revoking or listing every
subject are human-facing operations, so they stay off unless a human-facing
client sets `exposeAdminTools: true` in the plugin config. Even then, the model
never gains a code path that approves itself: `allow_request` rejects
`approver`/`by`/`id`/state/hash fields with `E_PRIVILEGED`.

- `allow_check` — check a concrete subject/capability/scope (`scope` optional;
  omitted means "any active grant for this capability").
- `allow_request` — create a pending Request and return
  `{ requestId, status, expiresAt, reason, hint }`.
- `allow_wait` — poll one request for its current state (`requestId`,
  optional `timeoutMs` and owner `subject`; 5s default, 25s cap).
- `allow_requests` — list only the given subject's pending requests.
- `allow_issue` (opt-in) — issue a grant directly (legacy admin path).
- `allow_approve` / `allow_deny` (opt-in) — the human decision; approval creates
  the Grant bound to the request hash.
- `allow_revoke` (opt-in) — revoke a grant by `id`; `subject` is required and
  must match the grant owner, so one subject cannot revoke another's grant.
- `allow_list` (opt-in) — list grants for a required `subject` (optional exact
  `capability`, `status` and `approver` filters); there is no fleet-wide listing.

This package is a control plane, not a sandbox: it records and answers
out-of-turn authorization questions and cannot stop same-process code from
bypassing it. Do not expose the admin tools to untrusted agents.

## Persistence

In-memory by default. Set `config.stateFile` to a JSON path to persist grants,
requests, counters and the audit log across restarts. Writes go to a sibling
temporary file opened with mode `0600`, are `fsync`ed, and are promoted with
`rename` (atomic on the same filesystem); a failed write removes the temporary
file and surfaces `E_STATE`, while `issue`/`request`/`approve`/`deny` roll back
their in-memory change. A missing file starts empty; unreadable or malformed
state fails closed with `E_STATE` instead of silently authorizing from a damaged
ledger. Requests whose hash no longer matches, and approved requests whose Grant
is missing, are dropped on load. State version 2 adds `requests`; version 1
files (grants only) still load. When `stateFile` is set, `wait()` re-reads the
file on each poll, so a running host observes a decision written by
`dsh-os approvals`; subsequent `check` calls see the reloaded Grant. This is a
local MVP store, not a multi-process ledger: do not point two live writers at
the same file.

The `dsh-os approvals` CLI edits the same state file directly (no shell, no
network, no profile writes):

```sh
dsh-os approvals list --state /path/to/allow-state.json
dsh-os approvals approve req_... --by alice --state /path/to/allow-state.json
dsh-os approvals deny req_... --reason "not now" --state /path/to/allow-state.json
```

## Security model

- **Fail closed.** Unknown grants, wrong scope, expired/revoked grants and state
  errors never become `allowed`; expired requests never become `approved`.
- **No model approval.** The default tool surface has no `allow_approve`,
  `allow_deny` or `allow_issue`. The model can only create a pending request and
  read its own state; `approver` and other server-owned fields are rejected.
- **Approval is bound.** Approval checks `requestHash` first, rejects widened
  scope, and writes the request transition and Grant together.
- **No default allow.** A grant only allows; it cannot override a deny from DSH
  policy. Deny stays priority.
- **Revocation is forward-looking.** A revoked grant rejects the next check, but
  cannot stop work already in flight.
- **No secrets.** Only grant metadata and the caller-supplied evidence reference
  are stored; never store credential values in `evidence`.
- **No tamper-proof claim.** The audit log survives restarts when `stateFile` is
  set, but an administrator who can rewrite the file can rewrite history.

## Test

```sh
node --test
```

Covers request/approve/deny, hash mismatch, expiry, idempotent approval, scope
narrowing, privilege rejection, wait polling, persistence round-trips, plus the
existing grant lifecycle: issue/check, wildcard and array scopes, revocation,
audit retention under check floods, cross-subject tool refusal,
persistence-failure rollback and `stateFile` round-trips.

## License

MIT.
