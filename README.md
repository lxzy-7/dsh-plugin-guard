# dsh-plugin-guard

> Install safety net for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): pre-install snapshots, one-click / automatic rollback, guarded boot, and incident reports that auto-trigger agent analysis.
>
> DeepSeek Harness 的插件安装安全网：安装前自动快照、一键/自动回退、守护启动、事故报告自动触发 Agent 分析。

---

## English

### What it does

A bad plugin install can leave the app unable to boot, and fixing it by hand usually means digging through config files. This plugin automates the whole chain:

```
Install a plugin (any method)
   │  tools.guard hook: automatic snapshot BEFORE the install (in-process)
   ▼
Guarded boot (boot-guard script)
   │  snapshot before boot → start dsh web → health check
   ├─ healthy ─────────────────────────────► passes through untouched
   └─ unhealthy ─► auto-rollback to last good snapshot → retry once
                   → write an incident report + set a pending marker
                   → the next session's prompt tells the agent to analyze it
                   → after fixing, call `incident_resolved` to clear the marker
```

### How it detects problems (important to understand)

The guard does **not** statically inspect plugin code, and it does **not** try to "test" a plugin in isolation. Detection works at three levels:

1. **Snapshots are pure file copies.** Taking a snapshot just copies 4 config files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.patch.yml`). No plugin is run, no behavior is evaluated.

2. **Boot-level detection does run the harness — with your plugin loaded.** The `boot-guard` script starts the whole `dsh web` process (which loads every installed plugin, including the one you just added) and then health-checks HTTP `/` within a timeout. If a plugin breaks boot — load error, startup crash, unresponsive server — the check fails, and the guard automatically kills the tree, rolls back to the last good snapshot, and retries once. So **yes**: to catch a boot-breaking plugin, the harness (and therefore that plugin) has to actually start. That is the one moment where "running the plugin" is part of detection.

3. **Runtime-only problems are not detected at install time.** If a plugin installs and boots fine but only misbehaves later (crashes under a specific operation, corrupts state, etc.), no generic guard can predict that without running your real workload. When such an incident happens, `dsh_rollback action=incident` builds a problem-localization report (last boot logs, server stderr, and a diff of the profile config against the last good snapshot) and sets a pending marker so the next session automatically focuses on diagnosing it. And because a snapshot is always taken before any mutation, you can always roll back manually afterwards.

In short: the guard never *judges* whether a plugin is "good". It guarantees that (a) every mutation is reversible, (b) boot failures roll back automatically, and (c) incidents get analyzed instead of silently breaking your setup.

### Install

```sh
# From GitHub source (current):
dsh plugin --profile web add github:lxzy-7/dsh-plugin-guard

