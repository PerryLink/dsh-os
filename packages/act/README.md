# Act · `dsh-act`

> Typed action registry and agent-facing action bus for DeepSeek Harness.

**Status: 0.1.1 MVP：服务/tools；UI/CLI 下一版**

0.1.0 ships the Host service `ctx.act` and the `act_list` / `act_invoke` agent
tools. The action panel, natural-language router, preview/undo/audit pipeline
and the `dsh-act` CLI are planned for the next release.

Act is an **action bus**, not a repository task runner such as `dsh-actions`:
plugins register typed `ActionDescriptor`s once, and humans, agents and future
front-ends invoke the same actions through one registry and one grant check.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-act
```

Plain ESM, Node.js 22+, no runtime dependencies and no build step.

## Service

The plugin exposes `ctx.act`:

```js
const act = ctx.get('act')

const dispose = act.register({
  id: 'workspace.open',              // ^[a-z][a-z0-9_.-]{1,63}$
  title: 'Open workspace file',
  description: 'Open one file in the editor.',
  risk: 'write',                     // read | write | danger
  parameters: { type: 'object', additionalProperties: true },
  async execute(args, meta) {
    return { opened: args.path, session: meta?.sessionId }
  },
})

act.get('workspace.open')            // descriptor | undefined
act.list('open')                     // substring filter over id/title/description
act.list({ text: 'open', riskMax: 'write' })
await act.invoke('echo', { text: 'hi' }, { subject: 'session-42' })
dispose()
```

`register()` validates the id, title, risk and `execute`; duplicate ids throw
`action_exists`. Results are structured and never throw for expected failures:

| Outcome | Value |
| --- | --- |
| Success | `{ ok: true, actionId, result }` |
| Unknown id | `{ ok: false, code: 'action_not_found', actionId }` |
| Missing grant | `{ ok: false, code: 'grant_required', actionId, capability }` |
| `execute` threw | `{ ok: false, code: 'action_failed', message }` |

## Grant checks

`read` actions run directly. `write` and `danger` actions first call the
optional Allow service:

```js
const allow = ctx.get('allow')
const decision = await allow.check({
  subject: meta?.subject ?? meta?.sessionId ?? 'anonymous',
  capability: `act:invoke:${id}`,
  scope: meta?.scope,
})
```

If Allow is absent, the check throws, or the decision is not affirmative,
`invoke()` returns `grant_required` and does **not** execute the action
(fail-closed). Affirmative decisions are `true`, `'allow'`, or an object with
`granted`/`allowed`/`allow`/`permitted === true`, `decision`/`status === 'allow'`,
or `ok === true`.

## Built-in actions

| id | risk | result |
| --- | --- | --- |
| `echo` | read | `{ text }` — echoes `args.text` |
| `now` | read | `{ now }` — ISO 8601 timestamp |
| `list` | read | `{ actions }` — action summaries (`id`, `title`, `risk`, `description?`) |

## Agent tools

- `act_list` — read-only; optional `query` string; returns `{ actions }`.
- `act_invoke` — `id` required, `args` optional object. The effective risk is the
  target descriptor's risk; `write`/`danger` actions still go through the Allow
  check above. The plugin injects the `tools` service for both tools.

## Test

```sh
cd packages/act
node --test
```

## License

MIT.
