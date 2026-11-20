# Recipe：把 Check 接进 GitHub Actions

> 适用 Check 0.1.x。目标：对两份**同任务集**的 run JSON 做回归门禁，
> `regression` 让 job 失败，`warning` 不失败，报告留档。
>
> Check 0.1.x 在门禁里只做 diff。它**不会**启动 DSH、调用模型或生成 run；
> 配对 runner 在 0.2.0。因此 workflow 里的 `candidate.json` 必须由你的
> harness 作业产出，或作为 fixture 提交在仓库里。

## 1. 先确定两份输入

| 文件 | 角色 | 放在哪 |
|---|---|---|
| `checks/baseline.json` | 旧环境（升级前）的 run | 提交进仓库，作为已审核的基线 |
| `checks/candidate.json` | 新环境（升级后 / 本 PR）的 run | 由 runner 作业产出并上传 artifact，或提交 fixture |

两份都必须是 `dsh.check.run/v1`，任务 id 一致。Check 的完整 diff 规则见
[`packages/check/README.md`](../../packages/check/README.md#diff-rules)。

最小 run（只保留一个任务和一个 result；其余维度默认 0）：

```json
{
  "schema": "dsh.check.run/v1",
  "tasks": [
    { "id": "session-token-summary", "result": { "text": "Usage by model: deepseek-chat 18.3k tokens." } }
  ]
}
```

## 2. 最小可用 workflow

把下面存成 `.github/workflows/check.yml`：

```yaml
name: check-gate

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Diff paired runs
        id: diff
        shell: bash
        run: |
          set +e
          npx --yes @perrylink/dsh-check@0.1.1 \
            diff --old checks/baseline.json --new checks/candidate.json \
            --json > check-report.json
          status=$?
          set -e

          if [ ! -s check-report.json ]; then
            echo "::error::Check produced no report (install or usage failure)"
            exit 2
          fi

          case "$status" in
            0) echo "Check passed, or warnings only." ;;
            1) echo "::error::Check found a regression; open check-report.json." ;;
            *) echo "::error::Check failed with exit $status." ;;
          esac
          exit "$status"

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: check-report
          path: check-report.json
          if-no-files-found: ignore
```

这个 workflow 假定 `checks/baseline.json` 和 `checks/candidate.json` 都已经在
checkout 里。想先跑通流水线，可以先提交两份 fixture；确认能稳定变红/变绿后，
再把 candidate 换成 artifact。

### 为什么用 `npx --yes @perrylink/dsh-check@0.1.1`

- 不需要 `npm install` 步骤，npx 会临时解析包并执行 `dsh-check` bin；
- **必须写 scoped 包名**。`npx dsh-check` 会在 npm 上找裸包 `dsh-check` 并
  得到 404；
- 固定 patch 版本，避免 `latest` 漂移改变门禁行为。升级 Check 时单独改这一行
  并审阅 diff。

## 3. candidate 来自 artifact

如果 candidate 是每次运行生成的，在 gate job 里先下载：

```yaml
      - name: Download candidate run
        uses: actions/download-artifact@v4
        with:
          name: candidate-run
          path: checks
```

生产 artifact 的作业（同一个 workflow 的另一个 job，或另一个 workflow）负责：

```yaml
      - name: Upload candidate run
        uses: actions/upload-artifact@v4
        with:
          name: candidate-run
          path: checks/candidate.json
```

> 0.1.x 里“跑 DSH、把 session 转成 task run”这一步不在 Check 内。用你自己的
> harness 产出 JSON；Check 0.2.0 才会带配对 runner。
>
> 跨 workflow 下载 artifact 需要 `actions/download-artifact` 的
> `run-id`/`github-token` 组合，或用 `workflow_run` 触发；这里不展开。

## 4. warning 不是失败，flaky 可以局部放行

diff 规则（节选）：

| 维度 | 变化 | verdict |
|---|---|---|
| result | 任何深比较差异 | **regression** |
| trajectory | `errors` 增加 | **regression** |
| trajectory | `steps` 增加 > 20% | warning |
| trajectory | `toolCalls` 增加 > 20% | warning |
| cost | `usd` 增加 > 25% | warning |
| approvals | `asked` / `rejected` 增加 | warning |

warning 的退出码仍是 `0`；只有 regression 是 `1`。如果团队要求“warning 也
拦”，在 workflow 里读 `check-report.json` 自己判断，例如：

```bash
jq -e '.verdict != "warning"' check-report.json >/dev/null \
  || echo "::warning::Check reported warnings; see check-report.json"
```

已知 flaky 的任务用 `--allow-flaky` 保留 diff、但从门禁里移除：

```bash
npx --yes @perrylink/dsh-check@0.1.1 \
  diff --old checks/baseline.json --new checks/candidate.json \
  --allow-flaky session-token-summary
```

实测输出：

```text
Check PASS: 1 task(s), 0 regression(s), 0 warning(s), 1 ignored
  IGNORED session-token-summary [result/regression] result changed
```

不要用 `--allow-flaky` 放行一个真实回归；它只适合“同一任务本来就抖动”的
情况。每个被忽略的任务都会出现在 `summary.ignored` 里，报告仍然可审计。

## 5. 基线更新纪律

- 不要在这个 gate 里自动改 `baseline.json`。基线变更应该是**独立的、被审阅的
  提交**，否则门禁会自己把自己变绿。
- 升级 DSH/模型/插件后，先用同一套任务在新旧环境各跑一遍，确认 candidate 的
  每条 diff 都是预期的，再更新 baseline。
- Check 0.1.x 不能替你跑任务；0.2.0 的 runner 会补上隔离 `DSH_HOME`、headless
  运行和 baseline 管理。

## 6. 排错

| 现象 | 原因 | 修复 |
|---|---|---|
| `npm error 404 ... 'dsh-check@*'` | 用了 `npx dsh-check` | 改成 `npx --yes @perrylink/dsh-check@0.1.1` |
| `Check produced no report` | npx 下载/执行失败，或 Check 在写报告前就退出 | 看这一步的 stderr；确认 registry 可达、Node 版本正确 |
| exit `2` | 用法或输入错误：缺 `--old/--new`、JSON 非法、task id 重复/为空 | 先用 `npx ... diff --old ... --new ...` 在本地复现 |
| exit `1` 但看不到 diff 行 | 加了 `--json`，stdout 只有 JSON | 打开 artifact 里的 `check-report.json` |
| 每次都是 `PASS` | baseline 和 candidate 内容相同，或 candidate 没更新 | 检查 artifact 是否覆盖了旧文件；用 `--json` 看 `summary.compared` |
| 每次都因同一任务变红 | 该任务确实回归，或环境不确定 | 先修回归；确认是抖动后才考虑 `--allow-flaky`，并记录原因 |

再往下：安装/版本/registry 问题见
[`../troubleshooting.md`](../troubleshooting.md)。
