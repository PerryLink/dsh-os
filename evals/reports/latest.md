# dsh-os AI 可用性评测报告

- 生成：2026-11-21T06:42:45.796Z
- 层：P-scripted (fixed policy; no model, no network)
- 环境：Node v24.22.1 · commit 8220013（工作树有未提交改动）

## 总览

| 指标 | 值 |
|---|---|
| 成功率 | 2/5（40.0%） |
| 首步选择准确率 | 100.0% |
| 恢复率 | 40.0%（2/5 个有失败场景最终通过） |
| 无效调用率 | 7.1%（3/42） |
| 平均步数 | 8.4 |
| tokens 估算 | 总 5553 · 均 1111 |
| 人类介入 | 4 次（自主成功 0，辅助成功 2） |

## 场景

| 场景 | 成功 | 步数 | 无效 | 介入 | tokens | 首个失败判据 |
|---|---:|---:|---:|---:|---:|---|
| fix-failing-test 修失败测试 | ✅ | 8 | 0 | 1 | 1451 | — |
| tidy-clipboard 整理剪贴板 | ✅ | 8 | 0 | 1 | 1109 | — |
| upgrade-regression 升级回归 | ❌ | 12 | 0 | 1 | 1279 | trigger-run-has-path |
| evidence-chain 证据链 | ❌ | 8 | 3 | 0 | 936 | two-resolvable-refs |
| approval-recovery 审批恢复 | ❌ | 6 | 0 | 1 | 778 | write-once |

## 判据与失败点

- **fix-failing-test** ✅ · 首步 `check_compare` · 介入 1 · 全部判据通过
- **tidy-clipboard** ✅ · 首步 `snip_capture` · 介入 1 · 全部判据通过
- **upgrade-regression** ❌ · 首步 `trigger_register` · 介入 1 · `trigger-run-has-path`: trigger_runs 未保存 path/payload；`delivery-receipt`: receipts: escalation
- **evidence-chain** ❌ · 首步 `seek_providers` · 介入 0 · `two-resolvable-refs`: 1/2 个 source ref 可解析；`no-bogus-ref`: dsh://memento/mem-42, dsh://locator/docs/missing.md
- **approval-recovery** ❌ · 首步 `act_invoke` · 介入 1 · `write-once`: 成功的 fs.write 调用 2 次；`replay-rejected`: 同参重放被接受（第二次写入）

> P 层脚本策略，不是真实模型的 AUS；成功只读外部状态，模型自述不计分。

