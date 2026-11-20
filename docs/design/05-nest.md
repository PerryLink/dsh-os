# 05 Nest：工作区档案（Workspace Profile）

> 判断：DSH 的 workspace 现在只是**一条记录**（`path/title/sessionIds/createdAt/updatedAt`），不是**契约**。Nest 把它升级成可版本化、可执行、可审计、可带走的工作区档案——打开项目，每个会话自动继承上下文、权限、环境与默认值，且能 diff、能解释、能回退。
> 2026-11-20 · DSH checkout `0.2.2-rc.4`（`ca33fd6`）· 对象 PerryLink（个人开发者，非官方，not affiliated with DeepSeek）· 交付契约：Host seam `ctx.workspaceProfile` + Client UI + Agent tools + CLI。

## 0. 口径与证据边界

- 内核结论读自本机 checkout `ca33fd6`（`package.json` = `0.2.2-rc.4`，2026-11-17 merge），rc.5 未逐项复核；npm 读数 = `downloads/point/last-week`，抓取日 2026-11-20，是采用代理而非安装量，未检索到 ≠ 不存在。
- 带日期的数字是抓取时现值；本文无自测性能/转化数字，未实测一律标「待验」。

## 1. 名字与可用性（2026-11-20 registry 实测）

| 候选 | npm 状态 | 判定 |
|---|---|---|
| **dsh-nest** | **404 未发布** | ✅ 首选，立刻占位 |
| dsh-den / dsh-pad | 404 / 404 | 备选；语义偏「窝/便签」，弱于 Nest |
| dsh-room | **200**，`0.0.1`「name reserved; first release in development」，1.4 kB | ❌ 占位包已占 |
| dsh-profile | **200**，同类占位包 | ❌ 已占 |
| dsh-workspace-profile | 404 | 只作搜索别名，**不作包名**（与官方 `@deepseek-ai/dsh-workspace` 同族，易误认官方） |

- **最终名**：Nest｜npm `dsh-nest`｜seam `ctx.workspaceProfile`｜CLI `dsh nest`｜对象 `WorkspaceProfile`。
- 语义：工作区是「巢」——上下文、护栏、环境住在里面，走时整个带走（`Den` 像缓存目录、`Pad` 像便签、`Room` 已被占）。残留风险：404 ≠ 永久可注册（可能被撤包保留），落地第一步 `npm view dsh-nest` 复核并发 `0.0.1` 占位；与 NestJS 无包名冲突，检索须带 `dsh` 前缀。

## 2. 一句话 / 问题 / 用户

**一句话**：Give every workspace a contract, not a folder——打开项目，会话自动继承上下文、权限、环境与默认值，且可 diff、可解释、可审计、可带走、可回退到上一版。

**问题**（三条，都可指到源码/数据）
1. **只有记录**：`workspaceRecord` 就 5 个字段（`packages/workspace/workspace/src/spec.ts:24`），`Workspace` 接口除标题与 session 记账外只有 `status(): 'ok'|'missing-dir'`（`entity.ts:194`）；无 context / permissions / env / lifecycle。
2. **配置散在六处**：`AGENTS.md` 靠目录约定自动发现、skills 靠项目根 `.dsh/skills` 约定（`skill-filesystem/src/index.ts:252`）、sandbox 靠会话内 `sandbox/mode` 事件、preset/model 靠会话级投影、env 靠 shell、权限靠规则文件。没有一处能回答「这个项目的标准配置是什么、从哪层来」。
3. **团队无共享契约**：同事只能口头/README 复述「我们要 workspace-write、要这几个 skill、要走这个代理」。最近的 `dsh-workspace-combiner`（564/w，v0.8.13）已做「多项目路径注入 + 联动沙盒白名单」，但它是**运行时注入器**，不是可版本化/可审计/可共享的档案。

| 人群 | 场景 | 为谁付钱 |
|---|---|---|
| 个人（2–10 项目，每周 3+ 会话） | 客户代码 vs 自己项目要不同护栏；换机器要重建 | 免费核心；不想每次重新交代 |
| 团队（3–20 人，常 review 客户代码） | 新人第一天就要正确权限/上下文/环境；审计「谁改过护栏」 | $8/seat/月：共享档案、审计、策略包 |
| 企业（受审计行业） | 项目级最小权限 + 可证明的执行环境 | 席位 + 私有 registry + SSO（v2） |

