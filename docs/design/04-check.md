# Check：升级金丝雀 / 回归门禁

> 2026-11-20 · 对象 PerryLink（个人开发者，非官方，not affiliated with DeepSeek）· 基线 DSH 0.2.2-rc.4（`ca33fd6`）· 定位：DSH 升级 / 换模型 / 升插件前后的**配对回归门禁**，不是通用 benchmark · 证据：源码/Registry 实测 [A]，公开页面 [B]，设计判断 [D]。

> **npm package:** `dsh-canary` — the unscoped `dsh-check` is blocked by npm name-similarity rules; the product name remains **Check**.

## 0. 结论

- **名字**：Check；npm `dsh-check`；CLI `dsh check`；Host seam `ctx.canary`；机制名 canary（金丝雀）。
- **一句话**：升级前，用你的 10 条真实任务在旧环境和新环境各跑一遍；结果、轨迹、成本、审批四维 diff，回归就 exit 1。
- **MVP 5 周**（4 周核心 + 1 周硬化）；企业版 6 周。**最大风险**：金任务过拟合 + 模型非确定性导致误报，门禁被关掉；其次是官方原生 eval 吸收品类。
- **必须承认的竞品**：`dsh-eval-harness` 0.3.1 已做 YAML 用例 + headless + trace 断言 + baseline + CI 退出码（月下载 237）；`dsh-session-eval` 0.4.1 做回溯评分（月下载 1,942）。Check 的差异只剩**同一任务跨环境配对 + 四维 diff + 真实 session 取例 + Action/夜间升级**，不能再宣称“无人做 CI 门禁”。DSH 结论来自本机 checkout `0.2.2-rc.4`；npm/GitHub 数字为 2026-11-20 公开面；未做用户访谈。

## 1. 名字与可用性

| 候选 | npm | 实测 | 判断 |
|---|---|---|---|
| **Check** | `dsh-check` | **404 = 未发布，可用** | ✅ 主选；动词清楚，CI 语境自然 |
| Canary | `dsh-canary` | 404，可用 | 机制名；作 GitHub topic / `--canary`，不作主名 |
| Test | `dsh-test` | 200，0.0.1“面板名预留” | ❌ 已占，且太泛 |
| Guard | `dsh-guard` | 200，1.0.0 运行期快照回退 | ❌ 语义冲突 |
| Prove | `dsh-prove` | 404，可用 | 备选；不如 Check 直白 |

`dsh-check` 的 404 是 npm 对不存在包的标准响应，不是“下载失败”。风险是 `dsh-check-update`、`dsh-check-for-updates`、`dsh-check-pack` 已存在，搜索词拥挤；用“upgrade canary, not an update checker”作首句，关键词加 canary/regression/eval/CI，立即发 0.1.0 占名；同时注册 `dsh-canary` 兜底。产品名 Check，机制名 canary，seam 用任务要求的 `ctx.canary`。

## 2. 一句话 / 问题 / 用户

**一句话**：升级 DSH、换模型或升插件之前，先跑一遍“我的真实任务”，旧环境 vs 新环境配对对比；四维 diff 只要有回归，CI exit 1。

**问题**（按严重度）：
1. DSH 按周发 rc、插件按月更；“能启动”不等于“任务还能完成”。内核无 eval/test CLI，`benchmarks/` 只测性能（`docs/capability-seams.md` 无 eval 服务）。
2. 现有 eval 工具是**单环境自比**：这次跑 vs 上次报告；回答不了“rc.4 → rc.5 到底是什么变了”。回溯评分只看旧日志，不跑新任务。
3. 回归不只在结果：工具多调 3 步、成本涨 40%、审批从 0 次变 3 次，都是升级事故；现有工具没有把成本/审批纳入同一张门禁。
4. 真实 bad case 留在 session 里，无法一键变成可回放的金任务；手工写用例成本高，写出来还容易过拟合。

| 用户 | 场景 | 愿意为什么付费 |
|---|---|---|
| 插件作者（PerryLink 型） | 发版前证明兼容 DSH rc.x / 不破坏既有行为 | 兼容矩阵自动化，少背“升级坏了”的锅 |
| 企业平台/平台工程 | 升级 DSH 前在 CI 跑部门常用任务；留审计证据 | 门禁、租户隔离、报告、SSO |
| DSH 团队/维护者 | 用真实任务做 canary 反馈，拿到可复现 regression corpus | 不直接付费；是标准与分发杠杆 |

## 3. 范围与非目标

