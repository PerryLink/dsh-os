# Kit · `dsh-os-kit`

> One install for the six core dsh-os modules: Act, Allow, Snip, Check, Kernel and Shell.

**Status: 0.5.0 experimental — dependency-only meta bundle, no business code.**

`dsh-os-kit` is a thin Cordis bundle. It installs six independently versioned
modules and mounts them through one insert patch:

| Module | Package | Host seam |
| --- | --- | --- |
| Act | `dsh-act` | `ctx.act` |
| Allow | `dsh-allow` | `ctx.allow` |
| Snip | `dsh-snip` | `ctx.snip` |
| Check | `dsh-canary` | `ctx.check` |
| Kernel | `dsh-os-kernel` | `ctx.kernel` |
| Shell | `dsh-os-shell` | `ctx.osShell` |

The kit registers no service, no capability and no agent tool. Its `index.js`
is an empty plugin entry kept so the package is a valid bundle; every behavior
belongs to the six modules above. **The kit contains no business code.**

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install all six at once

```sh
dsh plugin --profile web add dsh-os-kit
```

The kit's dependencies bring in Act, Allow, Snip, Check, Kernel and Shell, and
its `cordis.patch.yml` mounts all six in a single `insert`. The kit ships no
`config`, so each module keeps its own defaults and can still be overridden by
id from the profile's patch layer.

## Install individually

Every module is also a standalone package, so you can install only what you
need:

```sh
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
dsh plugin --profile web add dsh-snip
dsh plugin --profile web add dsh-canary
dsh plugin --profile web add dsh-os-kernel
dsh plugin --profile web add dsh-os-shell
```

Use the kit for the whole set, or install only the modules you need. Modules
added directly to the profile remain independent of the kit.

## Removing the kit

```sh
dsh plugin --profile web remove dsh-os-kit
```

Removing the kit does **not** affect modules you installed individually: they
are direct profile dependencies and stay installed. Modules that only arrived
as kit dependencies may be pruned with the kit.

## The dependency exception

The dsh-os module contract forbids runtime dependencies. **The kit is the
documented exception** (`"kit": true` in its manifest): it contains no runtime
logic, and its six `dependencies` are exactly the modules it mounts. The ranges
are compatible semver ranges, not pins: `dsh-act ^0.3.0`, `dsh-allow ^0.4.0`,
`dsh-snip ^0.2.0`, `dsh-canary ^0.3.0`,
`dsh-os-kernel ^0.2.0` and `dsh-os-shell ^0.3.0`, so each
module keeps its own release cadence.

## Requirements

Node.js 22.19+ or 24.9+, and DSH `>=0.2.1-rc.2 <0.3.0-0`. The six modules must
be resolvable; installing the kit handles that through its dependencies.

## License

MIT.
