# Shell · `@perrylink/dsh-os-shell`

> **The shell is optional.** It is a contribution registry, an owner-only JSON
> bridge and a minimal client page, not a product. No module requires it;
> removing it leaves Act, Allow, Snip, Check, Nest, Trigger, Seek, Trace, Stage,
> Ring and Root working headless (CLI and agent tools). In a Web profile it adds
> an **OS** panel; in a non-Web profile it adds nothing visible.

**Status: 0.2.0 — minimal UI.** `ctx.osShell` keeps the 0.1 view registry and
open history, and adds `snapshot()`. When the profile has `ctx.webServer`, four
`/api/os-shell/*` routes expose Act, Snip and Check to a root React page with
three tabs. The page lives in `ui/client.js`, which is a hand-written module
bundle: **React is provided by the DSH host**, so this package has no React
dependency, no JSX and no build step.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-os-shell
```

Requires Node 22.19+ (or Node 24.9+) and a DSH host in the
`>=0.2.1-rc.2 <0.3.0-0` range. Install it only when you want the panel; without
it every other dsh-os module still works.

## What the UI shows

Open **OS** in the sidebar. The page is root-scoped and does not depend on the
current Session.

| Tab | Data | Actions |
|---|---|---|
| Act | `ctx.act.list()` | Filter by id/title/description, edit JSON arguments, **Run**. `read` actions run directly; `write`/`danger` ask for confirmation and may return `grant_required`. |
| Snip | `ctx.snip.list()` / `snip.search(q)` | Search, browse previews and copy full text. Redacted entries only copy their `[redacted:*]` placeholder. |
| Check | last Check report | Verdict, per-task diffs and the CLI exit code (0 pass/warning, 1 regression, 2 input error). |

Failures render as an error box with a stable code; the page never retries a
missing grant on its own. Missing services render "not installed in this
profile" instead of breaking the page.

## Host service `ctx.osShell`

| Method | Purpose |
|---|---|
| `registerView({ id, title, module, mount? })` | Add a contribution. Throws `E_CONFLICT` on a duplicate id, `E_INVALID_ARGUMENT` on a bad shape. Returns a copy. |
| `unregisterView(id)` | Remove a contribution (**not** its past history). Throws `E_NOT_FOUND`. |
| `listViews()` | Contributions in registration order; copies, `mount` included for the Host. |
| `open(id)` / `close(id)` | Record an open and return `{ view, state }`; `close` is idempotent for a registered view. |
| `history` / `openViews` | Copy of the last 50 opens, and ids currently open. |
| `render()` | Framework-free HTML for `listViews()`; also exported as `render(views)`. |
| `snapshot()` | Aggregate the optional peer services (below). |
| `checkLast()` | Last Check report plus exit code, or `{ available: false }`. |
| `invokeAction(id, args)` | Invoke an Act action as the fixed subject `ui:os-shell`. |
| `searchSnips(q, limit?)` | List (empty `q`) or search Snips, with full text for copying. |

`snapshot()` reads peers with `ctx.get('act')`, `ctx.get('snip')` and
`ctx.get('check')`. A missing service yields `{ available: false }`; it never
throws because an optional module is absent:

```js
await ctx.osShell.snapshot()
// {
//   act:   { available: true,  actions: [{ id, title, risk, description? }] },
//   snip:  { available: true,  entries: [{ id, handle, kind, preview, ... }] },
//   check: { available: true,  last: report | null, exitCode: 0 | 1 | 2 | null },
// }
```

The shell is in-memory only. Open history and the Check "last" report are lost
on process restart (the Check service owns persistence in a later release).

## HTTP API

Registered when `ctx.webServer.register` exists (or when a Web profile mounts
its webserver later); otherwise the module activates silently. All routes are
exact paths, owner-only (the Web server applies its usual authentication),
answer JSON, and send `cache-control: no-store`.

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/os-shell/snapshot` | `{ ok, snapshot }`; sections may be `{ available: false }`. |
| `POST` | `/api/os-shell/act/invoke` | Body `{ id, args }`. Returns the Act result (`ok`, `result`), or `grant_required`, `action_not_found`, `action_failed`. Missing Act service → 503 `service_unavailable`; bad JSON/body → 400. |
| `GET` | `/api/os-shell/snip/search?q=&limit=` | `{ ok, entries }`; empty `q` lists newest first (max 50). Matching entries include `text` for copy. |
| `GET` | `/api/os-shell/check/last` | `{ ok, available, last, exitCode }`; `available: false` when Check is not installed. |

`act.invoke` uses the fixed subject `ui:os-shell`: the root page has no Session
identity, so it must not impersonate one. `write`/`danger` actions therefore
need an Allow grant for that subject; the UI surfaces `capability` and does not
retry. A non-JSON-serializable Act result becomes a clean 500
`serialization_failed`, never a half-written response.

## Client bundle

`package.json` declares `dsh.client.platform = "web"`; the browser entry is
fixed by `exports["./client"]` → `ui/client.js`. The file is a classic script
(`window.__ModuleLoader__.load(...)`, `factory(require)`) that requires only
`react` from the host module table and registers two slots:

- `main` — key / page id `os`.
- `sidebar.panellist` — id `os`, order 30, label `OS`.

It returns `{ apply, inject: ['slots'] }`. Registration is wrapped in
`ctx.slots.inject(...)` so a sidebar or layout remount re-registers cleanly.

> **Artifact contract:** the hand-written `__ModuleLoader__` bundle follows the
> shape DSH currently emits for in-tree client plugins, not a public API. Treat
> it as pinned to the supported DSH range and re-test when upgrading DSH.

The existing `dsh.os.ui` manifest (`ui/index.js`, a lazy list of dsh-os view
descriptors) is separate from `./client` and retained for 0.1 compatibility.

## Rendering (Host)

```js
import { render } from '@perrylink/dsh-os-shell'

render(ctx.osShell.listViews())
// <ul class="dsh-os-views">…</ul>
```

Titles, ids and module names are HTML-escaped. This markup is for adapters
without a React surface; it is not the Web panel.

## Agent tools

| Tool | Arguments | Result |
|---|---|---|
| `os_shell_views` | `{}` | `{ views: [{ id, title, module, mountable }] }` |
| `os_shell_open` | `{ id }` | `{ view, state: 'opened' }` |
| `os_shell_close` | `{ id }` | `{ view, state: 'closed' }` |

All are plain `ToolDefinition` objects, with `mount` replaced by a boolean
`mountable` flag so functions never cross the tool boundary.

## Non-goals (0.2.0)

- No routing, theme engine, window management or keyboard shortcuts.
- No React/JSX build pipeline and no React package dependency.
- No Snip write operations, Check runner or persistence in the UI.
- No network, telemetry or secret collection beyond the owner-only API.

## Test

```sh
cd packages/shell && node --test
```

Covers the fake-webServer Host routes, snapshot aggregation, missing services
and the client bundle contract (`node --check` plus slot registration).

## License

MIT. Not affiliated with DeepSeek; DeepSeek and DeepSeek Harness are
trademarks of their respective owners.
