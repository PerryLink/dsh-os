# 0.2.0 local smoke (2026-11-20, Linux)

This is **maintainer smoke evidence**, not user validation. No external user has
been interviewed or installed the toolkit yet.

| Check | Command | Result |
|---|---|---|
| Unit + integration | `node scripts/test-all.mjs` | 21 suites, 0 failed |
| Conformance | `node scripts/conformance.mjs` | 20 packages, 0 error / 0 warning |
| Pack | `node scripts/pack-smoke.mjs` | 20 packages, 0 failed |
| Versions | `node scripts/check-versions.mjs` | 20 packages, 0 failed |
| OS kit demo | `node examples/os-kit/demo.mjs` | 6/6 PASS |
| Check gate demo | `bash examples/os-kit/check-demo/run-check-demo.sh` | `REGRESSION`, inner exit 1 |
| Kit install | `dsh plugin add dsh-os-kit@0.1.0` | 5 packages, 4 patch rows in `--dump-config` |
| Catalog CLI | `node packages/cli/bin/dsh-os.js list` | 18 entries, versions correct |

## Platform reality on this machine

- **Snip**: `ClipboardAdapter.available()` → `{ available: false, reason:
  'clipboard unsupported on linux' }` (no `wl-paste`/`xclip` on this box).
  Windows WinRT and macOS `pbpaste` paths are covered by mocked runner tests,
  not by a real clipboard read here.
- **Stage**: `listAdapters()` exposes macOS/Windows/mock; on Linux only `mock`
  is usable. Windows adapter was reported passing on a Windows machine by the
  implementation agent; macOS was **not** tested on hardware.
- **Check runner**: tested with an injected `spawn` mock. A real run needs a
  DSH checkout, a profile and a model key; not run here.
- **Seek**: locator/memento providers tested with mocks; neither service is
  installed in this profile, so the real path is unverified.
- **Trigger**: agent/fs/webhook sources tested with fake contexts and a temp
  directory; no public webhook port opened.
- **Shell UI**: host API tested with a fake web server; `ui/client.js` passes
  `node --check`; no browser E2E.

## What this means

- The **integration contract and failure paths** are tested.
- The **real OS/model paths** are best-effort and need platform smoke:
  Windows clipboard, macOS AX/TCC, real DSH headless run.
- User validation is still 0/10; see [PLAN.md](PLAN.md).
