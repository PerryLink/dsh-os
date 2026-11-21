# dsh-os 0.4 发布说明 / Release notes

> **版本：** 0.4.0 · 2026-11-21 · MIT · 独立社区项目，**Not affiliated with DeepSeek**
> **兼容：** DSH `>=0.2.1-rc.2 <0.3.0-0` · Node `^22.19.0 || >=24.9.0`
> **范围：** npm 上可安装的 0.4.0。仓库 `main` 之后的 0.4.1 提交（A2A 原型、
> 真模型评测运行器）不在这份说明里。
>
> 数字与能力边界以 2026-11-21 的实际包和测试为准；外部验证进度见
> [`../validation/STATUS.md`](../validation/STATUS.md)。

## 中文

### 0.4 能做什么

- **一次装四个核心模块。** `dsh-os-kit@0.4.0` 依赖并挂载 Act 0.3、Allow 0.4、
  Snip 0.2、Check 0.3；每个模块仍可单独安装、单独配置。
- **一次性授权闭环。** Allow 0.4 支持 `request` → 人类 `approve` → `Grant` →
  `check` 消费；Grant 有 TTL（默认 24h，最长 30 天）、scope 和本地审计。默认
  一次批准只放行一次（`maxUses=1`），可显式放宽到 100；重放会被拒绝，可选 JSON
  状态文件持久化。
- **真实文件动作。** Act 0.3 提供 `fs.read` / `fs.write` / `fs.list` / `fs.undo`，
  路径限制在 workdir；写前可 `preview`，写动作需要 Allow Grant；undo 仅对 5 分钟
  内的单次写有效。
- **回归门。** Check 0.3 可用 `dsh-check run` 启动 headless 任务，再对 result /
  trajectory / cost / approvals 做四维 diff，回归时 exit 1。`check_run` 需要
  Grant，有每小时运行数上限、脱敏环境和审计。
- **可选模块。** Trigger 0.3、Seek 0.3、Trace 0.3、Ring 0.3、Kernel 0.2、
  MCP 0.2、Shell 0.3 可按需安装；Kernel 把 76 个 legacy 工具适配成
  `legacy.*`，并提供 `os_*` 动词。
- **本地优先。** 默认无遥测；除 Check 的模型调用、Trigger/Ring 的显式外发外，
  运行时代码不主动联网。

### 0.4 不能做什么

- **不是沙箱。** Allow 是控制面，只记录/回答“谁批准了什么、多久、什么范围”；
  它不能阻止同进程代码绕过检查，也不替代 DSH 的 approval、permission rules、
  presets 或 OS sandbox。
- **不是安全审计。** 没有第三方审计或渗透测试；被市场收录也不等于安全审查。
- **不是全平台已验证。** 原生剪贴板/窗口路径是实验性的；本机只在 Linux 做了
  smoke，macOS 真机与 Windows 剪贴板没有在本轮重新验证。
- **不是真模型成绩。** 仓库里的 6/6 是脚本策略基线（P 层），不是模型能力；
  真模型 A 层评测尚未运行（本机没有模型 key）。
- **不覆盖 DSH 0.3+。** `engines.dsh` 的上限是 `<0.3.0-0`。
- **没有完整权限中心 UI。** Shell 0.3 提供审批收件箱和活动流，不是企业级
  permission center。

### 安装

```sh
# 推荐：四个核心模块（npm origin 可解析）
dsh plugin --profile web add dsh-os-kit@0.4.0

# 或只装需要的
dsh plugin --profile web add dsh-allow@0.4.0
dsh plugin --profile web add dsh-canary@0.3.0
```

- `--profile web` 只是示例；换成你的实际 profile。
- 国内镜像可能滞后；解析不到 0.4.0 时用
  `--registry=https://registry.npmjs.org/` 再试，不要改包名。
- 干净 profile 的真实安装仍在外部验证中（**0/3**）；上面的命令是文档化的
  安装路径，不是“已被外部用户验证”的证明。
- 不装 profile 也能跑 API 演示（需要 Node 22+）：

```sh
git clone https://github.com/PerryLink/dsh-os
cd dsh-os
node examples/os-kit/demo.mjs
```

演示输出 `PASS: 6/6`（拒绝 → 签发 → 放行 → 撤销 → 再拒绝）。它证明 API 语义，
不证明 OS 原生能力已经接好。

### 已知限制

1. **Allow 的边界：** `request`/`approve` 默认一次性、进程内同步消费；legacy
   `issue` 不传 `maxUses` 时仍是无上限。管理工具默认不暴露给模型；
   `stateFile` 是可选的本地 JSON，不是防篡改账本。
2. **Act 的边界：** `fs.*` 只在 workdir 允许目录内；undo 只覆盖单次写、5 分钟内、
   最多 16 条 / 每条约 1 MiB 的内存记录。
3. **Check 的边界：** 真实 run 需要 DSH checkout/CLI 和模型 key；headless 没有
   实时审批人；运行数/成本上限是保护，不是计费系统。
