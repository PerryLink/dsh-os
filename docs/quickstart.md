# Quickstart：10 分钟从零到 Check REGRESSION

这篇只做两件事：

1. 在临时目录安装 Check CLI，喂两份配对的 run JSON，看到 `Check REGRESSION`
   并以 `1` 退出；
2. 在 DSH 的隔离 profile 里安装 Check + Act/Allow/Snip/Nest/Root，用
   `--dump-config` 看到 6 个 bundle 层。

> 实测环境：2026-11-20 · Node 24.22.1 · npm 11.19.1 · dsh 0.2.2-rc.4 ·
> pnpm 12.21.0。
>
> Check 0.1.x 的核心能力是 diff（另有 `init`/`list` 辅助命令），**不会启动
> DSH、不调用模型、不生成 run**；配对 runner 在 0.2.0。0.1.x 的输入是两份
> `dsh.check.run/v1` JSON。
>
> 只想要零安装的仓库内演示？先看
> [`examples/os-kit`](../examples/os-kit/README.md)；本文走真实安装路径。

## 0. 准备（约 1 分钟）

```sh
node --version
dsh --version
```

预期：

- `v24.9.0` 或更高。只跑 `dsh-check` CLI 时 Node 22.19+ 就够，但 `dsh`
  本身要求 Node >= 24.9；
- `dsh` 在 `0.2.1-rc.2` 到 `0.2.x` 之间。dsh-os 包的 `engines.dsh` 是
  `>=0.2.1-rc.2 <0.3.0-0`。

如果 `dsh` 不存在：

```sh
npm install -g @deepseek-ai/dsh@latest
```

