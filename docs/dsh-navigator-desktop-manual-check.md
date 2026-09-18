# dsh-navigator Desktop 联调手工清单（G3）

**这是一份手工执行清单，不是票据、也不阻塞任何票。** 它对应设计文档「验证状态」里仍未验证的 G3：

> G3 | Desktop 本地联调路径（bundle 必须解析到 profile 内，且安装时不发 prepare） | 在 Desktop 上链接预构建产物实测一次 | 联调范围收窄到 CLI / Web / SDK

**要证的两件事**：① 本包**预先构建好的产物**（不跑任何构建脚本）能被 Desktop 的 profile 按包名装载并激活；② 复核干预在 Desktop 的对话里看得见（那一行在、展开有正文、会话重载后仍在）。
**不做的事**：不发布 registry、不改 Desktop、不改本包源码。

- 适用版本：DSH `0.1.6-alpha.1`（本插件只对这个版本承诺行为）。
- 预计耗时：15–25 分钟。
- 全程只动 `$DSH_HOME`（默认 `~/.dsh`）下的 Desktop profile；仓库内只读产物。

---

## 0. 前置条件

- [ ] 机器上装了 DSH Desktop，且其自带 runtime 的 dsh 版本是 `0.1.6-alpha.1`（从应用的「关于 / 版本」看，或看随包 runtime 里 `@deepseek-ai/dsh/package.json` 的 `version`；对不上就**停止**，在记录里写「Desktop 版本不符，未验」）。
- [ ] Desktop 已经能正常跑一轮对话（模型凭据已在应用里配好）。联调要真实发一次复核请求，没凭据会把它记成复核失败——Part A 会因此看不结论，Part B 反而照样能过（它本来就靠超时）。
- [ ] 本仓检出就绪，`node -v` ≥ 22.21，`pnpm -v` 是 `10.12.1`（根 `packageManager` 声明）。
- [ ] 记下 `$DSH_HOME` 的实际值：`echo "${DSH_HOME:-$HOME/.dsh}"`。下文用 `<DSH_HOME>` 指代。

---

## 1. 构建产物（在仓库里）

```bash
cd packages/dsh-navigator
./node_modules/.bin/tsc -p tsconfig.json     # 门禁同款：不加 --noEmit，必须产出 lib/
ls -l lib/index.js lib/index.d.ts            # 两个文件都要在
```

- [ ] `lib/index.js` 与 `lib/index.d.ts` 存在。
- [ ] 这一步**只在开发机做**；下面装进 profile 的那份产物必须来自本节，且装完不再构建。

## 2. 打 tarball 并核对内容

```bash
cd packages/dsh-navigator
rm -rf /tmp/dsh-nav-g3 && mkdir -p /tmp/dsh-nav-g3
pnpm pack --pack-destination /tmp/dsh-nav-g3
tar -tzf /tmp/dsh-nav-g3/dsh-clipclop-dsh-navigator-*.tgz | sort
```

- [ ] 清单里**有** `package/lib/index.js`、`package/lib/index.d.ts`、`package/cordis.patch.yml`、`package/package.json`。
- [ ] 清单里**没有** `package/src/`（发布清单只带 `lib/**` 与 `cordis.patch.yml`；`README.zh.md` 随包是正常的）。
- [ ] 记下 tarball 的绝对路径：`TARBALL=$(ls /tmp/dsh-nav-g3/*.tgz)`。

> 为什么用 tarball 而不是 `file:` 目录：`file:` 是硬链接副本，内容随装配那一刻的工作副本长什么样；tarball 只随打包那一刻的产物。Desktop 的安装口径是 `--ignore-scripts`、不发 prepare，所以产物必须已经在包里。

## 3. 找到并备份 Desktop profile

```bash
PROFILE="<DSH_HOME>/profiles/desktop"
ls "$PROFILE/package.json" "$PROFILE/pnpm-workspace.yaml"
cat "$PROFILE/package.json"          # 看 dsh.profile.bundles 现在有哪几个包
cp "$PROFILE/package.json" "$PROFILE/package.json.g3bak"
cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.g3bak" 2>/dev/null || echo '（还没有 profile patch，稍后会新建）'
```

