# 11 Root：环境档案（Env Profiles）

> 判断：DSH 的「环境」现在是一组互不相识的存储面（launch 快照 / 两层 `.env` / credentials / profile patch / 实时 `process.env`），不是一个对象。Root 把它变成**命名、分作用域、带信任级与 provenance 的环境档案**：启动时可 materialize，运行时可解释、可快照、可 diff、可共享；`ctx.env` 是 Host seam。
> 2026-11-20 · DSH checkout `0.2.2-rc.4`（`ca33fd6`）· 对象 PerryLink（个人开发者，非官方，not affiliated with DeepSeek）· 交付契约：Host seam `ctx.env` + Client UI + Agent tools + CLI。

> **npm package:** `@perrylink/dsh-root` — the unscoped `dsh-root` is blocked by npm name-similarity rules; the product name remains **Root**.

## 0. 口径与证据边界
- 内核结论读自本机 checkout `ca33fd6`（`package.json` = `0.2.2-rc.4`）；npm/GitHub 采样 2026-11-20，周下载是**采用代理**不是安装量；本文无自测性能/转化数字，未实测标「待验」，行号升级需重核。
- 一条决定性边界：**launch 快照在 `apps/cli/src/bin.ts:36` 创建、插件 mount 之前就冻结**（`launch-environment/src/index.ts:106-115`），所以插件**无法**回头改 `launchEnvironmentOf()` / credentials / launcher 代理看到的环境。这决定了本文的**两层应用模型**。

