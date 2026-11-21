# dsh-market 收录包（等待 awesome 合并）

> **状态：HOLD，未提交、未开 PR。** 前置条件只有一个：`awesome-dsh-plugin` 的
> `PerryLink/dsh-os--packages-allow.yml` **已合并**。市场没有独立投稿入口，
> **不要向 `dsh-market` 仓库提插件条目 PR**。
>
> 事实核对：2026-11-21 17:34 +08。披露：维护者 PerryLink；独立社区项目，
> **Not affiliated with DeepSeek**。

## 0. 为什么不能直接投市场

`dsh-market/dsh-market` 的 README 写得很明确：

> This repo is the market app, not the catalog. The plugin list comes from the
> curated `awesome-dsh-plugin` registry — to get your plugin listed in the
> market, open a PR **there** ... Please don't PR plugin entries against this
> repo.

所以正确顺序是：

```text
awesome 单条 YAML 合并
        ↓
catalog（awesome-dsh-plugin.com/plugins.json）重新构建
        ↓
dsh-market 打开时读取 catalog（通常 1 天内出现）
```

**不要**为了“更快出现”重复投 awesome，**不要**给市场仓库开条目 PR，也**不要**
改别人的条目。

## 1. 提交字段（一个条目）

| 字段 | 值 | 说明 |
|---|---|---|
| `url` | `https://github.com/PerryLink/dsh-os/tree/main/packages/allow` | monorepo 子目录；必须与仓库 URL 完全一致 |
| `name` | `PerryLink/dsh-os#allow` | 列表链接文字；与 awesome 条目一致 |
| `category` | `security` | 贴合实际功能；分类不准维护者会改，不会因此打回 |
| `description.en` | `Revocable, expiring capability grants with scope and a local audit trail for DSH plugins and out-of-turn authorization checks.` | **必填**；与代码一致，不加营销词 |
| `description.zh` | `可撤销、可过期的能力授权，带范围和本地审计记录，供 DSH 插件与回合外操作做授权检查。` | 可选；已提供，避免维护者代译 |
| `icon` | **不填** | 目前没有 GitHub 托管的方形位图；回退作者头像。不要用 SVG 或第三方图床 |
| `tarball` | **不填** | npm 已发布 `dsh-allow@0.4.0`，优先 npm；不需要 GitHub Release tarball |
| `screenshots` | **暂不填** | 仓库里还没有 `packages/allow/screenshots.json`；不要伪造截图或写死外部 URL |
| `npm` | **不手写** | catalog 自动采集；手写会被校验拒绝 |
| npm 关联 | `package.json` 的 `repository.url` 指回 `PerryLink/dsh-os`，`directory: packages/allow` | 市场才能把 npm 包与条目关联 |
| `stars` / `added` | **不手写** | 自动生成 |

字段来源：`awesome-dsh-plugin` 的 `contributing.md`（2026-11-21 读取）。
**一个文件就是全部投稿**；两个 README 由脚本生成，不要手改。

## 2. 截图（可选，当前留空）

市场的详情页支持 App Store 式截图，但**声明必须放在我们自己的仓库里**：

- 文件位置：`packages/allow/screenshots.json`（与 `package.json` 同目录）。
- 内容：1–8 个**相对路径**，相对于该 JSON 文件，例如
  `["assets/allow-approvals.png", "assets/allow-audit.png"]`。
- 图片：PNG / JPEG / WebP，**GitHub 托管**；不要 SVG、不要第三方图床。
- 画面：不含 token、密钥、用户名、真实客户路径或未公开会话；终端字号可读。
- 只放能对得上当前 `0.4.0` 的界面/输出；不要把 0.5 工作树的截图提前放上来。

**当前决定：不填。** 没有截图时市场会从 README 自动抽取；这不会阻塞收录。
补截图是后续独立动作（需要改包内文件），不在本次“只写文档”的范围内。
`icon` 同理：没有就回退作者头像，不拿 SVG 凑。

## 3. 描述（复制即用）

```yaml
url: https://github.com/PerryLink/dsh-os/tree/main/packages/allow
name: PerryLink/dsh-os#allow
category: security
description:
  en: 'Revocable, expiring capability grants with scope and a local audit trail for DSH plugins and out-of-turn authorization checks.'
  zh: '可撤销、可过期的能力授权，带范围和本地审计记录，供 DSH 插件与回合外操作做授权检查。'
```