**范围内（v0）**：真实 session 取例与脱敏；Golden Task schema；隔离 profile 的配对 runner（headless `--json` + session replay）；结果/轨迹/成本/审批四维 diff；baseline 接受与比较；flake 分类/重试/隔离；JUnit + Markdown + exit code；GitHub Action + 夜间升级金丝雀；`ctx.canary` seam、Act action、Allow Grant、Root 引用。

**非目标**：通用 benchmark/榜单；模型排名；数据集托管/RL 训练；自动改 prompt；替代单测/类型检查/安全扫描；v0 不做跨租户 SaaS、不做 UI 像素级回归。headless 只覆盖 host/agent 行为，面板渲染回归用 v0.2 的 browser lane（Playwright）补，MVP 不承诺。

## 4. 架构

### 4.1 对象与 Golden Task schema

所有对象继承基类：`id, owner, scope, createdAt, updatedAt, expiresAt?, auditRef`。核心对象：`Case`（金任务）、`EnvironmentSnapshot`、`Run`、`Baseline`、`Diff`、`Verdict`。Case 默认 `expiresAt=+90d`，Run +30d，Baseline 直到被新 revision 取代。

```yaml
schema: dsh.check.case/v1
id: case-budget-usage-01
source: {sessionId: ses_..., eventSeq: 42, redaction: redact-v1}
task:
  prompt: |
    查看本会话的 token 用量，按模型汇总。
  workspace: {rootRef: root_..., commit: ...}
environment:
  dsh: {version: 0.2.2-rc.4, commit: ca33fd6}
  plugins: [{name: dsh-budget, version: 0.4.27, integrity: sha512-...}]
  model: {provider: deepseek, model: deepseek-chat, route: default}
  policy: {preset: workspace-write, approval: ask}
assert:
  result: {contains: ["token"], jsonSchema: ./expected/usage.schema.json}
  trajectory: {toolsRequired: [session_query], toolsForbidden: [bash], maxSteps: 8}
  cost: {maxTokens: 50000, maxUsd: 0.15, maxRatioVsBaseline: 1.2}
  approval: {maxAsks: 2, outcomes: [allowed-once], maxNewAsksVsBaseline: 0}
```

`capture` 用 `ctx.sessionQuery` 取首条 user message、工具白名单、workspace commit（dirty 存 patch 或拒绝）、model route，生成 case；`prompt` 是**投影**，不是原始 session，不存整段日志；`source.sessionId` 只在本地有效，导出时剥离；`repeats` 默认 1；`provenance` 必填（captured/synthetic/imported），禁止匿名用例；`case.lock` 存 prompt/fixtures/assert 的 sha256，防篡改。

### 4.2 Runner：三条 lane

| lane | 做什么 | 成本/用途 |
|---|---|---|
| `live`（默认） | 两个隔离 `DSH_HOME` 各装基线/候选 DSH + 插件，真实模型跑同一 case | 有成本；模型/插件/DSH 升级的唯一质量证据 |
| `replay` | 用 `ctx.sessions.create({seed})` 重放已录事件，重推导 host 投影 | $0；抓 host/投影/渲染数据回归；**不重跑模型或工具** |
| `cassette`（v0.2） | provider 响应缓存（Inspect 式，按 canonical request hash） | $0；只证明“接线没变”，不产质量声明；rc.4 无原生支持，做可选 adapter |

执行步骤：① `plan` 解析 case/环境/单因子变更，估成本，查 Grant；`--dry-run` 打印。② `prepare` 建临时 `DSH_HOME`，按 lockfile 固定 DSH/插件 integrity，用 Root 或 `git worktree` 在 commit 上挂只读工作区，模型密钥走短期环境变量、不落盘。③ `execute` 交错跑 baseline/candidate，解析 `--json` NDJSON 只作进度；recorder 插件从公开 `session/event`/`ctx.sessionQuery` 写完整 `events.ndjson`、`usage.json`、`approvals.json`。**stdout 不是日志**：`--json` 每行封顶 32 KiB、字符串 8 KiB 且省略事件（`packages/bundle/headless/README.md:104,192`）。④ 归一化：去时间戳/ID/临时路径/耗时，canonical JSON。⑤ `diff` + `gate`。进程退出码 0 与 `final.reason.kind === 'completed'` 必须同时成立（`packages/bundle/headless/README.md:96,136`）。

### 4.3 四维 diff

