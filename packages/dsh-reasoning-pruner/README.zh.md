# dsh-reasoning-pruner

`dsh-reasoning-pruner` 让**历史步骤的推理块**不再进入此后的模型请求，从而省下每次请求都要重付的那部分输入。记录本身不变，只有模型可见的历史被改变（术语见根目录 [`CONTEXT.md`](../../CONTEXT.md) 的「推理裁剪」）。

当前目录包含配置 schema、裁剪算子、投影与可装载的插件入口（`name`、`inject`、`Config`、`apply`）。三处挂点都已落地：**② 按会话级步数节流批量推进**（`agent/pre-step`）、**① 溢出救援**（`agent/request-error`，只搭车、不自持重试）、**④ 手动命令与主界面开关**（`/prune-reasoning` + 浏览器半）。本包**不修改 DeepSeek Harness 源码**。实施票据 `01`–`08` 全部完成（`.scratch/historical-reasoning-pruning/issues/`）。

## 适用前提（先看这一节，否则装了也不会有任何效果）

裁剪资格**逐步骤**判定：只有 replay 信封声明由 `api === 'openai-completions'` 传输产生的 assistant 消息才可裁（`src/replay.ts` 的 `isReasoningPrunable`）。没有 `replayState`、信封是 `deepseek-messages`、或 `api` 是别的传输，一律原样保留。

因此**本插件只在 pi-ai 路由上有效，且该路由要显式声明 `api: openai-completions`**。写自有适配器、不发 replay 信封的路由（例如本机 web profile 里的 `dsh-cline-pass`）不产生可裁消息——此时插件装载成功、也不报错，但**一个块都不会被裁**，设置里的开关还会显示为置灰（`The current model route cannot benefit from reasoning pruning.`）。

不满足前提时，下面是**装载成功的读数**（都能对上，但裁剪量恒为 0）：命令 `/prune-reasoning` 存在、设置行存在、会话日志里没有带 `clipclop` 键的事件。

## 环境

| 项 | 取值 | 依据 |
| --- | --- | --- |
| DSH | `0.1.7-rc.2` | 本包唯一基准（`AGENTS.md`「DSH 版本基准」），`peerDependencies` 逐版本钉住 |
| Node | `^22.19.0 \|\| >=24.0.0` | DSH 检出根 `package.json` 的 `engines` |
| pnpm | `10.12.1` | 本仓根 `package.json` 的 `packageManager` |
| 宿主 peer | `cordis ~4.0.4`、`dsh-llm 0.1.7-rc.2`、`dsh-session 0.1.7-rc.2` | `peerDependencies`，由目标 profile 的 `node_modules` 提供 |

本包**未发布到 npm registry**（`package.json` 的 `private: true`），只承诺「本地 profile 内的 `node_modules` 链接 + 预构建产物」这条路。

`pnpm` 版本对不上时会**直接拒绝执行**（corepack 不切版本），报 `This project is configured to use 10.12.1 of pnpm`。两个办法：用 DSH 检出里那份 pnpm，或给命令加 `--pm-on-fail=ignore` 绕过检查。

## 构建

装进 profile 的必须是**预先构建好的产物**：安装不执行构建脚本，所以先在仓库里构建、再打包。

```bash
pnpm --pm-on-fail=ignore --dir packages/dsh-reasoning-pruner run build
```

`build` 是两步：`tsc -p tsconfig.json` 直出 host 半的 `lib/**`，`node scripts/build-client.mjs` 用 esbuild 把浏览器半打成发布态的 CJS 闭包工厂 `lib/client.js`。

两个面都是**必需**的：浏览器半缺失会在服务构造期同步抛错（`client bundle not found`），不是降级。验证产物齐全：

```bash
ls -l packages/dsh-reasoning-pruner/lib/index.js packages/dsh-reasoning-pruner/lib/client.js
```

## 安装

1. 打 tarball（**不要**用 `file:` 目录——tarball 固定打包那一刻的产物，`file:` 是随工作副本变化的链接副本）：

   ```bash
   pnpm --pm-on-fail=ignore --dir packages/dsh-reasoning-pruner pack --pack-destination /tmp/dsh-rp
   ```

   产物是 `dsh-clipclop-dsh-reasoning-pruner-0.1.0.tgz`，内含 `lib/**`（host 半 + `client.js`）与 `cordis.patch.yml`，另加 `package.json` 与本 README（npm 总是带上这两个，与 `files` 无关）。

2. 装进目标 profile（`$DSH_HOME` 默认 `~/.dsh`，profile 目录是 `$DSH_HOME/profiles/<name>`）：

   ```bash
   dsh plugin --profile <name> add /tmp/dsh-rp/dsh-clipclop-dsh-reasoning-pruner-*.tgz --ignore-scripts
   ```

   这个包声明了 `dsh.bundle.patch`，所以安装会把它**自动追加**进 profile 的 `dsh.profile.bundles`，不需要手改。`dsh plugin` 是把参数转发给 profile 目录里的 pnpm，因此 `--ignore-scripts` 这类 pnpm flag 照常可用。

3. **重启 DSH**。装入一个组合包会改变 profile 的层组合，重启是最可靠的方式。

`desktop` profile 由 Electron 独占、CLI 拒绝管理：改为在该 profile 目录里直接跑 `pnpm add <tarball> --ignore-scripts`，并手工把包名 `@dsh-clipclop/dsh-reasoning-pruner` 加进 `dsh.profile.bundles`。

