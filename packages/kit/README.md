# Kit · `dsh-os-kit`

> One install for the four core dsh-os modules: Act, Allow, Snip and Check.

**Status: 0.1.0 experimental — dependency-only meta bundle, no business code.**

`dsh-os-kit` is a thin Cordis bundle. It installs four independently versioned
modules and mounts them through one insert patch:

| Module | Package | Host seam |
| --- | --- | --- |
| Act | `dsh-act` | `ctx.act` |
| Allow | `dsh-allow` | `ctx.allow` |
| Snip | `dsh-snip` | `ctx.snip` |
| Check | `@perrylink/dsh-check` | `ctx.check` |

The kit registers no service, no capability and no agent tool. Its `index.js`
is an empty plugin entry kept so the package is a valid bundle; every behavior
belongs to the four modules above.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install all four at once

```sh
dsh plugin --profile web add dsh-os-kit
```

The kit's dependencies bring in Act, Allow, Snip and Check, and its
`cordis.patch.yml` mounts all four in a single `insert`. The kit ships no
`config`, so each module keeps its own defaults and can still be overridden by
id from the profile's patch layer.

## Install individually

Every module is also a standalone package, so you can install only what you
need:

```sh
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
dsh plugin --profile web add dsh-snip
dsh plugin --profile web add @perrylink/dsh-check
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
exception**: it contains no runtime logic, and its four `dependencies` are
exactly the modules it mounts. All ranges are `^0.1.0` (compatible semver
ranges, not pins), so Act, Allow, Snip and Check keep their own release
cadence.

Because the current repo gates reject a bundle with non-empty `dependencies`,
`scripts/conformance.mjs` and `scripts/check-versions.mjs` report `dsh-os-kit`
as a failure until the exemption lands. **The kit is the exception: the root
will exempt `dsh-os-kit` in the gate later** (root 后续在 gate 里豁免 `dsh-os-kit`).
The kit does not modify those scripts.

## Requirements

Node.js 22.19+ or 24.9+, and DSH `>=0.2.1-rc.2 <0.3.0-0`. The four modules
must be resolvable; installing the kit handles that through its dependencies.

## License

MIT.