## 3. 范围与非目标

| 范围内（v1） | 范围外（明确不做） |
|---|---|
| `nest.profile.yml` schema + 校验 + 优先级 + 生效值解释 | **文件管理器**：不接管文件树/预览/CRUD（官方 `ui-sidebar-files` 已做且只读） |
| 新会话/恢复/fork/切换时应用；`show/doctor/diff/apply/export/import/migrate` | **云盘/同步后端**：不做多端同步、不做 blob 存储（接 session-sync / 用户自有 git） |
| settings 页 + 会话面板状态条 + CLI + 审计导出 | **快照引擎**：快照/回滚交 checkpoint-rewind，Nest 只声明 lifecycle 契约 |
| 模板库（Node/Python/monorepo/无 git 目录） | **secret 存储/第 5 套规则引擎/多根 explorer**：只引用 CredentialRef、Grant、roots |

## 4. 架构

### 4.1 WorkspaceProfile schema（`nest.profile.yml` 置于工作区根）

```yaml
apiVersion: nest/v1                 # schema 版本，与内容版本分离（4.4）
metadata:                           # 共享对象基类
  id: wp_01J9...                    # 稳定 id，不用路径（realpath 会重写）
  owner: user:perry                 # 团队为 team:acme-dev
  scope: workspace                  # workspace | user | team
  createdAt: 2026-11-20T12:00:00Z
  updatedAt: 2026-11-20T12:00:00Z
  expiresAt: null                   # 到期降级，见 7.3
  auditRef: nest:wp_01J9...@3       # 指向审计事件
workspace:
  path: "."                         # 必须 realpath == workspace.path，否则 doctor 报 E-PATH
  roots: ["../shared-lib"]          # 额外可写根 → sandboxPolicy.registerWritableRoot
context:
  agents: ["AGENTS.md", "docs/architecture.md"]   # 声明上下文 → systemPrompt.context()，非目录约定
skills:
  required: ["pdf", "office"]       # 只校验存在；项目内 .dsh/skills 已自动发现
  roots: []                         # 工作区外的额外根（需 Grant）
permission:
  sandbox: workspace-write          # 唯一被强制执行的字段 → setSandboxMode
  grants: ["grant:fs:write:src"]    # 引用 Allow 的 Grant id，不内联规则
  denyCommands: ["git push --force"] # 默认只作提示层（见 7.6）
env:
  profileRef: "root:acme-dev"       # 引用 Root（Environments）的 profile 名
defaults: { preset: standard, model: deepseek-chat, approval: ask }   # preset 仅新会话生效
lifecycle: { onTurn: snapshot, trash: retain-30d }                    # 声明式交给 checkpoint-rewind
```

基类映射：`id`→`metadata.id`（uuid，非路径）｜`owner`→`user:<id>`/`team:<id>`｜`scope`→决定写权与继承链｜`createdAt/updatedAt`→ISO-8601，改档必更｜`expiresAt?`→到期 `degraded` + 只读｜`auditRef`→每次 apply 追加，导出可对账。

### 4.2 继承与覆盖（四级，冲突必须可解释）

`deployment default → user profile → team profile → workspace profile`，后层覆盖前层；同一层内**后写不静默覆盖**（带 `expectedHash` 的 CAS，见 7.4）。

- 解释性照抄 `settings` 的 provenance 形状（`resolved / base / user`，`packages/settings/settings/src/types.ts:29`）：`resolve()` 每字段返回 `{ value, from, overridden: [...] }`。与沙箱层序对齐：`approved 显式模式 > 会话最后一次 sandbox/mode > 部署默认`（`sandbox-policy/src/index.ts:208`）。**profile 不是第五层沙箱**——它只在会话开始时写一条 `sandbox/mode` 事件，之后走内核既有优先级，运行中用户手动改档**永远赢**。

### 4.3 应用时机

