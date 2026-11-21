# @perrylink/dsh-os-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[dsh-os](../../README.md) capability catalog. It is **read-only by default** and
adds an **approval-gated write path** with `--allow-write`. It projects
capability cards as MCP tools, serves static and `dsh://` resources, and never
performs an OS action.

- **Zero runtime dependencies**, one small Node.js process.
- **stdio only**: newline-delimited JSON-RPC 2.0, one message per line.
- **No network, no DSH connection.** The server does not import or launch
  DeepSeek Harness and does not read DSH sessions, profiles or credentials.
- **Default deny.** Write cards and `os_do`/`os_request` are hidden unless
  `--allow-write` is passed. Every write call needs a single-use `approvalToken`
  created by `os_request` after a human approves it.
- **Experimental.** Not affiliated with DeepSeek.

## Requirements

Node.js `>=22.19.0`.

## Install and run

```sh
npm install -g @perrylink/dsh-os-mcp
dsh-os-mcp --version
```

From this checkout, without installing:

```sh
node packages/mcp/bin/dsh-os-mcp.js --version
node packages/mcp/bin/dsh-os-mcp.js          # read-only; serves JSON-RPC on stdin/stdout
node packages/mcp/bin/dsh-os-mcp.js --allow-write
```

The process speaks MCP on stdin/stdout and logs only to stderr. Normally an MCP
client starts it; running it by hand just waits for JSON-RPC lines.

## Configure a client

The server is a standard stdio MCP server. Use the absolute path to the bin file
in this checkout:

```text
/ABS/PATH/dsh-os/packages/mcp/bin/dsh-os-mcp.js
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dsh-os": {
      "command": "node",
      "args": ["/ABS/PATH/dsh-os/packages/mcp/bin/dsh-os-mcp.js"]
    }
  }
}
```

After a global install, `"command": "dsh-os-mcp"` with `"args": []` also works.

### Claude Code

```sh
claude mcp add dsh-os -- node /ABS/PATH/dsh-os/packages/mcp/bin/dsh-os-mcp.js
```

### Cursor / other MCP clients

Use the same `mcpServers` object, for example in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dsh-os": {
      "command": "node",
      "args": ["/ABS/PATH/dsh-os/packages/mcp/bin/dsh-os-mcp.js"]
    }
  }
}
```

The client shows six read-only tools by default. With `--allow-write` it shows
eight (`os_do`, `os_request` and write cards are added); with
`--admin-token <token>` it also shows the admin-only `os_approve`. Approve the
server in the client before using it; this project does not ship an installer or
auto-approval.

## Protocol

| Method | Purpose |
|---|---|
| `initialize` | Negotiates `2025-06-18` or `2025-03-26`, returns `capabilities` and `serverInfo`. |
| `notifications/initialized` | Accepted silently; notifications never receive a response. |
| `tools/list` | Lists the exposed tools with `inputSchema`, `outputSchema` (2025-06-18 only) and `annotations`. |
| `tools/call` | Runs a meta tool, a catalog capability, or the write path. |
| `resources/list` | Lists `dsh-os://readme`, `dsh-os://catalog`, `dsh-os://approval`, plus live `dsh://requests/<id>` handles. |
| `resources/read` | Reads a static resource or a `dsh://requests/<id>` handle; truncates at 32 KiB. |
| `ping` | Returns `{}`. |

Errors use JSON-RPC errors, not `isError` tool results: `-32700` parse error,
`-32600` invalid request, `-32601` unknown method, `-32602` invalid arguments,
unknown tool/request/capability, `-32603` internal error, `-32002` unknown
resource, `-32001` capability unavailable, `-32003` write approval required or
admin token rejected. Every `-32003` carries `data.code: "E_DENIED"`,
`data.subcode` and `data.nextTools`.

## Tools

