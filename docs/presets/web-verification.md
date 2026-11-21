# Verifying the OS Gateway preset on the Web profile

This is a runbook for the question **"does a real Web session with
`agentPreset: os-gateway` see only the six `os_*` verbs?"** It records the
endpoints that select the preset, a reproducible `eval-gw` profile recipe, and
the checks that distinguish a real gateway-only surface from a preset that
merely failed to load.

Tested on DSH `0.2.2-rc.4` / Linux (WSL2), 2026-11-21, with the profile and
session described below. The headless bundle is **not** a valid surface
(`packages/bundle/headless/src/index.ts` does not compose the preset registry
and refuses a Session that records `agentPreset`).

## Bottom line

- `dsh web` always boots the **shipped `web` profile**; it is literal shorthand
  for `dsh --profile web`. To test `eval-gw`, boot
  `dsh --profile eval-gw --no-open --port 0`. Do not try to attach
  `--profile eval-gw` after the `web` subcommand: everything after the
  launcher's flags is handed to the already-selected app.
- The Web preset is selected by a **session-creation field**, not by a URL
  parameter or a CLI flag:
  `POST /api/session/create` with
  `payload.args.request.agentPreset: "os-gateway"`.
- The API route works end to end, so no Playwright run is required. The UI path
  is a useful independent check and is listed below.
- The authoritative proof is not the model's prose. It is
  `request/header.data.header.tools` in `session/events`: it is the exact tool
  list sent to the model. The test below asserts that it contains exactly the
  six `os_*` names and that no `tool/call` names anything else.

## 1. How the Web profile chooses an `agentPreset`

There are three layers, in precedence order:

| Layer | Where it lives | How it is set |
|---|---|---|
| Deployment default | `agent-preset-registry` row config | `config.default: os-gateway` |
| User default | settings namespace `agent-preset-registry`, field `selectedDefault` | Settings → **Agent presets** → **Set as new task default** |
| Per session | `SessionCreateRequest.agentPreset` | new-task preset chip, or the `session/create` request field |

`AgentPresetRegistry.defaultId` is
`config.selectedDefault.get() ?? config.default`
(`packages/preset/agent-preset-registry/src/index.ts`). The registry row is
already composed by the shipped Web bundle
(`packages/bundle/web-app/cordis.patch.yml`, row id
`agent-preset-registry`); a Web copy does **not** need a second registry row.

`SessionCreateRequest` is declared in
`packages/api/session-controller/src/types.ts` and exposed by
`@Remote('create')` in `packages/api/session-controller/src/index.ts`. A
created Session echoes the effective preset in
`SessionCreateValue.agentPreset`.

### What is *not* a selector

- No `--agent-preset` CLI flag exists for `dsh web` / `dsh --profile web`.
- No `agentPreset` URL query parameter exists. The only startup query parameter
  is `token`; it is an authentication handoff, not configuration.
- `SessionHeader.agentPreset` is a creation fact, not a live selector. The
  current selection is the last `agent-preset/selected` event.

### UI surfaces

- **New-task chip** — `conversation.hero.agentPreset`, registered in
  `packages/client/ui-agent-preset/src/client/index.ts`. English hint:
  *"Choose the agent preset for your new task"*. It appears on the new-session
  screen beside the workspace picker, not in the composer. Custom presets such
  as `os-gateway` appear under the **Custom** group.
- **Settings → Agent presets** — one card per preset; the button is
  *"Set as new task default"* for a non-default card and *"New task default"*
  for the current default. This writes `selectedDefault` through the settings
  namespace, not `config.default`.
- **Session header** — a read-only label showing the preset chosen when the
  task started.

The chip calls the same `session/create` Remote as the API path; there is no
separate UI-only preset mechanism.

### HTTP / WebSocket endpoints

Unary calls use plain HTTP:

```text
POST http://<host>:<port>/api/<namespace>/<method>
Content-Type: application/json
Cookie: dsh-auth-<hash>=...
```

