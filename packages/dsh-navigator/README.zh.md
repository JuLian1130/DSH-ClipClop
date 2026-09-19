# dsh-navigator

`dsh-navigator` 在主会话连续执行若干步骤后，使用主会话当前模型可见上下文发起一次辅助航向复核。复核不创建子 Session、不执行工具；它可以在等待模式下停止主会话，也可以在并行模式下向主会话提供带触发步骤的建议。

当前目录包含配置 schema、结论类型和可装载的插件入口（`name`、`inject`、`Config`、`apply`）：等待模式已能到点发起复核、把收场结算成一条记录，并按会话 id 读回与回放。三类结论对主会话的干预（建议注入、停止说明）与并行模式已落地，等待期作废亦已落地；任务结束与任务取消时会取消在途复核并落下原因正确的取消记录，重载 / 卸载时同样如此，并按 `failurePolicy` 放行或停止正在等待的那一步；本包不会修改 DeepSeek Harness 源码。

## 安装

本包**未发布到 npm registry**（`package.json` 的 `private: true`），只对 DSH `0.1.6-alpha.1` 承诺行为（`peerDependencies` 范围 `^0.1.6-alpha.1`）。Node 取 DSH 检出根 `package.json` 的 `engines`（`^22.19.0 || >=24.0.0`），pnpm 取本仓根 `packageManager` 的 `10.12.1`。第一版只承诺「本地 profile 内的 `node_modules` 链接 + 预构建产物」这条路，依据与登记状态见设计文档的[发行与联调](../../docs/dsh-navigator-design.md#发行与联调)与[验证状态](../../docs/dsh-navigator-design.md#验证状态)。

装进 profile 的必须是**预先构建好的产物**：安装不执行构建脚本（Desktop 的口径是 `--ignore-scripts`、不发 `prepare`），所以先在仓库里构建、再打包，装完不再构建。

1. 构建产物（`lib/` 由 `tsc` 直出，随包发布）：

   ```bash
   cd packages/dsh-navigator
   ./node_modules/.bin/tsc -p tsconfig.json
   ls -l lib/index.js lib/index.d.ts
   ```

2. 打 tarball：

   ```bash
   pnpm pack --pack-destination /tmp/dsh-nav
   ```

   用 tarball 而不是 `file:` 目录：tarball 固定打包那一刻的产物，`file:` 是随装配时工作副本变化的硬链接副本。

3. 装进目标 profile（`$DSH_HOME` 默认 `~/.dsh`，profile 目录是 `$DSH_HOME/profiles/<name>`）：

   ```bash
   dsh plugin --profile <name> add /tmp/dsh-nav/dsh-clipclop-dsh-navigator-*.tgz --ignore-scripts
   ```

   这个包声明了 `dsh.bundle.patch`，所以安装会把它**自动追加**进 profile 的 `dsh.profile.bundles`，不需要手改。`desktop` profile 由 Electron 独占、CLI 拒绝管理，装它时改为在该 profile 目录里直接跑 `pnpm add <tarball> --ignore-scripts`，并手工把包名 `@dsh-clipclop/dsh-navigator` 加进 `dsh.profile.bundles`。

4. 重启 DSH（或让 profile 重载）。装载成功的读数是：会话跑出第一次复核后，`$DSH_HOME/storages/clipclop_review/records/` 下出现记录文件。

本包还要求目标 profile 已经提供存储栈（`storage`、`storage-json`、`storage-domain`），见下面「复核记录」。

卸载：

```bash
dsh plugin --profile <name> remove @dsh-clipclop/dsh-navigator --ignore-scripts
```

Desktop 同样在该 profile 目录里直接 `pnpm remove ... --ignore-scripts`。移除时包名会同时从 `dsh.profile.bundles` 中消失。

> 逐条可核对的手工步骤、Desktop 特有的预期现象与失败处置见 [Desktop 联调手工清单](../../docs/dsh-navigator-desktop-manual-check.md)。

## 配置

配置通过 DSH 原生 profile patch 加载，不使用独立的配置加载器：在 profile 自己的 `cordis.patch.yml` 里按 id `dsh-navigator` 覆写。profile 层在 bundle 层之后应用，所以这一条盖得住包内 [`cordis.patch.yml`](./cordis.patch.yml) 的默认值。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `triggerEverySteps` | `50` | 主会话每完成多少个步骤触发一次复核 |
| `mode` | `wait` | `wait` 在下一步开始前等复核；`parallel` 让主会话继续跑 |
| `reviewTimeoutMs` | `120000` | 一次复核请求的超时 |
| `maxOutputTokens` | `4096` | 一次复核请求的最大生成 token 数 |
| `failurePolicy` | `continue` | 复核失败时放行；`stop` 在等待模式下追加停止说明并停下 |
| `prompt` | `''` | 追加到固定结构化输出请求上的提示词；留空用内置提示词 |

```yaml
- id: dsh-navigator
  config:
    triggerEverySteps: 20
    mode: wait
```

## 复核记录

复核生命周期记录（触发步骤、快照里每条消息的 id 列表、配置快照、结论、用量、耗时、失败原因、取消原因、状态）写入插件自有的 storage 域 `clipclop_review`，**一会话多条**（键 = 会话 id 的路径安全变换 + 触发步骤，读回按触发步骤升序）。不使用 Session 事件，原因见 [ADR 0002](../../docs/adr/0002-review-records-outside-session-log.md)。

这个存储域由 profile 提供的存储栈承载：`storage` 服务、一个存储后端（JSON 后端，`storage-json`）与 `storage-domain`（`backend: 'json'`）。本包只声明域 `clipclop_review`（`per-record` 布局、`invalidRecords: 'backup-and-skip'`），不提供这三者，也不把它们的条目写进自己的 bundle patch——[`cordis.patch.yml`](./cordis.patch.yml) 只列本插件自己的条目，与 DSH 其他插件一致。
