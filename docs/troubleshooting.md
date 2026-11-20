# Troubleshooting

> 适用 dsh-os 0.1.x + DSH 0.2.x。命令以 bash 为例；PowerShell 把
> `export FOO=bar` 换成 `$env:FOO = "bar"`，把 `grep` 换成 `Select-String`。
>
> 先收集这四行，再往下查：
>
> ```sh
> node --version
> dsh --version
> npm config get registry
> pnpm config get registry
> ```

## 1. 安装失败

### 1.1 `dsh: command not found`

```sh
npm install -g @deepseek-ai/dsh@latest
dsh --version
```

`dsh` 自身声明 Node >= 24.9（`engines.node`）。Node 22 能跑独立的
`dsh-check` CLI，但不在 `dsh` 的支持范围。

如果全局安装报 `EACCES`：

- 不要 `sudo npm install -g`。root 拥有的全局目录会让后续 `dsh plugin`
  写入混乱；
- 用用户级 Node（nvm/fnm/volta），或把 npm prefix 指到你拥有的目录；
- 确认 `which dsh` 指向的是你刚装的那份，而不是旧版本。

### 1.2 `dsh plugin` 参数错误

实测：

```console
$ dsh plugin add dsh-act
error: required option '--profile <name>' not specified
```

`--profile` 是 **dsh** 的选项，不是 pnpm 的；它必须出现在 `plugin` 之后、
`add` 之前：

```sh
dsh plugin --profile web add dsh-act
```

下面这种把 `--profile` 放到 `add` 后面的写法也会得到同一个错误，因为 dsh
在转发给 pnpm 之前就要求 `--profile`：

```sh
dsh plugin add dsh-act --profile web   # 错
```

### 1.3 scope 用错：404 / 找不到包

实测（把 scoped 包写成了裸名）：

```console
$ dsh plugin --profile web add dsh-trace
Error: ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST

  × adding a new package
  ╰─▶ Failed to resolve the latest version of dsh-trace: Failed to fetch
      metadata from https://registry.npmmirror.com/dsh-trace: HTTP status
      client error (404 Not Found)
```

三个包必须带 `@perrylink/`：

| 产品 | npm 包名 |
|---|---|
| Check | `@perrylink/dsh-check` |
| Root | `@perrylink/dsh-root` |
| Trace | `@perrylink/dsh-trace` |