## 1. 名字与可用性（2026-11-20 registry 直查）
| 候选 | npm 状态 | 判定 |
|---|---|---|
| **dsh-root** | **404 未发布** | ✅ 主名，立刻占位 |
| dsh-ground / dsh-field | 404 / 404 | 备选；Ground 可作发布失败时的 fallback（语义：ground truth / 地基） |
| dsh-env | 404 | ❌ 搜索被 708 次/周的 `@hyzyn/dsh-env` 占死，语义太泛 |
| dsh-env-profile / dsh-profiles | **200**（`0.1.4`，206 次/周）/**200**（`0.0.1` 占位） | ❌ 已存在 / 已占 |
| @perrylink/dsh-root | 404 | 备用，不作主名（发现性差） |

- **最终名**：Root｜npm `dsh-root`｜bin `dsh-root`｜seam `ctx.env`｜对象 `EnvProfile`｜CLI `dsh-root …` + 会话内 `/env`。**`dsh root` 不可用**：launcher 把第一个非 flag token 当 profile 名（`apps/cli/src/args.ts:206`），`dsh root` = 启动名为 root 的 profile，CLI 必须是独立 bin。
- 残留风险：官方 monorepo 根包内部名就是 `@deepseek-ai/dsh-root`（private，npm 404），源码搜索会撞；README 首行 + `bin` banner + `repository` 三处声明非官方，绝不发 `@deepseek-ai/*` scope。404 ≠ 永久可注册，落地第一步 `npm view dsh-root` 复核并占位。

## 2. 一句话 / 问题 / 用户
**一句话**：Give every workspace and agent a named, explainable, snapshot-able environment — and let every value answer “where did I come from?”（给每个工作区与代理一个命名、可解释、可快照的环境；每个值都能回答「我从哪来、为什么是它」。）

1. **没有环境对象**：`ctx.settings` 只把插件 Config 的 **Volatile** 字段投影成表单，写入也只作用于 volatile path（`settings/src/index.ts:308,386`）；普通变量、跨插件偏好、用户级环境都不在词汇表。settings 的 provenance 只有 `value/base/user` + revision（`settings/src/types.ts:29-43`），回答不了「谁加的 PATH」。
2. **项目 `.env` 被设计成不能设 PATH/代理/endpoint**：`BOOTSTRAP_NAMES` 显式含 `PATH`、`HTTP(S)_PROXY`、`DEEPSEEK_BASE_URL` 等（`app-boot/src/index.ts:137-157`），项目层一律拒绝（`:189-196`），只有 home `.env` 放行代理与两个 endpoint（`:173-185`）。而真实 workspace 恰恰需要这几项。
3. **生态是碎片不是层**：`@hyzyn/dsh-env` 708 次/周，用单文件 `~/.dsh/env.yml` + 直接写 `process.env`（README 原文）；代理插件 743/478 次/周各改一格。`@hyzyn` 自己的 README 承认宿主优先级在 `0.2.1-alpha.3` 翻转过、`process.env` 与 `credentials.resolve()` 可能不同答（「卡片说已配置、MCP 却 401」）。没人做「值从哪来」。

| 人群 | 场景 | 付费点 |
|---|---|---|
| 个人（2–10 仓、多工具链/代理） | 客户项目要不同 PATH/代理/密钥；换机器要重建 | 免费核心：命名 + 解释 + 快照 |
| 团队（3–20 人） | 新人第一天就要「正确环境」；review 时问「谁改的」 | $8/seat/月：共享基线、漂移告警、审计 |
| 企业（受审计行业） | 出网策略、最小权限、Grant 绑定环境 | 席位 + SSO/私有 registry（v2） |

## 3. 范围与非目标
| 范围内（v1） | 范围外（明确不做） |
|---|---|
| `EnvProfile` schema + 校验 + 优先级 + 信任级 + provenance；脱敏快照 + diff | **dotfiles 管理器**：不写 shell rc、不改注册表、不做 `.envrc` 的替代品 |
| 命名 profile CRUD、`use/why/snapshot/import/migrate` + 团队基线 + `.env` 导入 | **系统设置全家桶**：字体/IME/音频/电源归其他产品，不做 |
| Tier A 启动层 materialize（`dsh-root run`）+ 运行时 proxy 叠层 | **密钥存储**：只存 `CredentialRef`，值仍归 credentials |
| 所有权/作用域/审计；workspace `.dsh/env.yml` TOFU | **插件配置编辑器**：Config 仍归 `ctx.settings`，Root 只引用/解释 |

## 4. 架构
### 4.1 `EnvProfile` schema
```yaml
apiVersion: root/v1
metadata:
  id: env_01J9...                 # 稳定 id，不用路径（realpath 会重写）
  owner: user:perry               # 团队为 team:acme
  scope: { kind: workspace, ref: ws_01J9... }
  createdAt: 2026-11-20T12:00:00Z
  updatedAt: 2026-11-20T12:00:00Z
  expiresAt: null                 # 到期只读 + 横幅，不删除
  auditRef: root:env_01J9...@3
trust:
  level: workspace                # trustLevel；与存储位置不符 = 拒绝加载（E-TRUST-SPOOF）
  pin: sha256:...                 # workspace 首次 TOFU 确认的指纹
spec:
  vars:
    NODE_ENV: { value: development }
    OPENAI_API_KEY: { secretRef: OPENAI_API_KEY }   # 只存 ref，永不落值
    GOPATH: { value: "{workspace}/.go" }
  pathPrepend: ["{workspace}/node_modules/.bin", "{workspace}/.venv/bin"]
  proxy: { mode: inherit }        # inherit | direct | manual{ url, noProxy }
  inherit: ["root:base-dev"]      # 组合，显式 DAG；环 = 加载失败
  deny: ["AWS_*", "http_proxy"]   # 否决，低信任层不可加回
revision: 3
```

基类映射：`id/owner/scope/createdAt/updatedAt/expiresAt/auditRef` 原样；`expiresAt` 到期只读；`auditRef` 每次 apply 追加。
### 4.2 存储与优先级

| 层 | 存哪 | trustLevel | 可入仓库 |
|---|---|---|---|
| user | `$DSH_HOME/env-profiles/*.yml` | user | 否（可导出） |
| team | 团队基线（git / 私有 registry，签名） | team | 是 |
| workspace | `<ws>/.dsh/env.yml` | workspace（TOFU pin） | 是 |
| agent | `ctx.storage.domain`（KV） | agent | 否 |
| session | 内存 + storage（`/env set`） | session | 否 |

- **覆盖序（谁生效，后者赢）**：deployment → user → team → workspace → agent → session；**信任序（谁能设哪些字段，前者高）**：user > team > workspace > agent > session。两个序方向相反，混用是最常见的实现错误。
- `deny` 是**否决**：低信任层不能把被 deny 的名字加回来；冲突不 last-write-wins，每字段返回 `from / overridden / trust`。

| 字段 | user | team | workspace | agent | session |
|---|---|---|---|---|---|
| vars（非密） | ✅ | ✅ | ✅ | ✅ | ✅ |
| pathPrepend | ✅ | ✅ | ⚠️ 首次 TOFU + pin | ⚠️ 仅 workspace 内已存在目录 | ✅ |
| proxy | ✅ | ✅（签名） | ❌ | ❌ | ❌ |
| endpoint（`DEEPSEEK_*`） | ✅ | ❌ | ❌ | ❌ | ❌ |
| secretRefs | ✅ | ✅ | ❌ | ❌ | ❌ |
| deny | ✅ | ✅ | ✅（仅本层及以下） | ⚠️ | ✅ |

### 4.3 应用点：两层模型（本产品最关键的事实）

**Tier A · launcher（唯一能改 launch 快照的层）**

- `dsh-root run <profile> -- dsh --profile web`：组合 env（不覆盖显式导出的同名变量；`secretRef` 不 materialize，留给运行时 `resolve()`）→ 子进程 exec → `loadLayeredEnv('dsh')`（`apps/cli/src/bin.ts:36`）读成最高信任的 `process` 层 → `installProxyFromEnvironment` 在首个插件 mount 前装好（`apps/cli/src/profile-boot.ts:286`）→ credentials 的 inherited 层、`!!js` 配置、MCP 子进程、子代理 CLI 全部吃得到；`dsh-root env <profile> --shell=posix|pwsh` 输出 direnv 风格 export 行（**不写 rc**）。
- 代价：**一进程一环境**，与 proxy 进程级、快照不可变对齐。Web GUI 单进程多 workspace 时，v0 的 workspace 环境只对 Root 自己的命令生效。

**Tier B · in-process（解释 + 局部注入）**

| 面 | 现有 seam | Root 动作 | 缺口 |
|---|---|---|---|
| shell spawn | `ShellExecRequest.env` 在 credential scrub 之后、`dshEnv` 之前合并（`shell/src/types.ts:85-99`；`bash-local/src/index.ts:163-172`） | 组合后的 vars 写入 `request.env` | **tool-bash 只传 `dshEnv`**（`tool-bash/src/index.ts:535-540`；pwsh 同 `:558-562`）→ 需 ~20 行上游 seam |
| 出站 dispatcher | `installProxyFromEnvironment(env)` 返回 disposer，可叠层安装、dispose 恢复上层（`http-proxy/src/install.ts:199,322`） | profile 变更时 dispose+reinstall；loopback 强制直连（`policy.ts:33`） | 进程级；worker 线程不继承（`install.ts:190`） |
| 子代理 | 进程内共享 `process.env`；进程外走 `SubprocessSpawnSpec.env` | 记录继承链 + profile id | 无 per-agent env：`AgentOptions` 只有模型字段（`agent/src/runtime-types.ts:32-41`） |
| CLI | `dsh` 无插件子命令机制（`apps/cli/src/args.ts:153,206`） | 独立 bin `dsh-root` + `ctx.commands` 注册 `/env` | 不能扩展 `dsh` 本体 |
| 配置 `!!js` | Loader 在 mount 时求值（`docs/cordis-primer.md:39`） | 只要 Tier A 先写好 env | Tier B 写入太晚（快照已冻结） |

**硬约束**：`tool-bash`/`tool-pwsh` 不把 agent 传进 `resolve`，`ShellExecRequest` 也没有 agent 字段，所以 Root **无法**在不改 shell 工具的情况下知道「这是哪个 agent 的 shell」。这是 v0 最大技术依赖（§7.5 / §11）。

### 4.4 provenance

```ts
interface ResolvedVar {
  name: string
  value?: string                 // secret 永不返回；secretRef 只留引用
  from: { kind: 'process'|'project-env'|'user-env'|'profile'|'credential'|'default'
          id?: string; path?: string; line?: number; revision?: number }
  overridden: Array<{ id: string; value?: string }>
  trust: 'user'|'team'|'workspace'|'agent'|'session'
  appliedTo: Array<'launch'|'shell'|'proxy'|'child'>   // 解释「只对谁生效」
}
```

- `dsh-root why PATH` / `why HTTPS_PROXY --json` / `/env why`：**< 1s**（读缓存解析，不重读文件）；形状对齐 settings 的 `value/base/user`（`settings/src/types.ts:29-43`），但把「被谁覆盖」展开成带 id/revision 的链。

### 4.5 snapshot / diff

- 快照 JSON（脱敏）：schema、DSH 版本/平台、profile ids + hash + revision、effective vars（secret 只留 ref/configured/source）、proxy policy + 安装时机（launch/runtime）、deny 列表、`profileContext.name/dir`（`profile-context.ts:15-27`）。
- `dsh-root snapshot` / `snapshot --baseline`；`dsh-root diff a b --check` 漂移时退出码 2（可进 CI）；diff 分三类：**值变、来源层变、信任级变**，secret 只说「configured/source 变了」，不比 value。

### 4.6 `ctx.env` seam

```ts
class EnvService extends Service {                 // super(ctx, 'env')
  resolve(scope: { profileId?: string; session?: Session; agent?: Agent; workspaceId?: string }): Promise<ResolvedEnv>
  list(): Promise<EnvProfileSummary[]>;  show(id: string): Promise<EnvProfileView>
  why(name: string, scope?: EnvScope): Promise<ResolvedVar>;  diff(a: string, b: string): Promise<EnvDiff[]>
  snapshot(o?: { baseline?: boolean }): Promise<EnvSnapshot>
  fingerprint(): EnvFingerprint                   // 给 Allow 绑定
  apply(id: string, o?: { dryRun?: boolean; expectedHash?: string }): Promise<ApplyReceipt>
  // 事件：env/resolved|applied|blocked|drift|snapshot
}
```

- Client：`settings.section` 注册 Environment 页（`ui-settings-account/src/client/index.ts:327` 同款），会话面板用 `conversation.session.panel.section`（`ui-jobs/src/client/index.ts:39`）显示 `env: acme @r3 · 2 drift`。
- 只依赖公共 seam：`launchEnvironment`（读）、`credentials`（resolve/describe）、`storage.domain`、`profileContext`、`shell`/`subprocess`（写侧适配器）；缺 `credentials` → secretRef 标 `unresolved`，其余照常。两个 bundle entry：`root-boot`（零注入、同步 materialize 非密 vars，供 `!!js`）与 `root`（完整服务，带注入）。**mount 顺序是产品的一部分**：必须排在聚合层第一位（与 `@hyzyn/dsh-env` 同一手法）。

## 5. 与 Nest / Allow / Check 的组合
| 组合 | 契约 | 失败即关 |
|---|---|---|
| **Nest** | `env.profileRef: "root:acme-dev"`（可 `@3` 钉 revision）；Nest 只存 ref，不解析值 | ref 不可解析 → Nest 标 `unresolved`，其余字段照常 |
| **Allow** | Grant 的 `environment` 绑定 `ctx.env.fingerprint()`（profile ids+revision、workspace、runtime、tenant、设备）；Root 写动作是 `risk:'write'`，先查 Grant | 环境指纹变化 → 绑定 Grant 自动 suspend；无 Grant → 一次性审批 |
| **Check** | `snapshot --baseline` 产出 Check 可直接吃的环境基线；升级 DSH/换 model 时「同 prompt、同任务、只换环境」配对跑，回归归因到 env | Check 报回归 → `apply` 拒绝，`--force` 需审批 |

动作：`root:profile.list/show/why/diff/snapshot`（read，无 Grant）→ tools `env_profile_list/describe/why/diff/snapshot`；`root:profile.use/apply/import`（write，**Grant**）→ `env_profile_apply`；`root:profile.migrate`（exec，Grant + 备份）。CLI 同名：`dsh-root list|show|why|diff|use|apply|snapshot|import|migrate|env|run`，全部 `--json`；会话内 `/env`。

## 6. 安全
1. **不改运行中的 `process.env`**：`childEnv()` 每次都读**实时** `process.env` 再 scrub（`subprocess/src/index.ts:73-87`；`subprocess-local/src/spawn.ts:41-47`），任何运行中写入都会泄漏到所有并发会话的所有子进程。Root 只在 Tier A 子进程启动前写；Tier B 只写 `ShellExecRequest.env`。
2. **代理是进程级**：一进程一份 dispatcher（`install.ts:199`）；运行中切换是「叠层 + dispose 恢复」。UI 必须标「全局」，per-agent 代理一律拒绝并记 `env/blocked`；worker 线程不继承（`:190`）。
3. **仓库配置不能提权**：`trustLevel` 不取自 YAML 自述，而由存储位置 + 签名派生；workspace 声明 `user` → 加载失败。workspace 的 `pathPrepend` 首次需 TOFU 确认并 pin 指纹（PATH 即代码执行）；`proxy/endpoint/secretRef` 在 workspace 层**永不生效**。
4. **秘密只存引用**：`secretRef` 必须是 `CredentialRef`（`credentials/src/types.ts:14`），每次使用 `resolve()`，不缓存、不写快照/日志/导出；`describe()` 只暴露 configured/source（`credentials-local/src/index.ts:571-584`）。
5. **`*KEY*` 陷阱**：子进程基础 env 会剥掉 `/KEY|PASSWORD|SECRET|TOKEN/i` 与全部 `DSH_*`（`subprocess/src/index.ts:54`）——名字里带 `KEY` 的变量**不会自动到 shell**。Root 必须显式注入并写进文档，否则用户会看到「变量莫名消失」。
6. **审计**：`env/resolved|applied|blocked|drift|snapshot` 只记 name/hash/profile id/actor，不记 value；导出前跑脱敏断言（secret 值出现 = 0 才通过）。

## 7. 失败模式
| # | 失败 | 检测 | 行为 |
|---|---|---|---|
| 7.1 | **环境漂移** | 文件 hash、快照 hash、live `process.env` 三方对比 | 两向报 `drift:pending`（改了没应用）/`drift:tampered`（应用后被改）；`credentials.resolve()` 读冻结快照（`credentials-local/src/index.ts:571-584`），与 `!!js process.env` 可能不同答 → provenance 显式标 `visibleTo` |
| 7.2 | **子代理继承** | agent 创建时记 profile id + 父链 | 进程内子代理共享 `process.env`（无 per-agent env，`runtime-types.ts:32-41`）；进程外只有 provider 传 `SubprocessSpawnSpec.env` 才变 → 未合作就降级为「继承父进程」+ 角标 |
| 7.3 | **代理/TUN** | 安装返回的 policy + 诊断 | 只支持 http/https（`policy.ts:57`）；SOCKS/非法 URL 报诊断后直连（`install.ts:314`）；TUN fake-IP 让 noProxy 失效 → 只诊断，不静默 |
| 7.4 | **跨平台** | 平台探测 | Windows 环境名大小写不敏感、`PATH` vs `Path`、分隔符 `;`/`:`；pwsh 无 `export`；`env --shell=pwsh` 单独输出 |
| 7.5 | **shell seam 缺失** | 自检 tool-bash 是否读 `ctx.env` | 未打补丁 → per-agent env 不达模型 shell；UI 明示「只作用于 launch/proxy/Root 命令」，不假装生效 |
| 7.6 | **profile 过大 / PATH 爆炸** | 组合后长度上限 | 去重保序、每层最多 N 项、超限拒绝并提示拆 profile |

## 8. MVP：4 周
| 周 | 交付 | 出口判据 |
|---|---|---|
| W1 | schema/loader/resolver/信任矩阵/provenance；12 个坏档 fixture（workspace 自称 user、proxy 走私、agent 带 secret…）；`env show/why --json`；**上游 PR** 起草 | 坏档 100% 拒绝并报字段路径；`why` < 1s |
| W2 | Tier A `dsh-root run`（组合 → exec dsh）+ 代理叠层安装/dispose + `snapshot`；上游 PR：tool-bash/tool-pwsh 读 `ctx.env.forExecution(exec)` 注入 `request.env`（~20 行 + 测试） | 两 workspace 用不同代理各起一进程，LLM 请求走对代理；打补丁后模型 bash 看到 PATH |
| W3 | CLI 全量 + `/env` + Settings page（列表/编辑/provenance/diff/导入导出）+ `.env` 导入（bootstrap-only 变量改为「信任决策」而非硬拒）+ 3 个模板（Node/Python/代理） | 首次配置 < 3 分钟（3 人实测）；`.env` 导入后 diff 逐项可解释 |
| W4 | Act 6 个动作 + Allow fingerprint + Check baseline + 审计导出 + 0.2.1/0.2.2 双版本 smoke + 文档 + 0.1.0 + 5 个设计伙伴 | `pnpm test` 绿；卸载无残留；无 profile 时行为零变化；导出密钥值 = 0 |

**Go/No-Go（W2 末）**：上游 seam 未合入 → 降级为「Tier A + 代理 + provenance/snapshot」的 1.0，per-agent 环境移入 v1，UI 明示；**不静默假装**。

## 9. 指标与验证
| 指标 | 定义 | 首季目标 | 验证 |
|---|---|---|---|
| profile 采用 | 首个 profile 完成时间 | < 3 分钟 | 设计伙伴计时 |
| 复用 | 30 天内被 ≥2 会话使用的 profile 占比 | > 40% | 本地事件（opt-in 汇总） |
| 会话命中 | 已配置 workspace 中应用了 profile 的会话 | ≥ 60% | `env/applied` ÷ 会话数 |
| 解释力 | `why` p95 | < 1s | 本地计时 |
| 环境事故 | drift 从发现到解释 | < 5 分钟 | 事件时间戳 |
| 安全 | 导出/日志中的密钥值 | 0 | 红线测试 |
| 企业席位 | Team 付费席位 / 连续 2 周活跃 | 3 队 20 席 | 订阅 + 回访 |

反指标：`blocked` 频发 = 信任矩阵太严；`unresolved` 频发 = 引用与存储脱节。

## 10. 打包与变现
- 核心 `dsh-root`，Apache-2.0、local-first、单机、无服务端。**免费**：3 个 profile、7 天快照、`why/diff`。
- **Pro $6/月**（个人）：无限 profile、30 天快照、漂移告警、加密导出、模板库。
- **Team $8/seat/月**：团队基线（走用户自有 git / 私有 registry，**不托管内容**）、审批人、审计导出、策略包（企业禁 `direct` 代理）。
- **企业 v2**：SSO、离线许可、合规映射。不抽成市场；与 Nest/Check 交叉推广，不做捆绑强依赖。

## 11. 风险与开放问题
| 风险 | 说明 | 缓解 |
|---|---|---|
| **上游 seam（最大）** | tool-bash/pwsh 只传 `dshEnv`，per-agent 环境到不了模型 shell | W1 提 additive PR；W2 末 Go/No-Go；降级方案明确 |
| **launch 快照不可变** | 插件改不了 `!!js`/credentials/代理安装看到的 env（`bin.ts:36`） | Tier A 包装器 + `root-boot` 首挂；UI 标「需重启/需 run」 |
| **官方吸收** | env/settings 是 core 的自然演进 | 护城河放信任级 + provenance + 团队基线 + 导入；schema 提案进 upstream discussion |
| **@hyzyn 向下长** | 708 次/周、69★（仓库），已有 credential 集成与首挂经验 | 互操作（导入 `~/.dsh/env.yml`）；不拼「变量编辑器」，拼「层 + 解释 + 团队」 |
| **名字** | `@deepseek-ai/dsh-root` 是官方 monorepo 根包（private）；root 有 superuser 联想 | 三处非官方声明；CLI banner；必要时 fallback `dsh-ground`（404） |
| **进程环境全局** | 并发会话共享一个 proxy/env | v0 一进程一 profile；per-agent 只在 seam 合入后成立；文档写死 |

**开放问题**：① workspace PATH 的 TOFU 在 CI（非交互）怎么过——`--trust-workspace=<hash>` 还是直接拒绝？② 是否为兼容 `!!js` MCP 认证头而把 secret materialize 进 `process.env`（安全 vs 兼容，倾向默认否 + opt-in 审计）；③ 快照存 `$DSH_HOME` 还是 storage domain；④ 团队基线走 git 还是私有 registry；⑤ proxy 的 per-request dispatcher 是否值得 v2；⑥ `dsh-root run` 是否 shim 一个同名 `dsh`（PATH 风险）；⑦ GUI 单进程多 workspace 下，v0 的「一进程一环境」如何在 UI 上诚实地表达。

## 12. 证据
- 源码（checkout `ca33fd6`，0.2.2-rc.4）：`packages/boot/app-boot/src/index.ts:137,173,189,209`；`packages/util/launch-environment/src/index.ts:1-10,106-115`；`apps/cli/src/bin.ts:36`；`apps/cli/src/profile-boot.ts:286`；`apps/cli/src/args.ts:153,206`；`packages/settings/settings/src/index.ts:308,386`；`packages/settings/settings/src/types.ts:29-43`；`packages/util/http-proxy/src/install.ts:190,199,314,322`；`packages/util/http-proxy/src/policy.ts:33,57`；`packages/shell/shell/src/types.ts:85-99`；`packages/shell/shell-env/src/index.ts:122,133,164`；`packages/shell/tool-bash/src/index.ts:535-540`；`packages/shell/tool-pwsh/src/index.ts:558-562`；`packages/shell/bash-local/src/index.ts:163-172`；`packages/subprocess/subprocess/src/index.ts:54,73-87`；`packages/subprocess/subprocess-local/src/spawn.ts:41-47`；`packages/credentials/credentials-local/src/index.ts:1-10,571-584`；`packages/credentials/credentials/src/types.ts:14`；`packages/core/agent/src/runtime-types.ts:32-41`；`packages/core/tools/src/index.ts:128`；`packages/boot/app-boot/src/profile-context.ts:15-27`；`docs/cordis-primer.md:39`。
- 生态（npm/GitHub，2026-11-20）：[@hyzyn/dsh-env](https://www.npmjs.com/package/@hyzyn/dsh-env) `0.3.19` / 708 次/周 / 69★（仓库 `hyzyn/dsh-plugin-kit`）/ pushed 2026-11-19，单文件 `~/.dsh/env.yml`、写 `process.env`、README 自述首挂与 `0.2.1-alpha.3` 优先级翻转；[dsh-env-profile](https://www.npmjs.com/package/dsh-env-profile) `0.1.4` / 206 次/周；[@copylee/dsh-proxy](https://www.npmjs.com/package/@copylee/dsh-proxy) `0.4.6` / 743 次/周；[@tr1v3r/dsh-proxy](https://www.npmjs.com/package/@tr1v3r/dsh-proxy) `0.2.6` / 478 次/周；[dsh-network-settings](https://www.npmjs.com/package/dsh-network-settings) `0.3.3` / 436 次/周；DSH 主仓 284,543★（pushed 2026-11-18）。npm 可用性（curl registry 直查）：`dsh-root`/`dsh-ground`/`dsh-field`/`@perrylink/dsh-root` = 404；`dsh-env-profile` = 200（`0.1.4`）、`dsh-profiles` = 200（`0.0.1` 占位）；`@deepseek-ai/dsh-root` = 404（官方 monorepo 根包为 private）。
