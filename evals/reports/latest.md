# dsh-os AI 可用性评测报告

- 生成：2026-11-21T07:53:08.558Z
- 层：P-scripted (fixed policy; no model, no network)
- 环境：Node v24.22.1 · commit 8be0cd6（工作树有未提交改动）

## 总览

| 指标 | 值 |
|---|---|
| 成功率 | 6/6（100.0%） |
| 严格成功率（0 延后判据） | 6/6（100.0%） |
| 延后判据 | 0 条，覆盖 0 个场景（不计为通过，详见下文） |
| 首步选择准确率 | 100.0% |
| 恢复率 | 100.0%（6/6 个有失败场景最终通过） |
| 无效调用率 | 0.0%（0/48） |
| 平均步数 | 8.0 |
| tokens 估算 | 总 6958 · 均 1160 |
| 人类介入 | 5 次（自主成功 1，辅助成功 5） |

## 场景

| 场景 | 成功 | 步数 | 无效 | 介入 | 延后 | tokens | 首个失败判据 |
|---|---:|---:|---:|---:|---:|---:|---|
| fix-failing-test 修失败测试 | ✅ | 8 | 0 | 1 | 0 | 1466 | — |
| tidy-clipboard 整理剪贴板 | ✅ | 8 | 0 | 1 | 0 | 1118 | — |
| upgrade-regression 升级回归 | ✅ | 12 | 0 | 1 | 0 | 1452 | — |
| evidence-chain 证据链 | ✅ | 9 | 0 | 0 | 0 | 1230 | — |
| approval-recovery 审批恢复 | ✅ | 6 | 0 | 1 | 0 | 797 | — |
| kernel-write 内核网关写入 | ✅ | 5 | 0 | 1 | 0 | 895 | — |

## 判据与失败点

- **fix-failing-test** ✅ · 首步 `check_compare` · 介入 1 · 全部有效判据通过
- **tidy-clipboard** ✅ · 首步 `snip_capture` · 介入 1 · 全部有效判据通过
- **upgrade-regression** ✅ · 首步 `trigger_register` · 介入 1 · 全部有效判据通过
- **evidence-chain** ✅ · 首步 `seek_providers` · 介入 0 · 全部有效判据通过
- **approval-recovery** ✅ · 首步 `act_invoke` · 介入 1 · 全部有效判据通过
- **kernel-write** ✅ · 首步 `os_find` · 介入 1 · 全部有效判据通过

> P 层脚本策略，不是真实模型的 AUS；成功只读外部状态，模型自述不计分。
> ⏸ 延后判据 = 当前 packages API 无法满足、但未伪造通过的判据；它们仍计入 `successCriteria` 并在每次报告中保留。

