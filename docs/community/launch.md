# dsh-os 社区发布手册

> **范围：** 官方 GitHub Discussions、`awesome-dsh-plugin` 收录、`dsh-market` 上架。
> **本文只写文档，不发帖、不私信、不提交 PR。** 所有对外动作由维护者在核对后手动执行。
> **基线日期：** 2026-11-20（仓库与 npm 包的实际状态以执行当天为准）。
> **一句话原则：** **没有可运行 demo 就不发；不是官方就显著写清楚；一个项目一条讨论；不刷票。**

---

## 0. 发布前事实表

写任何文案之前，先按这张表核对一遍。表中的数字会漂移，**执行当天重新跑一遍**，
不要把本文当现值引用。

| 事实 | 当前值 | 怎么核对 |
|---|---|---|
| 仓库 | `https://github.com/PerryLink/dsh-os` | 浏览器打开，确认 public |
| 产品包 | 11 个（act / allow / snip / check / nest / trigger / seek / trace / stage / ring / root） | `ls packages` + 各包 `package.json` |
| npm 可安装版本 | 11 个产品包均为 `0.1.x` | `npm view <pkg> version` |
| Node | 22.19–22.x（或 24.9+） | 各包 `engines.node` |
| DSH | `>=0.2.1-rc.2 <0.3.0-0` | 各包 `engines.dsh` |
| 演示 | `node examples/os-kit/demo.mjs` → `PASS: 6/6` | 在仓库根目录实跑 |
| Check 演示 | `bash examples/os-kit/check-demo/run-check-demo.sh` → `PASS` | 需要 bash（Windows 用 Git Bash 或 WSL） |
| 终端卡片 | `docs/assets/check-demo.svg` | 确认已提交到 `main`，raw 链接返回 200 |
| 遥测 | 无（运行时代码无网络调用） | 读 [`docs/telemetry.md`](../telemetry.md)，复跑 grep |
| 许可 | MIT | `LICENSE` |
| 仓库年龄 | 2026-11-20 创建 | **2026-11-21 之后**才满足 awesome 的 1 天门槛 |

**两个硬门槛：**

1. **官方帖：** 演示链接必须可访问、安装命令在干净 profile 上成功、正文里的每个
   “能做 X”都能在 README/代码里找到对应。否则不发。
2. **awesome PR：** 仓库创建满 1 天（CI 自动检查）+ 每个包有 `dsh.bundle` +
   仓库有 `dsh-plugin` topic。否则不投。

---

## 1. 官方 Discussions 帖（Show Your Plugins!）

### 1.1 发在哪里、遵守什么