# From the tarball stored in the repo:
dsh plugin --profile web add https://raw.githubusercontent.com/lxzy-7/dsh-plugin-guard/main/dist/dsh-plugin-guard-0.1.0.tgz
```

Restart `dsh web`. This is a standard **bundle plugin**: it joins the profile layer stack and takes effect automatically. (Once published to npm, `dsh plugin --profile web add dsh-plugin-guard` also works.)

**Enable guarded boot (strongly recommended):** launch through `scripts/boot-guard.ps1` (Windows) or `scripts/boot-guard.sh` (macOS/Linux) instead of running `dsh web` directly. Example on Windows, inside your launcher:

```cmd
@echo off
set DSH_HOME=%~dp0.dsh-home
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File node_modules\dsh-plugin-guard\scripts\boot-guard.ps1
```

**Optional CLI shim (covers manual terminal installs):** the package ships a `dsh-guard` bin (`scripts/guard-cli.js`). Put it on your PATH and run `dsh-guard snapshot` before `dsh plugin add <pkg>` from a terminal, or wrap your own `dsh` wrapper with it. This covers installs that do not go through the in-process `tools.guard` hook.

**One-click manual rollback (Windows):** the package also ships `scripts/rollback.cmd`. After install it lives at `$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-guard/scripts/rollback.cmd` — right-click → *Create shortcut* (or copy the file anywhere) and double-click it to restore the last good snapshot of every profile and re-run `pnpm install --frozen-lockfile`. It works even when the app cannot start, and it self-derives `DSH_HOME` when the environment does not set it.

### Usage

**Settings panel — 备份管理 (Backup Manager).** In the web UI, open **设置 (Settings) → 备份管理**: per-environment snapshot lists, **load a specific backup**, **create a manual snapshot**, and **set how many snapshots each environment keeps (minimum 2)**.

**Agent tools** (registered for every session in the profile):

| Tool | Purpose |
|---|---|
| `dsh_snapshot` | Manually snapshot one profile or all profiles |
| `dsh_rollback` | list / rollback / status / incident (Node-based, cross-platform) |
| `incident_resolved` | Mark a pending incident as resolved after analysis/fix |

**CLI** (`dsh-guard`, usable even when the app will not start):

```
snapshot  [--profile X] [--tag T] [--reason R] [--force]
list      [--profile X]
rollback  [--profile X] [--id I | --good] [--skip-install]
keep      [N]                     # show or set the per-profile cap (min 2)
health    [--port N]
incident  [--kind K] [--no-marker]
resolve
profiles
```

### Configuration

`$DSH_HOME/guard/config.json` (auto-created on first write; all optional):

```json
{
  "keepSnapshots": 10,
  "port": 3080
}
```

- `keepSnapshots` — how many snapshots each profile retains (clamped to 2–100, default 10). Pruning removes older ones.
- `port` — web port used by health checks / incident reports (default 3080). Set it if your `dsh web` runs on another port. You can also pass `--port` to the CLI.

Every path is anchored at `$DSH_HOME` (defaults to `~/.dsh` when the env var is unset):

```
$DSH_HOME/rollbacks/<profile>/<stamp>/    snapshots (4 config files + manifest.json)
$DSH_HOME/guard/logs/                     boot/server logs, incident reports, last-boot.txt
$DSH_HOME/guard/pending-incident.json     pending incident marker
$DSH_HOME/guard/config.json               guard settings (keepSnapshots, port)
```

### Rollback semantics

- Rollback = restore the 4 config files + `pnpm install --frozen-lockfile` to reproduce `node_modules` exactly.
- pnpm resolution order: absolute path recorded in the snapshot manifest (same environment as when installed, independent of the current PATH) → `DSH_GUARD_PNPM` env var → current PATH → harness-local `node_modules/.bin`.
- Every rollback first writes a `pre-rollback` snapshot, so **rollback itself is reversible**.
- "Last good" = the newest snapshot not tagged `pre-boot`/`pre-rollback`.

### Platform support

| Component | Windows | macOS / Linux |
|---|---|---|
| Plugin (tools / hooks / prompt injection) | ✅ | ✅ |
| `dsh-guard` CLI | ✅ | ✅ |
| Guarded boot script | PowerShell | bash |

### Security notes

- The plugin only reads/writes profile config files and snapshots; it never executes third-party code. `pnpm install --frozen-lockfile` restores only the locked dependencies recorded in the snapshot.
- Snapshots and incident reports are local files without credentials (credentials live elsewhere under `$DSH_HOME`, not in this directory layout).
- Automatic rollback happens only when the boot health check fails; the guard never silently changes config during normal runtime.

### Known limitations

- Incident auto-analysis covers **boot-failure class** incidents; for mid-session errors, run `dsh_rollback action=incident` manually to produce the same report.
- Bundle-plugin changes require a web restart to take effect.
- Corrupted session logs are a data problem and are out of scope for rollback.

### Development

```sh
node scripts/smoke-test.js    # engine smoke test (throwaway DSH_HOME, no side effects)
node scripts/guard-cli.js help
```

### Publish

The package is MIT-licensed and ready to publish to npm (name: `dsh-plugin-guard`). It ships zero runtime dependencies and runs its engine smoke test automatically before every publish (`prepublishOnly`), so a broken build can never be published. To publish:

```sh
npm login     # once, on your machine
npm publish   # runs npm test first, then publishes with public access
```

`repository` / `homepage` are optional — add them once you have a GitHub repo (the fields only improve the npm listing).

Users can install it from the live repo with `dsh plugin --profile web add github:lxzy-7/dsh-plugin-guard` (or the tarball in `dist/`); once it reaches npm, `dsh plugin --profile web add dsh-plugin-guard` also works.

### License

MIT

---

## 中文

### 这是什么

一次坏的插件安装可能让应用起不来、对话崩溃，修复常常要手动翻配置。本插件把整条链路自动化：

```
安装插件(任何途径)
   │  tools.guard 钩子:安装前自动快照(进程内)
   ▼
