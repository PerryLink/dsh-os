# Shell · `@perrylink/dsh-os-shell`

> **The shell is optional.** It is a contribution registry and a minimal HTML
> renderer, not a front end and not a product. No module requires it; removing
> it leaves every other dsh-os module working.

**Status: 0.1.0 — protocol MVP.** Registers view descriptors on `ctx.osShell`,
tracks open history (last 50) and renders a plain HTML fragment. There is no
React, no bundler, no DOM access and no runtime dependency. **No module UIs are
shipped in 0.1.0** — in particular the shell does **not** implement the eleven
dsh-os apps; each module may contribute one view later through this protocol.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-os-shell
```

Requires Node 22.19+ (or Node 24.9+) and a DSH host in the
`>=0.2.1-rc.2 <0.3.0-0` range. The shell is an optional bundle: a profile
without it still runs Act, Allow, Snip, Check, Nest, Trigger, Seek, Trace,
Stage, Ring and Root.

## Contribution protocol

```js
// A module's ui/index.js (client-side, lazy)
export const views = [
  {
    id: 'act.panel',           // ^[a-z][a-z0-9_.-]+$
    title: 'Act',              // 1-80 characters, escaped before rendering
    module: 'dsh-act',         // package name
    mount(ctx, container) {},  // optional; called by the client, never by Host
  },
]
```

`package.json` declares the client entry and the view ids:

```jsonc
"dsh": {
  "os": {
    "ui": { "entry": "./ui/index.js", "views": ["act.panel"] }
  }
}
```

The Host entry **never imports** `ui/index.js`. A client adapter loads that
entry lazily, only when the shell is shown. The Host only stores a supplied
`mount` function; it never calls it. `registerView` rejects unknown fields,
invalid ids, empty/overlong titles, invalid module names and non-function
mounts.

## Service `ctx.osShell`

| Method | Purpose |
|---|---|
| `registerView({ id, title, module, mount? })` | Add a contribution. Throws `E_CONFLICT` on a duplicate id, `E_INVALID_ARGUMENT` on a bad shape. Returns a copy. |
| `unregisterView(id)` | Remove a contribution (**not** its past history). Throws `E_NOT_FOUND`. |
| `listViews()` | Contributions in registration order; copies, `mount` included for the Host. |
| `open(id)` | Record one open in history and return `{ view, state: 'opened' }`. |
| `close(id)` | Mark the view closed, return `{ view, state: 'closed' }`. Idempotent for a registered view. |
| `history` | Copy of the last 50 opens as `[{ id, at }]`, oldest first. |
| `openViews` | Ids of views currently open, for routing/highlighting. |
| `render()` | HTML for `listViews()`; also exported as `render(views)`. |

`open`/`close`/`unregisterView` throw `E_NOT_FOUND` for an unknown id. The
service is in-memory only; the shell owns persistence in a future version.

## Rendering

```js
import { render } from '@perrylink/dsh-os-shell'

const html = render(ctx.osShell.listViews())
// <ul class="dsh-os-views">
//   <li data-view-id="act.panel" data-module="dsh-act">Act</li>
// </ul>
```

Titles, ids and module names are HTML-escaped. This markup is a reference for a
future client adapter, not a finished UI.

## Agent tools

| Tool | Arguments | Result |
|---|---|---|
| `os_shell_views` | `{}` | `{ views: [{ id, title, module, mountable }] }` |
| `os_shell_open` | `{ id }` | `{ view, state: 'opened' }` |
| `os_shell_close` | `{ id }` | `{ view, state: 'closed' }` |

All are plain `ToolDefinition` objects, with `mount` replaced by a boolean
`mountable` flag so functions never cross the tool boundary.

## Non-goals (0.1.0)

- No routing, keyboard shortcuts, theme or window management — that is the
  client shell's job.
- No module UIs, no eleven separate Apps, no React or other framework.
- No persistence, network, telemetry or secret collection.

## Test

```sh
cd packages/shell && node --test
```

## License

MIT. Not affiliated with DeepSeek; DeepSeek and DeepSeek Harness are
trademarks of their respective owners.