其余产品（Act、Allow、Snip、Nest、Trigger、Seek、Stage、Ring）是不带 scope
的 `dsh-*`。完整清单见根 [`README.md`](../README.md#packages)。

CLI 同理：`npx dsh-check` 会去找 npm 上的裸包 `dsh-check` 并 404。没装本地
依赖时用包名：

```sh
npx --yes @perrylink/dsh-check@0.1.1 --help
```

### 1.4 装到的不是最新 patch（`minimumReleaseAge`）

`dsh plugin` 把安装委托给 pnpm。profile 的 pnpm 配置可能启用
`minimumReleaseAge`，刚发布不久的 patch 会先被跳过。实测输出：

```text
Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt):
  @perrylink/dsh-check@0.1.0
...
dependencies:
+ @perrylink/dsh-check 0.1.0
```

而 npm 上的 latest 可能已经是 `0.1.1`。两种处理：

1. **固定版本**（推荐，尤其是 CI）：

   ```sh
   dsh plugin --profile web add @perrylink/dsh-check@0.1.1
   ```

   实测会写入 `minimumReleaseAgeExclude` 并装到 `0.1.1`。

2. **等窗口过去**，再跑一次不带版本的 `add`。不要在全局关掉
   `minimumReleaseAge` 来“解决”这个问题；它是供应链保护。

确认实际版本：

```sh
npm view @perrylink/dsh-check version   # registry 上的 latest
(cd "${DSH_HOME:-$HOME/.dsh}/profiles/web" && pnpm list --depth 0)
```

`pnpm list` 会给出 profile 里**实际装到**的版本；`package.json` 里的 `^0.1.0`
只是范围，不等于当前解析结果。

### 1.5 registry / 镜像

`dsh`、`npm`、`pnpm` 可能不是同一个 registry。先分别查：

```sh
npm config get registry
pnpm config get registry
```

本机实测两者都是 `https://registry.npmmirror.com`（镜像）。镜像同步滞后时，
某个刚发布的包可能 metadata 或 tarball 返回 404。临时指定 npmjs：

```sh
dsh plugin --profile web add dsh-nest --registry=https://registry.npmjs.org/
```

实测可以正常安装。`dsh plugin` 把剩余参数原样转发给 pnpm，所以
`--registry=...` 放在包名后面也能生效。

排查某个包在 npmjs 上的真实状态：

```sh
npm view @perrylink/dsh-check version dist.tarball --registry=https://registry.npmjs.org/
```

如果这里正常、镜像不正常，就是镜像同步问题，不是包损坏。

> 根目录的 `.npmrc` 形如
> `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，只用于**发布**，不要为了
> 安装去填 token。不要把任何 token 写进仓库、日志或 issue。

### 1.6 权限 / 路径

- `dsh plugin` 只写 `$DSH_HOME/profiles/<name>`。目录不可写时会以
  `EACCES` / `EPERM` 失败；把 `DSH_HOME` 指到你有写权限的目录。
- 不要用 `sudo` 跑 `dsh plugin`。root 创建的 `node_modules` 会让普通用户
  后续升级/卸载失败。
- WSL 下建议把 `DSH_HOME` 放在 Linux 文件系统（如 `~/.dsh`），不要放在
  `/mnt/c/...`，避免 DrvFs 的权限/大小写/性能差异。
- 磁盘满也会表现成安装失败；先看 pnpm 的完整错误和剩余空间。

## 2. 版本不匹配

先对齐三个版本：

```sh
node --version
dsh --version
npm view @perrylink/dsh-check engines --json
```

dsh-os 包的约束（以 0.1.x 为例）：

| 字段 | 范围 |
|---|---|
| `engines.dsh` | `>=0.2.1-rc.2 <0.3.0-0` |
| `engines.node` | `^22.19.0 || >=24.9.0` |

所以：

- `dsh` 0.2.0 及以下、0.3.0 及以上不在支持范围；
- 独立 `dsh-check`/服务代码可以跑在 Node 22.19+；
- 但 `dsh` CLI 本身要 Node >= 24.9。

DSH 的插件管理器会读取插件 `package.json` 的 `engines.dsh`（没有时回退到
`@deepseek-ai/dsh*` peer）并给出兼容性诊断，形如：

```text
Plugin <name>@<version> is incompatible with dsh <runtime-version>: requirements {"engines.dsh":"..."}. Running it may cause crashes or data loss. ...
```

正确处理顺序：

1. **升级/降级 DSH** 到包的范围内（首选）；
2. 或安装一个 `engines.dsh` 覆盖你当前 DSH 的插件版本；
3. 不要手改 `node_modules` 里的 `package.json`。

最后手段是给**精确的包@版本 + 精确的 DSH 版本**做豁免。实测用法字符串：

```text
usage: dsh plugin allow-version <package@version> --dsh-version <exact> --accept-risk
```

例如（把 `PACKAGE@VERSION` 和 `DSH_VERSION` 换成真实值）：

```sh
dsh plugin --profile web allow-version PACKAGE@VERSION \
  --dsh-version DSH_VERSION --accept-risk
dsh plugin --profile web version-exemptions
```

> 豁免可能带来崩溃或数据丢失，只对精确的 package@version + DSH 版本生效。
> 能升级就不要用。撤销用
> `dsh plugin --profile web revoke-version PACKAGE@VERSION --dsh-version DSH_VERSION`。

## 3. Scope 与 registry 速查

| 现象 | 先查 | 处理 |
|---|---|---|
| `404 ... dsh-check@*` | 是不是漏了 `@perrylink/` | 用 `@perrylink/dsh-check` |
| `ERR_PNPM_FETCH_404` / tarball 404 | `npm view <pkg> dist.tarball --registry=https://registry.npmjs.org/` | 换 registry，或按 §4 用 tarball URL |
| 镜像有 metadata、没 tarball | 同上 | 临时 `--registry=https://registry.npmjs.org/` |
| 401 / 403 | 是不是误把发布 token 配到了安装环境 | 安装用公共 registry，token 只用于发布 |
| `npx` 走的版本不对 | `npx` 是否用了缓存/镜像 | 固定 `@x.y.z`，或加 `--registry` |

## 4. Trace tarball 404

`@perrylink/dsh-trace` 曾出现过“npm 上有 metadata，但 tarball 404”的情况；
镜像同步也可能只同步到一半。症状是 `dsh plugin add @perrylink/dsh-trace`
报 `ERR_PNPM_FETCH_404`、`404 Not Found`，或 `Failed to resolve ... tarball`。

### 4.1 先确认官方 tarball 是否存在

```sh
npm view @perrylink/dsh-trace version dist.tarball --registry=https://registry.npmjs.org/
```

实测输出：

```text
version = '0.1.0'
dist.tarball = 'https://registry.npmjs.org/@perrylink/dsh-trace/-/dsh-trace-0.1.0.tgz'
```

如果这里也 404，先等/重试；不要随便换第三方镜像。

### 4.2 用编码后的 tarball URL 安装

把 `/` 编码成 `%2F`，并给 URL 加引号：

```sh
dsh plugin --profile web add 'https://registry.npmjs.org/@perrylink%2Fdsh-trace/-/dsh-trace-0.1.0.tgz'
```

实测：

```text
dependencies:
+ @perrylink/dsh-trace 0.1.0
```

然后确认层：

```sh
dsh --profile web --dump-config | grep '^# == @perrylink/dsh-trace'
# == @perrylink/dsh-trace
```

### 4.3 注意

- tarball URL 会作为**精确依赖**写进 profile 的 `package.json`，不会跟着
  `latest` 更新；镜像恢复后建议换回普通 scoped 安装：

  ```sh
  dsh plugin --profile web remove @perrylink/dsh-trace
  dsh plugin --profile web add @perrylink/dsh-trace
  ```

- URL 里的版本必须真实存在；先用 `npm view` 确认。
- URL 含 `@` 和 `%2F`，用单引号包住，避免 shell 把特殊字符吃掉；编码形式
  是文档验证过的写法。

## 5. 权限 / 沙箱

### 5.1 dsh-os 不是沙箱

Allow 的 Grant、Act 的 `risk`、Root/Nest 的 profile 都是**控制面/账本**：

- 它们不扩大 OS 文件/网络/进程权限；
- 不替代 DSH 的 approval prompt、permission rules、preset 或 OS sandbox；
- Grant 只能 allow，不能覆盖 DSH 的 deny；
- Root 0.1.x / Nest 0.1.x **不修改** `process.env`、shell rc、注册表或
  `.env` 文件，只是声明式账本。

如果动作本身被 OS 或 DSH 拒绝（`EACCES`、sandbox deny、审批被拒），先修那条
路径的权限/策略；发 Grant 不会让它通过。

### 5.2 Act 一直返回 `grant_required`

按顺序查：

1. **subject**：agent 工具用 `exec.agent.session.id`；后台代码用你显式传的
   `meta.subject`。Grant 的 subject 必须完全一致；
2. **capability**：必须是 `act:invoke:<action-id>`，不是动作的 title；
3. **状态**：`allow.check({ subject, capability })` 看 `reason` 是
   `no-grant`、`expired`、`revoked` 还是 `scope-mismatch`；
4. **服务是否真的在**：`ctx.get('allow')` 为 `undefined` 时 Act fail closed；
   确认 `dsh-allow` 已安装并已挂载；
5. **scope**：0.1.x 的 Act 调 `allow.check` 不带 scope；本 recipe 用 `*`。
   要按 scope 收紧，在调用前自行传 scope。

### 5.3 状态文件权限 / 损坏

Allow、Root、Snip、Nest 的可选 `stateFile`：

- 目录必须可写；Allow/Root/Snip 用临时文件 + `rename`，文件模式 `0600`；
- Allow 损坏/不可读 → `E_STATE`；Root → `state_invalid`；Snip →
  `SNIP_STATE_INVALID`；Nest → `E_STATE_INVALID`；
- 这些错误都是 **fail closed**，不会静默变成“全部允许”；
- 先备份，再检查 JSON/版本/权限。不要用“删状态文件”来修复授权问题。

多个进程同时写同一个 `stateFile` 不在 0.1.x 的支持范围；一个文件一个写者。

### 5.4 Windows / WSL

- PowerShell 里环境变量是 `$env:DSH_HOME`，不是 `export`；
- 路径含空格时给整个路径加引号；
- WSL 访问 `/mnt/c` 的 POSIX 权限/原子 rename 行为与 Linux 文件系统不同；
  状态文件和 `DSH_HOME` 尽量放在 WSL 的 `$HOME` 下；
- 在 Git Bash 里跑本文的 `grep`/heredoc 最省事；纯 PowerShell 用
  `Select-String` 和 `Set-Content`。

## 6. 卸载

### 6.1 移除一个 DSH 插件

```sh
dsh plugin --profile web remove dsh-nest
```

实测（节选）：

```text
dependencies:
- dsh-nest 0.1.0
```

确认层消失：

```sh
dsh --profile web --dump-config | grep '^# =='
```

`dsh plugin remove` 会同时更新 profile 的 `package.json` 和
`dsh.profile.bundles`，不需要手改。

### 6.2 移除 Check CLI

在当初安装它的项目里：

```sh
npm uninstall @perrylink/dsh-check
```

如果是 `npx --yes @perrylink/dsh-check@...` 临时跑的，没有项目依赖需要清；
npm 缓存可以用 `npm cache verify` 维护，但不要为了“干净”删整个缓存。

### 6.3 移除实验 profile

先打印并确认绝对路径，再只隔离/删除那一个 profile 目录：

```sh
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/quickstart"
realpath "$PROFILE"
# 确认输出确实是你建的那个 quickstart profile，再把它移到隔离目录：
QUARANTINE="$(mktemp -d)"
mv -- "$PROFILE" "$QUARANTINE/"
# 检查 "$QUARANTINE" 里只有这个 profile，最后才删隔离目录：
rm -rf -- "$QUARANTINE"
```

> **不要直接对 `$PROFILE` 跑 `rm -rf`，也不要删整个 `$DSH_HOME`。** 它可能
> 同时含 sessions、credentials、其他 profile 和日志。先 `realpath`、再隔离、
> 确认后才删隔离目录。
>
> 不想手删的话，保留目录也无害；下次 `dsh plugin --profile <name> add`
> 会复用/初始化它。

### 6.4 清理状态文件

Allow/Root/Snip/Nest 的 `stateFile` 是普通 JSON。卸载插件不会自动删它。
确认不再需要后，先备份再删；如果里面还有有效 Grant 或账本，删掉等于丢审计。

## 7. 还是卡住

带上这些信息再开 issue / 问人：

```sh
node --version
dsh --version
npm --version
pnpm --version
npm config get registry
pnpm config get registry
dsh --profile web --dump-config | grep '^# =='
```

（最后一行把 `web` 换成你实际的 profile 名。）

加上：

- 完整命令和完整错误（不要只截最后一行；pnpm 的 `ERR_PNPM_*` 和
  `dsh: plugin command failed; diagnostics: ...` 日志路径都要）；
- 操作系统（Windows/WSL/macOS/Linux）和是否在代理后；
- 是 `dsh plugin` 安装失败，还是运行时 `grant_required`/`E_STATE`；
- 如果用了 `--registry` 或 tarball URL，原样给出。

相关文档：

- [Quickstart](quickstart.md)
- [把 Check 接进 GitHub Actions](recipes/ci-gate.md)
- [Act + Allow 的写动作授权与撤销](recipes/agent-write.md)
- [Snip 的 `clipboard://` 句柄](recipes/clipboard.md)
- 各包 README：`packages/<name>/README.md`
