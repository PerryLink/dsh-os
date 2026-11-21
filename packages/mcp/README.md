# @perrylink/dsh-os-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server
prototype for the [dsh-os](../../README.md) capability catalog. It projects
capability cards as MCP tools, serves a few static resources, and never performs
an OS action.

- **Zero runtime dependencies**, one small Node.js process.
- **stdio only**: newline-delimited JSON-RPC 2.0, one message per line.
- **No network, no DSH connection.** The server does not import or launch
  DeepSeek Harness and does not read DSH sessions, profiles or credentials.
- **Read-only by default.** Write cards are hidden unless `--allow-write` is
  passed, and cannot execute either way.
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
node packages/mcp/bin/dsh-os-mcp.js          # serves JSON-RPC on stdin/stdout
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

The client should show six read-only tools. Approve the server in the client
before using it; this project does not ship an installer or auto-approval.

## Protocol

| Method | Purpose |
|---|---|
| `initialize` | Negotiates `2025-06-18` or `2025-03-26`, returns `capabilities` and `serverInfo`. |
| `notifications/initialized` | Accepted silently; notifications never receive a response. |
| `tools/list` | Lists the read-only tools with `inputSchema`, `outputSchema` (2025-06-18 only) and `annotations`. |
| `tools/call` | Runs a meta tool or a catalog capability. |
| `resources/list` | Lists three static resources: `dsh-os://readme`, `dsh-os://catalog`, `dsh-os://approval`. |
| `resources/read` | Reads one static resource. |
| `ping` | Returns `{}`. |

Errors use JSON-RPC errors, not `isError` tool results: `-32700` parse error,
`-32600` invalid request, `-32601` unknown method, `-32602` invalid arguments or
unknown tool, `-32603` internal error, `-32002` unknown resource, `-32001`
capability unavailable, `-32003` write approval required.

## Tools

| Tool | Backing data | Notes |
|---|---|---|
| `os_find` | Catalog | Ranks exposed capabilities by intent and returns argument examples. |
| `os_help` | Catalog | Overview, examples and per-verb documentation. |
| `os_status` | Catalog | Mode, protocol version, catalog source, counts and warnings. |
| `snip_search` | Built-in sample card | Clipboard search. Returns sample rows, `connected: false`. |
| `seek_search` | Built-in sample card | Evidence search. Returns sample rows, `connected: false`. |
| `trace_search` | Built-in sample card | Memory search. Returns sample rows, `connected: false`. |

The three capability tools are **examples**, not a live clipboard, evidence or
memory backend. Every result is marked `sample: true` and carries a warning.
A custom catalog card without a `sample` object returns `E_UNAVAILABLE`.

## Catalog

`--catalog <file>` replaces the built-in examples with capability cards from a
JSON file (a bare array or `{"capabilities":[...]}`). The file is read once at
startup; maximum 256 KiB, 64 cards. Tool names must match
`^[a-z][a-z0-9_]{1,63}$` and cannot shadow `os_find`, `os_help` or `os_status`.

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
    }
  ]
}
```

`readOnly` must be exactly `true` for a card to be exposed by default. Any other
value is treated as a write card. Supported argument validation: object type,
`properties`, `required`, `additionalProperties: false`, string/integer/number/
boolean/array types, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`.

## Security model

- **stdio purity**: every byte written to stdout is a JSON-RPC message. All
  diagnostics, including startup and initialization logs, go to stderr.
- **Read-only by default**: `readOnly:false` cards are filtered out of
  `tools/list`; calling one returns an unknown-tool error.
- **Write path pending**: `--allow-write` only makes write cards visible for
  discovery. `tools/call` still fails with `-32003` /
  `{"code":"E_DENIED","subcode":"grant_required"}`. No request, grant,
  `requestId` or `approvalUrl` is issued. The approval protocol described in
  `dsh-os://approval` (pending request -> human approval in the DSH inbox ->
  single-use grant bound to args/scope/expiry -> re-authorize before execution)
  is **not implemented**.
- **Size limits**: request lines default to 1 MiB (`--max-bytes`), tool
  arguments to 16 KiB, catalog files to 256 KiB, resources to 64 KiB. Oversized
  lines get a JSON-RPC `-32600` error and the stream stays usable.
- **No network**: the implementation imports only `node:fs` (catalog) and
  standard process streams. There is no HTTP transport, auth layer, telemetry or
  DSH connection.
- **No user-data reads**: the only file read is the explicit `--catalog` path.
- **Catalog files are trusted input**: card descriptions become model-visible
  tool descriptions, so only load catalogs you would install as a plugin.

## Limitations

- Prototype only: no live capability execution, no host adapter, no grants.
- No HTTP/SSE transport, OAuth, resources/subscribe, prompts, sampling, roots,
  pagination, dynamic `tools/list` updates or `run_code`.
- Sample data must not be treated as real clipboard, evidence or memory content.
- Not a DSH plugin: `dsh.os.service` is `null`, `dsh.os.tools` is `[]`, and
  stability is `experimental`. It is not published by this change.

## Test

```sh
cd packages/mcp
node --test
```

The suite spawns the real bin over stdio and covers `initialize`, both protocol
versions, `tools/list`, `tools/call` (meta tools, built-in samples, errors),
`resources/list`, `resources/read`, `--catalog`, write-card hiding,
`--allow-write`, oversized requests and a broken catalog.

## License

MIT. See [LICENSE](LICENSE).