The body is a Connection RPC envelope, not the bare method arguments:

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "session/create",
  "payload": { "args": { "request": { "cwd": "/tmp/eval-work", "agentPreset": "os-gateway" } } }
}
```

A success response is:

```json
{
  "type": "server-response",
  "rpcId": "<same uuid>",
  "result": { "ok": true, "value": { "sessionId": "session-...", "agentPreset": "os-gateway" } }
}
```

A failure carries `result.ok: false` and
`result.error.code` / `result.error.message`. The RPC layer is described in
`docs/api-gateway.md`; Connection maps `/api` calls to
`POST /api/<namespace>/<method>`.

| Purpose | Endpoint | `payload.args` |
|---|---|---|
| List presets, including the effective default | `/api/agentPresets/list` | `{}` |
| Read one preset declaration | `/api/agentPresets/read` | `{"agentPreset":"os-gateway"}` |
| Create a Session with a preset | `/api/session/create` | `{"request":{"cwd":"/tmp/eval-work","agentPreset":"os-gateway"}}` |
| Select a preset on an existing **blank** Session | `/api/agentPresets/select` | `{"agentId":"session-...","agentPreset":"os-gateway"}` |
| Send a prompt | `/api/session/prompt` | `{"request":{"requestId":"<uuid>","sessionId":"session-...","mode":"queue","content":[{"type":"text","text":"..."}]}}` |
| Wait for quiescence | `/api/session/wait` | `{"request":{"sessionId":"session-...","timeoutMs":90000}}` |
| Read the durable event log | `/api/session/events` | `{"request":{"address":{"kind":"session","sessionId":"session-..."},"maxMessages":200}}` |

Two argument shapes are easy to get wrong:

- Methods whose Host signature is `method(request: X)` require
  `args.request`; flattening fields into `args` fails with
  `gateway/arguments-invalid ... missing "request"`.
- `agentPresets/select` takes the `agent` lookup directly, so its wire fields
  are flat `agentId` and `agentPreset`, not a `request` wrapper.

Streaming Remote methods (`session/follow`, `session/observeState`, …) use the
WebSocket at `/api/remote.mux`; none of the checks below need it.

### Authentication

`/api` is protected. A bare request gets `401 unauthorized`. The startup line
printed by `--no-open` is the login URL:

```text
dsh web: http://127.0.0.1:<port>/?token=<process-token>
```

Opening it once mints an authority-bound `dsh-auth-<sha256(host)>` HttpOnly
cookie and redirects to `./`. The cookie is `SameSite=Strict` and bound to the
exact `host:port` authority: `localhost` and `127.0.0.1` are different
authorities for this check. Use a cookie jar and keep one authority throughout.
The token is per process; restarting the server invalidates the printed URL.

## 2. Reproducible `eval-gw` recipe

The recipe uses a throwaway `DSH_HOME`. Do not create this profile in your live
`~/.dsh` for a one-off verification; the cleanup at the end is part of the
recipe.

### 2.1 Launcher

The commands use a launcher array so the same recipe runs with either a
native `dsh` or the checkout CLI:

```sh
# Native Linux install:
DSH=(dsh)

# On the authoring WSL machine the PATH `dsh` is the Windows npm shim and
# fails at boot with "No usable native binding found for
# node-addon-require-builtin-linux-x64-gnu"; the checkout CLI is the working
# equivalent (same 0.2.2-rc.4):
DSH=(node /home/yy/deepseek-harness/apps/cli/lib/bin.js)
```

Pick one line and use `"${DSH[@]}"` below. Do not mix a Windows `dsh` for
profile installation with a Linux runtime for boot.

### 2.2 Create the profile from the shipped Web template

```sh
export DSH_HOME=$(mktemp -d /tmp/dsh-gw.XXXXXX)
"${DSH[@]}" --profile eval-gw --from-default-profile web --dump-config >/dev/null
"${DSH[@]}" plugin --profile eval-gw add \
  dsh-os-kernel@0.3.0 dsh-allow@0.4.0
```

`--from-default-profile web --dump-config` initializes a profile whose bundle
list is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` and exits without
binding a port. It copies the **shipped template**, not the live
`$DSH_HOME/profiles/web` user layer. It is destructive: running it again on
`eval-gw` replaces the profile and deletes its installed plugins and patch.
`--dump-config` is only used here as a non-booting initializer; a real boot
writes the same profile root.

Pin both packages. With the pnpm release-age policy active on the authoring
machine, an unpinned `dsh plugin add dsh-allow` resolved **0.1.0**, not 0.4.0.
Check `profiles/eval-gw/package.json` after installation; it should contain
`"dsh-allow": "0.4.0"` and both bundles in `dsh.profile.bundles`.