- [ ] profile 目录存在，`package.json` 里有 `dsh.profile.bundles`（初始是 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`）。
- [ ] 两个 `.g3bak` 备份已生成（清理时要还原）。

> Desktop 的 profile 固定是 `$DSH_HOME/profiles/desktop`。CLI 的 `dsh --profile desktop` 被刻意拒绝（desktop 由 Electron 独占），所以本清单直接在该目录里用 pnpm，这正是设计文档承诺的「本地 profile 内 `node_modules` 链接」那条路。

## 4. 把产物装进 profile（不发构建脚本）

```bash
cd "$PROFILE"
pnpm -v                                   # 记下来；profile 里若有 packageManager 字段就按它
pnpm add "$TARBALL" --ignore-scripts
ls node_modules/@dsh-clipclop/dsh-navigator/lib/index.js
test ! -e node_modules/@dsh-clipclop/dsh-navigator/src && echo '副本不含 src OK'
```

- [ ] `pnpm add` 退出码为 0。
- [ ] 安装副本里有 `lib/index.js` 与 `lib/index.d.ts`。
- [ ] 安装副本里**没有** `src/`（证明它是预构建产物，不是源码）。

### 4b. 查一遍有没有「混装」（必做）

本包的 `peerDependencies` 就是六个 DSH 服务包（`cordis` / `dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-session-projection` / `dsh-storage-domain`）。**profile 里已经有 Desktop 自带的那一套时，pnpm 会复用它们**；但若某个 peer 在 profile 里找不到可满足的版本，pnpm 会**另装一份**（默认取更新版，很可能是 `0.1.6-alpha.2`）——那就与本插件承诺的 `0.1.6-alpha.1` 混装了，插件会从自己那份副本 import。

```bash
cd "$PROFILE"
grep -c "0.1.6-alpha.2" pnpm-lock.yaml || echo '0（无 alpha.2）'
# 插件运行时 import 的那一份到底落在哪、哪个版本
node -e "const p=require.resolve('@deepseek-ai/dsh-llm/package.json',{paths:['$PROFILE/node_modules/@dsh-clipclop/dsh-navigator']});console.log(p);console.log(require(p).version)"
```

- [ ] `pnpm-lock.yaml` 里 `0.1.6-alpha.2` 计数为 0；若桌面版自带的就是 alpha.2，以「与 Desktop 自带那一套同版本」为准，把下面那条判据换成它。
- [ ] 上面 `node -e` 打出的版本与 Desktop 自带的那一套一致（把路径记进结论）。
- [ ] 若出现混装：在 profile 的 `package.json` 里把版本钉回 Desktop 自带的那一套，再重装重查，例如

      ```jsonc
      "pnpm": { "overrides": { "@deepseek-ai/dsh-llm": "<Desktop 自带版本>", "@deepseek-ai/dsh-session": "<同左>" } }
      ```
      （需要哪几个就钉哪几个；然后 `pnpm install --ignore-scripts` 并重跑本节两条检查。）

## 5. 启用 bundle 并写联调配置

在 `package.json` 的 `dsh.profile.bundles` 末尾加上包名：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-clipclop/dsh-navigator"   // ← 新增这一行
      ]
    }
  }
}
```

在 profile 自己的 `cordis.patch.yml`（与 `package.json` 同目录）里按 id 覆写本插件的配置——profile 层在 bundle 层之后应用，所以这一条盖得住包内 `cordis.patch.yml` 的默认值：

**Part A（真实结论，观察模型自己的判断）**

```yaml
- id: dsh-navigator
  config:
    triggerEverySteps: 1     # 默认 50 太慢，联调改成 1
    mode: wait
```

**Part B（确定性可见路径，见第 7 步）**

```yaml
- id: dsh-navigator
  config:
    triggerEverySteps: 1
    mode: wait
    failurePolicy: stop      # 复核失败时追加停止说明并停下
    reviewTimeoutMs: 1       # 1ms，让复核必然超时 → 必然产生一条可见的停止说明
```

- [ ] `bundles` 里已加 `@dsh-clipclop/dsh-navigator`。
- [ ] `cordis.patch.yml` 写好了 Part A 的配置（Part B 留到第 7 步再换）。

## 6. Part A：启动 Desktop，验证「激活 + 真复核」

- [ ] 完全退出 Desktop 再启动（让它重新读 profile）。
- [ ] 新建一个会话，给一个**会产生至少两步**的任务，例如：
      `先用 bash 跑 echo one，再用 bash 跑 echo two，然后一句话总结。`
      （第 1 步会 claim 你这条消息且步数还没到触发点；第 2 步到点触发复核。）
- [ ] 复核记录已落盘（**这一步与结论无关，必然发生**）：
      `ls "<DSH_HOME>/storages/clipclop_review/records/"` → 至少一个新文件。
      若没有：多半是这个 turn 只有一步（模型没调工具、直接答完），换一条更明确要求调用工具的提示词再来。
- [ ] 如果这一轮复核的结论是 `adjust` 或 `stop`：对话里出现一行「上下文注入」折叠行；点开能看到正文（正文以 `第 N 步的导航复核建议` / `第 N 步的导航复核停止` 开头）。
- [ ] 如果结论是 `continue`：**这是正常的**——规格规定 `continue` 不写任何内容进对话。此时切到 Part B 拿可见读数。

> 判「插件真的激活了」以**记录文件 + 复核请求真的发出**为准；`continue` 不产生界面元素不算失败。

