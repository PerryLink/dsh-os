# Snip · `dsh-snip`

> A local-first clipboard ledger for DeepSeek Harness with secret exclusion and
> `clipboard://` agent handles.

**Status: 0.1.1 (MVP). A ledger, not a background listener.** Snip records a
clipping only when a caller explicitly invokes `snip.add(...)` or the `snip_add`
agent tool. 0.1.1 has no OS clipboard polling, no `snip_capture`, no network
access and no encryption yet. Secret-looking text is excluded by default.
Everything stays on this machine: entries live in process memory, plus an
optional local JSON snapshot when `stateFile` is configured.

In one sentence: **0.1.1 is a ledger, not a background listener; it excludes
secrets by default and stores clippings locally.**

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-snip
```

The bundle patch mounts the plugin and provides `ctx.snip`.

## Host service

```js
const snip = ctx.get('snip')

const clip = snip.add({ text: 'SELECT * FROM users', sourceApp: 'psql' })
// { id, handle: 'clipboard://<id>', kind: 'text', preview, createdAt, expiresAt, redacted }

snip.get(clip.handle).text // original text, or '[redacted:<reason>]'
snip.search('select')      // newest-first summaries
snip.list({ kind: 'text', limit: 20 })
snip.forget(clip.id)       // true when it existed
snip.clear()               // number removed
```

`add()` accepts `{ text, kind = 'text', sourceApp = 'unknown', sensitivity = 'normal' }`.
Supported kinds are `text`, `html`, `link` and `color`; sensitivities are
`normal`, `sensitive` and `secret` (`secret` always redacts). Handles are
`clipboard://<id>` and are accepted anywhere an id is accepted. `get()` returns
`null` for an unknown, expired or forgotten id. `sourceApp` is trimmed, limited
to 80 characters and rejected with `SNIP_BAD_SOURCE_APP` when it is not a
string, contains control characters or matches a secret pattern; an empty label
becomes `unknown`.

## Agent tools

The plugin registers six plain-object tools (no `@deepseek-ai/dsh-tools`
dependency):

| Tool | Arguments | Result |
| --- | --- | --- |
| `snip_add` | `text` (required), `kind`, `sourceApp`, `sensitivity` | `{ id, handle, kind, preview, createdAt, expiresAt, redacted }` |
| `snip_search` | `query` (required), `limit` | `{ query, entries }` |
| `snip_get` | `id` (id or `clipboard://` handle) | full entry including `text` |
| `snip_list` | `kind`, `limit` | `{ entries }` |
| `snip_forget` | `id` | `{ ok, removed }` |
| `snip_clear` | none | `{ removed }` |

`entries` are newest-first summaries (`id`, `handle`, `kind`, `preview`,
`createdAt`, `expiresAt`, `redacted`). `snip_get` returns the full text, which
then becomes part of the append-only conversation session log — read only what
you need.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `excludeSecrets` | `true` | Detect secrets and store only the redaction marker. |
| `ttlMs` | `86400000` (24 h) | Entry lifetime; expired entries are swept on access. |
| `maxEntries` | `200` | Oldest entries are evicted when the cap is exceeded. |
| `maxBytes` | `65536` (64 KiB) | Larger `add()` calls fail with `SNIP_TOO_LARGE`. |
| `stateFile` | unset | Optional JSON snapshot path, written atomically. |

Expiry and the entry cap are applied automatically on `add`, `list`, `search`,
`get`, `forget` and on mount.

## Secret exclusion and local storage

- With `excludeSecrets` on (the default), a hit is **not stored at all**: the
  ledger keeps only `[redacted:<reason>]` as the text/preview and marks
  `redacted: true`. Supported patterns include `sk-...`, `ghp_...` /
  `github_pat_...`, `AKIA...` / `ASIA...`, PEM/PGP private keys,
  `password=...`, `api_key=...`, bearer tokens, JWTs, Slack, Stripe and Google
  API keys.
- Detection is best-effort, not a guarantee. Set `excludeSecrets: false` to
  opt out (not recommended). `sensitivity: 'secret'` is a caller-side override
  that always redacts. `sourceApp` is metadata, not a secret store: labels are
  screened for the same patterns and rejected when they look like a secret,
  independently of `excludeSecrets`.
- `search` only scans the stored text, so a redacted secret's original value
  can never be found through search; `get` returns only `[redacted:<reason>]`.
  `forget` deletes the map entry and the next snapshot, so no index residue or
  on-disk copy remains.
- When `stateFile` is set, each mutation writes the snapshot through a
  temporary file and `rename` (atomic replace, mode `0600`) **before** the
  in-memory ledger is updated. If the write fails, the call throws
  `SNIP_STATE_WRITE_FAILED` and both memory and disk keep the previous state.
  The snapshot is plain JSON and is **not encrypted in 0.1.1** — protect it
  like any local secret. A snapshot written with detection disabled is
  re-screened on load, and bad `sourceApp` metadata is replaced with `unknown`.
- 0.1.1 performs no network I/O and does not read the OS clipboard. There is no
  background capture, watcher or timer.

## Development

```sh
cd packages/snip
node --test
```

Pure ESM JavaScript, Node 22+, no runtime dependencies and no build step.

## License

MIT. See [LICENSE](./LICENSE).
