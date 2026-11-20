# Root · `@perrylink/dsh-root`

> Named, explainable environment profiles for DeepSeek Harness.

**Status: 0.1.1 MVP：环境账本/解释器；注入在 0.2.0。**

Root 0.1.0 ships the Host service `ctx.env` and five `root_*` agent tools. It
records named environment profiles with inheritance, deny rules and per-key
provenance, and resolves them into a single effective view.

**Root 0.1.0 never reads or writes `process.env`.** Profiles are declarative
ledger entries; resolving one does not apply it to the current process, a
shell, an agent or a child process. Materialization (launcher/shell injection,
proxy installation, credential resolution) is planned for 0.2.0. Treat this
release as the data model and interpreter that later application layers build
on.

Root is not a dotfiles manager: it does not write shell rc files, edit the
registry or manage `.env` files. It answers "what should the environment be,
where did each value come from, and what was denied?".

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add @perrylink/dsh-root
```

Plain ESM, Node.js 22+, no runtime dependencies and no build step.

## Service

The plugin provides `ctx.env`:

```js
const env = ctx.get('env')

env.set('base', {
  vars: { NODE_ENV: 'development' },
  secretRefs: { OPENAI_API_KEY: 'cred:openai' },
  proxy: { http: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1' },
  pathPrepend: ['/opt/homebrew/bin'],
  inherit: null,
  deny: ['AWS_*'],
  trust: 'user',
  scope: 'user',
})

env.set('acme-dev', {
  inherit: 'base',
  vars: { NODE_ENV: 'test' },
  pathPrepend: ['./node_modules/.bin'],
  trust: 'workspace',
  scope: 'workspace',
})

env.get('acme-dev')      // full profile (deep copy) or undefined
env.list()               // all profiles in insertion order (deep copies)
env.remove('acme-dev')   // true | false

env.resolve('acme-dev')
env.explain('acme-dev', 'NODE_ENV')
```

| Method | Result |
| --- | --- |
| `set(name, profile)` | Normalized profile (deep copy); throws a coded error on invalid input |
| `get(name)` | Deep copy of one profile, or `undefined` |
| `list()` | Deep copies of all profiles, in insertion order |
| `remove(name)` | `true` when a profile was removed, otherwise `false` |
| `resolve(name, { layer }?)` | Effective view: `{ vars, secretRefs, proxy, pathPrepend, sources, denied }` |
| `explain(name, key)` | Provenance of one key, or why deny removed it |

## Profile

```js
{
  name: 'acme-dev',                    // supplied by set(); must match if present
  vars: { NODE_ENV: 'test' },          // Record<string, string>; keys ^[A-Z_][A-Z0-9_]*$
  secretRefs: { TOKEN: 'cred:acme' },  // reference names only, never values
  proxy: { http, https, noProxy },     // all optional, at least one when proxy is set
  pathPrepend: ['./node_modules/.bin'],
  inherit: 'base',                     // parent profile name or null
  deny: ['AWS_*', '*_TOKEN'],          // case-insensitive glob patterns
  trust: 'workspace',                  // user | workspace | agent (default user)
  scope: 'workspace',                  // user | workspace | agent (defaults to trust)
}
```

- Variable names must match `^[A-Z_][A-Z0-9_]*$`; values must be strings.
- `vars` and `secretRefs` share one environment namespace, so one profile
  cannot define the same key twice. Inheritance may move a key between the two
  maps; the later layer wins.
- `secretRefs` values are credential reference names, not secrets. Root never
  resolves them and never stores a value; put secret material in the
  credentials store, not in `vars`.
- `pathPrepend` entries must be non-empty strings and are de-duplicated.
- `inherit` may point to a profile that is registered later; a missing parent
  fails at `resolve`/`explain` time, not at `set` time.
- Unknown profile fields are rejected so typos do not silently disappear.

## Resolution

`resolve(name)` walks `inherit` links from the root ancestor to the requested
profile and composes them in that order:

1. **vars / secretRefs** — later profiles override earlier ones. The returned
   `sources` map records the winning profile for every effective key.
2. **proxy** — merged field by field (`http`, `https`, `noProxy`); `null` when
   no visible profile sets any field.
3. **pathPrepend** — inherited entries first, then the profile's own, with
   duplicates removed while preserving order.
4. **deny** — the union of every visible profile's patterns. Matching is
   case-insensitive and `*` matches any run of characters. Matching keys are
   removed from the effective result and listed in `denied`.

```js
env.resolve('acme-dev')
// {
//   vars: { NODE_ENV: 'test' },
//   secretRefs: { OPENAI_API_KEY: 'cred:openai' },
//   proxy: { http: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1' },
//   pathPrepend: ['/opt/homebrew/bin', './node_modules/.bin'],
//   sources: { NODE_ENV: 'acme-dev', OPENAI_API_KEY: 'base' },
//   denied: []   // e.g. ['AWS_KEY'] when a defined key matched AWS_*
// }
```

`{ layer }` is an optional visibility ceiling. The order is
`user < workspace < agent`: a profile is visible when its `trust` rank is at or
below the requested layer. Resolving a profile above the ceiling fails with
`layer_forbidden`. Omit `layer` to resolve the whole chain.

`explain(name, key)` returns `{ profile, key, found, denied, deniedBy }` plus,
when defined and not denied, `kind` (`var` or `secretRef`), `source`, `trust`,
`scope`, `overridden` (shadowed profile names) and either `value` (vars) or
`secretRef`. Denied keys never expose their value in `explain`.

Stable error codes include `invalid_profile`, `invalid_var_name`,
`invalid_secret_ref`, `invalid_proxy`, `invalid_deny`, `invalid_profile_name`,
`profile_not_found`, `inherit_cycle`, `layer_forbidden`, `invalid_layer`,
`state_invalid` and `state_write_failed`.

## Persistence

Set an optional JSON state file:

```js
apply(ctx, { stateFile: '/home/me/.dsh/root/profiles.json' })
```

Profiles are written atomically (temporary file in the same directory, then
rename, mode `0600`) after every successful `set`/`remove`. A failed write rolls
the in-memory change back. The format is `{ "version": 1, "profiles": [...] }`;
corrupt or invalid state fails loudly with `state_invalid` instead of silently
discarding data.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `root_set` | Create or replace a profile (`name` + `profile`) |
| `root_get` | Read one profile; throws `profile_not_found` |
| `root_list` | List all profiles |
| `root_resolve` | Resolve one profile, with optional `layer` |
| `root_explain` | Explain one key's source, overrides or deny decision |

All five tools are ledger operations: they never modify `process.env`. The
plugin injects the `tools` service for registration but the service itself is
usable without it.

## Security and limitations (0.1.0)

- No environment injection, no proxy installation, no credential resolution.
  **Nothing in this release changes what a shell, child process or HTTP client
  sees.**
- `trust` and `scope` are descriptive metadata, not an enforcement boundary in
  0.1.0. Do not treat a self-declared `trust: 'user'` as proof of provenance.
- Only references belong in `secretRefs`. Accidentally putting a secret in
  `vars` is outside Root's protection.
- No snapshot, diff, CLI, Settings UI, TOFU pinning or team baselines yet.

## Test

```sh
cd packages/root
node --test
```

## License

MIT.
