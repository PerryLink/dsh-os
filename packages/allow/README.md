# Allow · `dsh-allow`

> Revocable capability grants and an audit-ready permission center for DeepSeek Harness.

**Status: 0.1.1 MVP.** Host seam `ctx.allow` + a read-only agent tool, in-memory by
default, optional atomic JSON state.

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
| `issue({ subject, capability, scope = '*', ttlMs?, approver = 'user', evidence? })` | `Grant` |
| `check({ subject, capability, scope })` | `{ allowed, grant?, reason }` |
| `revoke(id)` | updated `Grant` (idempotent for revoked/expired grants) |
| `list(filter?)` | `Grant[]`, filter by exact `subject`, `capability`, `status` or `approver` |
| `audit(limit = 100)` | newest-first audit events |

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
  evidence: { approvalId: '...' }, // optional
  usedAt: 1700000001000,     // last successful check
}
```

`check` returns `reason: 'allowed' | 'no-grant' | 'expired' | 'revoked' |
'scope-mismatch'`. A successful check updates `usedAt` and writes an `allowed`
audit event. Every denial is audited as `denied`, and elapsed grants are
materialized as `expired` before `check`/`list`/`revoke` answer. Audit events are
`issued`, `allowed`, `denied`, `revoked` and `expired`; the newest 2000 are kept
(newest first from `audit()`).

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

- Default TTL is 24 hours; maximum is 30 days. Non-positive, non-finite or
  oversized `ttlMs` is rejected with `E_TTL`.
- `subject` and `capability` must be non-empty strings (256 characters max);
  `scope` entries are at most 512 characters; `approver` is at most 128.
- Expiry uses the service clock (`Date.now()` by default); a backwards clock is
  treated as expiry. There is no implicit renewal.
- Expected failures throw an `Error` with a stable `code` such as `E_SUBJECT`,
  `E_CAPABILITY`, `E_SCOPE`, `E_TTL`, `E_GRANT_NOT_FOUND`, `E_STATE`.

## Agent tools

Plain object `ToolDefinition`s, no `@deepseek-ai/dsh-tools` import.

**Default surface: `allow_check` only.** Issuing, revoking or listing every
subject are human-facing operations. Exposing them to the model lets an agent
mint its own Grant and bypass Act's write gate, so they stay off unless a
human-facing client sets `exposeAdminTools: true` in the plugin config.

- `allow_check` — check a concrete subject/capability/scope (`scope` optional;
  omitted means "any active grant for this capability").
- `allow_issue` (opt-in) — issue a grant (`subject`, `capability` required).
- `allow_revoke` (opt-in) — revoke by grant id.
- `allow_list` (opt-in) — list grants with optional exact filters.

This package is a control plane, not a sandbox: it records and answers
out-of-turn authorization questions and cannot stop same-process code from
bypassing it. Do not expose the admin tools to untrusted agents.

## Persistence

In-memory by default. Set `config.stateFile` to a JSON path to persist grants and
the audit log across restarts. Writes go to a sibling temporary file and are
promoted with `rename` (atomic on the same filesystem); the file is created with
mode `0600`. A missing file starts empty; unreadable or malformed state fails
closed with `E_STATE` instead of silently authorizing from a damaged ledger. This
is a local MVP store, not a multi-process ledger: do not point two live writers
at the same file.

## Security model

- **Fail closed.** Unknown grants, wrong scope, expired/revoked grants and state
  errors never become `allowed`.
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

Covers issue/check, wildcard and array scopes, expiry, revocation, denial,
list/audit, validation, tool registration and `stateFile` round-trips.

## License

MIT.