| Tool | Available | Backing data | Notes |
|---|---|---|---|
| `os_find` | always | Catalog | Ranks exposed capabilities by intent and returns argument examples. |
| `os_help` | always | Catalog | Overview, examples and per-verb documentation. |
| `os_status` | always | Catalog | Mode, protocol version, source, approval settings, counts and warnings. |
| `os_request` | `--allow-write` | Approval store | Creates or polls a pending write request. |
| `os_do` | `--allow-write` | Catalog + approval store | Executes read capabilities; write capabilities need a valid token. |
| `os_approve` | `--allow-write` + `--admin-token` | Approval store | Admin-only approve/deny for pending requests. |
| `snip_search`, `seek_search`, `trace_search` | always (built-in catalog) | Sample cards | Return built-in sample rows, `connected: false`. |

The three built-in capability tools are **examples**, not a live clipboard,
evidence or memory backend. Every result is marked `sample: true` and carries a
warning. A custom catalog card without a `sample` object returns
`E_UNAVAILABLE` when called directly.

## Write approval

Writes are disabled unless the server starts with `--allow-write`. The flow is
pending request -> human approval -> single-use token -> execution:

```text
os_request({ capability: "fs_write", arguments: { path: "/tmp/a" }, reason: "fix" })
  -> { requestId: "req_...", status: "pending", nextTools: [os_request poll] }

human: os_approve({ requestId, adminToken, decision: "approve" })
   or: dsh-os-mcp --approve <id> --request-store /abs/store.json

os_request({ requestId })
  -> { status: "approved", approvalToken: "dshat_...", tokenExpiresAt, nextTools: [os_do] }

os_do({ capability: "fs_write", arguments: { path: "/tmp/a" }, approvalToken })
  -> { ok: true, status: "authorized", simulated: true, applied: false }
```

Token rules:

- Generated by `os_request` only after the request is approved; never at
  request-creation time.
- Single-use: consumed atomically by the first successful `os_do`; replay fails
  with `subcode: "token_used"`.
- Bound to the capability and a canonical hash of the arguments; a different
  capability or argument value fails with `subcode: "token_mismatch"`.
- TTL is 5 minutes from issuance. Pending requests expire after 10 minutes.
- Stored only as a SHA-256 hash. The plaintext token is returned once; if it is
  lost, deny the request and create a new one.
- The server enforces everything locally. No host adapter is connected, so a
  successful write returns a **simulated authorization receipt**
  (`status: "authorized"`, `applied: false`); it does not write a file, run a
  command or touch the clipboard.

Approving:

- `os_approve` exists only when the server has `--admin-token`; it requires the
  same token in `adminToken` and is compared in constant time. A wrong token
  returns `-32003` / `subcode: "admin_required"`.
- `dsh-os-mcp --approve <id> --request-store <file>` approves one pending
  request and exits. It prints request status only, never the token; the
  requester polls `os_request` to receive the token.
- The `--approve` CLI and the server must use the same `--request-store` file.
  Without it, pending requests live in the server's memory and only
  `os_approve` can approve them.

Pending requests are kept in memory by default. `--request-store <file>` makes
them durable and shareable with the CLI. Writes are atomic (temporary file +
rename) with mode `0600`; the file contains request arguments and reasons, so
place it somewhere private. One server process should own a store file at a
time.

## Resources and handles

`resources/read` serves:

- `dsh-os://readme` — profile, tools, write path and safety limits.
- `dsh-os://catalog` — exposed capability cards and approval settings.
- `dsh-os://approval` — the implemented pending/approval/token contract.
- `dsh://requests/<requestId>` — redacted request status; never includes raw
  arguments, token hashes or the plaintext token.

No resource response exceeds **32 KiB**. Longer documents are cut on a UTF-8
boundary and end with `[truncated at 32768 bytes]`.

## Catalog

`--catalog <file>` replaces the built-in examples with capability cards from a
JSON file (a bare array or `{"capabilities":[...]}`). The file is read once at
startup; maximum 256 KiB, 64 cards. Tool names must match
`^[a-z][a-z0-9_]{1,63}$` and cannot shadow `os_find`, `os_help`, `os_status`,
`os_do`, `os_request` or `os_approve`.

