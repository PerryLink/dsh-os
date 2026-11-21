# awesome-dsh-plugin 提交包（单条：Allow）

> **状态：已准备，未提交。** 本文件是提交包，不是 PR。只投 **1 条**；不手改
> 生成的 README；不发官方 Discussions；不向 `dsh-market` 提条目 PR。
>
> **事实核对时间：** 2026-11-21 17:34 +08（Asia/Shanghai）。提交前按 §0 重跑一遍。
> **披露：** 维护者是 PerryLink。独立社区项目，**Not affiliated with DeepSeek**。

## 0. 提交前门槛（缺一不投）

| 检查 | 实测值 | 怎么复核 | 结论 |
|---|---|---|---|
| 仓库 public、未归档 | public，`archived: false` | GitHub API `repos/PerryLink/dsh-os` | ✅ |
| 仓库创建满 **24 小时** | 创建 `2026-11-20T13:21:58Z`；24h 门槛 `2026-11-21T13:21:58Z`（**21:21:58 +08**）。写稿时 20.2h | API 的 `created_at` + 24h | ⏳ **21:22 后再投** |
| `dsh-plugin` topic | 已有（另有 `dsh`、`deepseek-harness` 等） | 仓库 About / API `topics` | ✅ |
| 子包 `dsh.bundle` | `packages/allow/package.json` 有 `dsh.bundle.patch`，同目录有 `cordis.patch.yml` | `node -p "require('./packages/allow/package.json').dsh.bundle"` | ✅ |
| npm 版本 = 仓库版本 | 两者都是 `0.4.0`（npm origin） | `npm view dsh-allow version --registry=https://registry.npmjs.org/` | ✅ |
| 真实代码 | 有 `index.js` + `lib/core.js` + 34 个测试；npm tarball 含 `lib/core.js` | `npm pack dsh-allow@0.4.0 --dry-run` | ✅ |
| 不是纯聚合包 | 投的是单个产品包 Allow，不是 `dsh-os-kit` | — | ✅ |
| 未收录过 | `data/plugins/PerryLink__dsh-os.yml` 与 `...--packages-allow.yml` 均返回 404（无历史提交） | GitHub contents + commits API | ✅ |
| 只 1 条 | 本 PR 只新增 1 个 YAML，不动其他条目 | `git diff --stat` | ✅ |

**年龄说明（别被“日历一天”骗了）：** 仓库在 2026-11-20 晚上创建，按日历已跨到
第二天；但 awesome 的 CI 用的是**精确 24 小时**（`MIN_AGE_DAYS = 1`）。写稿时还差
约 4 小时。**21:22 前提交会先红，CI 到点自动重跑并转绿；不要关闭/重开 PR，也不要
推空提交。**

## 1. 唯一改动：新增 1 个 YAML

文件：`data/plugins/PerryLink__dsh-os--packages-allow.yml`

```yaml
url: https://github.com/PerryLink/dsh-os/tree/main/packages/allow
name: PerryLink/dsh-os#allow
category: security
description:
  en: 'Revocable, expiring capability grants with scope and a local audit trail for DSH plugins and out-of-turn authorization checks.'
  zh: '可撤销、可过期的能力授权，带范围和本地审计记录，供 DSH 插件与回合外操作做授权检查。'
```

不要加 `icon:`（目前没有 GitHub 托管的方形位图）、不要加 `tarball:`（npm 已发布，
优先 npm）、不要写 `npm:` 字段（目录自动采集）。`description` 里的英文含 `: ` 的
风险已用单引号规避，保持原样。

## 2. PR 标题

```text
Add PerryLink/dsh-os#allow (security)
```

分类 `security` 来自 awesome 的合法分类表；`name` 与条目一致，维护者不用猜。

## 3. PR 正文（复制即用）

~~~~markdown
## What

Adds one entry for `dsh-allow`, a package in the `PerryLink/dsh-os` monorepo:

`data/plugins/PerryLink__dsh-os--packages-allow.yml`

```yaml
url: https://github.com/PerryLink/dsh-os/tree/main/packages/allow
name: PerryLink/dsh-os#allow
category: security
description:
  en: 'Revocable, expiring capability grants with scope and a local audit trail for DSH plugins and out-of-turn authorization checks.'
  zh: '可撤销、可过期的能力授权，带范围和本地审计记录，供 DSH 插件与回合外操作做授权检查。'
```

