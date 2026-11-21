# dsh-os AI 可用性基线（2026-11-21）

> 本文件由**实际运行**得出：`node evals/run.mjs`，不是从
> `01-research/dsh-os-ai-usability-2026-11-21/06-workflows.md` 的旧 trace 抄来的数字。
> 旧 trace 只用于对照失败类型；本基线的步数、token、判据均来自当前工作树。

## 环境与方法

- 运行时间：2026-11-21 12:36（Asia/Shanghai）· Node **v24.22.1** · git HEAD `8220013`，工作树有未提交的 0.3 改动（act fs actions、allow request/wait）。
- 层：**P 层脚本策略**（固定工具序列，无模型、无网络）。不是 08-eval 里的 A 层 AUS，30/100 的旧分不可直接比较。
- fake Cordis `ctx` + 真实包源码：`tools` / `provide` / `get` / `effect`。fs 用真实临时目录；剪贴板用注入 adapter；check 用本地 `node --test` runner；不 spawn DSH 宿主。
- 工具面：基础 **76** 个工具（比 06 trace 的 73 多 3 个，因为 Allow 现在公开 `allow_request` / `allow_wait` / `allow_requests`）；修测试场景加 `check_run` = 77，证据场景注入 `locator_find` = 77。
- 成功只读外部状态：文件内容/哈希、测试退出码、Snip ledger、Trigger run、Ring receipt、Allow request/grant、Trace 记录。

## 总览

| 指标 | 基线 | 说明 |
|---|---:|---|
| 任务成功率 | **2/5 = 40.0%** | 默认阈值 50% ⇒ `node scripts/eval.mjs` **exit 1** |
| 自主成功率 | **0/5** | 两个成功场景各用了 1 次人类批准 |
| 首步选择准确率 | 5/5 = 100% | 脚本策略按预期路由，非真实模型成绩 |
| 恢复率 | 2/5 = 40% | 5 个场景都出现过失败调用；2 个最终通过 |
| 无效调用率 | 3/42 = 7.1% | 3 次都是证据链的缺工具/错工具 |
| 平均步数 | 8.4 | 42 次 AI tool call / 5 场景 |
| tokens 估算 | 5,553（均 1,111） | `40 + JSON 字符数/4`，启发式，不是模型 tokenizer |
| 人类介入 | 4 次 | S1/S2/S3/S5 各 1 次；S4 0 次 |

## 逐场景

| 场景 | 成功 | 步数 | 无效 | 介入 | tokens | 首个失败判据 |
|---|---:|---:|---:|---:|---:|---|
| 修失败测试 `fix-failing-test` | ✅ | 8 | 0 | 1 | 1,451 | — |
| 整理剪贴板 `tidy-clipboard` | ✅ | 8 | 0 | 1 | 1,109 | — |
| 升级回归 `upgrade-regression` | ❌ | 12 | 0 | 1 | 1,279 | `trigger-run-has-path` |
| 证据链 `evidence-chain` | ❌ | 8 | 3 | 0 | 936 | `two-resolvable-refs` |
| 审批恢复 `approval-recovery` | ❌ | 6 | 0 | 1 | 778 | `write-once` |

## 诚实失败记录

### 1. 升级回归：事件链仍不闭合（2/6 判据失败）

- `check_compare` 返回 `verdict=regression`，`fs.change` 触发 1 条 run，Ring case 已 `escalated`，console 收到 1 条通知。
- ❌ `trigger-run-has-path`：`trigger_runs` 的 run 对象只有 `event/ok/startedAt`，**没有 path/payload**；AI 无法知道是哪个文件变了。
- ❌ `delivery-receipt`：`ring_notify` 成功送达 console，但 **不写 delivery receipt**；`ring.receipts()` 只有 `escalation`。只有 `ring.tick()` 会写 delivery receipt，而工具面没有 `ring_tick`（`ring.tick` 只是服务方法）。因此“送达可回执”对 agent 不可达。
- 与 06-workflows WF3 的结论一致：`trigger` 丢 payload、`ring_notify` 不落投递回执、无 `ring_tick`。

### 2. 证据链：没有 resolver，伪 ref 照收（1/3 判据通过）

