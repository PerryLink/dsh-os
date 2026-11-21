# Snip · `dsh-snip`

> A local-first clipboard ledger for DeepSeek Harness with opt-in OS clipboard
> capture, secret exclusion and `clipboard://` agent handles.

**Status: 0.4.0 — clipboard entries are tainted and `snip_get` mints a token.**
Snip records a clipping only when a caller explicitly calls
`snip.add(...)`, `snip.capture(...)`, or one of the agent tools. **Clipboard
capture is off by default**: mounting the plugin never reads the OS clipboard,
never starts a watcher and never enables a timer. Set `capture.enabled: true`
to allow `snip_capture` / `snip_watch_start`; nothing else turns capture on.

In one sentence: **0.4.0 reads the clipboard only when explicitly asked,
labels every ledger entry as external taint, redacts secrets by default, stores
clippings locally, and pages search results through an `os.result/v1`
envelope.**

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-snip
```

The bundle patch mounts the plugin and provides `ctx.snip`.

## Platform support

| Platform | `snip_capture` (one read) | `snip_watch_start` | Permissions and limits |
| --- | --- | --- | --- |
| Windows 10/11 | Text through WinRT `Clipboard.GetContent()` in Windows PowerShell 5.1; if WinRT fails it falls back to `Get-Clipboard -Raw`. Images/files are only classified, not read. | Polling, experimental (default 700 ms). Each poll starts `powershell.exe`, so a read blocks the host event loop for roughly 0.3–0.6 s. | No clipboard-read consent dialog. `ExcludeClipboardContentFromMonitorProcessing` is honored on a best-effort basis; Windows clipboard history is **not** imported. |
| macOS | `pbpaste` text. Images and source/marker formats are not visible to `pbpaste`. | Polling, experimental. **Not recommended:** each programmatic read can trigger a pasteboard permission prompt on macOS 15.4+. | A prompt is expected for programmatic reads; the user-initiated paste path is always allowed. A denied or timed-out one-shot read is not retried automatically; an enabled watcher does poll again, so do not start one if access was denied. |
| Linux | `wl-paste --no-newline` on Wayland, otherwise `xclip -selection clipboard -o` on X11. | Polling, experimental. | Needs `WAYLAND_DISPLAY` + `wl-paste`, or `DISPLAY` + `xclip`. WSL is treated as Linux, not as Windows; the Windows clipboard is not bridged. |

`snip_watch_start` is never called automatically and no watcher is created on
mount. Call `snip_watch_stop` (or unload the plugin) when done. Because the
default runner is `spawnSync`-based, polling on Windows blocks the event loop;
keep intervals at the default or above and stop the watcher after the task.

`capture.enabled` is a host-wide opt-in: once it is on, the agent can call
`snip_capture` and read whatever is on the clipboard (secret-looking text is
still redacted before storage). Enable it only in profiles where that is
acceptable. Capture runs in the DSH host process: if the GUI is served from
another machine, it reads the **server's** clipboard, not the browser's — keep
capture disabled for remote profiles and paste manually.

## Host service

```js
const snip = ctx.get('snip')

snip.add({ text: 'SELECT * FROM users', sourceApp: 'psql' })
snip.capture({ sourceApp: 'editor' }) // explicit one-shot clipboard read
snip.watch({ intervalMs: 1000 })      // explicit opt-in polling
snip.stopWatch()

snip.get('clipboard://<id>').text
const entry = snip.get('clipboard://<id>')
snip.verifyTaintToken(entry.taintToken, entry.id) // true in this process only
snip.search('select')
snip.list({ kind: 'text', limit: 20 })
snip.forget('clipboard://<id>')
snip.clear()
```

`add()` accepts `{ text, kind = 'text', sourceApp = 'unknown', sensitivity = 'normal' }`.
Supported kinds are `text`, `html`, `link` and `color`; sensitivities are
`normal`, `sensitive` and `secret` (`secret` always redacts). Handles are
`clipboard://<id>` and are accepted anywhere an id is accepted.

`capture()` is disabled unless `capture.enabled` is true. It reads once,
applies the same secret screening and TTL as `add()`, and returns a safe
summary without the clipboard text:

```js
// captured text: { ok: true, kind: 'text', captured: true, duplicate: false,
//   id, handle, redacted, bytes, expiresAt, tainted: true,
//   taintSource: 'clipboard' }
// unchanged/duplicate text: { ok: true, kind: 'text', captured: false,
//   duplicate: true, handle, redacted, tainted: true,
//   taintSource: 'clipboard' }
// empty/image/file: { ok: true, kind: 'empty' | 'image' | 'file',
//   captured: false }
```

Repeated identical content is deduplicated by an in-memory SHA-256 of the raw
text (the hash is never persisted). A redacted secret still gets one ledger
entry containing only `[redacted:<reason>]`, and the original value is never
stored or returned. `watch()` requires `capture.enabled`, is idempotent while
running, and records only the error code of a failed poll in
`stopWatch().lastError` (never clipboard content).

## Agent tools

