# dsh-os in 10 minutes

Two runnable demos for the dsh-os primitives. There is **nothing to install**:
no dependencies, no build step, no network, and no DSH profile. Both demos run
against the package sources in this checkout.

- **Allow + Act + Snip:** a write is denied, a human issues a 30-minute Grant,
  the write succeeds, the Grant is revoked, the write is denied again.
- **Check:** the same task produces a different result in a new environment, so
  `dsh-check` reports `REGRESSION` and exits `1`.

> **Requirements:** Node.js **22.19+** (or 24.9+; both are in `engines`), and a
> checkout of this repository. The Check demo also needs `bash` (Git Bash or WSL
> on Windows). Verify with `node --version`.

Run every command below from the repository root.

## Minutes 0–3: Allow + Act + Snip

```sh
node examples/os-kit/demo.mjs
```

The script builds a fake Cordis context (`provide`/`get`/`tools`), applies the
three packages, registers two demo actions and walks through six steps. It exits `0` only
when all six pass, and `1` with a `FAIL: step N/6: ...` line on the first broken
assertion.

Three actions are wired, of which two are registered by the demo:

| Action | Risk | What it does |
|---|---|---|
| `echo` | read | Act **built-in**; echoes `args.text` (no grant needed) |
| `demo.read` | read | reads a fake in-memory file (no grant needed) |
| `demo.write` | write | calls `snip.add(text)`; needs `act:invoke:demo.write` |

`echo` is not registered again: Act already ships it and rejects a duplicate id
with `action_exists`.

Expected output (Node version, grant ids and `clipboard://` handles differ
per run):

```text
[1/6] fake ctx + apply Allow, Act, Snip
  node v24.22.1 · services: allow, act, snip · 9 agent tools
  tools: act_invoke, act_list, allow_check, snip_add, snip_clear, snip_forget, snip_get, snip_list, snip_search

[2/6] register demo.read (read) and demo.write (write -> snip.add); echo ships with Act
  actions: echo/read, demo.read/read, demo.write/write

[3/6] read-risk actions run with no Grant
  echo -> {"text":"hello from dsh-os"}
  demo.read notes.md -> 4 lines, 58 bytes

[4/6] write without a Grant is refused (fail closed)
  demo.write -> {"ok":false,"code":"grant_required","capability":"act:invoke:demo.write"}
  snip entries: 0 (execute() never ran)

[5/6] a human issues a 30-minute Grant; the same write now succeeds
  grant grant_<uuid> · status=active · ttl=30min · scope=*
  demo.write -> {"ok":true,"handle":"clipboard://<uuid>","redacted":false}
  snip.get(handle).text === written text: true

[6/6] revoke the Grant; the next write is refused again
  grant status after revoke: revoked
  allow.check -> {"allowed":false,"reason":"revoked"}
  demo.write -> {"ok":false,"code":"grant_required"}
  snip entries: 1 (forward-looking: the earlier clipping stays)

PASS: 6/6 steps — denied -> issued -> allowed -> revoked -> denied
  audit: 6 events (security=2, allowed=1, denied=3)
```

What the six steps prove:

| Step | Evidence |
|---|---|
| 1 | Services and 9 agent tools exist without a DSH host |
| 2 | `echo`/`demo.read`/`demo.write` are all resolvable by id |
| 3 | `read` risk actions bypass the grant check by design |
| 4 | A missing grant returns `grant_required` **before** `execute()`, so Snip stays empty (fail closed) |
| 5 | A 30-minute grant (`ttlMs: 30 * 60 * 1000`) lets the same action run; the clipping round-trips through `snip.get(handle)` |
| 6 | Revocation rejects the next check with `reason: "revoked"`; the earlier clipping remains (revocation is forward-looking) |

Allow and Snip are configured **in memory**: the demo writes no files.

## Minutes 3–6: the Check regression gate

```sh
bash examples/os-kit/check-demo/run-check-demo.sh
```

Expected output:

```text
old: check-demo/old.json — baseline run  (dsh 0.2.1-rc.2 / deepseek-chat)
new: check-demo/new.json — candidate run (dsh 0.2.2-rc.4 / deepseek-chat)
[1/2] node ../../packages/check/bin/dsh-check.js diff --old check-demo/old.json --new check-demo/new.json
Check REGRESSION: 1 task(s), 1 regression(s), 0 warning(s), 0 ignored
  REGRESSION session-token-summary [result/regression] result changed
[2/2] dsh-check exit code: 1 (expected 1: the regression gate fired)
PASS: Check caught the result regression and rejected the candidate run.
```

Both fixtures describe the same task (`session-token-summary`) under two
environments. The trajectory, cost and approvals are identical; only
`result.text` changed from a token summary to `"usage unavailable"`. Check treats
**any** result difference as a regression, so the CLI exits `1`.

The wrapper captures that code, asserts it is `1`, then exits `0` itself: the
demo is green while the gate it demonstrates is red. To use it as a real gate,
call the CLI directly and let the exit code propagate:

```sh
node packages/check/bin/dsh-check.js diff \
  --old examples/os-kit/check-demo/old.json \
  --new examples/os-kit/check-demo/new.json
echo $?   # 1
```

## Minutes 6–9: change something and rerun

- **Grant length:** change `GRANT_TTL_MS` in `demo.mjs` and watch the
  `ttl=30min` line and the `expiresAt - createdAt` assertion.
- **Deny instead of allow:** issue the grant for a different subject (for
  example `agent:other`); step 5 fails with `grant_required`.
- **Gate behaviour:** edit `new.json`, e.g. raise `trajectory.steps` from `6` to
  `8`. That is a `>20%` increase, so Check adds a `WARN` line; warnings are
  advisory, but the result regression still exits `1`. Restoring only
  `result.text` leaves the steps warning, so the verdict becomes `WARNING`
  (still exit `0`); restore the steps too for `PASS`.
- **New action:** register one more descriptor with `act.register()` and invoke
  it with `act.invoke()`. Ids must match `^[a-z][a-z0-9_.-]{1,63}$`.

## Minutes 9–10: where to go next

| Want | Read |
|---|---|
| Grant scopes, TTL limits, persistence, admin-tool isolation | [`packages/allow/README.md`](../../packages/allow/README.md) |
| Action descriptor rules, built-ins, `act_list`/`act_invoke` | [`packages/act/README.md`](../../packages/act/README.md) |
| Snip secret exclusion, TTL, `stateFile` | [`packages/snip/README.md`](../../packages/snip/README.md) |
| Diff rules, thresholds, JSON report, exit codes | [`packages/check/README.md`](../../packages/check/README.md) |

Nothing here publishes a package, modifies `packages/*` or writes to a DSH
profile. The demo files are:

```text
examples/os-kit/
├── demo.mjs                     # Node 22+, zero dependencies
├── check-demo/
│   ├── old.json                 # baseline run
│   ├── new.json                 # candidate run (result changed)
│   └── run-check-demo.sh        # asserts dsh-check exits 1
└── README.md
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SyntaxError` / top-level `await` failure | Use Node 22.19+ (`node --version`); 24.9+ is also supported |
| `action_exists: echo` | Do not re-register Act's built-in `echo`; give your action a new id |
| `command not found: bash` on Windows | Run the Node demo directly, or use Git Bash/WSL for the Check wrapper |
| `FAIL: step N/6: ...` and exit 1 | The message names the failed assertion; rerun with `DEBUG=1 node examples/os-kit/demo.mjs` for a stack trace |
| Different `grant_<uuid>` / `clipboard://<uuid>` values | Expected; ids are generated per run |