- 目标：`deepseek-ai/deepseek-harness` → Discussions → **Show Your Plugins!**
- 置顶规则（[Discussion #2004](https://github.com/deepseek-ai/deepseek-harness/discussions/2004)）：
  - **一个主题只介绍一个项目。**
  - 项目必须与 DSH 有实际集成；无关推广、蹭名称、重复发布会被删除。
  - 标题统一：`DSH｜项目名称｜一句话说明用途`。
  - 正文要有项目地址、简短介绍、截图/GIF/视频、与 DSH 的集成方式。
  - **显著注明非官方。**
  - 排序只看社区 Upvote，不代表官方审核或推荐。
- 我们对“一个项目”的理解：**dsh-os 是一个仓库、一个项目**，11 个包是这个项目里
  可独立安装的组件，不是 11 个无关项目拼盘。正文第一段就说明这一点，避免被当成
  批量推广。
- 如果维护者认为应按“一个包 = 一个项目”拆分：**不要争辩**，把本帖改成只介绍
  Act（或 Allow），其余包另开帖，每帖间隔至少 3 天，绝不一天连发。

### 1.2 标题

```text
DSH｜dsh-os｜11 个可组合的 OS 原语：动作、授权、触发器与回归门（0.1.x 协议层 MVP，非官方）
```

标题核对：

- 以 `DSH｜` 开头，符合中文模板的全角分隔符。
- 第二段是项目名 `dsh-os`。
- 第三段是一句话用途，没有“最强 / 唯一 / 官方”等词。
- 结尾标注 `非官方`，与正文的 disclosure 一致。

### 1.3 正文（复制即用）

> 发布前确认图片链接返回 200。当前示例用已提交的 `docs/assets/check-demo.svg`；
> 如果 GitHub 不渲染 SVG，先导出 PNG 或录 10 秒 GIF，换成新链接，不要贴坏图。

~~~markdown
> **非官方项目**，由社区成员独立开发和维护，与 DeepSeek 无隶属关系，也未获得
> DeepSeek 的审核、认证或背书。
> **Not affiliated with DeepSeek.** DeepSeek 和 DeepSeek Harness 是其各自权利人的商标。

**项目地址：**
https://github.com/PerryLink/dsh-os

**项目介绍：**

dsh-os 是**一个仓库、一个项目**：把 Agent 操作系统里最容易被每个插件各自造轮子的
11 件事，做成 11 个可独立安装的 DSH 插件——动作注册、可撤销授权、剪贴板账本、
回归金丝雀、工作区档案、事件触发器、证据检索、记忆治理、窗口拓扑、审批升级、
环境档案。

每个包只做一件事，通过 `ctx.*` seam 组合，不 fork DSH、不给宿主打补丁。可以只装
其中一个，也可以按需组合；卸载一个不会把其他包弄坏（契约要求，见
[docs/module-contract-v1.md](https://github.com/PerryLink/dsh-os/blob/main/docs/module-contract-v1.md)）。

**0.1.x 的边界（先说做不到的）：**

这 11 个包目前是**协议 / 服务层 MVP**，不是 11 个成品。原生适配器——macOS AX /
Windows Win32、真实剪贴板监听、DSH headless runner、fs/webhook/agent 事件源、
locator / library / memento provider、环境注入——都在 0.2.0 的路线图里。

现在就能跑通的端到端链路是三条：

1. **Act + Allow + Snip**：一次写动作被拒绝 → 人类签发 30 分钟 Grant → 同一个动作
   放行 → 撤销 Grant → 再次拒绝。每一步都有审计记录。
2. **Trigger**：内存内“事件 → 条件 → 动作”，带冷却和运行账本（不订阅宿主事件）。
3. **Check**：两份 run JSON 对比，结果回归时 CLI 以 `1` 退出，可以直接当 CI 门。

其余包在 0.1.x 提供的是 seam、对象和工具，原生接线要等 0.2.0。这个边界写在每个
包的 README 第一屏，欢迎按代码核对。

**与 DSH 的集成方式：**

- 标准 Cordis bundle：每个包都有 `dsh.bundle.patch` + `cordis.patch.yml`，用
  `dsh plugin --profile web add <包名>` 安装。
- Host seam：`ctx.act` / `ctx.allow` / `ctx.snip` / `ctx.triggers` / `ctx.evidence` /
  `ctx.trace` / `ctx.stage` / `ctx.ring` / `ctx.env`；其他插件用 `ctx.get(...)` 消费，
  不直接 import 彼此的包。
- Agent tools：每个包注册 1–6 个工具，命名前缀与 seam 一致；工具清单见各包 README。
- 运行环境：Node.js 22.19+（22.x）或 24.9+；`engines.dsh` 为
  `>=0.2.1-rc.2 <0.3.0-0`。0.1.x 的接口核对基线是 DSH `0.2.2-rc.4`（`ca33fd6`）。

**90 秒演示（不需要安装 DSH profile）：**

```sh
git clone https://github.com/PerryLink/dsh-os
cd dsh-os
node examples/os-kit/demo.mjs
```

核心输出（每次的 grant id / handle 会不同）：

```text
[4/6] write without a Grant is refused (fail closed)
  demo.write -> {"ok":false,"code":"grant_required","capability":"act:invoke:demo.write"}
  snip entries: 0 (execute() never ran)

[5/6] a human issues a 30-minute Grant; the same write now succeeds
  grant grant_<uuid> · status=active · ttl=30min · scope=*
  demo.write -> {"ok":true,"handle":"clipboard://<uuid>","redacted":false}

[6/6] revoke the Grant; the next write is refused again
  allow.check -> {"allowed":false,"reason":"revoked"}
  demo.write -> {"ok":false,"code":"grant_required"}

PASS: 6/6 steps — denied -> issued -> allowed -> revoked -> denied
```

演示只是终端里的 Node 脚本，不装任何东西、不联网；它证明的是 API 语义，不是
“OS 原生能力已经接好”。

第二个演示（Check 回归门，需要 bash）：

```sh
bash examples/os-kit/check-demo/run-check-demo.sh
```

![终端演示：dsh-check 报 REGRESSION 并以 1 退出](https://raw.githubusercontent.com/PerryLink/dsh-os/main/docs/assets/check-demo.svg)

**安装（先试这三个）：**

```sh
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
dsh plugin --profile web add dsh-trigger
```

11 个包的完整安装清单放在首评里，避免正文过长。

**安全与数据：**

- 本地优先：0.1.x 运行时代码没有网络调用，没有遥测；默认不采集任何使用数据。
  策略见 [docs/telemetry.md](https://github.com/PerryLink/dsh-os/blob/main/docs/telemetry.md)。
- Allow 是**控制面，不是沙箱**：它记录和回答“谁批准了什么、多久、什么范围”，
  不能阻止同进程代码绕过检查，也不替代 DSH 的 approval、permission rules、
  presets 或 OS sandbox。
- 装第三方插件会以你的权限运行代码；装之前请读源码，尤其是不熟悉的包。

**反馈：**

Bug / 功能请求请走仓库 issue 模板，附上安装方式、DSH 版本、Node 版本、日志和
最小复现步骤。不要在公开 issue 里贴 token、密钥或完整路径。

**License：** MIT。

感谢阅读。如果这个方向对你有用，欢迎在评论里说你的场景；不要求 star，也不要求
upvote——按你自己的判断来。
~~~

### 1.4 首评（作者自己发，发布后立刻补）

> 首评的作用是补全安装/兼容/限制，不是重复正文，也不是“求 upvote”。

~~~markdown
补充：完整安装清单、兼容矩阵和 0.1.x 的已知限制。

**11 个包（按需安装，不必全装）：**

```sh
dsh plugin --profile web add dsh-act
dsh plugin --profile web add dsh-allow
dsh plugin --profile web add dsh-snip
dsh plugin --profile web add dsh-nest
dsh plugin --profile web add dsh-trigger
dsh plugin --profile web add dsh-seek
dsh plugin --profile web add dsh-stage
dsh plugin --profile web add dsh-ring
dsh plugin --profile web add @perrylink/dsh-check
dsh plugin --profile web add @perrylink/dsh-root
dsh plugin --profile web add @perrylink/dsh-trace
```

`@perrylink/` 前缀不是随意加的：`dsh-check` / `dsh-root` / `dsh-trace` 这三个
非 scoped 名称被 npm 的近名保护拒绝，所以用了 scope；安装命令以上面为准。

**兼容矩阵：**

| 项 | 支持范围 | 备注 |
|---|---|---|
| Node | 22.19–22.x（或 24.9+） | 与各包 `engines.node` 一致 |
| DSH | `>=0.2.1-rc.2 <0.3.0-0` | 接口核对基线 `0.2.2-rc.4` |
| OS | Windows / macOS / Linux | Check 的 demo 需要 bash |
| 安装方式 | npm（推荐）、GitHub source、release tarball | 源码安装可能触发构建授权 |
| 遥测 | 无 | 0.1.x 不联网、不采集 |

**0.1.x 每个包现在到底能做什么（按代码，不按设计文档）：**

| 包 | 现在能做 | 现在不做 |
|---|---|---|
| `dsh-act` | 注册/列出/调用动作；`echo`/`now`/`list` 内置；写/危险动作查 `act:invoke:<id>` Grant | 面板、NL 路由、CLI、预览/撤销 |
| `dsh-allow` | 签发/检查/撤销/列出 Grant；TTL、scope、approver、evidence；审计；可选 JSON 状态 | 权限中心 UI；默认只暴露 `allow_check`，管理工具需显式开启 |
| `dsh-snip` | 显式记录剪贴板、搜索、secret 排除、`clipboard://` handle | 后台监听、系统剪贴板轮询、加密 |
| `@perrylink/dsh-check` | 对比两份 run JSON，回归时退出 1 | 启动 DSH、跑模型、读 session log（0.2.0） |
| `dsh-nest` | 版本化 workspace profile、diff、一级继承 | 读取 `nest.profile.yml`、应用到 workspace |
| `dsh-trigger` | 内存触发器、条件 DSL、冷却、运行账本、4 个工具 | 订阅宿主事件、fs/webhook/agent 源、重试/持久化 |
| `dsh-seek` | provider 协议、去重、排序、`dsh://` ref 校验 | 内置 provider（locator/library/memento/web） |
| `@perrylink/dsh-trace` | 内存记忆治理账本、4 个工具 | memento/向量库/SQLite；重启即丢 |
| `dsh-stage` | 拓扑/layout 协议、校验、记录 | 调原生窗口 API、真正移动窗口 |
| `dsh-ring` | 审批 SLA 状态机、tick、回执 | 发送通知；ack 不等于批准 |
| `@perrylink/dsh-root` | 环境档案账本、继承、deny、provenance、5 个工具 | 读写 `process.env`、注入 shell/子进程 |

**只想试一个的话：**

- 想看“授权”这条线：`dsh-act` + `dsh-allow`，跑 `node examples/os-kit/demo.mjs`。
- 想看 CI 回归门：`@perrylink/dsh-check`，跑 `bash examples/os-kit/check-demo/run-check-demo.sh`。
- 想看事件触发：`dsh-trigger`，在对话里让 Agent 调 `trigger_register` → `trigger_fire`
  → `trigger_runs`。

**装不上时先查这四件事：**

1. `dsh --version` 是否在 `>=0.2.1-rc.2 <0.3.0-0`；
2. `node --version` 是否 22.19+（22.x）或 24.9+；
3. profile 名是否写对（`--profile web` 只是默认示例）；
4. 安装日志里是否有 `allowBuilds` / 构建授权提示；有的话先看包是否提供了预构建 tarball。

仍然失败的话，开 issue 并附上：安装命令、DSH/Node 版本、OS、完整错误日志、复现步骤。
不要在 issue 里贴 token 或密钥。

**路线图：** 0.2.0 的重心是原生适配器和持久化，不是再加新包名。具体每包的“下一步”
写在各自 README 的 `0.2.0` 一节；以那里为准，不以本评论为准。
~~~

### 1.5 发帖后 48 小时

- **24 小时内：** 只回复评论，不主动私信、不在别人的帖子里贴链接、不要求互赞。
- **48 小时内：** 把高频问题补进 README / FAQ；如果是安装问题，先修文档，不急着
  发第二个帖。
- **不做的：** 删除负面评论、和质疑者争论、把“非官方”改成“官方合作”、在评论里
  放购买/赞助链接。
- **指标只记录不追逐：** views、upvotes、comments、install issue 数。Upvote 受
  发布时间和算法影响，不作为成功标准。

---

## 2. `awesome-dsh-plugin` PR

### 2.1 先核对规则（2026-11-20 读到的版本）

来源：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md` 与 README。

| 规则 | 对我们的影响 |
|---|---|
| 一个 PR 最多 **3 条**，鼓励 1 条 | 首次只投 **1 条**；后续一包一 PR，不打包 11 条 |
| 列表数据在 `data/plugins/<owner>__<repo>.yml`，README 是生成的 | **不要手改 README**；只加 YAML |
| monorepo 子包：`url` 指向子目录，`name` 用 `owner/repo#subname`，文件名 `owner__repo--packages-<name>.yml` | 我们的路径是 `packages/allow`，所以文件名是 `PerryLink__dsh-os--packages-allow.yml` |
| 仓库需声明 `dsh.bundle`（根包或子包） | 11 个产品包都有 `dsh.bundle.patch` + `cordis.patch.yml` |
| 仓库创建满 **1 天** | 2026-11-20 创建；**2026-11-21 之后**再投 |
| 仓库加 `dsh-plugin` topic | 投之前确认 |
| 描述必须与代码一致，不能夸大 | 见 §2.3 的逐句核对 |
| 纯聚合包不收 | 我们投的是单个产品包，不是 `dsh-os-kit` |
| 分类要贴合实际功能 | Allow → `security`；Act → `tools`；Trigger → `workflow` |

### 2.1.1 描述以 npm 上可安装的版本为准

维护者会按条目去装包。如果仓库里的版本高于 npm 上已发布的版本（本仓出现过
`package.json` 已到 0.1.2、npm 还是 0.1.1 的情况），**先发版，或者把描述收窄到
npm 版本真实具备的能力**。不要用仓库 HEAD 的功能去写条目——用户装到的是 npm 版本。

发布前跑一遍：

```sh
for p in dsh-allow dsh-act dsh-trigger; do
  printf '%-14s repo=%s npm=%s\n' "$p" \
    "$(node -p "require('./packages/${p#dsh-}/package.json').version")" \
    "$(npm view "$p" version)"
done
```

两列不一致时，按 §6 的检查项处理，不要带着差异提交。

### 2.2 第一条投哪个

**第一条：`dsh-allow`（category: `security`）。**

理由（按可核对的事实，不按“最强”）：

- 它填的是一个明确的空洞：DSH 的 `ctx.approval.request()` 在回合外直接 throw
  （`packages/interaction/user-approval/src/index.ts:243-254`），而 Allow 提供
  可过期、可撤销的 Grant 对象和 `allow_check`；
- 它不是 `dsh-actions` 的同类替代，分类不会和现有条目挤在一起；
- 演示闭环完整：拒绝 → 签发 → 放行 → 撤销 → 再拒绝，能逐句对到代码。

**第二条 / 第三条（等第一条合并后再分别开 PR，不合并到一个 PR）：**

- `dsh-act`，category `tools`；
- `dsh-trigger`，category `workflow`。

不要一次投 3 条，也不要在第一条还在 review 时开第二条——维护者是逐条读源码的，
批量提交只会让每条都读不细。

### 2.3 第一条 PR 的 YAML（逐字使用）

文件：`data/plugins/PerryLink__dsh-os--packages-allow.yml`

```yaml
url: https://github.com/PerryLink/dsh-os/tree/main/packages/allow
name: PerryLink/dsh-os#allow
category: security
description:
  en: 'Revocable, expiring capability grants with scope and a local audit trail for DSH plugins and out-of-turn authorization checks.'
  zh: '可撤销、可过期的能力授权，带范围和本地审计记录，供 DSH 插件与回合外操作做授权检查。'
```

逐句核对（维护者会做的检查，我们先自己做）：

| 描述里的说法 | 代码依据 | 不夸大的边界 |
|---|---|---|
| revocable | `AllowService.revoke()` | 撤销是前向的；已发生的动作不会回滚 |
| expiring | `ttlMs`，默认 24h，最大 30 天 | 过期后 `check` 返回拒绝 |
| scope | `normalizeScope` / `scopeCovers`，支持 `*`、精确值、`prefix:*`、数组 | 默认 `*` 表示全范围；匹配不等于沙箱 |
| local audit trail | `audit()` / `auditStats()`，可选 `stateFile` | 默认内存；不是防篡改账本 |
| for DSH plugins and out-of-turn checks | `ctx.allow` + `allow_check` | 默认只暴露只读工具；管理工具需显式开启 |

**不要写进描述的词：** permission center、sandbox、secure、official、best、
prevents malicious plugins、audit-proof、enterprise-grade。

### 2.4 PR 标题

```text
Add PerryLink/dsh-os#allow (security)
```

（近期同仓库的标题风格是 `Add <owner>/<repo>`，括号里标分类；这个标题与条目
`name` 一致，维护者不用猜。）

### 2.5 PR 正文（复制即用）

~~~markdown
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
- The repo is older than one day and has the `dsh-plugin` topic.
- The description is checked against the code: grants have TTL, scope, `check`, `revoke`, `list` and a local audit log. It does **not**
  claim to be a sandbox, and it does not claim to stop same-process code that
  bypasses the check.
- No network access and no telemetry in the runtime; state is in memory by
  default, with an optional local JSON file.

## Scope

One entry only. This PR does not touch any other entry and does not edit the
generated READMEs.

I maintain this package. It is an independent community project, **not
affiliated with DeepSeek**; nothing here claims official status or endorsement.
~~~

### 2.6 投递与 review 纪律

- 投之前：`git status` 干净；只新增 1 个 YAML；跑一次本地安装（干净 profile）。
- 投之后：**不要**在 PR 里 @ 维护者、不要私信、不要重复 push 空提交。
- 被 `held: author`：按评论改，推同一个分支，留**一条**评论说明改了什么；不要
  反复催。
- CI 失败先读日志：entry count、`dsh.bundle`、仓库年龄、awesome-lint。README
  生成冲突通常由维护者 rebase，不要自己手改 README。
- 合并后 **24 小时**再检查站点/市场是否出现；没出现先等构建，不要立刻开 issue。

---

## 3. `dsh-market` 提交清单

**先记住一件事：`dsh-market` 没有独立的插件投稿入口。**

它的 README 写得很清楚（`dsh-market/dsh-market` → “Submit your plugin”）：

> This repo is the market app, not the catalog. The plugin list comes from the
> curated `awesome-dsh-plugin` registry — to get your plugin listed in the
> market, open a PR **there** ... Please don't PR plugin entries against this
> repo.

所以 **不要**向 `dsh-market` 提插件条目 PR。正确路径是：先合并
`awesome-dsh-plugin` 的条目，市场会自动抓取（通常 1 天内）。

### 3.1 清单

| # | 项 | 怎么做 | 完成标准 |
|---|---|---|---|
| 1 | 先上 awesome | 按 §2 投 `dsh-allow`，等合并 | `data/plugins/PerryLink__dsh-os--packages-allow.yml` 在 `main` |
| 2 | `dsh.bundle` | 子包 `package.json` 有 `dsh.bundle.patch`，旁边有 `cordis.patch.yml` | CI 的 `dsh.bundle` 检查通过 |
| 3 | npm 关联 | `package.json` 的 `repository.url` 指回 `PerryLink/dsh-os`，`directory` 指 `packages/allow` | 市场能把 npm 包和条目关联 |
| 4 | topic | GitHub 仓库加 `dsh-plugin` | topic 页面可见 |
| 5 | 图标（可选） | `icon:` 用 GitHub 托管的 PNG/JPG/WebP，方形 | 不填则回退作者头像；不要用第三方图床/SVG |
| 6 | 截图（可选） | 在 `packages/allow/screenshots.json` 放 1–8 个仓库内相对路径 | 市场详情页能展示；不填则从 README 抽 |
| 7 | 等抓取 | 合并后打开 `https://awesome-dsh-plugin.com/plugins.json` 搜索 `dsh-os` | 条目出现；通常 1 天内 |
| 8 | 市场验证 | 装 `dshmarket`，在干净 profile 搜 `Allow`，点一次安装 | 安装成功、重启后仍在 |
| 9 | 失败排查 | 看市场诊断页/日志，确认版本和 DSH 兼容 | 不重复投条目；先修包 |

### 3.2 不要做

- 不要向 `dsh-market` 仓库提插件条目 PR（README 明确拒绝）。
- 不要手写 `npm:` 字段（会被校验拒绝；映射自动采集）。
- 不要为了“更快出现”重复提交同一条目或改别人条目。
- 不要在条目里写“官方推荐 / DeepSeek 合作 / 已验证安全”。
- 不要用 SVG 或第三方图床做 icon。
- 不要假设 listing = 安全审查；市场自己也这么写。

### 3.3 市场验证命令

```sh
# 安装市场（只需一次）
dsh plugin --profile web add dshmarket
# 重启 dsh web，然后 Plugins → Plugin Market / Discover 搜索 "Allow"

# 确认 catalog 已收录（把 URL 换成实际 JSON）
curl -s https://awesome-dsh-plugin.com/plugins.json | grep -o 'PerryLink/dsh-os#allow' | head -1
```

> `dsh-market` 只允许安装其 curated registry 里的来源；所以“先上 awesome”不是
> 可选项，是上架的前置条件。

---

## 4. 四周日历：demo → Discussions → awesome → 复盘

日期按 2026-11-20（周五）之后的周一开始；如果某一周的 gate 没过，**顺延一周，
不要跳过 gate**。

| 周 | 日期 | 主题 | 交付物 | 进入下一周的门槛 |
|---|---|---|---|---|
| **W1** | 2026-11-23 – 11-29 | **Demo** | 90 秒演示（GIF/MP4）+ 终端 PNG；两个 demo 在 Node 22 和 24 各跑一次；3 个锚点包在干净 profile 安装成功 | `demo.mjs` 6/6；`run-check-demo.sh` PASS；GIF ≤10 MB；画面无 token/路径/用户名 |
| **W2** | 2026-11-30 – 12-06 | **官方 Discussions** | §1 的帖子 + 首评；48 小时评论响应 | 仓库 public；demo 链接 200；标题符合 `DSH｜…｜…`；正文含非官方声明；只发 1 帖 |
| **W3** | 2026-12-07 – 12-13 | **awesome PR** | §2 的 1 条 YAML + PR；合并后检查 dsh-market | 仓库满 1 天；`dsh.bundle` 通过；干净 profile 安装成功；只 1 条；不手改 README |
| **W4** | 2026-12-14 – 12-20 | **复盘** | 一页复盘：数据、问题、决定 | 复盘写完并决定：继续投 Act/Trigger / 先修 0.2.0 / 暂停 |

### W1 — Demo（不发帖）

- 跑 `node examples/os-kit/demo.mjs`，确认 `PASS: 6/6`；跑 Check demo，确认
  `PASS` 且 CLI 退出码为 1。
- 在 Node 22.19+（22.x）与 Node 24.9+ 各跑一次（如果本机只有其中一个，记录实际版本，
  不要写“都测过”）。
- 在**干净 profile** 安装 `dsh-act` / `dsh-allow` / `dsh-trigger`，确认
  `dsh plugin add` 成功、重启后仍加载。
- 录屏：终端字号 ≥14，隐藏用户名/路径/令牌；先 `clear`，命令逐条输入；GIF 控制在
  90 秒内。
- 产出：`docs/assets/demo.gif`（或 release 附件）+ 一张 PNG 封面。
- **Gate：** 没有可播放的 demo 文件，不进入 W2。

### W2 — Discussions（只发 1 帖）

- 按 §1 复制正文，替换 demo 链接；先在自己的浏览器确认图片能显示。
- 发布后立刻补首评；首评不要重复正文。
- 24 小时内只回复，不主动私信；48 小时内把高频问题补进 README。
- **Gate：** 如果评论指出“这不是一个项目”或“别打包推广”，按 §1.1 的拆分预案
  处理，不要争辩；拆分后每帖间隔 ≥3 天。

### W3 — awesome（一次 1 条）

- 2026-11-21 之后才满足仓库年龄；W3 时肯定满足。
- 只投 `dsh-allow`；等合并后再考虑 Act，不要同周连投。
- 合并后 24 小时检查 catalog 与 dsh-market；没出现先等，不重复投。
- **Gate：** 第一条 PR 没合并，不投第二条；如果被拒，先按评论修描述/分类，再重投。

### W4 — 复盘（不新增对外动作）

回答五个问题，写进 `docs/community/retro-YYYY-MM.md`（如果维护者同意再建）：

1. 官方帖带来了什么：views / upvotes / comments / 真实安装问题各多少？
2. 哪条安装路径失败最多：DSH 版本、Node 版本、profile、构建授权？
3. awesome PR 的状态：merged / held / closed；原因是什么？
4. dsh-market 是否收录？一键安装是否成功？
5. 哪 1 个包被真实使用最多？0.2.0 应该先补哪个适配器？

**Decide：** 继续（投 Act/Trigger + 补适配器）／ 只修 0.2.0（暂停新帖）／ 停（把
仓库标为 experimental，不再推广）。不要因为“已经发了”就继续发。

---

## 5. 不要做

### 5.1 私信群发

- 不群发 DM、不批量 @、不在别人的 discussion/issue 下贴自己的链接。
- 不私信维护者求 merge / 求 star / 求 upvote / 求转发。
- 不建“互赞群”、不买 star、不刷 upvote。官方排序只看 Upvote，刷票既违反平台
  规则，也会让项目看起来不可信。
- 需要跟进时：在**自己的帖子/PR** 里留一条评论，等对方回复；不跨线程催。

### 5.2 冒充官方

- 不写“官方 / official / DeepSeek 团队 / 官方合作 / 官方认证 / 官方推荐”。
- 不用 DeepSeek 的头像、Logo、品牌色做项目身份；不用“DeepSeek”作为产品名、
  包名、域名、社交账号名。
- 不在标题/描述里暗示“DeepSeek 出品”或“获得授权”。
- README、package description、帖子、PR 正文都必须有
  **“Not affiliated with DeepSeek.”** 或等价中文声明。
- 介绍 DSH 时用**提名性使用**（nominative use）：例如“for DeepSeek Harness”
  “DSH 插件”，只用于说明兼容对象，不用于背书。

### 5.3 用 DeepSeek 商标

- 不用 DeepSeek 的 Logo、字标、图标、官方截图做宣传物料。
- 不注册含 `DeepSeek` / `DeepSeek Harness` 的域名、npm scope、社交账号、组织名。
  `dsh-` 作为插件名前缀是社区惯例，但不要把它当成官方标识或背书。
- 不在付费广告、应用商店、会议赞助里使用这些名称。
- 产品名用我们自己的（`dsh-os`、`Act`、`Allow`…）；包名已经发布且可用，不临时
  改名去蹭。
- 如果收到权利人通知：立即停止使用并改名，不争论“合理使用”。

### 5.4 无 demo 发帖

- 没有可运行的 demo（脚本/视频/GIF/截图 + 可复现命令），不发“我们发布了”的帖。
- 没有在干净环境验证安装命令，不写“一条命令安装”。
- 不 P 图、不伪造终端输出、不把设计文档里的“计划做”写成“已经做”。
- 不用“coming soon”“即将支持”作为发布理由；等能做出来再发。
- 演示里不出现真实 token、密钥、用户名、客户路径、未公开的会话内容。

### 5.5 其他不要做

- 不重复发同一个项目（官方规则明确会删）。
- 不在官方帖里塞多个不相关项目；dsh-os 是一个项目，但不要把它写成 11 个产品
  一起“重磅发布”。
- 一次最多向 awesome 投 3 条，首选 1 条；不要为了多收录而把同周拆成多条。
- 不手改 awesome 生成的 README、不改别人条目。
- 不在 issue/PR 里贴完整日志中的密钥、cookie、私有路径。
- 不把“上架”当成“安全审计”；对外不说“市场已验证安全”。

---

## 6. 发布前检查（逐项打勾）

- [ ] `node examples/os-kit/demo.mjs` → `PASS: 6/6`
- [ ] `bash examples/os-kit/check-demo/run-check-demo.sh` → `PASS`（有 bash 的环境）
- [ ] `dsh plugin --profile web add dsh-act` 在干净 profile 成功
- [ ] `dsh plugin --profile web add dsh-allow` 在干净 profile 成功
- [ ] `dsh plugin --profile web add dsh-trigger` 在干净 profile 成功
- [ ] 帖子里的 demo 图片/GIF 链接返回 200，且画面无敏感信息
- [ ] 标题符合 `DSH｜项目名｜一句话用途`，正文有非官方声明
- [ ] 文中每个“能做 X”都能在 README/代码里找到；没有把 0.2.0 写成现在
- [ ] GitHub topic `dsh-plugin` 已添加
- [ ] npm 最新版本与仓库版本一致，或条目描述只写 npm 版本已有的能力
- [ ] awesome 条目只 1 条、YAML 可解析、`url` 指向子目录、仓库满 1 天
- [ ] `git status` 干净；没有把 token/密钥/本地路径带进提交

**最后一条：** 如果以上任何一项不确定，**推迟发布**。推迟的成本远小于被维护者
删除、被用户装崩、或被认为在冒充官方。
