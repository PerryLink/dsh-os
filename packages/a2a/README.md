# @perrylink/dsh-os-a2a

An **A2A prototype** for [dsh-os](../../README.md): one Agent Card, 12 skills,
in-memory tasks and a local approval loop. It is a protocol sketch, not a
production agent gateway.

- **Zero dependencies**, one Node.js process.
- **stdio JSON-RPC 2.0**: newline-delimited messages; stdout carries protocol
  messages only, diagnostics go to stderr.
- **Simulated execution by default** (`{echo, skill}`). No DSH, kernel, MCP or
  OS call is made.
- **Not affiliated with DeepSeek.** Experimental, not published.

## Run

Node.js `>=22.19.0`.

```sh
node packages/a2a/bin/dsh-os-a2a.js            # waits for JSON-RPC lines
node packages/a2a/bin/dsh-os-a2a.js --version
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"agent/card"}' | node packages/a2a/bin/dsh-os-a2a.js
```

To use it from a client, spawn
`node /ABS/PATH/dsh-os/packages/a2a/bin/dsh-os-a2a.js` and write JSON-RPC lines
to stdin. There is no HTTP listener yet, so `/.well-known/agent-card.json` is not
served; call `agent/card` instead.

## Agent Card

`agent/card` returns `name`, `description`, `url`, `version`, `capabilities` and
`skills`. The 12 skills are `act`, `allow`, `snip`, `check`, `nest`, `trigger`,
`seek`, `trace`, `stage`, `ring`, `root` and `kernel` (one per dsh-os module).
Each has `id`, `name`, `description`, `tags` and `examples`; a skill is a task
family, not a tool.

## Methods and states

| Method | Purpose |
|---|---|
| `agent/card` | Return the Agent Card. |
| `message/send` | Create a task; simulate it, or stop at approval. |
| `tasks/get` / `tasks/list` | Return one task by `id`, or list/filter tasks. |
| `tasks/cancel` | Cancel a non-terminal task. |
| `tasks/approve` / `tasks/deny` | Resolve a pending approval. Local/test only. |

`message/send` returns the Task: `task.id` is the taskId and
`task.status.state` is the state.

```text
submitted -> working -> completed | failed
submitted -> input-required -> (approve) working -> completed
input-required -> (deny) canceled
submitted | working | input-required -> canceled
```

Tasks are in memory; restarting loses them. Errors: `-32601` unknown method,
`-32602` invalid params/skill, `-32001` unknown task, `-32002` task not
cancelable, `-32010` no pending approval.

## Approval

A task declaring `requiresApproval: true` stops in `input-required` and returns
an `approvalRequest` (`id`, `taskId`, `skill`, `risk`, `state`, `reason`,
`createdAt`). A local caller can approve or deny it:

```json
{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"delete temp"}]},"metadata":{"skill":"act","requiresApproval":true,"reason":"writes a file"}}}
{"jsonrpc":"2.0","id":3,"method":"tasks/approve","params":{"id":"task_..."}}
```

Approval reruns the executor and completes the task; deny moves it to `canceled`.
Both methods are unauthenticated and exist for tests/local use only. A remote A2A
deployment must not expose them; approvals belong to the DSH ledger, and
requester and approver must be different principals.

## Execution

The default executor returns
`{ data: { echo: <message text>, skill: <skill id> } }`. Inject one to connect a
real backend later:

```js
import { createServer } from '@perrylink/dsh-os-a2a'

const server = createServer({
  executor: async ({ skill, text }) => {
    // Future: call the dsh-os kernel gateway or an MCP client here.
    return { data: { skill, output: text } }
  },
})
```

The executor receives the task snapshot, skill, text, full message and approval
object. A thrown error marks the task `failed`; `{data}` or `{text, data}` becomes
the task artifact. A2A stays a thin adapter and must not mint grants.

## Scope and limits

- Prototype: no HTTP/SSE/push, no JWS card, no auth, no persistence, no
  multi-turn continuation after `input-required` (approval only).
- Simulated by default: no DSH, kernel, MCP or OS service is connected.
- Not full A2A v1.0 wire conformance; JSON-RPC shapes follow the spec where
  practical.
- Manifest: `dsh.os.service` is `null`; `tools` is `[]`. Not a DSH plugin; it
  registers no host service.
- A2A is task-level; MCP remains the tool-level protocol and the first
  interoperability target.

## Test

```sh
cd packages/a2a && npm test
# or, from the repo root:
node --test 'packages/a2a/test/*.test.js'
```

Covers card (12 skills), send/get/list/cancel, approval/deny, unknown
task/method/skill, executor injection and the stdio bin.

## License

MIT. Not affiliated with DeepSeek.