> 不要把 `sudo` 和全局 npm 安装混用。装不上时先看
> [Troubleshooting §1](./troubleshooting.md#1-安装失败)，不要直接改系统目录权限。

## 1. 安装 Check（约 2 分钟）

Check 有两个入口：

| 入口 | 用途 | 安装方式 |
|---|---|---|
| `dsh-check` CLI | 本地/CI 里 diff 两份 run | `npm install --save-dev @perrylink/dsh-check` |
| DSH bundle | 提供 `ctx.check` 和 `check_compare` | `dsh plugin ... add @perrylink/dsh-check` |

先装 CLI，因为下一步马上要用：

```sh
mkdir dsh-os-quickstart
cd dsh-os-quickstart
npm init -y
npm install --save-dev @perrylink/dsh-check
npx dsh-check --help
```

预期（节选）：

```text
Usage:
  dsh-check diff --old <old.json> --new <new.json> [--json] [--allow-flaky <id>]...
  dsh-check init [dir]
  dsh-check list --file <check.tasks.json> [--json]

Exit codes: 0 pass/warnings, 1 regression, 2 usage or input error.
```

包名是 **scoped** 的 `@perrylink/dsh-check`。裸 `dsh-check` 在 npm 上不存在：
在没装本地依赖的目录里跑 `npx dsh-check` 会得到 404，见文末
[常见错误](#常见错误)。

## 2. 生成任务和两份 run（约 3 分钟）

### 2.1 任务文件

```sh
npx dsh-check init evals
```

预期：

```text
Created <absolute-path>/evals/check.tasks.json with 3 golden tasks.
```

`init` 只写任务清单（`session-token-summary`、`repo-status`、
`test-failure-triage`），**不执行任务**。0.1.x 没有 runner。

### 2.2 两份配对 run

两份 JSON 代表“同一组任务在两个环境下的执行结果”。下面是最小样例；先写
baseline：

```sh
cat > baseline.json <<'JSON'
{
  "schema": "dsh.check.run/v1",
  "environment": {
    "label": "dsh 0.2.1-rc.2 / deepseek-chat",
    "dsh": "0.2.1-rc.2",
    "model": "deepseek-chat"
  },
  "tasks": [
    {
      "id": "session-token-summary",
      "result": { "text": "Usage by model: deepseek-chat 18.3k tokens." },
      "trajectory": { "steps": 6, "toolCalls": 4, "errors": 0 },
      "cost": { "usd": 0.12, "tokens": 18300 },
      "approvals": { "asked": 0, "rejected": 0 }
    }
  ]
}
JSON
```

再写 candidate。只把 `result.text` 改成 `usage unavailable`，其余指标保持
不变——这样 diff 恰好只有一条 result 回归：

```sh
cat > candidate.json <<'JSON'
{
  "schema": "dsh.check.run/v1",
  "environment": {
    "label": "dsh 0.2.2-rc.4 / deepseek-chat",
    "dsh": "0.2.2-rc.4",
    "model": "deepseek-chat"
  },
  "tasks": [
    {
      "id": "session-token-summary",
      "result": { "text": "usage unavailable" },
      "trajectory": { "steps": 6, "toolCalls": 4, "errors": 0 },
      "cost": { "usd": 0.12, "tokens": 18300 },
      "approvals": { "asked": 0, "rejected": 0 }
    }
  ]
}
JSON
```

## 3. 跑 diff：看到 REGRESSION（约 1 分钟）

```sh
npx dsh-check diff --old baseline.json --new candidate.json
echo "exit=$?"
```

预期（逐字）：

```text
Check REGRESSION: 1 task(s), 1 regression(s), 0 warning(s), 0 ignored
  REGRESSION session-token-summary [result/regression] result changed
exit=1
```

`result` 是深比较：对象键顺序不影响结果，但任何值差异都算 regression。
退出码：

| 退出码 | 含义 |
|---|---|
| `0` | `pass` 或 `warning`；warning 不是门禁失败 |
| `1` | `regression`；至少一个非 flaky 任务回归 |
| `2` | 用法/输入错误（缺 flag、文件不可读、JSON 非法、run 结构非法） |

要机器可读报告，加 `--json`：

```sh
npx dsh-check diff --old baseline.json --new candidate.json --json > check-report.json
echo "exit=$?"
```

预期 `exit=1`，`check-report.json` 的顶层（节选）：

```json
{
  "schema": "dsh.check.diff/v1",
  "verdict": "regression",
  "summary": {
    "tasks": 1,
    "compared": 1,
    "regressions": 1,
    "warnings": 0,
    "ignored": 0,
    "added": 0
  }
}
```

完整报告还会在 `tasks[].diffs` 里给出 `dimension`、`severity`、`old` 和
`new`。

## 4. 安装 6 个 DSH bundle（约 2 分钟）

用一个只给本 quickstart 用的 profile，避免动你现有的 `web`：

```sh
dsh plugin --profile quickstart add @perrylink/dsh-check
dsh plugin --profile quickstart add dsh-act dsh-allow dsh-snip dsh-nest @perrylink/dsh-root
```

> 这个 profile 只用于“看层”。要在 Web/真实会话里使用，把 `quickstart` 换成
> 你的实际 profile（通常是 `web`）：`dsh plugin --profile web add ...`。

预期（节选；`<version>` 以实际解析结果为准）：

```text
dsh: initialized profile quickstart at <DSH_HOME>/profiles/quickstart
...
dependencies:
+ @perrylink/dsh-check <version>
...
dependencies:
+ @perrylink/dsh-root <version>
+ dsh-act <version>
+ dsh-allow <version>
+ dsh-nest <version>
+ dsh-snip <version>
```

> `dsh plugin` 把参数转发给 pnpm。`@perrylink/dsh-check` 在这里装的是
> **bundle**；第 1 步项目里的那份是 **CLI**。同名同包，但两个入口各管一边。
>
> 如果你刚发布了一个 patch，pnpm 的 `minimumReleaseAge` 可能先解析到旧
> patch。固定版本即可：`... add @perrylink/dsh-check@0.1.1`。详见
> [Troubleshooting §1.4](./troubleshooting.md#14-装到的不是最新-patchminimumreleaseage)。

## 5. 用 `--dump-config` 看到层（约 1 分钟）

```sh
dsh --profile quickstart --dump-config | grep -E '^# == (dsh-|@perrylink/)'
```

预期（顺序可能因 pnpm 解析而不同）：

```text
# == @perrylink/dsh-check
# == @perrylink/dsh-root
# == dsh-act
# == dsh-allow
# == dsh-nest
# == dsh-snip
```

每一行就是一个 bundle 的 patch 层：每个包用自己的 `cordis.patch.yml`
`insert` 一个条目。去掉 `grep` 还会看到 `# == @deepseek-ai/dsh-base` 等
模板层。

如果层不齐：

```sh
dsh plugin --profile quickstart add MISSING_PACKAGE
dsh --profile quickstart --dump-config | grep '^# =='
```

## 6. 接下来

| 你要做的事 | 读这篇 |
|---|---|
| 把 Check 接进 GitHub Actions | [recipes/ci-gate.md](recipes/ci-gate.md) |
| 给写动作发/撤 Grant | [recipes/agent-write.md](recipes/agent-write.md) |
| 在插件里用 `clipboard://` 句柄 | [recipes/clipboard.md](recipes/clipboard.md) |
| 安装失败、版本不匹配、卸载 | [troubleshooting.md](troubleshooting.md) |
| 零安装跑一遍 Allow+Act+Snip 和 Check | [examples/os-kit](../examples/os-kit/README.md) |

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `npm error 404 ... 'dsh-check@*'` | 用了裸名，或在没装依赖的目录跑 `npx dsh-check` | 装 `@perrylink/dsh-check`，或 `npx --yes @perrylink/dsh-check@0.1.1 ...` |
| `error: required option '--profile <name>' not specified` | `dsh plugin` 少了 `--profile`，或 `--profile` 放在 `add` 后面 | 用 `dsh plugin --profile quickstart add ...`；`--profile` 必须在子命令前 |
| `Failed to resolve the latest version of dsh-trace ... 404` | 用了未加 scope 的 `dsh-trace`，或镜像还没同步 | 用 `@perrylink/dsh-trace`；镜像问题见 [Troubleshooting §4](./troubleshooting.md#4-trace-tarball-404) |
| 输出 `Check PASS`，不是 `REGRESSION` | 两份 run 的 `result` 相同，或 `--old/--new` 指向了同一份/错文件 | 用 `--json` 看 `verdict`；确认 candidate 的 `result` 真的变了 |
| `Error: dsh: profile "quickstart" does not exist` | 还没创建该 profile | 先跑第 4 步的 `dsh plugin --profile quickstart add ...` |
| `.../check.tasks.json already exists; refusing to overwrite` | 对同一个目录重复跑 `init` | 换一个目录（`npx dsh-check init evals2`），或先确认旧文件不再需要 |
| 装到的是旧 patch，不是 npm 上的 latest | pnpm 的 `minimumReleaseAge` 暂缓新版本 | 固定版本 `pkg@x.y.z`，或等窗口过去；见 Troubleshooting |
| Windows 上 `grep` 不存在 | 用的是 PowerShell | 用 Git Bash/WSL 跑本文命令，或把 `grep` 换成 `Select-String` |
