# dsh-os AI 可用性基线（2026-11-21 · 0.4 并行实现冻结后）

> 本文件由**实际运行**得出：`node evals/run.mjs`（多轮重跑指标一致，最后一轮为
> 2026-11-21 15:39 Asia/Shanghai）。数字不来自旧 trace 推算，也不来自模型自述。
> 40% 旧基线快照保留在 `evals/baselines/2026-11-21-40pct.json`；本基线快照为
> `evals/baselines/2026-11-21.json`。

## 环境与方法

- 运行时间：2026-11-21 15:39（Asia/Shanghai）· Node **v24.22.1** · git HEAD `bc66d9e`。
- 工作树 **dirty**：运行在并行落地的 0.4 包上（trigger payload、ring delivery receipt / `ring_tick`、`seek_resolve` + Trace 写前校验、Allow `maxUses`、Check `check_run` 授权、kernel `os_request` 修复）。这些改动在 15:37 冻结；本评测**未修改任何 `packages/*`**。
- 层：**P 层脚本策略**（固定工具序列，无模型、无网络、不 spawn DSH 宿主）。不是 08-eval 的 A 层 AUS；旧的 30/100 不可直接比较。
- fake Cordis `ctx` + 真实包源码：`tools` / `provide` / `get` / `effect`。fs 用真实临时目录；剪贴板用注入 adapter；check 用本地 `node --test` runner；kernel 用真实 `CapabilityRegistry` + 一个写盘 fixture 能力。
- 工具面：经典 17 包约 78 个工具（0.3 的 76 个 + `seek_resolve` + `ring_tick`），修测试场景加 `check_run` = 79，证据场景注入 `locator_find` / `locator_resolve` = 80，kernel 场景再挂 6 个 `os_*` = 84。
- 成功只读外部状态：文件内容/哈希、测试退出码、Snip ledger、Trigger run（含 `path`/`payload`）、Ring receipt、Allow request/grant/uses、Trace 记录。模型/策略自述不计分。
- **延后判据（deferred）机制保留**：本轮 **0 条**。历史缺口仍在 `2026-11-21-40pct.json` 中保留，未删除任何场景。

## 总览

| 指标 | 40% 基线（2/5） | 本基线（6/6） | 说明 |
|---|---:|---:|---|
| 任务成功率 | **40.0%** | **100.0%** | 默认阈值 50% ⇒ `node scripts/eval.mjs` **exit 0** |
| 严格成功率（0 延后） | — | **100.0%** | 本基线无延后判据 |
| 自主成功率 | 0/5 | **1/6** | `evidence-chain` 0 次人类介入 |
| 首步选择准确率 | 100% | 100% | 脚本策略按预期路由，非真实模型成绩 |
| 恢复率 | 40% | 100% | 6/6 场景都出现一次**预期**失败并恢复（`grant_required` / 无 channel / `E_REF_NOT_FOUND` / `E_DENIED`） |
| 无效调用率 | 7.1%（3/42） | **0.0%（0/48）** | 未知工具/错 schema/同参无效重试均 0 |
| 平均步数 | 8.4 | 9.0 | 54 次 AI tool call / 6 场景 |
| tokens 估算 | 5,553（均 1,111） | 9,104（均 1,517） | `40 + JSON 字符数/4`，启发式，不是模型 tokenizer |
| 人类介入 | 4 次 | 7 次 | S1/S2/S5/S6 各 1 次；S3 2 次（首次投递无频道仍消耗一次性 Grant，配置频道后二次批准）；S4 0 次。新增场景，次数不可直接横比 |

## 逐场景

| 场景 | 成功 | 步数 | 无效 | 介入 | tokens | 判据 |
|---|---:|---:|---:|---:|---:|---|
| 修失败测试 `fix-failing-test` | ✅ | 8 | 0 | 1 | 1,466 | 测试退出 0 / 测试哈希不变 / 源码 diff ≤3 行 / 隐藏用例 `add(3,5)=8` |
| 整理剪贴板 `tidy-clipboard` | ✅ | 8 | 0 | 1 | 1,118 | `clip.md` 规范化一致 / `sourceApp=Chrome` / 无密钥 |
| 升级回归 `upgrade-regression` | ✅ | 12 | 0 | 1 | 1,452 | verdict=regression / fs.change run / **run.path=app.txt** / console 1 条 / **delivery receipt(ok=true)** / escalated |
| 证据链 `evidence-chain` | ✅ | 9 | 0 | **0** | 1,230 | 2 条 claim / 2 个 ref 可解析 / 0 伪 ref / **伪 ref 被 `seek_resolve` 标 missing 且 Trace 拒收** |
| 审批恢复 `approval-recovery` | ✅ | 6 | 0 | 1 | 797 | 恰好写 1 次 / timeout=30 / request approved / **重放 `grant_required`** / **Grant used 1/1** |
| 内核网关 `kernel-write` | ✅ | 5 | 0 | 1 | 895 | `os_find` 命中 `fs.write` / 未授权 `E_DENIED` / **`os_request` 建 request** / 批准后写入 1 次 / `os_status` 6 工具 |