## Why it meets the bar

- The subpackage declares `dsh.bundle.patch` and ships `cordis.patch.yml`.
- Install command: `dsh plugin --profile web add dsh-allow`. Declared compatibility:
  DSH `>=0.2.1-rc.2 <0.3.0-0`, Node `^22.19.0 || >=24.9.0`.
- The description is checked against the code: grants have TTL and scope, and
  support `check`, `revoke`, `list` and a local audit log. Requests are approved
  by a human, and a grant may carry a use budget (approval defaults to one use).
  A replayed call after the budget is spent is denied.
- It does **not** claim to be a sandbox, and it does not claim to stop
  same-process code that bypasses the check. It does not replace DSH's approval
  prompt, permission rules, presets or OS sandbox.
- No network access and no telemetry in the runtime. State is in memory by
  default, with an optional local JSON file written with a temp-file + rename.

## Scope

One entry only. This PR does not touch any other entry and does not edit the
generated READMEs. The other packages in the monorepo are not part of this PR.

## Disclosure

I maintain this package. It is an independent community project, **not
affiliated with DeepSeek**; nothing here claims official status or endorsement.
DeepSeek and DeepSeek Harness are trademarks of their respective owners.
~~~~

## 4. 描述逐句核对（维护者会看，我们先自己做）

| 描述里的说法 | 代码依据 | 边界（不要越界解释） |
|---|---|---|
| revocable | `AllowService.revoke()` | 撤销是**前向**的；已发生的动作不会回滚 |
| expiring | `ttlMs`，默认 24h，最大 30 天 | 过期后 `check` 返回拒绝 |
| scope | `normalizeScope` / `scopeCovers`；支持 `*`、精确值、`prefix:*`、数组 | 匹配不等于沙箱；默认 `*` 是宽范围 |
| local audit trail | `audit()` / `auditStats()`；可选 `stateFile` | 默认内存；不是防篡改账本 |
| out-of-turn authorization checks | `ctx.allow`、`request`/`approve`、`allow_check` | 默认只暴露 4 个模型工具；管理工具在 `exposeAdminTools` 后面 |

**不要写进条目/PR 的词：** permission center、sandbox、secure、official、
best、prevents malicious plugins、audit-proof、enterprise-grade。

## 5. 提交操作（人工执行；本文件不代为发 PR）

```sh
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
git checkout -b add-perrylink-dsh-os-allow

# 新建 data/plugins/PerryLink__dsh-os--packages-allow.yml，内容见 §1
git add data/plugins/PerryLink__dsh-os--packages-allow.yml
git commit -m "Add PerryLink/dsh-os#allow (security)"
git push -u origin add-perrylink-dsh-os-allow
```

然后在 GitHub 用 §2 标题、§3 正文开 PR。**只开 1 条。**

## 6. 提交前检查清单

- [ ] 已在 **21:22 +08 之后**（或接受 CI 先红、到点自动转绿）
- [ ] `git status` 干净；分支从最新 `main` 拉出
- [ ] `git diff --stat main` 只有 1 个新增 YAML
- [ ] YAML 可解析；`name` 为 `PerryLink/dsh-os#allow`，`url` 指向子目录
- [ ] npm `dsh-allow` 版本是 `0.4.0`，与仓库 `packages/allow/package.json` 一致
- [ ] 仓库有 `dsh-plugin` topic；子包 `dsh.bundle.patch` + `cordis.patch.yml` 都在
- [ ] 描述只写 TTL/scope/check/revoke/audit/out-of-turn；没有 sandbox/official 等词
- [ ] 没有手改 README、没有改别人的条目、没有加第 2 条
- [ ] PR 正文含 “not affiliated with DeepSeek” 披露
- [ ] 不在 PR 里 @ 维护者、不私信、不催 merge
- [ ] 合并后 24h 再查 catalog / dsh-market；没出现先等构建，不重复投

## 7. 合并后（只做这些）

1. 确认 `data/plugins/PerryLink__dsh-os--packages-allow.yml` 在 `main`。
2. 等 catalog 自动构建，按 [`dsh-market.md`](dsh-market.md) 的 §5 验证。
3. **第一条合并前不投 Act/Trigger**；合并后也一次只开一条，不把三条塞进一个 PR。

如果被 `held: author`：按评论改，推同一个分支，留**一条**评论说明改了什么；不要
反复催，也不要重开 PR。