## 启用

**装上即为启用**，不需要额外的开关：① 与 ② 默认开启，④ 的手动入口默认给出（`交付约束与范围`「默认状态」）。

配置按 id `dsh-reasoning-pruner` 在目标 profile 自己的 `cordis.patch.yml` 里覆写。profile 层在 bundle 层之后应用，所以这一条盖得住包内 [`cordis.patch.yml`](./cordis.patch.yml) 的默认值。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `everySteps` | `50` | 每多少个**会话级步骤**允许推进一次裁剪边界（`M`，成本摊薄） |
| `keepRecentSteps` | `10` | 最近多少个步骤原样保留、不裁（`K`，任务质量） |
| `manualPrune` | `true` | ④ 手动命令是否可用（**只管 ④**，不控制 ①/②） |

```yaml
- id: dsh-reasoning-pruner
  config:
    everySteps: 20
    keepRecentSteps: 10
```

**两个参数必须满足 `everySteps ≥ keepRecentSteps + 2`**：第 `M` 步的 pre-step 上只有 `M − 1` 条已记录步骤，减掉保留窗口 `K` 必须为正，否则每次到点都是空批量。越界配置在装载期**大声失败**，不做静默回退。

默认值 `50`/`10` 的背书来自闸门 B/D 的实测（`n` 随 `M` 增大而下降、`K = 10` 是首个不再恶化档）：判定为**不必收紧**，取值原样。实测记录见 `.scratch/historical-reasoning-pruning/issues/07-gate-bd-experiment.md`。

### 验证已生效

会话跑够 `M` 步后，会话日志里应出现带 `clipclop` 键的承载事件。日志是 **zstd 压缩**的，普通 `grep` 读不出来（会得到 0，看起来像「没生效」），要先解压：

```bash
zstdcat ~/.dsh/sessions/*/*/session.v4.jsonl.zstd | grep -c clipclop
```

计数从 0 变为正数即说明裁剪已落盘。也可以用 `/prune-reasoning` 手动触发一次看回应，两种读数应一致。

## 停用

三层，按需要选：

**1. 停用整个插件（保留依赖与产物）**——在 profile 的 `cordis.patch.yml` 里按 id 关掉这一行：

```yaml
- id: dsh-reasoning-pruner
  disabled: true
```

这是 DSH 原生的行级停用（DSH 自己的 bundle 也这样停用行）。此时 ①②④ 全部不挂载：不注册投影、不写任何承载事件。手工编辑 profile patch 后重载或重启生效。

**2. 只停用 ④ 手动入口**——两种等价写法，改的是同一个字段：

- 主界面 **设置 → 通用** 里的 **Prune historical reasoning** 开关（浏览器半写回 `manualPrune`）；
- 或 profile patch 里 `manualPrune: false`。

关掉后命令**拒绝执行**（`Manual reasoning pruning is turned off by the main-interface switch.`），一个事件都不落；**① 与 ② 不受影响**，仍在跑。

**3. 彻底移除**：

```bash
dsh plugin --profile <name> remove @dsh-clipclop/dsh-reasoning-pruner --ignore-scripts
```

移除时包名会同时从 `dsh.profile.bundles` 中消失。Desktop 同样在该 profile 目录里直接 `pnpm remove ... --ignore-scripts`。

## 手动命令

```text
/prune-reasoning
```

立刻对本会话做一次裁剪，**不设保留窗口**（`K` 是 ② 的参数）；资格仍由 host 半逐步骤强制。三种结局：开关关闭 ⇒ 报错且零落盘；没有任何历史步骤通过资格 ⇒ `No historical step qualified for reasoning pruning.`；否则成功并给出承载事件的 seq。

## 配置错误

`Config` schema 在装载阶段校验，直接调用 `apply` 时还有一套运行期副本，两处都**大声失败**：字段不是整数或越界时抛错并点名字段与取值（`everySteps must be an integer >= 1, got …`）。不做静默回退，也不把不变量破坏降级成一行日志。

## 已知边界

- **不降低「上下文占比」读数**。`tokenMeter.measure()` 按**原始表面事件**定价、不读投影，所以裁剪会省下请求输入，但界面上的上下文占比不动。这是机制事实（设计文档「激活点 ②」），不是缺陷。
- **辅助读者看到未裁剪历史**。`session-query`、文档 / 传播与迁移代际校验用的是硬编码的首方投影表，不认插件注册的投影。**模型可见路径是对的**，受影响的只是这些辅助读者。
- **不承诺跨格式迁移**：只承诺 equal-version 的 append / reload。
- **任务是否达成只能人工判定**：`turn/end.completed` 不是任务成功信号，代理信号只支持「没有恶化」。
- 装好后**没裁任何东西**，先按上面「适用前提」核对当前路由的传输是不是 `openai-completions`。

## 开发

```bash
pnpm --pm-on-fail=ignore --dir packages/dsh-reasoning-pruner run build
pnpm --pm-on-fail=ignore --dir packages/dsh-reasoning-pruner run typecheck
pnpm --pm-on-fail=ignore --dir packages/dsh-reasoning-pruner run test
```

设计与取舍见 [`docs/dsh-reasoning-pruner-design.md`](../../docs/dsh-reasoning-pruner-design.md)，验收标准见 [`.scratch/historical-reasoning-pruning/spec.md`](../../.scratch/historical-reasoning-pruning/spec.md)。