## 7. Part B：确定性拿到可见的一行（并验证重载仍在）

1. 把第 5 步的配置换成 Part B（`failurePolicy: stop`、`reviewTimeoutMs: 1`）。
2. 重启 Desktop（或让 profile 重载）。
3. 新开会话，给一个会产生至少两步的任务（同上）。
4. 期望：

- [ ] 当前 turn 停下来（不再继续往下做），对话里出现一条停止说明的折叠行。
- [ ] 点开那一行，正文以 `第 N 步的导航复核停止：复核失败` 开头（`failurePolicy: stop` 的失败分支写的是「复核失败」）。
- [ ] 复核记录里新增一条失败态记录（记录 JSON 里 `"status": "failed"`；三种取值是 `completed` / `failed` / `cancelled`）。
- [ ] **会话重载后仍在**：切到别的会话再切回来（或重启 Desktop 后重新打开这个会话），那一行还在、还能展开。

> 为什么这条是确定的：`reviewTimeoutMs: 1` 让复核必然超时；等待模式 + `failurePolicy: stop` 必然把「复核失败」写成一条可见说明再停下。界面那行的渲染是 DSH 既有的「上下文注入」折叠行，本插件没有新写客户端。

## 8. 清理（把机器还原）

```bash
cd "<DSH_HOME>/profiles/desktop"
pnpm remove @dsh-clipclop/dsh-navigator --ignore-scripts
# 还原 package.json / cordis.patch.yml
mv package.json.g3bak package.json
mv cordis.patch.yml.g3bak cordis.patch.yml 2>/dev/null || rm -f cordis.patch.yml
rm -rf /tmp/dsh-nav-g3
```

- [ ] 包已从 profile 移除，`bundles` 与 profile patch 已还原，Desktop 能照常启动。

## 9. 失败怎么判、怎么收窄

先看是哪一类，别急着改代码（产物本身已由 `tests/prebuilt-artifact.spec.ts` 在安装副本上验过 ACTIVE）：

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| Desktop 起不来 / 启动审计报该条目未激活 | bundle 没进 `dsh.profile.bundles`，或 profile 里没装成功 | 回到第 4、5 步核对；确认 `bundles` 里那一行的包名与安装副本的 `name` 完全一致 |
| 插件装了、配置也改了，但行为没变化 | profile 的 `cordis.patch.yml` 没被读到（文件名/层级不对） | 对照 `$DSH_HOME/profiles/desktop/cordis.yml`（根配置，应为空数组）与 `cordis.patch.yml`；注意本插件条目 id 必须是 `dsh-navigator` |
| 之前还能用，某次启动后设置被重置 | Desktop 的**原生恢复**会 `sanitizeProfile`：把 profile 的 `cordis.patch.yml` 备份成 `.bak-<时间戳>`，并把 `bundles` 重置回 web 模板（第三方 bundle 被关掉） | 从 `.bak-<时间戳>` 恢复 patch，重新把包名加回 `bundles`；这在记录里注明一次即可 |
| 装的时候报 prepare / 构建脚本被拦 | 装的是源码包或 `file:` 目录，而不是第 2 步的 tarball | 只用 tarball 装，且带 `--ignore-scripts` |
| profile lock 里冒出 `0.1.6-alpha.2`，或插件激活了但注入的消息形状不对 | peer 被另装了一份，与本插件承诺的 alpha.1 混装 | 回到第 4b 步：把 peer 钉回 Desktop 自带版本后重装重查；仍不行就按下面收窄 |
| 记录文件没有、复核也没发 | 插件没激活（多半是 bundle 未启用），或该会话不是顶层会话（子 agent 会话不触发） | 核对第 5 步；确认用的是自己新建的普通会话 |

**收窄退路**（设计文档已写死）：若 Desktop 这一路在本机确认走不通，就把联调范围收窄到 **CLI / Web / SDK**（这三条在本仓已有可重跑的自动化用例：`prebuilt-artifact.spec.ts`、`web-entry.spec.ts`、`sdk-entry.spec.ts`），并在记录里写清「Desktop 路径失败的**具体一步**与报错」。

## 10. 结果记到哪

跑完（无论通过与否）记两处：

- [ ] 设计文档 `docs/dsh-navigator-design.md` 的「验证状态」：把 G3 从「仍未验证」移到「已实测通过」，或在原行写明失败与收窄结论（含日期、Desktop 版本、dsh 版本）。本清单已在该行挂上链接。
- [ ] 结论一句话模板：
      `G3：Desktop <版本>（dsh <版本>，pnpm <版本>）上按本清单链接 tarball 产物并启用 bundle，<通过 | 失败>；peer 解析到 <路径>（<版本>）；证据：复核记录 <路径>、对话里的折叠行 <截图/描述>；<未收窄 | 已收窄到 CLI/Web/SDK，原因 …>。`