| 时机 | 挂接点（已核实） | Nest 动作 |
|---|---|---|
| 新会话 | `agent/created`，`source:'startup'`（`core/agent/src/runtime-types.ts:152`） | 全量 apply，写 `nest/applied` |
| 恢复 | 同事件 `source:'resume'` | **必须重放运行时态**：`registerWritableRoot` 的授权 runtime-only（原文：*Grants are runtime-only and must be registered again after resume or fork*，`sandbox-policy/src/index.ts:237`） |
| 清空/压缩 | `source:'clear'/'compact'` | 不重开会话；`systemPrompt.context()` 在每次组装时求值、无需重放（`core/system-prompt/src/index.ts:84`），但**消息通道**（`agent.inject()`，`hooks-claude-code` 同款，`experimental/hooks-claude-code/src/index.ts:212`）会被压缩吃掉，compact 后需重新注入 |
| fork | `session/fork`，子会话按 `sessionIds` 归属（`session-controller/src/commands.ts:571`） | 继承父 profile id，重注册 roots，写 `nest/inherited` |
| 会话切换 | 切到另一 session | 按该 session header `cwd` realpath 匹配；无匹配 = no-op（不改未配置工作区行为） |
| 运行中改档 | 文件 watch | 写 `nest/drift`；热更白名单 `sandbox/roots/context/defaults`（下一轮生效）；**`preset` 不可热更**（会话级投影，需新会话） |

### 4.4 版本化与 diff

- 三个独立版本：`apiVersion`（schema，破坏性才升）、`hash`（规范化 YAML 的 sha256，内容指纹）、`revision`（该 workspace 的 apply 序号）。每次 apply 往自有 storage domain（`ctx.storage.domain` + `defineDomain`，`storage-domain/src/index.ts:2`）写 `{workspaceId, hash, revision, appliedAt, sessionId|actor, source, degraded[]}`。
- `dsh nest diff` 三方对比 `working file` vs `last applied` vs `team baseline`，输出字段级 diff + 受影响会话数；档案进仓库时 **git 就是历史**，Nest 不重造 VCS，只保证「文件内容 → 生效指纹」可对账。
- 迁移：未知主版本 → 拒绝加载并提示 `dsh nest migrate --dry-run`（先打印将改字段，再落盘；永不自动改文件）。

### 4.5 `ctx.workspaceProfile` seam

```ts
class WorkspaceProfileService extends Service {           // super(ctx, 'workspaceProfile')
  resolve(scope: {session?: Session; workspaceId?: WorkspaceId}): Promise<ResolvedProfile>  // 生效值 + provenance
  show(workspaceId): Promise<ProfileView>
  doctor(workspaceId): Promise<Finding[]>                 // 纯只读，无需 Grant
  diff(workspaceId, o?: {against?: 'applied'|'baseline'}): Promise<FieldDiff[]>
  apply(workspaceId, o?: {dryRun?: boolean; expectedHash?: string}): Promise<ApplyReceipt>
  export(workspaceId): Promise<string>                    // 已脱敏
  import(yaml: string, o?: {expectedHash?: string}): Promise<ApplyReceipt>
}
// 事件：nest/applied · nest/drift · nest/degraded · nest/blocked
```

只 depend 已存在的公共 seam：`workspaceRegistry`（`workspace/src/index.ts:220`）、`sandboxPolicy`（`registerWritableRoot`/`setSandboxMode`）、`systemPrompt.context()`（`core/system-prompt/src/index.ts:524`）、`skills`、`storage.domain`、`credentials`；远端面用 `TypertRemoteService`（与 `WorkspaceRegistry` 同款）供 Client 调用，不 patch core。`workspaceRegistry` 或 `sandboxPolicy` 缺失 → 只读模式（show/doctor/diff 可用，apply 拒绝并说明原因）。

### 4.6 Client UI（不接管官方工作区 UI）