4. **Kernel 的缺口：** `os_do` 需要宿主显式交付 Grant；`os_observe` 不会自动刷新
   已批准的 request。
5. **平台前置：** Snip 默认不读剪贴板，需显式开启 capture；Linux 需要
   `wl-paste` 或 `xclip`，macOS 受 TCC 权限约束。Stage 的原生移动/缩放默认不启用。
6. **包与镜像：** `dsh-os-kit@0.4.0` 的依赖解析已在 npm origin 上做过 dry-run；
   npmmirror 当时还是旧版本。发布前请以 origin 为准。

---

## English

### What 0.4 can do

- **One install for four core modules.** `dsh-os-kit@0.4.0` depends on and mounts
  Act 0.3, Allow 0.4, Snip 0.2 and Check 0.3. Every module remains independently
  installable and configurable.
- **A one-time authorization loop.** Allow 0.4 supports `request` → human
  `approve` → `Grant` → consuming `check`. Grants carry a TTL (24h default, 30
  days max), a scope and a local audit log. Approval defaults to a single use
  (`maxUses=1`, up to 100); replay after the budget is spent is denied. Optional
  JSON state persists across restarts.
- **Real filesystem actions.** Act 0.3 provides `fs.read` / `fs.write` /
  `fs.list` / `fs.undo`, confined to the workdir. Writes can be previewed and
  require an Allow Grant; undo is limited to one write within five minutes.
- **A regression gate.** Check 0.3 runs headless tasks with `dsh-check run` and
  diffs result, trajectory, cost and approvals, exiting 1 on a regression.
  `check_run` requires a Grant, has an hourly run budget, a sanitized environment
  and an audit entry.
- **Optional modules.** Trigger 0.3, Seek 0.3, Trace 0.3, Ring 0.3, Kernel 0.2,
  MCP 0.2 and Shell 0.3 can be installed separately. Kernel adapts 76 legacy
  tools as `legacy.*` and exposes the `os_*` verbs.
- **Local-first.** No telemetry by default. Apart from model calls made by Check
  and explicit Trigger/Ring egress, the runtime does not initiate network calls.

### What 0.4 cannot do

- **It is not a sandbox.** Allow is a control plane: it records and answers who
  approved what, for how long and under which scope. It cannot stop same-process
  code from bypassing the check, and it does not replace DSH approvals,
  permission rules, presets or the OS sandbox.
- **It is not a security audit.** There is no third-party audit or penetration
  test. A marketplace listing is not a security review.
- **It is not validated on every platform.** Native clipboard/window paths are
  experimental. This round only ran Linux smoke; macOS hardware and Windows
  clipboard were not re-verified.
- **It is not a real-model result.** The 6/6 in the repo is a scripted policy
  baseline (P layer), not model capability. The real-model A-layer evaluation has
  not run (no model key on this machine).
- **It does not cover DSH 0.3+.** The `engines.dsh` upper bound is `<0.3.0-0`.
- **There is no full permission-center UI.** Shell 0.3 provides an approval inbox
  and an activity feed, not an enterprise permission center.

### Install

```sh
# Four core modules (resolvable on the npm origin)
dsh plugin --profile web add dsh-os-kit@0.4.0

# Or install only what you need
dsh plugin --profile web add dsh-allow@0.4.0
dsh plugin --profile web add dsh-canary@0.3.0
```

- `--profile web` is an example; use your actual profile.
- Mirrors may lag. If 0.4.0 cannot be resolved, retry with
  `--registry=https://registry.npmjs.org/`; do not rename the package.
- A real clean-profile install is still being validated externally (**0/3**);
  the commands above are the documented path, not proof that an external user
  has run them.
- The API demo needs no DSH profile (Node 22+):

```sh
git clone https://github.com/PerryLink/dsh-os
cd dsh-os
node examples/os-kit/demo.mjs
```

`PASS: 6/6` (deny → issue → allow → revoke → deny) demonstrates API semantics,
not native OS integration.

### Known limitations

1. **Allow:** `request`/`approve` default to a single use, consumed synchronously
   in-process; the legacy `issue` path without `maxUses` is still unlimited. Admin
   tools are hidden from the model by default; `stateFile` is an optional local
   JSON file, not a tamper-proof ledger.
2. **Act:** `fs.*` stays inside the workdir allowlist; undo covers one write
   within five minutes, up to 16 entries of about 1 MiB each.
3. **Check:** a real run needs a DSH checkout/CLI and a model key; headless has no
   live approver; the run/cost budgets are guardrails, not billing.
4. **Kernel:** `os_do` needs the host to deliver a Grant explicitly;
   `os_observe` does not refresh an approved request automatically.
5. **Platform prerequisites:** Snip never reads the clipboard unless capture is
   enabled; Linux needs `wl-paste` or `xclip`, macOS is subject to TCC. Stage's
   native move/resize is opt-in.
6. **Packages and mirrors:** `dsh-os-kit@0.4.0` dependency resolution was
   dry-run against the npm origin; npmmirror was still serving older versions at
   the time. Check the origin before publishing.