| 维度 | 采集 | 判据 | 默认门禁 |
|---|---|---|---|
| **result** | 最终 assistant 文本、产出文件 | exact/contains/regex/JSON Schema/文件 sha256 | 不匹配 = FAIL；LLM judge 只做 tie-break，默认关 |
| **trajectory** | tool_call/tool_result 序列、参数、步数、tool error、turn reason | 必需/禁止工具、maxSteps、归一化 trace hash | 禁止工具或必需工具缺失 = FAIL；步数涨 >50% = WARN |
| **cost** | session usage 的 uncached input/output/cache read/write | `token-meter` 给 token；USD 由 Check 的 `pricing.json` 算（含 cache/peak，带 source+retrievedAt） | 超 maxUsd/maxTokens 硬杀；>baseline×1.2 = FAIL |
| **approval** | `approval/asked` + `approval/decided` 对、policy、permission preset | ask 次数、outcome、新增被拒/不可用工具 | 新增 `rejected`/`unavailable` 或 ask 超 baseline = FAIL |

Verdict 五种：`PASS` / `REGRESSION` / `BLOCKED` / `UNSTABLE` / `NOT_COMPARABLE`。退出码：0 PASS；1 REGRESSION；2 BLOCKED/UNSTABLE/NOT_COMPARABLE。**2 不是 1**：基础设施/无法比较不能算产品回归，否则 CI 会误伤。

### 4.4 Baseline、flake、CI

- **Baseline 双层**：`EnvironmentSnapshot`（旧 DSH/插件/模型）与 `BaselineRecord`（上次接受的结果）。`baseline accept` 生成不可变 revision + reason/approver，**不自动 ratchet**；环境或 case set digest 不匹配 → `BLOCKED`，除非显式 `--allow-mixed`。
- **单因子**：默认只允许改一个变量（DSH 版本、插件版本、模型路由之一）；多变量变更记 `factors[]` 并标 `attribution: ambiguous`。
- **flake**：重试只针对 infra error（provider 5xx/超时/`BLOCKED`），断言失败不重试；`repeats>1` 出现混合结果 = `UNSTABLE`（exit 2）；quarantine 必填 owner + expiresAt，报告显式列 skipped，绝不静默跳过。
- **CI Action**：`perrylink/dsh-check-action@v1`，输入 suite/baseline/candidate/mode/budget/fail-on；输出 verdict、JUnit、Markdown、PR 评论；Action 按 SHA pin。**fork PR 只跑 replay（无密钥、$0）**；live 只在受信分支、`schedule`、`workflow_dispatch` 跑。夜间金丝雀定时装 `dsh@next` 跑 live suite，回归自动开 issue/评论，不自动改代码。

### 4.5 `ctx.canary` seam

```ts
interface CanaryService {
  capture(sessionId: string, opts: CaptureOptions): Promise<Case>
  list(filter?: CaseFilter): Promise<Case[]>
  run(req: RunRequest): Promise<RunHandle>          // 异步，返回 runId
  gate(runId: string, policy: GatePolicy): Promise<Verdict>
  baseline: {
    accept(runId: string, opts: AcceptOptions): Promise<Baseline>
    current(scope: Scope): Promise<Baseline | null>
  }
  quarantine(caseId: string, opts: QuarantineOptions): Promise<void>
  export(runId: string, format: 'json' | 'junit' | 'md'): Promise<Artifact>
}
```

事件：`canary/case-captured`、`canary/run-started`、`canary/case-finished`、`canary/run-finished`、`canary/baseline-accepted`、`canary/quarantined`。存储用 `ctx.storageDomain` 的 `check` domain；case 是 git 友好文件，run 是 JSONL。Client 用现有 settings/slot 挂“Check”页：Cases / Runs / Diff（四维）/ Baselines / Quarantine。Agent tools：`check_capture`、`check_run`、`check_gate`、`check_baseline_accept`、`check_explain`。CLI：`dsh check init|capture|run|gate|diff|baseline|quarantine|export|doctor`。

## 5. 与 Act / Allow / Root 组合

**Act**：`check.run` 是 Check 在 Act 里的入口 action，其余为辅助动作；全部注册 ActionDescriptor（`id, title, argsSchema, risk, availability, preview, execute, undo`）：

