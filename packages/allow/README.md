# Allow · `dsh-allow`

> Revocable capability grants and an audit-ready permission center for DeepSeek Harness.

**Status: 0.4.0.** Host seam `ctx.allow` + model tools for request/wait/list/check,
in-memory by default, optional atomic JSON state with `fsync`. Approvals are a
two-step protocol: a model can create a pending `Request`, but only a human
`approve`/`deny` decides it, and approval creates the `Grant` in the same write.
A Grant now carries a use budget: one use by default, consumed atomically before
the action runs, so approving once permits the action once.

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
| `request({ subject, capability, scope = '*', ttlMs?, maxUses? = 1, reason? })` | pending `Request`; `maxUses` is an integer in `1..100`; rejects `approver`, ids, states and hashes with `E_PRIVILEGED` |
| `approve({ id, by, scope?, maxUses? = 1 })` | `{ request, grant }`; creates the Grant and binds it to `requestHash` in one save; `maxUses` may not exceed the request |
| `deny({ id, by, reason })` | `{ request }`; denial is terminal and idempotent |
| `requests({ status?, subject? })` | `Request[]` filtered by exact status/subject |
| `wait(id, { timeoutMs?, subject? })` | current `Request` after polling; 5s default, 25s cap |
| `issue({ subject, capability, scope = '*', ttlMs?, maxUses?, approver = 'user', evidence? })` | `Grant` (legacy admin path); omitting `maxUses` keeps the legacy unlimited grant |
| `check({ subject, capability, scope })` | `{ allowed, grant?, reason, remainingUses }`; a success consumes one use |
| `revoke(id, { subject }?)` | updated `Grant`; a supplied `subject` must match the owner; idempotent for revoked/expired/used grants |
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
  status: 'active',          // active | used | revoked | expired
  createdAt: 1700000000000,
  expiresAt: 1700086400000,
  maxUses: 1,                // 1..100, or Infinity for a legacy unlimited grant
  uses: 0,                   // successful checks so far
  lastUsedAt: null,          // last successful check, or null
  approver: 'user',
  requestId: 'req_<uuid>',   // set when the Grant came from an approved request
  requestHash: '<sha256>',   // the exact ask this Grant is bound to
  evidence: { approvalId: '...' }, // optional
  usedAt: 1700000001000,     // 0.1 compatibility alias of lastUsedAt
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
  maxUses: 1,                // use budget the human may approve (1..100)
  reason: 'edit one file',   // untrusted self-report, never a decision input
  status: 'pending',         // pending | approved | denied | expired
  createdAt: 1700000000000,
  expiresAt: 1700000600000,
  requestHash: '<sha256 of subject/capability/scope/ttlMs/reason[/maxUses]>',
  grantId: 'grant_<uuid>',   // approved only
  decidedBy: 'alice',        // approved/denied only
  denyReason: 'not now',     // denied only
}
```

`approve` only narrows: an approval scope must be covered by the requested
scope, so `repo:src` cannot become `repo:*`, and its `maxUses` may not exceed the
requested budget (`E_MAX_USES`). The approval budget defaults to **1**, even
when the request asked for more. It is idempotent — a second approval returns
the same Grant and does not add another audit row, and it cannot revive a Grant
whose budget is already spent. Expired requests can never be approved, and a
request whose content no longer matches `requestHash` is refused with
`E_REQUEST_HASH`. Denial is terminal, so an approved request cannot be denied
afterwards. Approval creates the Grant and the request transition in one atomic
state-file write.

`check` consumes one use on success and returns
`remainingUses` (`null` for an unlimited legacy Grant, `0` once spent). The
matching Grant is mutated in the same synchronous turn, so interleaved checks
cannot overdraw it in a single host process. When the last use is taken the
Grant becomes `used`, an `exhausted` security event is recorded, and later
checks are denied with `reason: 'grant_exhausted'` and `remainingUses: 0`.
Finite consumption is persisted with the same atomic write; if that write fails
the in-memory counter is rolled back and `E_STATE` is thrown (fail closed).
Unlimited legacy Grants keep the 0.1 behavior of answering checks from memory
without rewriting the state file, so their `uses` counter is advisory between
saves.

`check` denial reasons are `'no-grant' | 'scope-mismatch' | 'expired' |
'revoked' | 'grant_exhausted'`; success is `'allowed'`. Every denial is recorded
as `denied`, and elapsed grants/requests are materialized as `expired` before
`check`/`list`/`requests`/`wait`/`revoke` answer. An expiry transition inside
`sweep()` still persists on its own.

### Audit retention

Audit events are `requested`, `request-approved`, `request-denied`,
`request-expired`, `issued`, `allowed`, `denied`, `revoked`, `expired` and
`exhausted`. Security events (`issued`, request events, `revoked`, `expired`,
`exhausted`) outlive routine checks:

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
- `maxUses` must be an integer in `1..100` for a request or an approval.
  Omitting it on `request`/`approve` means 1; omitting it on the legacy
  `allow_issue` path means `Infinity`. Approval may lower but never raise the
  requested budget (`E_MAX_USES`).
- Expiry uses the service clock (`Date.now()` by default); a backwards clock is
  treated as expiry. There is no implicit renewal and no "timeout auto-approve".
- Expected failures throw an `Error` with a stable `code` such as `E_SUBJECT`,
  `E_SUBJECT_MISMATCH`, `E_CAPABILITY`, `E_SCOPE`, `E_SCOPE_NARROW`, `E_TTL`,
  `E_MAX_USES`, `E_PRIVILEGED`, `E_REQUEST_NOT_FOUND`, `E_REQUEST_HASH`,
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
  omitted means "any active grant for this capability") and consume one use;
  the result carries `remainingUses`.
- `allow_request` — create a pending Request with an optional `maxUses` (default
  1, max 100) and return `{ requestId, status, expiresAt, maxUses, reason, hint }`.
- `allow_wait` — poll one request for its current state (`requestId`,
  optional `timeoutMs` and owner `subject`; 5s default, 25s cap).
- `allow_requests` — list only the given subject's pending requests.
- `allow_issue` (opt-in) — issue a grant directly (legacy admin path); an
  optional `maxUses` makes it one-shot, otherwise it stays unlimited.
- `allow_approve` / `allow_deny` (opt-in) — the human decision; approval creates
  the Grant bound to the request hash, defaults to one use, and cannot exceed
  the request's `maxUses`.
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
file and surfaces `E_STATE`, while `issue`/`request`/`approve`/`deny` and a
finite-use `check` roll back their in-memory change. A missing file starts
empty; unreadable or malformed state fails closed with `E_STATE` instead of
silently authorizing from a damaged ledger. Requests whose hash no longer
matches, and approved requests whose Grant is missing, are dropped on load.

The on-disk version stays **2** so the standalone `dsh-os approvals` CLI keeps
reading the file; the use budget is an additive optional field. A Grant written
by 0.3 (or by the CLI, which does not copy `maxUses`) loads with `uses: 0` and
`maxUses: Infinity` — the behavior it had when unlimited. `null` is the JSON
form of `Infinity`. When such a CLI-written Grant links to a request that has a
finite `maxUses`, it adopts that budget on load so a default one-use approval
stays one-use. Requests with `maxUses > 1` cannot be approved by the standalone
CLI (its hash covers only the 0.3 fields); approve them through
`allow_approve`/`allow.approve` instead.

When `stateFile` is set, `wait()` re-reads the file on each poll, so a running
host observes a decision written by `dsh-os approvals`; subsequent `check` calls
see the reloaded Grant. This is a local MVP store, not a multi-process ledger:
the synchronous check is atomic only within one host process, so do not point
two live writers at the same file.

The `dsh-os approvals` CLI edits the same state file directly (no shell, no
network, no profile writes):

```sh
dsh-os approvals list --state /path/to/allow-state.json
dsh-os approvals approve req_... --by alice --state /path/to/allow-state.json
dsh-os approvals deny req_... --reason "not now" --state /path/to/allow-state.json
```

## Security model

- **Fail closed.** Unknown grants, wrong scope, expired/revoked/used grants and
  state errors never become `allowed`; expired requests never become `approved`.
  A failed consumption write is rolled back and fails the check.
- **No model approval.** The default tool surface has no `allow_approve`,
  `allow_deny` or `allow_issue`. The model can only create a pending request and
  read its own state; `approver` and other server-owned fields are rejected, and
  `approve` derives the subject from the request rather than accepting one.
- **Approval is bound and spent atomically.** Approval checks `requestHash`
  first, rejects widened scope and a raised `maxUses`, and writes the request
  transition and Grant together. The default budget is one use, so the approval
  that authorized an action cannot authorize a replay of the same call.
- **No default allow.** A grant only allows; it cannot override a deny from DSH
  policy. Deny stays priority.
- **Revocation is forward-looking.** A revoked grant rejects the next check, but
  cannot stop work already in flight; a `used` Grant is terminal and cannot be
  revived by re-approving its request.
- **No secrets.** Only grant metadata and the caller-supplied evidence reference
  are stored; never store credential values in `evidence`.
- **No tamper-proof claim.** The audit log survives restarts when `stateFile` is
  set, but an administrator who can rewrite the file can rewrite history.

## Test

```sh
node --test
```

Covers 34 cases: request/approve/deny, hash mismatch, expiry, idempotent
approval, scope narrowing, privilege rejection, wait polling, persistence
round-trips, plus the 0.4 use budget: approval defaults to one use, a second
`act_invoke`/replay is denied with `grant_exhausted`, `remainingUses` decreases,
legacy unlimited grants keep working, counters survive restarts, concurrent
checks cannot overdraw a one-use Grant, and the real Act gate writes exactly
once. The older grant lifecycle is covered too: issue/check, wildcard and array
scopes, revocation, audit retention under check floods, cross-subject tool
refusal, persistence-failure rollback and `stateFile` round-trips.

## License

MIT.