| 面 | 插槽（已核实） | 内容 |
|---|---|---|
| 设置页 | `settings.section`（`ui-agent-preset/src/client/index.ts:283` 同款） | 档案列表、字段编辑、provenance、diff、导入导出、doctor 报告 |
| 会话面板 | `conversation.session.panel.section`（`ui-jobs/src/client/index.ts:38`） | 一行：`profile: acme-web @r3 · 2 项漂移`，点击展开 |
| 会话头角标 | `conversation.session.panel.indicator` | 只在降级/漂移时亮，不常驻噪音 |
| **不碰** | 右侧栏文件树（root = 会话 cwd、只读、单根）、文件预览、workspace 增删（`delete.workspace` 归官方） | 官方边界即 Nest 边界 |

## 5. 与 Allow / Root / Check 的组合

| 组合 | 契约 | 形态 | 失败即关 |
|---|---|---|---|
| **Allow（Grant）** | 写前查 Grant；Grant = 主体 × 能力 × 范围 × 期限 × approver | `permission.grants[]` 只存 Grant id；`apply` 是 `risk:'write'` 动作，无 Grant → 一次性审批；profile 请求的档位高于 Grant 上限 → 停低档 + `nest/degraded` | 不自行提权；`danger-full-access` 必须有对应 Grant 才写事件 |
| **Root（Environments）** | 环境只存引用不存值 | `env.profileRef: root:<name>`，Nest 从不解析值，只校验可解析；导出保留 ref 原文 | Root 缺失 → 字段标 `unresolved`，其余照常应用 |
| **Check（Canary）** | 升级前用真实任务配对验证 | `dsh nest export --baseline` 产出 Check 可直接吃的基线；升级 DSH/换 model 后先跑 Check，回归计入其审批/成本维 | Check 报回归 → `apply` 拒绝，`--force` 需审批 |
| **Act（ActionDescriptor）** | 关键操作注册为 action，人面与模型面共享 | 见下 | 无 |

| action id | risk | Grant | 镜像的 agent tool |
|---|---|---|---|
| `nest:profile.show` / `.doctor` / `.diff` | read | 否 | `workspace_profile_show/doctor/diff` |
| `nest:profile.apply` / `.import` | write | **是** | `workspace_profile_apply` |
| `nest:profile.migrate` | exec | 是 + 备份确认 | — |

CLI 与之同名（`dsh nest show|doctor|diff|apply|export|import|migrate`），全部支持 `--json`。

## 6. 安全与隐私

1. **路径边界**：`workspace.path` 必须 realpath 等于注册记录；`roots` 限工作区内或显式 Grant 覆盖内，绝对路径、拒绝软链（复用 `registerWritableRoot` 既有校验：相对路径/NUL 抛错，缺失/非目录/软链拒绝）。内核事实：额外可写根在 **Windows 只对 harness 文件工具生效，进程权限不变**（`sandbox-policy/src/index.ts:238`）——profile 不得宣称「命令也受限」。
2. **秘密只存引用**：`env` 走 Root 引用；`CredentialRef`（`credentials/src/types.ts:14`）是裸引用；UI 只显示 `configured/writable`（`CredentialRecordInfo`，`credentials/src/index.ts:128`），**永不取值**。loader 对高熵串与 `sk-`/`ghp_` 前缀直接拒绝并建议改引用。
3. **团队共享**：档案进 git 即共享；`owner/scope` 决定写权；`expectedHash` CAS 防静默覆盖；每次 apply 记 `actor`（user/agent/session），团队版另记 `approver`。
4. **审计与上报**：`nest/applied|drift|degraded|blocked` 四类事件 + JSON/CSV 导出；审计主语复用 Allow 的 subject 模型，不造第二套身份。指标全为本地事件，团队版仅在显式开启时汇总计数（无路径、无内容）。
5. **迁移**：`import` 先校验（schema/路径/引用可解析）再落盘，失败不动原文件；跨机导入必须重验路径与 Grant（Grant id 不跨机器）。

## 7. 失败模式