| Action | 参数 | 风险 | preview 必须显示 | undo |
|---|---|---|---|---|
| `check.capture` | sessionId, name, redaction | R1 | 脱敏后的 prompt、将写入的文件、TTL | 删除 case（未被引用时） |
| `check.run` | cases, baseline, candidate, mode, maxUsd | R2 | 环境 diff、case 数、预估成本、Grant | 无；只能 cancel（花钱不可逆） |
| `check.gate` | runId, policy | R1 | verdict 与失败 case | 无（只读计算） |
| `check.baseline.accept` | runId, reason | R2 | 新旧 baseline 差异、受影响 case | 回退到上一 revision |
| `check.quarantine` | caseId, owner, expiresAt | R1 | 将跳过的门禁项 | 解除隔离 |

**Allow**：写操作前查 Allow 的 Grant：`ctx.allow.ensure({subject, capability, scope})`。能力：`check:case:write`、`check:run`（含 `maxUsd`/`maxCases`）、`check:baseline:write`、`session:read`、`model:egress`、`proc:spawn`、`fs:write`。无 Grant → `ask`；非交互/CI → `deny` + exit 2。`check.run` 的 Grant 绑定 suite、候选环境、预算与过期时间；子进程只继承衰减后的 Grant；撤销后下一次调用拒绝，运行中尽力取消。**绝不默认放行**。

**Root**：`EnvironmentSnapshot.rootRef` 只存 `{id, revision, digest}`，由 Root 以只读方式物化到 commit，不复制工作区；环境 diff 用 `ctx.root.diff(a,b)`。没有 Root 时降级：git commit + `--dump-config` 输出 hash + 插件 lockfile hash，标 `rootRef: null, degraded: true`，仍可跑，只是不可精确复现。

Act/Allow/Root/`ctx.canary` 在 rc.4 内核都不存在（`docs/capability-seams.md` 只有 `ctx.sessions`/`ctx.sessionQuery`/`ctx.storageDomain`）。实现用 feature-detect：`ctx.get('act')` 等存在则接，不存在则 CLI 独立工作；**不 patch 内核**。

## 6. 安全 / 隐私

- **取例脱敏**：默认本地；抓取前扫描密钥、token、邮箱/电话/IP、home 路径、租户 ID、熵异常；`--dry-run` 打印将保存的内容；支持 `redact` 与 `hash` 两档；原始 session 永不复制进 case；case 默认 90 天过期。
- **租户隔离**：case/run 按 `owner/scope` 分目录（项目 `.dsh/check/` 或 `DSH_HOME`），不共享缓存、不跨租户索引；报告默认只含 case id，不含 prompt；导出/分享需显式 `--share` + 脱敏回执。
- **成本上限**：case 级 maxTokens、run 级 maxUsd、墙钟、maxSteps 四道闸；到顶 kill 子进程；运行前按 baseline 中位数估算，估算超预算直接拒绝（fail closed）。`pricing.json` 带来源与抓取时间，不硬编码。
- **模型非确定性**：固定 provider/model/route，记录 tokenizer/price 版本；`repeats` + 配对比较；路由/别名变了标 `NOT_COMPARABLE`，不拿绝对分数说“变好/变坏”。
- **审批录制**：只读 `approval/asked|decided` 日志事件；脚本化 answerer 只在隔离 profile 里启用，默认 deny unknown，绝不注入用户真实 session；审批 reason 脱敏后入库。
- **供应链**：插件按 integrity pin；Action/镜像按 SHA pin；fork PR 无密钥；replay lane `--no-network`；npm 包开 provenance。
- **数据事故**：case 可删、baseline 可 tombstone；session 是用户资产，Check 不拥有、不清除、不上传。

## 7. 失败模式

| 失败模式 | 早期信号 | 缓解 |
|---|---|---|
| 金任务过拟合 | 套件 100% 通过，但换措辞/换 fixture 就挂 | hold-out、mutation（同义改写/扰动工具）、provenance + owner + 过期、跨仓取例 |
| flake 误报 | 同一 case 反复红绿 | infra/断言分离、repeats、归一化、quarantine、报告不稳定率 |
| 成本爆炸 | 单次 run 账单超预估 | 预算硬闸、replay、抽样、缓存、夜间跑而非每 PR |
| 模型升级不可比 | tokenizer/价格/路由变化 | 固定 route、`NOT_COMPARABLE`、只比任务级通过率、显式 `--accept-model-change` |
| 误报导致门禁被关 | gate disable 率 >30% | 确定性断言优先、失败必带复现命令、一键 waiver 留痕 |
| session 格式迁移 | 解析失败/字段缺失 | 锁 schema v1、adapter 隔离、golden fixture、升级前 smoke |
| runner 与 DSH CLI 漂移 | `--json`/flag 变更 | 版本矩阵 CI、CLI 契约测试、错误码明确 |