### 2.3 Add the preset row and make it the default

Write the whole profile patch (the default file is an empty list with
comments, so replacing it is safe):

```sh
cat > "$DSH_HOME/profiles/eval-gw/cordis.patch.yml" <<'YAML'
# eval-gw: web profile plus the dsh-os gateway-only preset.
- id: agent-preset-registry
  config:
    default: os-gateway

- insert:
    - id: preset-os-gateway
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: os-gateway
        name: OS Gateway
        description: Only os_find / os_do / os_request / os_observe / os_help / os_status.
        order: 4
        plugins:
          - id: os-persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You reach the operating system only through the six os_* verbs.
                Discover with os_find, request write/execute access with
                os_request, refresh an approval with os_observe, then execute
                with os_do. Never assume a grant exists.
              complete: true
              includeRuntimeContext: false
          - id: os-kernel-group
            name: cordis:group
            group: true
            isolate:
              kernel: true
            config:
              - id: os-kernel
                name: 'dsh-os-kernel'
                config:
                  gatewayOnly: true
YAML
```

Notes:

- The `agent-preset-registry` row already exists in the Web layer; this entry
  only **overrides its config**. Do not add a second registry row.
- `config.default` is required by the registry schema. `os-gateway` must match
  the `config.id` of the inserted preset exactly.
- `dsh-allow` is mounted outside the preset by its own bundle patch. Do not
  move it inside the preset: its `allow_*` tools would then be scope-local and
  visible, defeating gateway-only. The kernel can still resolve `ctx.allow`.
- The `cordis:group` with `isolate: { kernel: true }` is not cosmetic. The
  kernel bundle installed by `dsh plugin add` also mounts a **global** kernel;
  without isolation the second mount fails with
  `service kernel has been registered`. The copyable row is the same one in
  `docs/presets/os-gateway.cordis.yml`.

### 2.4 Boot and log in

In terminal 1:

```sh
"${DSH[@]}" --profile eval-gw --no-open --port 0 | tee /tmp/dsh-eval-gw.log
```

Wait for the `dsh web:` line (other startup diagnostics may follow):

```text
dsh web: http://127.0.0.1:<port>/?token=<process-token>
```

In terminal 2:

```sh
URL=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[^ ]*' /tmp/dsh-eval-gw.log | head -1)
BASE=${URL%%/?token=*}
JAR=/tmp/dsh-eval-gw-cookies.txt
curl -sS -c "$JAR" -L -o /dev/null "$URL"
```

The `-L` follows the 303 to `./`; the cookie jar now holds the authenticated
session. A call without `-b "$JAR"` returns `401 unauthorized`.

### 2.5 Cheap preflight: the roster and the default

Define one helper. The body is built around the exact `args` JSON, so nested
quotes inside the JSON value remain valid:

```sh
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
rpc() {
  local method="$1" args="$2"
  curl -sS -b "$JAR" -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$method\",\"payload\":{\"args\":$args}}" \
    "$BASE/api/$method"
}

rpc agentPresets/list '{}' | python3 -m json.tool
```

Expect `os-gateway` in `value.presets` with `"isDefault": true`, alongside the
shipped `standard` / `ptc` / `minimal` / `cordis` rows. If it is absent, the
preset row did not register; `agentPresets/list` would show it with a
`broken` field if activation failed. If it is present but another preset is
`isDefault`, see the `selectedDefault` pitfall.

This preflight needs no model credentials and no tool call. It proves the
registry, preset row, and effective deployment default are live.

### 2.6 Create a Session with `agentPreset=os-gateway`

```sh
mkdir -p /tmp/eval-work
SID=$(rpc session/create \
  '{"request":{"cwd":"/tmp/eval-work","agentPreset":"os-gateway"}}' \
  | tee /tmp/dsh-eval-create.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"]["sessionId"])')
echo "$SID"
```

Expect a response whose `value.agentPreset` is `"os-gateway"`. The `cwd` must
exist; a Session may join a Workspace by `workspaceId` instead, but `cwd` is
the minimal path for this test.

To prove `config.default` is effective as well, create a second Session with
only `{"request":{"cwd":"/tmp/eval-work"}}`; its `value.agentPreset` should
also be `os-gateway` in a fresh `DSH_HOME`.

### 2.7 Send the "try to call `read`" prompt