| # | 失败 | 检测 | 行为 |
|---|---|---|---|
| 7.1 | **与官方 workspace UI 边界模糊** | 季度复核 | 官方文件树 root = 会话 `cwd`（`api/workspace-files/src/index.ts:231`）、只读（同文件 `:2`「exposes no mutations」）、单根；Nest 只加档案视图，不做文件 CRUD |
| 7.2 | **profile 漂移** | watch + apply 时 hash | 两向都报：文件改了未应用（`drift:pending`）、应用后被改（`drift:tampered`）；白名单外字段绝不静默 live-apply |
| 7.3 | **路径失效/过期** | `status()==='missing-dir'`（`entity.ts:194`）、`expiresAt` | 档案保留但停用/只读 + 横幅；目录回来自动恢复，不要求重建 |
| 7.4 | **团队权限冲突** | `expectedHash` 不匹配 | 拒绝写 + 返回三方 diff；不自动 merge、不 last-write-wins |
| 7.5 | **静默降级** | 每次 apply 产出 `degraded[]` | 任一字段未应用必须留事件 + 黄色角标；`--quiet` 也不许吞 |
| 7.6 | **shell 绕过** | 已知，写进文档 | `denyCommands` 是提示/审批层不是强制层；UI 绝不声称「已阻止」 |

## 8. MVP：4 周

| 周 | 交付 | 出口判据 |
|---|---|---|
| W1 | schema + loader/validator + 四级优先级 + `resolve()` provenance；10 个 fixture（含坏档）；`workspace_profile_show` | 坏档 100% 拒绝并报字段路径；好档 100% 加载 |
| W2 | `agent/created` 应用（startup/resume/clear/compact）+ fork 继承 + roots 重注册；`doctor`+`drift`；3 个真实模板（Node/Python/monorepo） | 新会话与恢复都 100% 生效；resume 后 roots 仍有效 |
| W3 | 设置页（列表/编辑/provenance/diff/导入导出）+ 会话面板状态条 + 审计事件 + 错误恢复 | 首次配置 < 5 分钟（3 人实测）；导出→清空→导入还原 |
| W4 | `apply` 的 Grant 检查 + 6 个动作注册进 Act + CLI + 0.2.1/0.2.2 双版本 smoke + 文档 + 5 个设计伙伴内测 | `pnpm test` 绿；卸载无残留；未配置工作区行为零变化 |

**验收（硬）**：① 新会话 100% 应用；② fixture 漂移 100% 被 doctor 识别（0 漏报）；③ 卸载后无残留；④ 未配置工作区行为不变；⑤ 双版本 smoke 通过。

## 9. 指标与验证

| 指标 | 定义 | 首季目标 | 验证 |
|---|---|---|---|
| 活跃 profile | 30 天内被 ≥1 会话应用的档案数 | ≥ 20 | 本地事件，opt-in 汇总 |
| 会话命中率 | 有档案 workspace 中应用了档案的会话占比 | ≥ 60% | `nest/applied` ÷ 会话数 |
| 首次配置时长 | 打开设置页到首次 apply | < 5 分钟 | 设计伙伴实测计时 |
| 漂移捕获率 | doctor 抓到 ÷ 已知漂移 | 100%（0 漏） | fixture + 伙伴回放 |
| 迁移成功率 | `import` 成功后 7 天无 `blocked` | ≥ 95% | 事件 |
| 团队席位 / 设计伙伴 | Team 付费席位 / 连续 2 周有 apply | 3 队 20 席 / 5 人 | 订阅 + 回访 |

反指标：apply 失败率高 → schema 太严；`degraded` 频发 → 声明与内核能力脱节。

## 10. 打包与变现

- **核心** `dsh-nest`，Apache-2.0、local-first：单机、单档案、无服务端依赖、只读 doctor 与全部只读 CLI 免费。
- **Pro $6/月**（个人）：多档案、版本回看、模板库、导出报告。
- **Team $8/seat/月**：团队基线、共享档案同步（走用户自有 git/S3，**不托管内容**）、审计导出、策略包、审批人记录。
- **企业 v2**：SSO、私有 registry、合规映射、离线许可。**不抽成市场**（审核责任与运维成本高），模板库先进 Team；分发靠 PerryLink 家族（locator / checkpoint-rewind / session-sync）交叉推广，不做捆绑强依赖。