## 8. MVP 4-6 周

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | case schema v1、脱敏、`dsh check capture`、从 PerryLink 真实 session 抽 10 条 | 10 条可跑；密钥/PII 扫描 0 命中；单条 capture <30s |
| W2 | 双 `DSH_HOME` runner、`--json`/recorder、环境快照、预算 kill | 同 case 产出 run.json；replay 10/10 一致；live ≤$0.15/case |
| W3 | 四维 diff、归一化、baseline、JUnit/Markdown、exit code | 植入 10 个回归抓到 ≥8；误报 ≤1；门禁可复现 |
| W4 | GitHub Action、PR 评论、夜间 `dsh@next` 金丝雀、文档 | 无变更 PR 绿；植入回归红；fork PR 不泄密 |
| W5 | `ctx.canary`、Act action、Allow 查询、Root 引用、npm 0.1、3 仓 dogfood | 3 仓接入；10 次真实升级；抓到 ≥1 个真实回归 |
| W6 | 企业硬化（可选）：租户隔离、审计导出、SSO、SLA | 设计伙伴验收 |

**MVP 总验收**：① 10 条真实任务；② replay 确定性 10/10；③ 植入回归 ≥8/10、误报 ≤1/10；④ live ≤$0.15/条、回放 <30s/条；⑤ 10 条套件 p95 ≤10 分钟；⑥ 1 个真实升级回归被拦下并可复现。

## 9. 指标 / 验证

| 层级 | 指标 | 首年目标 |
|---|---|---|
| 采用 | CI 接入仓数、周 run 数、每仓 case 数 | 30 仓 / 300 run/周 / ≥8 case |
| 效果 | 升级前拦下的真实回归数、复现率 | 20 个；复现率 ≥90% |
| 质量 | 误报率（gate 红但复跑不红）、flake 率、quarantine 率 | ≤10% / ≤5% / ≤10% |
| 效率 | 从升级到定位的分钟数、capture→首跑时间 | <15 min / <10 min |
| 商业 | 免费→Pro 转化、Team 席位、gate disable 率 | 3% / 20 席 / <30% |

**验证设计**：3 个 PerryLink 仓 dogfood + 5 个设计伙伴；10 次真实升级（rc.4→rc.5、插件 patch/minor、模型 alias）；10 个合成回归（删工具、改工具描述、加审批、涨成本）；每周看误报与关闭原因。所有“抓到回归”必须附 runId + 复现命令，不接受口头声明。

## 10. 打包 / 变现

| 档 | 价格 | 内容 |
|---|---|---|
| Free | $0 | CLI、10 case、本地 run、JUnit、公开仓 Action |
| Pro | $12/月 | 无限 case、baseline 历史、diff UI、3 仓、夜间金丝雀 |
| Team | $29/seat/月 | 共享 baseline、CI 门禁、10 仓、SSO、90 天报告 |
| Enterprise | 年付 | 自托管 runner、租户隔离、审计导出、SLA、升级准入证据包 |

开源核心 Apache-2.0；托管面板/保留/合规模块收费；**不按 run 抽税**，不卖模型排名。分发：npm `dsh-check`、GitHub Marketplace Action、DSH 插件市场、PerryLink 家族交叉推广（locator 8,911/月、auto-review 7,313/月、budget 5,123/月、eval-pack 3,498/月），把“兼容矩阵”从版本组合数据变成 PASS/FAIL 门禁。所有页面写“not affiliated with DeepSeek”。

## 11. 风险 / 开放问题

1. **官方吸收**：#11079 已提“轨迹分析与评测闭环”；应对是把 schema 提案给上游、做参考实现，而不是等。
2. **直接竞品**：`dsh-eval-harness` 已覆盖 YAML+headless+baseline+exit；差异化必须落在配对、四维、Action、真实 session；可考虑 import 它的 YAML。
3. **回溯竞品**：`dsh-session-eval` 已做“变好/变差”回溯；要证明“前瞻配对”能抓到它抓不到的回归。
4. **通用 eval 红海**：promptfoo/Inspect/DeepEval 很强；Check 只做 DSH 原生（session/approval/token/权限），不做通用语义评测。
5. **误报杀死产品**：模型非确定性下，“回归”定义必须保守；2 个连续失败或确定性断言才判 REGRESSION。
6. **隐私事故**：一次上传用户 session 就致命；默认本地、默认脱敏、默认不分享。
7. **seam 不落地**：Act/Allow/Root 是家族提案，可能长期不在内核；CLI 必须独立可用，集成层 feature-detect。
8. **名字拥挤**：`dsh-check-*` 已有更新检查器，安全圈 canary token 又与发布 canary 同名；先占名、首句限定“upgrade canary”、关键词区分；若被抢注退 `dsh-canary`。
9. **付费意愿**：个人作者不愿为门禁付费；企业 CI/审计才是买家，Pro 只是漏斗。
10. **审批脚本化造成虚假安全感**：CI 里 auto-allow 会掩盖真实审批回归；报告必须标 `approvalMode`，关键套件另跑真实审批录制。
11. **DSH 版本矩阵维护成本**：rc 周更；用定时金丝雀 + 社区 case 分摊，否则会被维护拖死；Windows/WSL/macOS 路径与进程终止差异也要进 CI 矩阵。