The prompt asks for both halves: a tool that should not exist, and the
kernel's own status report.

```sh
rpc session/prompt "{\"request\":{\"requestId\":\"$(uuid)\",\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Try to call the read tool on /etc/hostname. If it does not exist, say so. Then call os_status and list the tool names it reports.\"}]}}"
```

Expect `value.accepted: true`. Then wait (the default wait is 30 s; a tool turn
can exceed it):

```sh
rpc session/wait \
  "{\"request\":{\"sessionId\":\"$SID\",\"timeoutMs\":90000}}" \
  | tee /tmp/dsh-eval-wait.json
```

Expect `value.reason: "idle"` and `value.state.running: false`. If the prompt
fails before a turn starts, the usual cause is a missing model credential in
the throwaway `DSH_HOME` (see pitfall 4.8); the preset/roster preflight above
still passes in that case.

### 2.8 Check the model-facing tool list and the tool calls

```sh
rpc session/events \
  "{\"request\":{\"address\":{\"kind\":\"session\",\"sessionId\":\"$SID\"},\"maxMessages\":200}}" \
  > /tmp/dsh-eval-events.json

python3 - <<'PY'
import json

expected = {'os_find', 'os_do', 'os_request', 'os_observe', 'os_help', 'os_status'}
value = json.load(open('/tmp/dsh-eval-events.json'))['result']['value']
headers = []
calls = []
for record in value['records']:
    event = record['event']
    if event['type'] == 'request/header':
        headers.append({tool['name'] for tool in event['data']['header'].get('tools', [])})
    elif event['type'] == 'tool/call':
        calls.append(event['data']['name'])

assert headers, 'no request/header event; increase maxMessages'
for names in headers:
    assert names == expected, f'model-visible tools are {sorted(names)}, not the six os_* verbs'
assert 'read' not in set().union(*headers)
assert set(calls) <= expected, f'non-os tool call: {calls}'

print('model-visible tools:', sorted(set().union(*headers)))
print('tool calls:', calls)
print('PASS: gateway-only surface')
PY
```

Observed on the tested runs:

```text
model-visible tools: ['os_do', 'os_find', 'os_help', 'os_observe', 'os_request', 'os_status']
tool calls: ['os_status']
PASS: gateway-only surface
```

A repeat run also produced `tool calls: ['os_find', 'os_status']` (the model
sometimes searches for the missing `read` first). The tool-call list is
model-dependent, so the script asserts a subset of the six, not equality; the
`request/header` list is the invariant.

The model's answer also said, in substance: *"I don't have a `read` tool
available — my only tools are the six `os_*` verbs"*, then called
`os_status` once and reported the six names. The `request/header` assertion is
the actual evidence; the assistant text is only a sanity check.

`os_status` reports `legacy: 8` in this composition. That is expected: the
eight inherited non-`os_*` tools are adapted into `legacy.<tool>` capabilities
behind `os_find` / `os_do`, not exposed to the model. The model-facing list is
what `request/header` carries, and it has six entries.

### 2.9 Cleanup

Stop the foreground server with `Ctrl-C`, then remove only the throwaway home:

```sh
case "$DSH_HOME" in
  /tmp/dsh-gw.*) rm -rf -- "$DSH_HOME" ;;
  *) echo "refusing to remove $DSH_HOME" ;;
esac
```

The guard is deliberate: a bare `rm -rf "$DSH_HOME"` is one unset variable away
from deleting a real Harness home. Sessions created by this recipe live only
under the throwaway home.

## 3. Browser / UI cross-check

The API path above is sufficient and was executed. This path is for a manual
cross-check or for a Playwright run if the HTTP route is unavailable in a
future release. It uses the same running server and printed URL.

1. Open the printed `http://127.0.0.1:<port>/?token=...` URL in a browser.
   The token is exchanged for the auth cookie; do not paste the URL into a
   shared log.
2. Stay on the **new task** screen. Next to the workspace picker is the agent
   preset chip. With `config.default: os-gateway` it already shows
   **OS Gateway**; otherwise click it and choose **OS Gateway** under
   **Custom**. (The shipped presets are under **Built-in**.)
3. Send: *"Try to call the read tool on /etc/hostname. If it does not exist,
   say so. Then call os_status and list the tool names it reports."*