## 11. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| **官方吸收（最大）** | workspace 已是一等实体且仍在加字段，core 加 policy 是自然演进 | 只依赖公共 seam；把 schema 提案成 upstream discussion 输入；两季度内被吸收则转模板/审计/迁移层 |
| **combiner 向上长** | 564/w、v0.8.13 已「注入路径 + 联动沙盒白名单」，离档案只差版本/审计 | 护城河放「可解释 + 可 diff + 可审计 + 团队基线」，不拼注入 |
| **注入即足够** | 有人觉得 `.dsh/skills` + `AGENTS.md` 约定已够 | 用「新人第一天就正确」「谁改过护栏」两个场景验证 |
| **shell 绕过 / Windows 语义差** | `denyCommands` 非强制；额外根只对文件工具生效 | 文档写死 + doctor 在 Windows 显式报「命令不受 roots 限制」 |
| **schema 版本债** | session 与框架格式都迁移过 | `apiVersion` + `migrate --dry-run` + 永不自动改文件 |

**开放问题**：① 档案放仓库（可 git 审计，但进团队 PR）还是 `$DSH_HOME`（不可移植）——倾向仓库 + `.gitignore` 例外；② `expiresAt` 过期是只读还是完全停用——倾向只读 + 横幅；③ 是否允许 profile 携带 prompt 片段（易膨胀成第二套 prompt 管理）——v1 只允许文件路径；④ 与 session-sync 的边界（同步文件 ≠ 同步 Grant）；⑤ 无 git 目录的团队基线存哪。

## 12. 证据

- 工作区记录仅 5 字段：`packages/workspace/workspace/src/spec.ts:24`；`Workspace` 接口与 `status()`：`packages/workspace/workspace/src/types.ts` / `entity.ts:194`。
- 运行时授权仅内存、resume/fork 需重注册：`sandbox-policy/src/index.ts:244`；解析优先级：同文件 `:208`；`setSandboxMode` 写单条事件：`src/session-mode.ts:53`。
- 生命周期来源：`SessionStartSource = 'startup'|'resume'|'clear'|'compact'`（`core/agent/src/runtime-types.ts:152`）；`agent/created` 派发（`core/agent/src/index.ts:575`）；fork 归属（`api/session-controller/src/commands.ts:571`）。
- 上下文注入：`systemPrompt.context()`/`getContextOrder()`（`core/system-prompt/src/index.ts:524`）；skills 根（`skill/skill-filesystem/src/index.ts:252`）。
- 官方文件面只读、root = 会话 cwd：`api/workspace-files/src/index.ts:2,231`（`:241` 记录「root 外路径也允许预览」，故 Nest 不做路径白名单 UI）。
- provenance 先例：`resolved/base/user`（`settings/settings/src/types.ts:29`）；秘密状态：`CredentialRef`（`credentials/src/types.ts:14`）、`CredentialRecordInfo`（`credentials/src/index.ts:128`）；存储域：`storage/storage-domain/src/index.ts:2`。
- Client 插槽：`client/ui-jobs/src/client/index.ts:38`、`client/ui-agent-preset/src/client/index.ts:283`。
- 竞品：[dsh-workspace-combiner](https://www.npmjs.com/package/dsh-workspace-combiner) 564/w（v0.8.13，描述原文含「联动沙盒白名单」）、[dsh-workspace-migrate](https://www.npmjs.com/package/dsh-workspace-migrate) 1,245/w、[@reed-io/dsh-workspace-move](https://www.npmjs.com/package/@reed-io/dsh-workspace-move) 567/w、[dsh-git-multirepo](https://www.npmjs.com/package/dsh-git-multirepo) 749/w、[dsh-workspace-hub](https://www.npmjs.com/package/dsh-workspace-hub) 199/w——全是整理/移动/树/多仓，无档案层。
- npm 可用性（2026-11-20 registry 直查）：`dsh-nest`/`dsh-den`/`dsh-pad`/`dsh-workspace-profile` = 404；`dsh-room`、`dsh-profile` = `0.0.1` 占位包。核验命令：`curl -o /dev/null -w '%{http_code}' https://registry.npmjs.org/dsh-nest`。