守护启动(boot-guard 脚本)
   │  启动前快照 → 启动 dsh web → 健康检查
   ├─ 正常 ────────────────────────────────► 无感放行
   └─ 异常 ─► 自动回退到最后良好快照 → 重试一次
               → 生成事故定位报告 + 待处理标记
               → 下一次会话的提示词自动告诉 Agent 去分析
               → 修复后调用 incident_resolved 标记已处理
```

### 它如何检测问题（重要，请理解）

Guard **不会**静态分析插件代码，也**不会**单独"测试"某个插件。检测分三层：

1. **快照只是纯文件复制。** 备份只是复制 4 个配置文件，不会运行任何插件，也不评估任何行为。

2. **启动级检测确实会运行 harness——连同你装的插件一起。** `boot-guard` 会启动整个 `dsh web` 进程（会加载所有已装插件，包括你刚加的），然后在超时内对 HTTP `/` 做健康检查。如果插件导致启动失败（加载报错、启动崩溃、服务无响应），检查即失败，guard 会自动杀掉进程树、回退到最后良好快照并重试一次。所以**是的**：要抓住"搞坏启动"的插件，harness（连同该插件）必须真正启动一次——这是检测中唯一需要"运行插件"的时刻。

3. **只在运行期才出问题的插件，安装时检测不到。** 如果一个插件装得上、启动也正常，只是后来才出错（在某个操作下崩溃、弄坏状态等），任何通用 guard 都无法在不运行你的真实工作负载的情况下预判。这类事故发生后，`dsh_rollback action=incident` 会生成事故定位报告（最近启动日志、服务端 stderr、profile 配置与最近良好快照的差异），并设置待处理标记，让下一次会话自动聚焦于诊断它。而且任何变更前都会先快照，所以你事后也随时能手动回退。

一句话总结：guard **从不评判**一个插件"好不好"。它保证：(a) 任何变更都可回退；(b) 启动失败自动回退；(c) 事故会被分析，而不是悄悄搞坏你的环境。

### 安装

```sh
# 从 GitHub 源码安装(当前方式)：
dsh plugin --profile web add github:lxzy-7/dsh-plugin-guard