**开放问题**：case 归谁（个人/团队/租户）？保留多久？是否允许把脱敏 case 贡献到公共 corpus？官方是否愿意接受 `ctx.canary`/case schema？企业版能否接受“证据包”而非“SaaS 面板”？`dsh-eval-harness` 是竞争还是可合并的上游？

## 12. 证据

- 宿主源码（checkout `0.2.2-rc.4`，`ca33fd6`）：`docs/subsystems/session.md:5`（append-only，replay=再推导）；`packages/bundle/headless/README.md:12,96,104,136,192`（exit 0/1、`final.reason`、`--json` 上限、stdout 非日志）；`docs/cli-help.md:100-131`（headless flags）、`:41,45`（`--patch`、`--dump-config`）；`docs/subsystems/approval.md:11,86`（`approval/asked|decided`）；`packages/llm/token-meter/README.md`（replay-aware token 计量）；`docs/capability-seams.md:760,764`（`storageDomain`/`sessionQuery`；无 canary/act/allow/root）。
- npm Registry（2026-11-20）：[`dsh-check` 404](https://registry.npmjs.org/dsh-check)（可用）、[`dsh-test` 0.0.1](https://registry.npmjs.org/dsh-test)（预留）、[`dsh-guard` 1.0.0](https://registry.npmjs.org/dsh-guard)（运行期守护）、[`dsh-prove` 404](https://registry.npmjs.org/dsh-prove)、[`dsh-canary` 404](https://registry.npmjs.org/dsh-canary)。
- 竞品/生态：[`dsh-eval-harness` 0.3.1](https://www.npmjs.com/package/dsh-eval-harness)（237/月）；[`dsh-session-eval` 0.4.1](https://www.npmjs.com/package/dsh-session-eval)（1,942/月，回溯、不跑新任务）；[`dsh-eval-control` 0.5.0](https://www.npmjs.com/package/dsh-eval-control)（29★、2,215/月）；[`dsh-eval-guard` 0.7.11](https://www.npmjs.com/package/dsh-eval-guard)（3,762/月）；[`dsh-eval-pack` 0.2.0](https://www.npmjs.com/package/dsh-eval-pack)（PerryLink，3,498/月，可作 grader）。
- 家族分发：[`dsh-locator`](https://www.npmjs.com/package/dsh-locator) 8,911/月、[`dsh-auto-review`](https://www.npmjs.com/package/dsh-auto-review) 7,313/月、[`dsh-budget`](https://www.npmjs.com/package/dsh-budget) 5,123/月（npm last-month，2026-10-21~11-19）。
- 上游讨论：[#11079 轨迹分析与评测改进闭环](https://github.com/deepseek-ai/deepseek-harness/discussions/11079)、[#10436 候选插件隔离评测与用户批准晋级](https://github.com/deepseek-ai/deepseek-harness/discussions/10436)；维护者未给承诺。
- 前序研究与外部方法：`01-research/dsh-os-primitives-2026-11-20/12-agent-native.md` §5.3/§7（评测空白与 v0 草案）；`01-research/advisers-hardening-2026-11-17/04-0.3-research/15-eval-contracts.md`（Inspect 缓存、Anthropic error bars、pricing/replay 边界）；`01-research/dsh-agent-os-gaps-2026-11-14/03-plugin-landscape.md`（95 个 eval repo、top 40★、`dsh-eval-harness` 14★）；[Inspect caching](https://inspect.aisi.org.uk/caching.html.md)（provider 缓存换确定性，不做 HTTP VCR）；[Anthropic: Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640)（小样本必须报误差，不能只看点估计）。
