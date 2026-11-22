# Web interactive approval bridge (real Web session)

Status: **passes with profile-layer workarounds**, 2026-11-21, DSH `0.2.2-rc.4`,
Node 24.22.1, Linux/WSL2. Profile: `/tmp/dsh-real-home/profiles/eval-gw`.
Driver: `evals/real/web-approval.mjs`.

This is the real `os_request → human approval → os_observe → os_do` path, not a
unit test. It passed only after mounting two profile-local bridges and a test
`act.fs.write` capability; the shipped-package gaps are listed in §5.

## 1. Run

```sh
cd /mnt/d/Projects/dsh/dsh-os
DSH_HOME=/tmp/dsh-real-home node evals/real/web-approval.mjs
```

The script:

- turns `eval-gw` into a Web profile (swaps `@deepseek-ai/dsh-headless` for
  `@deepseek-ai/dsh-web-app`, removes the profile-local
  `@deepseek-ai/dsh-agent-preset-registry`);
- installs kernel/Allow/Act/shell plus two profile-layer bridges under
  `$DSH_HOME/eval-bridges/`;
- writes `cordis.patch.yml`, boots `dsh --profile eval-gw --no-open --port 0`;
- logs in through the printed `?token=` URL;
- creates a Session with `agentPreset:"os-gateway"`;
- drives the two model turns, verifies the file, stops the server.

The key is read from `/home/yy/.dsh/.credentials.yaml`
(`refs.DEEPSEEK_API_KEY`) and passed only in the server environment; it is never
printed, written, or included in `request.json`.

## 2. Actual result

```json
{
  "ok": true,
  "surface": { "tools": ["os_find","os_do","os_request","os_observe","os_help","os_status"] },
  "session": { "id": "session-9a4105e6-2016-44fc-94d3-a6e4e0330767", "agentPreset": "os-gateway" },
  "requests": {
    "kernel": { "id": "req_256c939b-d533-413d-9a75-f671aeb63d80", "capability": "cap:act.fs.write", "status": "approved", "grantId": "grant_590663b8-85be-4e95-9b47-8839e3d0c345", "decidedBy": "eval-human" },
    "module": { "id": "req_0309b596-1f22-4fa4-ad61-29c070e66140", "capability": "act:invoke:fs.write", "status": "approved", "grantId": "grant_7c65cf57-7943-4ef6-a37d-354625a865aa", "decidedBy": "eval-human" }
  },
  "observe": { "state": "approved", "grantAvailable": true },
  "write": { "ok": true, "actionId": "fs.write", "result": { "path": "/tmp/dsh-web-approval/work/approved.txt", "bytes": 8 } },
  "file": { "path": "/tmp/dsh-web-approval/work/approved.txt", "content": "approved", "bytes": 8, "sha256": "2687f86ed6784b8a5fca36e6c468e12aa44dc3c7e8137e3160d1a95079bdcd02" }
}
```

The six-tool surface is read from both turns' `request/header` events.
`request.json` in the workdir records both request IDs, approvals, observe state,
write result and final file hash.

## 3. Endpoints

| Purpose | Request |
|---|---|
| Login | `GET /?token=<process-token>` → `dsh-auth-<hash>` cookie |
| Create Session | `POST /api/session/create` `{request:{cwd, agentPreset:"os-gateway"}}` |
| Prompt | `POST /api/session/prompt` `{request:{requestId, sessionId, mode:"queue", content:[{type:"text", text}]}}` |
| Wait | `POST /api/session/wait` `{request:{sessionId, timeoutMs}}` |
| Events | `POST /api/session/events` `{request:{address:{kind:"session", sessionId}, maxMessages}}` |
| Pending approvals | `GET /api/os-approvals?status=pending` |
| Approve | `POST /api/os-approvals/:id/approve` `{"by":"eval-human"}` |

The approval route is the shell bridge (`packages/shell/bridge.js`), backed by
`Oversight` and the live `allow` service. The approve response carries the
approved request and the issued grant.

## 4. Two prompts