The plugin registers nine plain-object tools (no `@deepseek-ai/dsh-tools`
dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `snip_add` | `text` (required), `kind`, `sourceApp`, `sensitivity` | `{ id, handle, kind, preview, createdAt, expiresAt, redacted, tainted: true, taintSource: 'clipboard' }` |
| `snip_capture` | `sourceApp` | safe capture summary including taint labels; **no text or preview** |
| `snip_watch_start` | `intervalMs` | `{ ok, watching, intervalMs }` |
| `snip_watch_stop` | none | `{ ok, watching, stopped, lastError }` |
| `snip_search` | `query` (required), `limit` (default 20, max 100), `offset` | `os.result/v1` envelope `{ schema, ok, summary, items, page, truncated, next, error }` plus the legacy `{ query, entries }`; each entry carries `tainted: true` / `taintSource: 'clipboard'` |
| `snip_get` | `id` (id or `clipboard://` handle) | full entry including `text` and a process-local `taintToken` |
| `snip_list` | `kind`, `limit` | `{ entries }` (entries carry taint labels) |
| `snip_forget` | `id` | `{ ok, removed }` |
| `snip_clear` | none | `{ removed }` |

`entries` are newest-first summaries. `snip_search` reports the full match
count in `page.total`; `page.hasMore`/`truncated` say whether another page
exists, and `next` suggests the next `offset` or `snip_get` for a match.
`snip_get` returns the full text, which
then becomes part of the append-only conversation session log — read only what
you need. `snip_capture` intentionally returns a handle and metadata only.

`snip_search` failures return `{ ok: false, code, error }`; the original
`SNIP_*` code is preserved at the top level and inside
`error: { code, message, retryable, remediation, nextTools }`.

## Taint labels (0.4.0)

Snip's ledger is clipboard and other external text, so **every entry** is
labelled `tainted: true` with `taintSource: "clipboard"` — including
`snip_add`, because Snip cannot attest whether caller-supplied text was typed by
the user or copied from a page. `snip_capture`, `snip_search`, `snip_list` and
`snip_get` return the labels.

`snip_get` additionally mints a process-local `taintToken`: a random 256-bit id
mapped to the SHA-256 of the stored text (never the text itself). Tokens live
only in the Snip process, expire after 15 minutes (`taintTtlMs`), and are never
written to `stateFile`. A host can call `snip.verifyTaintToken(token, id?)`;
forged, expired, forgotten, cross-entry and cross-process tokens verify as
`false`. Pass the token (or `tainted: true`) to `act_invoke` and the write also
needs the `act:invoke:<id>:tainted` Grant.

> **This is a minimal gate, not taint tracking.** The label is caller-forwarded
> metadata: Snip cannot follow the text into the model, Act does not verify the
> token, and a model can omit both claims and fall back to the normal Grant.
> Treat this as an audit signal and a speed bump. The durable fix is
> host-produced result metadata that the host attaches to every tool result and
> passes to Act, plus a taint-aware planner — not a per-plugin label.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `excludeSecrets` | `true` | Detect secrets and store only the redaction marker. |
| `ttlMs` | `86400000` (24 h) | Entry lifetime, including captured entries. |
| `maxEntries` | `200` | Oldest entries are evicted when the cap is exceeded. |
| `maxBytes` | `65536` (64 KiB) | Larger `add()`/capture calls fail with `SNIP_TOO_LARGE`. |
| `stateFile` | unset | Optional JSON snapshot path, written atomically. |
| `taintTtlMs` | `900000` (15 min) | Lifetime of a `snip_get` taint token. |
| `taintMaxTokens` | `512` | Bound on live tokens; oldest tokens are evicted first. |
| `capture.enabled` | `false` | Master switch; `snip_capture`, `watch()` and `snip_watch_start` fail with `SNIP_CAPTURE_DISABLED` when false. |
| `capture.intervalMs` | `700` | Default polling interval. |
| `capture.timeoutMs` | `5000` | Hard per-read timeout; a timeout fails with `SNIP_CLIPBOARD_TIMEOUT`. |
| `capture.maxChars` | `65536` | Reads longer than this are truncated and marked `truncated`. |
| `capture.platform`, `capture.backend`, `capture.runner`, `capture.adapter` | host/auto | Test and embedding seams; normally unset. |

## Capture security

- **Fixed argv, no shell.** Windows runs
  `powershell.exe -NoProfile -NonInteractive -Command <constant script>`; the
  script only emits `TEXT:<base64>`, `EMPTY`, `IMAGE`, `FILE` or `EXCLUDED`.
  macOS runs `pbpaste`; Linux runs `wl-paste --no-newline` or
  `xclip -selection clipboard -o`. Clipboard text never becomes an argument.
- **Scrubbed environment.** The child environment drops `DSH_*` variables and
  anything matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`.
- **Timeouts and size caps.** Every read has a 5 s timeout and a capped output
  buffer; stderr and raw process errors are mapped to stable codes and are not
  returned to the model.
- **No text in tool results or logs.** Capture returns a handle, byte count and
  redaction flag. The plugin does not log clipboard content.
- **Secret screening is best-effort.** With `excludeSecrets` on (default), a hit
  is not stored: the ledger keeps only `[redacted:<reason>]` and marks
  `redacted: true`. Set `excludeSecrets: false` to opt out (not recommended).
  `sensitivity: 'secret'` is a caller-side override that always redacts.
- **No network I/O.** 0.2.0 makes no network requests and has no encryption;
  a `stateFile` snapshot is plain JSON at mode `0600` and should be protected
  like any local secret. This version does not import Windows clipboard
  history, does not OCR images, does not copy files and does not read
  `org.nspasteboard.*` markers on macOS.

## Development

```sh
cd packages/snip
node --test
```

Pure ESM JavaScript, Node 22+, no runtime dependencies and no build step.
Tests inject a fake runner; they never read the real clipboard. Adapter code
lives in `lib/capture.js`, the ledger and capture orchestration in
`lib/ledger.js`, taint-token bookkeeping in `lib/taint.js`; `index.js` stays a
small tool/registration entry.

## License

MIT. See [LICENSE](./LICENSE).
