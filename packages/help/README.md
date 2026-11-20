# Help · `dsh-help`

> Read-only install doctor and first-run wizard for the dsh-os module family.

**Status: 0.1.0 MVP.** Host seam `ctx.help` plus three agent tools. Help reads
the current Cordis context and returns findings and command plans; it never
installs a package, starts a process, writes a file or contacts a network.

The npm name `dsh-help` was available when this package was cut (checked
2026-11-20). It is not a renamed or scoped fallback.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners. This is an independent community package.

## Install

```sh
dsh plugin --profile web add dsh-help
```

No runtime dependencies, no build step, Node.js 22.19+ (or 24.9+).

## Host seam

```js
import { apply } from 'dsh-help'

const help = apply(ctx) // calls ctx.provide('help', service)
// or consume the seam:
const help = ctx.get('help')
```

`apply` returns the service and registers the tools when `ctx.tools` is
available. The service is usable without a tool registry.

### Service API

| Method | Result |
|---|---|
| `doctor()` | Node, DSH version, installed/missing dsh-os modules and suggested commands. |
| `firstRun()` | The five-step quickstart, each step with a command. |
| `installPlan(modules)` | Ordered `dsh plugin --profile web add ...` steps for package, product or service names. |

## Tools

| Tool | Parameters | Returns |
|---|---|---|
| `help_doctor` | none | Health report plus missing modules and install suggestions. |
| `help_first_run` | none | Five quickstart steps. |
| `help_install_plan` | `modules: string[]` | Ordered commands and dependency notes; never executes them. |

All three tools are read-only and return lossless JSON rendered as one text
block.

### `help_doctor`

The report contains:

- `node`: `{ version, required, ok }` for the declared Node range
  `^22.19.0 || >=24.9.0`.
- `dsh`: `{ version, source }`, read from `ctx.get('dshVersion')` first, then
  `process.env.DSH_VERSION`; `unknown` when neither is set. An unknown DSH
  version is reported but does not fail the report.
- `modules`: all eleven dsh-os modules with `installed` flags, probed through
  `ctx.get('act' | 'allow' | 'snip' | 'check' | 'nest' | 'triggers' |
  'evidence' | 'trace' | 'stage' | 'ring' | 'env')`.
- `installed` / `missing`: service names and missing-module details with one
  `dsh plugin ... add ...` command each.
- `suggestions`: install commands for missing modules, plus a Node or DSH
  version hint when relevant.
- `ok`: `true` only when Node is supported and no module is missing.
- `summary`: a one-line human-readable result.

```json
{
  "ok": false,
  "node": { "version": "v24.22.1", "required": "^22.19.0 || >=24.9.0", "ok": true },
  "dsh": { "version": "0.2.2-rc.4", "source": "ctx" },
  "installed": ["check"],
  "missing": [
    {
      "product": "Allow",
      "package": "dsh-allow",
      "service": "allow",
      "command": "dsh plugin --profile web add dsh-allow"
    }
  ],
  "suggestions": ["dsh plugin --profile web add dsh-allow"]
}
```

### `help_first_run`

Five steps, one command each:

1. Install Check: `dsh plugin --profile web add @perrylink/dsh-check`
2. Generate a run: `dsh --profile headless --json "<task>" > run-baseline.ndjson`
3. Diff two runs: `dsh-check diff --old run-baseline.json --new run-candidate.json`
4. Install Act and Allow: `dsh plugin --profile web add dsh-allow && dsh plugin --profile web add dsh-act`
5. Inspect the composed profile: `dsh --dump-config`

Headless emits NDJSON. Check 0.1.x diffs run JSON (`dsh.check.run/v1`), so
normalize one environment per file before step 3; the Check runner does this
automatically from 0.2.0.

### `help_install_plan`

Accepts package names (`dsh-act`), products (`Act`) or services (`act`), in any
order. The result is deterministic and dependency-safe:

- Check is independent, so it is first when requested.
- Allow precedes Act because Act checks Allow grants.
- Other modules keep their canonical order.
- Duplicate aliases are collapsed; unknown names throw `E_INVALID_ARGUMENT`.

```js
const plan = ctx.get('help').installPlan(['act', 'allow'])
// {
//   ok: true,
//   profile: 'web',
//   modules: ['allow', 'act'],
//   packages: ['dsh-allow', 'dsh-act'],
//   commands: [
//     'dsh plugin --profile web add dsh-allow',
//     'dsh plugin --profile web add dsh-act'
//   ],
//   executes: false,
//   ...
// }
```

An empty array returns an empty plan with a next-step hint instead of throwing.

## Boundaries

- **No installation.** Help only prints commands. Nothing is spawned and the
  plan carries `executes: false`.
- **No network.** No registry, marketplace or update check is contacted.
- **No user-data writes.** Help does not write profiles, credentials, sessions
  or configuration. It only reads the `ctx` seams named above.
- **No hidden state.** Every call recomputes the report or plan from the
  current context.

## Tests

```sh
cd packages/help
node --test
```

The suite covers the tool surface, the empty and fully-installed doctor cases,
the DSH version precedence, Node range checks, the five quickstart steps,
install-plan ordering, alias dedupe, the empty plan, invalid input, and a guard
that the runtime imports no process-spawning or network module.

## License

MIT.