1. `os_request` for `act.fs.write` with
   `{"path":"/tmp/dsh-web-approval/work/approved.txt","text":"approved"}`,
   plus `os_do("legacy.allow_request", {subject:<sessionId>,
   capability:"act:invoke:fs.write", scope:"*", ...})`. Both return pending
   requests; the model reports the IDs. `request.json` is written by the harness
   because the gateway intentionally has no ungated file write.
2. `os_observe(<kernel requestId>)` → `state:"approved"`,
   `grantAvailable:true`; then one `os_do("act.fs.write", {same args})`.
   The kernel consumes the cached grant and calls Act's real `fs.write`; Act
   consumes its own module grant.

## 5. Shipped-package gaps found

> **Follow-up (2026-11-21):** gaps 1–3 are fixed in the shipped packages
> (`shell@0.4.0` resolves `webServer` via `get()`; `kernel@0.4.0` resolves
> `allow` via `get()` and accepts `exec.agent.session.id` as the subject).
> The run above still used the pre-fix bridge profile; a clean profile no longer
> needs those two bridge wrappers. Gaps 4–5 remain: the registry has no
> `act.fs.write` capability, and kernel/module Grants are still two separate
> approvals.

1. **Shell cannot mount injected Web.** `packages/shell/index.js` read
   `ctx.webServer` while `inject` is `['tools']`; fixed in 0.4.0 by resolving
   `ctx.get('webServer')` with a safe direct fallback.
2. **Kernel cannot read Allow.** `gateway.js` read `ctx.allow` while `inject` is
   `['tools']`; fixed by `get('allow')` with a safe fallback.
3. **Kernel expects `exec.subject`.** DSH gives `exec.agent`; fixed with
   `exec.subject ?? exec.agent.session.id ?? exec.agent.id`.
4. **No shipped `act.fs.write` capability.** `os_status` reports
   `capabilities:0 / legacy:60`; the test profile registers a test capability.
   This is the module capability projection gap.
5. **Two grants.** Act checks `act:invoke:fs.write`; kernel checks
   `cap:act.fs.write`. Both must be requested/approved; no automatic bridge.
6. **Profile-local preset registry shadows the Web row.** Remove it; override
   the Web bundle's registry row by id, do not insert a second registry.
7. **Descriptor enum.** `idempotency:'supported'` is invalid; use
   `pure|idempotent|non-idempotent|destructive`.

## 6. Cleanup

The script stops the server in `finally` (`SIGTERM`, then `SIGKILL` if needed).
Remove the workdir with a guard:

```sh
case /tmp/dsh-web-approval in
  /tmp/*) rm -rf -- /tmp/dsh-web-approval ;;
  *) echo "refusing" ;;
esac
```

The profile stays configured with the bridge packages and generated patch so the
eval can rerun. To revert, remove `dsh-eval-kernel-bridge` /
`dsh-eval-approval-bridge` from the profile and restore the previous patch. Do
not delete `/tmp/dsh-real-home` if other evals share it.

## 7. Clean-profile one-approval run (2026-11-22)

Status: **passes on a clean Web profile with no bridges and no test capability.**

```sh
DSH_HOME=/tmp/dsh-clean-home \
DSH_PROFILE=eval-gw-clean \
DSH_WEB_APPROVAL_CLEAN=1 \
node evals/real/web-approval.mjs
```

The clean profile installs only `dsh-os-kernel`, `dsh-allow`, `dsh-act` and
`dsh-os-shell`, with the `os-gateway` preset and no `eval-bridges/`, no test
`act.fs.write` capability and no module-owned request.

Observed:

- exactly **one** request: `cap:act.fs.write`
- exactly **one** approval: `eval-human`
- `os_observe` → `approved`, `grantAvailable:true`
- `os_do("act.fs.write")` → `ok:true`, `tool:"act.fs.write"`, bytes 8
- `approved.txt` = `approved`, sha256
  `2687f86ed6784b8a5fca36e6c468e12aa44dc3c7e8137e3160d1a95079bdcd02`
- no module request was created

This closes gaps 4–5 from §5: the kernel projects Act actions as `act.<id>`,
Act accepts `cap:act.<id>` and the kernel's consumed-Grant proof, so one human
approval covers both sides.

The script also accepts both `OsResult` shapes (`{ok,tool,data}` and a nested
bridge payload) so a successful write is not misreported as a gap.