# 或从仓库里的安装包：
dsh plugin --profile web add https://raw.githubusercontent.com/lxzy-7/dsh-plugin-guard/main/dist/dsh-plugin-guard-0.1.0.tgz
```

重启 `dsh web`。这是标准 **bundle 插件**：加入 profile 层栈自动生效。(发布到 npm 后 `dsh plugin --profile web add dsh-plugin-guard` 也可用。)

**启用守护启动(强烈推荐)：** 把启动命令改为经过 `scripts/boot-guard.ps1`(Windows) 或 `scripts/boot-guard.sh`(macOS/Linux)，而不是直接跑 `dsh web`。Windows 启动器示例：

```cmd
@echo off
set DSH_HOME=%~dp0.dsh-home
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File node_modules\dsh-plugin-guard\scripts\boot-guard.ps1
```

**可选 CLI 垫片(覆盖终端手动安装)：** 包内带 `dsh-guard` 命令(`scripts/guard-cli.js`)。加入 PATH 后，在终端执行 `dsh plugin add <pkg>` 前先 `dsh-guard snapshot`（或自己包一层包装），覆盖不走进程内 `tools.guard` 钩子的安装途径。

**一键手动回退(Windows)：** 包内还带 `scripts/rollback.cmd`。安装后位于 `$DSH_HOME\profiles\<profile>\node_modules\dsh-plugin-guard\scripts\rollback.cmd`——右键 → 创建快捷方式放到桌面(或把该文件复制到任意位置)后双击，即可把所有 profile 还原到最近一份「良好」快照并重跑 `pnpm install --frozen-lockfile`。应用完全启动不了时也能用；环境未设置 `DSH_HOME` 时它会从自身位置自动推导。

### 使用

**设置面板 — 备份管理。** 网页界面里打开 **设置 → 备份管理**：按环境列出快照、**加载指定备份**、**手动存档**、**设置每个环境保留的快照数量(最少 2)**。

**Agent 工具**(profile 内每个会话都会注册)：

| 工具 | 作用 |
|---|---|
| `dsh_snapshot` | 手动快照一个或全部环境 |
| `dsh_rollback` | list / rollback / status / incident(跨平台 Node 实现) |
| `incident_resolved` | 分析并修复后标记事故已处理 |

**CLI**(`dsh-guard`，应用起不来时也能用)：

```
snapshot  [--profile X] [--tag T] [--reason R] [--force]
list      [--profile X]
rollback  [--profile X] [--id I | --good] [--skip-install]
keep      [N]                     # 查看或设置保留快照数(最少 2)
health    [--port N]
incident  [--kind K] [--no-marker]
resolve
profiles
```

### 配置

`$DSH_HOME/guard/config.json`(首次写入时自动创建；全部可选)：

```json
{
  "keepSnapshots": 10,
  "port": 3080
}
```

- `keepSnapshots` — 每个环境保留多少份快照(钳制 2–100，默认 10)，超出的旧快照会被清理。
- `port` — 健康检查/事故报告用的 web 端口(默认 3080)。如果你的 `dsh web` 跑在其他端口，改成实际值即可；CLI 也可用 `--port` 覆盖。

所有路径都锚定 `$DSH_HOME`(未设置时默认 `~/.dsh`)：

```
$DSH_HOME/rollbacks/<profile>/<stamp>/   快照(4 个配置文件 + manifest.json)
$DSH_HOME/guard/logs/                    启动/服务器日志、事故报告、last-boot.txt
$DSH_HOME/guard/pending-incident.json    待处理事故标记
$DSH_HOME/guard/config.json              备份设置(keepSnapshots, port)
```

### 回退语义

- 回退 = 恢复 4 个配置文件 + `pnpm install --frozen-lockfile` 精确还原 node_modules。
- pnpm 定位顺序：快照 manifest 记录的绝对路径(与当初安装同环境，不依赖回退时的 PATH) → `DSH_GUARD_PNPM` 环境变量 → 当前 PATH → harness 本地 `node_modules/.bin`。
- 每次回退前自动先存一份 `pre-rollback` 快照：**回退本身可逆**。
- "最后良好" = 最新的非 `pre-boot`/`pre-rollback` 标签快照。

### 平台支持

| 组件 | Windows | macOS/Linux |
|---|---|---|
| 插件(工具/钩子/提示注入) | ✅ | ✅ |
| `dsh-guard` CLI | ✅ | ✅ |
| 守护启动脚本 | PowerShell | bash |

### 安全说明

- 本插件只**读写 profile 配置文件与快照**，不执行第三方代码；`pnpm install --frozen-lockfile` 只按快照锁文件还原。
- 快照与事故报告是本地文件，不含凭据(凭据在 `$DSH_HOME` 其他位置，不在此目录约定内)。
- 自动回退只发生在"启动健康检查失败"时，运行期不会随意改动配置。

### 已知边界

- 事故自动分析覆盖**启动失败类**事故；对话中途报错可用 `dsh_rollback action=incident` 手动生成同款报告。
- bundle 插件的加载变化需要重启 web 生效。
- 会话日志损坏属于数据问题，不在回退范围。

### 开发

```sh
node scripts/smoke-test.js    # 引擎冒烟测试(临时 DSH_HOME，无副作用)
node scripts/guard-cli.js help
```

### 发布

MIT 许可，可直接发布到 npm(包名 `dsh-plugin-guard`)。包零运行时依赖，且 `prepublishOnly` 会在每次发布前自动跑引擎冒烟测试，坏包永远发不出去：

```sh
npm login     # 在本机登录一次
npm publish   # 先跑 npm test，再以 public 权限发布
```

`repository` / `homepage` 已指向 GitHub 仓库(仅影响 npm 页面的展示)。

用户可从在线仓库安装：`dsh plugin --profile web add github:lxzy-7/dsh-plugin-guard`(或下载 `dist/` 里的 tgz 按路径安装)；发布到 npm 后 `dsh plugin --profile web add dsh-plugin-guard` 也可用。

### License

MIT