4. The transcript should show an `os_status` tool card and no `read` card.
   The session header label should read **OS Gateway**.
5. For the default, open **Settings → Agent presets**. The OS Gateway card
   should show **New task default** (or offer **Set as new task default**).
   That action writes `selectedDefault`, which then wins over
   `config.default` for later sessions.

The chip is on the new-session screen, not the composer: after the first turn
the composition is locked and the header label becomes read-only.

## 4. Known pitfalls

### 4.1 `dsh web` is not a profile selector

`dsh web` is exactly `dsh --profile web` (`apps/cli/src/args.ts`). A command
such as `dsh web --profile eval-gw` gives `eval-gw` to the Web app as an inner
argument; it does not switch the profile. Symptom: the roster shows the
shipped presets, `os-gateway` is absent, and the default is `standard`. The
fix is `dsh --profile eval-gw --no-open --port 0`.

### 4.2 Registry peer and the registry row

`@deepseek-ai/dsh-agent-preset` declares
`@deepseek-ai/dsh-agent-preset-registry` as a peer, and
`@deepseek-ai/dsh-persona` declares `@deepseek-ai/dsh-system-prompt`. The
shipped `dsh-web-app` bundle supplies both. Do not assume a bare
`dsh plugin add @deepseek-ai/dsh-agent-preset` into a base-only profile is
enough: the registry row must be mounted and the peers resolvable. Copy the
`web` template rather than assembling the pieces.

The registry schema requires `config.default`
(`packages/preset/agent-preset-registry/src/index.ts`). An inserted registry
row without `default` fails at load. The Web bundle already has the row, so
override it by `id`; inserting a second `agent-preset-registry` row creates a
duplicate `agentPresets` service and fails boot.

### 4.3 `config.default` versus `selectedDefault`

`config.default` is the deployment default. Settings writes
`selectedDefault` in the `agent-preset-registry` settings namespace; the
registry resolves `selectedDefault ?? default`. In a reused `DSH_HOME` that
already has a saved selection, changing `config.default` alone will not change
the effective default. Use a fresh `DSH_HOME` or set the desired preset again
in Settings. `agentPresets/list.isDefault` reports the effective value, so it
is the cheap check before creating a Session. `session/create` without
`agentPreset` returned `os-gateway` in the fresh-home test once
`config.default` was set.

### 4.4 Headless cannot prove this

The `headless` bundle does not compose the preset registry and refuses to
adopt a Session that records an `agentPreset`; its one-shot runner reports
that the preset is one "which the one-shot runner does not compose"
(`packages/bundle/headless/src/index.ts`). `dsh --profile headless` cannot
prove either the roster or the six-tool surface. Use `web`, or a custom bundle
that actually mounts `@deepseek-ai/dsh-agent-preset-registry`.

### 4.5 Preset scope: isolation, Allow, and snapshots

- `gatewayOnly` calls `ctx.tools.restrict({ deny })`, which needs a **scoped**
  context (the preset mount or `agent.ctx`). A global kernel mount with
  `gatewayOnly` fails closed because it would mask every agent.
- The recipe mounts the kernel inside `cordis:group` with
  `isolate: { kernel: true }` because the kernel is also mounted globally by
  its bundle patch. Remove the isolation and the second mount fails with
  `service kernel has been registered`.
- Keep `dsh-allow` outside the preset. Inside the preset its tools are
  scope-local and therefore remain visible; the kernel still resolves
  `ctx.allow` from the outer mount.
- The deny list is a snapshot taken at mount. If you add a global tool plugin
  after the preset is mounted, that tool stays visible until the profile is
  restarted.
- `legacy: 8` in `os_status` is not a leak. The legacy bridge reads the global
  tool view and keeps hidden tools reachable as `legacy.<tool>` capabilities;
  the model-facing `request/header` list is still six.

### 4.6 The `agentPreset` wire field and selection lock

`session/create` accepts `agentPreset` and returns the effective value only
when the deployment composes a registry. The wire shape is
`args.request.agentPreset`; flattening it gives
`gateway/arguments-invalid` with `missing "request"; unexpected "cwd",
"agentPreset"`.

`agentPresets/select` uses flat `{"agentId": "...", "agentPreset": "..."}`
because the Host signature takes the `agent` lookup directly. It only works
before the Session's first turn; after that the Host rejects it with
`agent-preset/locked` / `This session has already started`. Use
`session/create` for a new conversation, or select on a blank Session before
prompting.