```json
{
  "capabilities": [
    {
      "tool": "fs_read",
      "title": "Read a file",
      "description": "Read a local file path (descriptor example).",
      "readOnly": true,
      "keywords": ["file", "read", "文件"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "minLength": 1 }
        },
        "required": ["path"],
        "additionalProperties": false
      },
      "sample": { "path": "/tmp/example.txt", "text": "sample content" }
    },
    {
      "tool": "fs_write",
      "title": "Write a file",
      "description": "Write a local file path (descriptor example).",
      "readOnly": false,
      "keywords": ["file", "write", "写"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "minLength": 1 }
        },
        "required": ["path"],
        "additionalProperties": false
      }
    }
  ]
}
```

`readOnly` must be exactly `true` for a card to be exposed by default. Any other
value is treated as a write card, hidden without `--allow-write`, and executable
only through `os_do` with an approval token. Calling a write card directly
always fails with `-32003` and points at `os_request`. Supported argument
validation: object type, `properties`, `required`, `additionalProperties:
false`, string/integer/number/boolean/array types, `enum`, `minLength`,
`maxLength`, `minimum`, `maximum`.

## Security model

- **stdio purity**: every byte written to stdout is a JSON-RPC message. All
  diagnostics go to stderr.
- **Read-only by default**: write cards, `os_do`, `os_request` and `os_approve`
  are absent from `tools/list` and unknown to `tools/call`.
- **Default deny for writes**: a valid, unexpired, unused token bound to the
  capability and arguments is required. Missing or invalid tokens return
  `-32003` with recovery `data.nextTools`.
- **Human in the loop**: the model can request and poll, but cannot approve or
  extend TTLs. Approvals come from the local CLI or the admin-token tool.
- **Size limits**: request lines default to 1 MiB (`--max-bytes`), tool
  arguments to 16 KiB, catalog files to 256 KiB, request-store files to 4 MiB,
  resources to 32 KiB. Oversized lines get a JSON-RPC `-32600` error and the
  stream stays usable.
- **No network**: the implementation imports only Node built-ins (`node:fs`,
  `node:crypto`) and uses process streams. There is no HTTP transport, auth
  layer, telemetry or DSH connection.
- **Writes only to an explicit store**: the only files written are the
  `--request-store` path chosen by the operator. The only file read for catalog
  data is the explicit `--catalog` path.
- **Admin token handling**: the token is compared in constant time and never
  logged or stored in the request store. It is passed as a tool argument, so use
  this surface only with a trusted local client; do not reuse a secret from
  another system.
- **Catalog files are trusted input**: card descriptions become model-visible
  tool descriptions, so only load catalogs you would install as a plugin.

## Limitations

- Prototype only: no live capability execution, no host adapter, no real write
  side effects. A token proves authorization, not that anything changed on disk.
- No HTTP/SSE transport, OAuth, MRTR, resources/subscribe, prompts, sampling,
  roots, pagination, dynamic `tools/list` updates or `run_code`.
- The approval store is local and single-process-oriented; it is not a shared
  multi-tenant approval service.
- Sample data must not be treated as real clipboard, evidence or memory content.
- Not a DSH plugin: `dsh.os.service` is `null`, `dsh.os.tools` is `[]`, and
  stability is `experimental`. It is not published by this change.

## Test

```sh
cd packages/mcp
node --test
```

The suite spawns the real bin over stdio and covers `initialize`, both protocol
versions, `tools/list` (read-only and `--allow-write`), `tools/call` (meta tools,
built-in samples, errors), the approval flow (`os_request` -> `os_approve` ->
`os_do`), missing/invalid tokens, replay, argument binding, the `--approve` CLI,
`dsh://requests` resources, the 32 KiB resource cap, `--catalog`, oversized
requests and a broken catalog.

## License

MIT. See [LICENSE](LICENSE).