**不要写：** permission center、sandbox、secure、official、best、prevents
malicious plugins、audit-proof、enterprise-grade。市场监管会按代码核对描述，
夸大是打回的主要原因。

## 4. 权限说明（给用户看的，不是市场字段）

条目本身**没有** `permissions:` 字段；市场读取的是包清单和 README。Allow 的
实际权限面如下：

| 项 | 实际值 | 说明 |
|---|---|---|
| bundle | `dsh.bundle.patch: ./cordis.patch.yml` | 标准 Cordis bundle |
| service | `allow`（`ctx.allow`） | 供其他插件检查 Grant |
| 声明 capabilities | `[]` | 没有声明 shell / 网络 / 原生能力 |
| 模型工具（默认） | `allow_check`、`allow_request`、`allow_wait`、`allow_requests` | 4 个；**不能自批** |
| 管理工具 | `allow_issue` / `allow_approve` / `allow_deny` / `allow_revoke` / `allow_list` | 默认关闭，需 `exposeAdminTools: true` |
| 网络 | 无 | 运行时代码不联网、无遥测 |
| 子进程 / shell | 无 | 不 spawn、不执行命令 |
| 本地状态 | 默认内存；可选 `stateFile` | JSON，临时文件 + rename 原子写，mode `0600`；重启可恢复 |
| 审计 | 内存或 stateFile | 记录 issue/check/revoke/expire 等；**不是防篡改账本** |
| 沙箱 | **不是沙箱** | 只回答“谁批准了什么”；同进程代码可绕过检查 |

**必须同时告诉用户的三句话：**

1. Allow 是**控制面**，不是沙箱，不能替代 DSH 的 approval、permission rules、
   presets 或 OS sandbox。
2. 管理工具默认不暴露给模型；Grant 只能由人或策略签发，模型只能创建 pending
   request。
3. **市场收录 ≠ 安全审查**；装第三方插件前读源码，装之前确认来源。

## 5. 合并后验证（按顺序，不跳步）

```sh
# 1) catalog 是否已收录（把输出贴进验证记录）
curl -s https://awesome-dsh-plugin.com/plugins.json \
  | grep -o 'PerryLink/dsh-os#allow' | head -1

# 2) 安装市场（只需一次）
dsh plugin --profile web add dshmarket
# 重启 dsh web；dsh 0.2.1+ 打开 Plugins → Plugin Market
```

- [ ] catalog 里出现 `PerryLink/dsh-os#allow`，`category` 为 `security`
- [ ] 市场搜索 `Allow` 能搜到；卡片描述与 §3 一致
- [ ] 点一次安装，确认装的是 `dsh-allow@0.4.0`
- [ ] 重启后插件仍在；`--dump-config` 能看到 `dsh-allow`
- [ ] 没有截图/图标时，详情页能正常回退（README 抽取/作者头像），不报错

通过后，把“市场已收录 + 安装成功”的日期、DSH/Node 版本、脱敏截图记到
[`../validation/STATUS.md`](../validation/STATUS.md)。这是**外部验证**证据，
不要用维护者本机 smoke 冒充。

## 6. 失败时怎么做

| 现象 | 先做什么 | 不要做什么 |
|---|---|---|
| 合并 24h 后 catalog 仍没有 | 确认 awesome `main` 里有 YAML；等一次构建；查 catalog 构建日志 | 不要重复投条目、不要给市场开 PR |
| 市场有卡片但版本旧 | 查 npm origin 的 `dsh-allow` 版本；修 npm 发布/描述 | 不要手写 `npm:` 字段 |
| 安装失败 | 看 DSH/Node 版本、profile 名、`allowBuilds` 提示；先修包 | 不要改别人的条目来“绕过” |
| 卡片描述不对 | 修 awesome YAML，等重新构建 | 不要在 dsh-market 仓库改 |
| 被质疑“这不是安全审查” | 直接承认：收录≠审计，控制面≠沙箱 | 不要辩称“市场已验证安全” |

## 7. 不要做

- 不要向 `dsh-market` 提插件条目 PR（README 明确拒绝）。
- 不要因为“想快点上架”重复投同一条目或改别人条目。
- 不要写“官方推荐 / DeepSeek 合作 / 已验证安全 / 企业级”。
- 不要用 SVG 或第三方图床做 icon / 截图。
- 不要把 listing 当成安全审计，也不要在文案里暗示。
- 不要在 awesome 第一条还没合并时，先来这里“占位”。