There is no URL or CLI preset selector. If a future UI adds one, it still has
to reach `session/create` or `agentPresets/select`; the Session header is not
a selector.

### 4.7 Authentication and the printed URL

`/api` returns `401 unauthorized` without the cookie. The token in the printed
URL is a per-process launch token, not a persistent API key: restart the
server and the old URL stops working. The cookie is signed and
authority-bound; use one authority (`127.0.0.1:<port>`) for login and API
calls. `--no-open` still prints the URL; do not bind a wildcard address (the
Web layer rejects it).

### 4.8 Model credentials in a throwaway home

A fresh `DSH_HOME` has no `.credentials.yaml`, so the Web profile's
`llm-deepseek` has no key. Roster and `session/create` still work, but the
prompt fails before a turn starts. Export `DEEPSEEK_API_KEY` for the server
process (the credentials plugin inherits the environment) or use a home that
already has credentials. Do not copy the credential file into a shared temp
directory and do not put the key in this document or a shell transcript. The
Web bundle's default model is `deepseek-official` / `deepseek-flash`.

### 4.9 Environment-specific launcher

On the authoring WSL machine `which dsh` is
`/mnt/c/Users/.../npm/dsh`, a Windows npm install. Boot fails with:

```text
dsh: fatal uncaught exception: Error: dsh: host preparation failed:
No usable native binding found for node-addon-require-builtin-linux-x64-gnu (auto)
```

That is a launcher/native-binding problem, not a preset problem. Use a
Linux-native `dsh` or the checkout CLI:

```sh
node /home/yy/deepseek-harness/apps/cli/lib/bin.js --profile eval-gw --no-open --port 0
```

### 4.10 Storage and log details

- A throwaway home stores sessions under
  `$DSH_HOME/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd`.
  The file is zstd-compressed; use `session/events` for assertions rather than
  parsing it by hand.
- `maxMessages` too small can omit the `request/header` event. Use 200 for a
  one-turn check.
- `session/wait` defaults to 30 s. Pass `timeoutMs: 90000` when the model has
  to make a tool call.

## 5. What this proves, and what it does not

Proved by the run:

- The `eval-gw` profile composes the `agent-preset-registry` and the custom
  `os-gateway` preset row.
- The effective default is `os-gateway` both in `agentPresets/list` and in a
  `session/create` call that omits `agentPreset`.
- A Session created with `agentPreset: "os-gateway"` sends the model exactly
  the six `os_*` tools, and the model cannot call `read`.
- `os_status` itself reports the same six names and the expected `legacy: 8`
  bridge count.

Not proved by this run:

- The approval bridge (`os_request` → human approval → `os_observe` →
  `os_do`). That needs a write/execute prompt and an approval decision; it is a
  separate test.
- Preset hot-reload and deny-list refresh. The deny list is a mount snapshot;
  restart the profile after adding a global tool plugin.
- Any non-Web surface. `headless` is explicitly out of scope; `tui` is not a
  shipped default profile on this installation.

## Source references

- `packages/api/session-controller/src/index.ts` — `@Remote('create')`,
  `prompt`, `wait`, `events`.
- `packages/api/session-controller/src/types.ts` — `SessionCreateRequest`,
  `SessionPromptRequest`, `SessionWaitRequest`, `SessionPageRequest`.
- `packages/preset/agent-preset-registry/src/index.ts` — registry config,
  `defaultId`, `presetForSession`, remote list/read/select.
- `packages/bundle/web-app/cordis.patch.yml` — shipped `agent-preset-registry`
  row and preset declarations.
- `packages/client/ui-agent-preset/src/client/index.ts` and
  `AgentPresetSeat.tsx` — new-task chip, settings section, header label.
- `packages/bundle/headless/src/index.ts` — the no-registry / no-adoption
  restriction.
- `packages/client/connection/src/api-path.ts` and
  `packages/client/connection/src/rpc-host.ts` — `/api` route and envelope.
- `packages/host/authentication-token/src/browser-auth.ts` — launch-token
  exchange, cookie binding, 401 behavior.
- `docs/api-gateway.md` — `POST /api/<namespace>/<method>` mapping and
  `args` payload.
- `docs/subsystems/core.md` — `ctx.agentPresets` contract.