## 三个旧失败是如何转绿的

1. **升级回归（原 `trigger-run-has-path` + `delivery-receipt`）**
   - `trigger_runs` 现在返回 `path` 与脱敏 `payload`；本轮 `runs[].path === 'app.txt'`，且 `payload.path` 保留绝对路径。
   - `ring_notify` 成功/失败都写 `delivery` receipt；本轮先因无 channel 失败一次（`ok=false`），宿主配置 console 后成功（`ok=true`），console 恰好 1 条。
   - 仍保留 `ring_tick` 工具，但本场景不依赖它。

2. **证据链（原无 resolver、伪 ref 被 Trace 接受）**
   - `seek_resolve` 对 3 个 hit 逐一解析：memento `found=true`（status unknown）、`env.md` `found=true`（fresh）、`missing.md` `found=false`（missing）。
   - `trace_remember` 写前经 Seek 校验；伪 ref 返回 `E_REF_NOT_FOUND`，未落库，最终只有 2 条真实 claim。
   - 失败步骤 `trace_remember[E_REF_NOT_FOUND]` 是**预期的负向验证**，不是无效调用。

3. **审批恢复（原 `write-once` + `replay-rejected`）**
   - Request/Grant 默认 `maxUses=1`；批准后第一次 `act_invoke` 消费一次，Grant 变 `used`、`uses=1/1`。
   - 同参重放返回 `grant_required`，文件只写一次；`write-once` 与 `replay-rejected` 同时成立。

## 新增 kernel 场景

- 流程：`os_find("write a file fs.write")` → `os_do`（无 Grant，`E_DENIED`）→ `os_request`（真实 Allow 创建 pending request）→ 人类批准 → `os_do` 带宿主交付的 Grant → 写盘 → `os_status`。
- 检查：能力卡 `fs.write`、未授权拒绝、request approved、handler 恰好写 1 次且文件内容正确、gateway 报 6 个工具且 health ok。
- **仍存在的真实缺口（未记为通过）**：`os_do` 需要显式 `grant`；kernel 的 `allowedByHost` 查 `cap:<id>`，而批准 Grant 的 capability 是 `<id>`；`os_observe` 也不会从 Allow 刷新已批准的 request。场景由宿主在批准后把 Grant 交给 agent，未声称 kernel 已自动消费 Grant。

## 诚实边界

- **P 层 ≠ 真模型**：100% 是“固定正确路线”的契约结果，不是模型能力。首步 100% 只是标注路由；真实模型/A 层 AUS 未测。
- 脚本策略使用 fixture 知识：例如 S4 选择 `mem-42` / `env.md`，S6 使用宿主交付的 Grant。真实模型是否这样选，本基线不能证明。
- 数字绑定于 15:37 冻结的**未提交工作树**（HEAD `bc66d9e` + 并行 0.4 改动）。`packages/*` 再变就必须重跑，不能把本 100% 当未来版本的现值。
- 升级场景依赖 `fs.watch` + 900ms debounce；多轮完整运行逐指标一致，但在极慢文件系统上仍可能 timing-sensitive。
- fixture 固定、未随机化；08-eval 的 holdout / A 层 / 5 人人类评测均未纳入。
- tokens 是字符启发式；不计算 AUS；本评测不构成安全证明（S1/S2 越权/泄漏未单独评分）。
- kernel 的 `os_do` 显式 Grant、`os_observe` 不刷新是已知集成限制；已在本文件和代码中保留，不用延后判据冒充通过。

## 复现与门禁

```bash
cd /mnt/d/Projects/dsh/dsh-os
node evals/run.mjs                      # 6 场景，写 evals/reports/latest.{json,md}，exit 0
node scripts/eval.mjs                   # 6/6 = 100% ≥ 50%，exit 0
node scripts/eval.mjs --threshold=1     # 调试门禁（本轮也会过）
node evals/run.mjs compare evals/baselines/2026-11-21-40pct.json evals/reports/latest.json
```

- 新基线：`evals/baselines/2026-11-21.json`
- 旧 40% 基线（保留）：`evals/baselines/2026-11-21-40pct.json`
- 失败/成功 trace 的逐步 JSON 在 `evals/reports/latest.json` 的 `scenarios[].steps/checks`。

## 与 06-workflows 旧 trace 的关系

| 旧结论 | 本基线 | 备注 |
|---|---|---|
| WF1/WF2 条件成功、1 次人类介入 | ✅ 通过，H=1 | 仍是 1 次写批准；S1 的 `check:run` 由宿主预授权，不占人类介入 |
| WF3 未闭环（payload / receipt / tick） | ✅ 通过 | run.path/payload + delivery receipt 已由并行实现补上 |
| WF4 只能搜+记、不能核验 | ✅ 通过 | `seek_resolve` + Trace 写前校验；伪 ref 被拒 |
| 30/100 AUS、0/5 无人通过 | 不可比 | 本报告是 P 层任务成功率；自主成功 1/6，方向改善但仍非模型成绩 |