- 搜索返回 2 条 claim 所需的 ref：`dsh://memento/mem-42`（可解析）和 `dsh://locator/docs/missing.md`（**文件不存在**）。
- ❌ 工具面仍无 `seek_resolve` / `locator_resolve` / `trace_resolve`；策略依次尝试 `seek_resolve`、`locator_resolve`（均 `TOOL_NOT_REGISTERED`）、`root_resolve`（`invalid_profile_name`），3 次无效调用。
- ❌ `trace_remember` 只把 `source` 当自由文本，**不校验 ref 是否存在**，所以伪 ref 被接受；最终 1/2 ref 可解析、1 条伪 ref。
- 与 WF4 一致：Seek 能搜、Trace 能记，但“可核验”仍依赖人或宿主注入 resolver。

### 3. 审批恢复：请求/批准能走，缺一次性授权（2/4 判据失败）

- ✅ `allow_request` 创建 pending request；人类批准后 request=`approved` 且有 `grantId`；`fs.write` 成功把 `timeout` 改成 30。
- ❌ `write-once`：成功 `fs.write` 调用 **2 次**。
- ❌ `replay-rejected`：同参 replay 仍返回 `ok:true`，**再次写入**。Grant 没有 `maxUses` / 一次性消费语义，`approve` 也不支持 `maxUses`；E06 要求的“批准 1 次、写恰好 1 次、重放拒绝”在当前 Allow 上做不到。
- 这是 0.3 新审批流相对 0.2 的实质进步（不再是人发 Grant 的死胡同），也是仍缺的一块。

### 4. 两个成功场景的代价

- 修测试：`check_compare` → `act_list` → `fs.write` 先 `grant_required` → `allow_request` → `allow_wait`（pending）→ **人类批准** → `fs.write` → `check_run`，测试转绿、测试文件哈希不变、源码只改 1 行。
- 剪贴板：`snip_capture` → `snip_search` → `snip_get` → `fs.write` 同样走一次批准，`clip.md` 与原文一致、`sourceApp=Chrome`、无密钥。
- 两者自主成功均为 0：当前“真实写文件”仍必须人类在环。06-workflows 的“WF1/WF2 条件成功、1 次 Grant”在语义上仍然成立，只是 Grant 换成了 request/approve。

## 与 06-workflows 旧 trace 的关系

| 旧结论 | 本基线 | 备注 |
|---|---|---|
| WF1/WF2 条件成功、1 次人类介入 | ✅ 通过，H=1 | 现在用内置 `fs.write` + `allow_request`，不再需要宿主注册 action |
| WF3 未闭环（payload / receipt / tick） | ❌ 同三类缺口 | 自跑复现，并非照抄 |
| WF4 只能搜+记、不能核验 | ❌ 同 | 伪 ref 仍被 Trace 接受 |
| 30/100 AUS、0/5 无人通过 | 不可比 | 本报告是 P 层任务成功率，不计算 AUS；自主成功 0/5 与旧结论方向一致 |

## 复现与门禁

```bash
cd /mnt/d/Projects/dsh/dsh-os
node evals/run.mjs                      # 跑 5 场景，写 evals/reports/latest.{json,md}，exit 0
node scripts/eval.mjs                   # 同跑，40% < 50%，exit 1
node scripts/eval.mjs --threshold=0.3   # 调门禁（仅调试用）
node evals/run.mjs compare evals/baselines/2026-11-21.json evals/reports/latest.json
```

基线快照：`evals/baselines/2026-11-21.json`。失败 trace 的逐步 JSON 在 `evals/reports/latest.json` 的 `scenarios[].steps/checks`。

## 已知局限

- 脚本策略是“正确路线”的对照，不是模型能力；首步 100% 不代表真实 Agent 路由。
- tokens 是字符启发式，只能做版本间相对比较。
- 升级场景依赖 `fs.watch` + 900ms 等待；在极慢文件系统上可能 timing-sensitive（当前 Linux 跑通）。
- 证据场景的伪 ref 由注入的 `locator_find` 故意返回不存在路径，用来检验“无 resolver 时 Trace 不校验 ref”，不代表 locator 真实行为。
- 未纳入实验性 `kernel`/`mcp` 包；本基线固定为 06-workflows 使用的 17 个经典包。
