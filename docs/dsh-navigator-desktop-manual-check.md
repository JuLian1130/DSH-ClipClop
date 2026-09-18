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

- [ ] 机器上装了 DSH Desktop，且其自带 runtime 的 dsh 版本是 `0.1.6-alpha.1`（从应用的「关于 / 版本」看，或看随包 runtime 里 `@deepseek-ai/dsh/package.json` 的 `version`；对不上就**停止**，在记录里写「Desktop 版本不符，未验」）。**为什么这条必须人眼确认**：本包只对 `0.1.6-alpha.1` 承诺行为，而 peer 范围 `^0.1.6-alpha.1` 会接受同段号的其它预发布版（`0.1.6-alpha.2`、`0.1.6-beta.1` 都满足，semver 已核），Node 的模块解析又根本不校验 peer 范围——所以「装上了」「跑起来了」都说明不了绑到的是 alpha.1。
- [ ] Desktop 已经能正常跑一轮对话（模型凭据已在应用里配好）。联调要真实发一次复核请求，没凭据会把它记成复核失败——Part A 会因此看不结论，Part B 反而照样能过（它本来就靠超时）。
- [ ] 本仓检出就绪，`node -v` 落在 DSH 声明的范围 `^22.19.0 || >=24.0.0`（DSH 检出根 `package.json` 的 `engines`；本包只对 DSH `0.1.6-alpha.1` 承诺行为），`pnpm -v` 是 `10.12.1`（本仓根 `packageManager` 声明）。不满足就**停止**，在记录里写「未验」与实测到的值（模板见第 10 步）。
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

### 4b. 装完后的两点预期（第 6 步首次启动之后再回来看一眼）

```bash
cd "$PROFILE"
ls -d node_modules/@dsh-clipclop/dsh-navigator      # 本包的副本，应当在
ls -A node_modules/@deepseek-ai 2>/dev/null || echo '（该目录已不存在，正常）'   # 空输出＝里面的包已被回收
```

- [ ] `node_modules/@dsh-clipclop/dsh-navigator` 还在——第 4 步装进去的那份副本应当在启动之后仍留在 profile 里。（`ls -d` 只证这个路径在；它是否真被装载解析到，见第 6 步的激活与复核记录。）
- [ ] 启动过 Desktop 之后，`ls -A node_modules/@deepseek-ai` 没有输出（目录还在但空了；目录整个不在时命令行会打印上面那行提示，同样算预期），或 `pnpm-lock.yaml` 消失——都属**预期现象**：Desktop 在每次生产启动时回收自己的核心包，并在它改动了 profile 清单/`overrides`、或树里还有核心包残留时删掉那份 lock。不要据此改配置或重装。

> 本包的 peer 绑到哪一份 DSH，不要在磁盘上推——以第 6 步「插件真的激活 + 有复核记录」为准。

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

- [ ] 完全退出 Desktop 再启动（让它重新读 profile）。启动后回到第 4b 步看一眼那两条预期（核心包被回收、本包副本还在）。
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
| profile 里 `node_modules/@deepseek-ai` 空了（或整个不在）、或 `pnpm-lock.yaml` 不见了 | Desktop 每次生产启动都在回收自己的核心包——见 4b | 预期现象，不要重装或改配置 |
| Desktop 自带的 dsh 不是 `0.1.6-alpha.1` | 本包只对 alpha.1 承诺行为；peer 范围会接受 alpha.2，Node 的解析又不校验范围（见第 0 步） | 按第 0 步停止并记「Desktop 版本不符，未验」 |
| 插件激活了，但注入的消息形状不对（那一行的摘要/正文与规格不符） | 真实失败信号，不是环境问题 | 记下那条消息的形状与会话事件，按第 10 步把失败写进设计文档 G3 行（不属于收窄那一档） |
| 记录文件没有、复核也没发 | 插件没激活（多半是 bundle 未启用），或该会话不是顶层会话（子 agent 会话不触发） | 核对第 5 步；确认用的是自己新建的普通会话 |

**收窄退路**（设计文档已写死）：若 Desktop 这一路在本机确认走不通，就把联调范围收窄到 **CLI / Web / SDK**（这三条在本仓已有可重跑的自动化用例：`prebuilt-artifact.spec.ts`、`web-entry.spec.ts`、`sdk-entry.spec.ts`），并在记录里写清「Desktop 路径失败的**具体一步**与报错」。

## 10. 结果记到哪

跑完（无论通过与否）记两处：

- [ ] 设计文档 `docs/dsh-navigator-design.md` 的「验证状态」：把 G3 从「仍未验证」移到「已实测通过」，或在原行写明结论（含日期、Desktop 版本、dsh 版本）——走失败结论时写明失败在哪一步与报错或现象原文；走**「未验」**（第 0 步就停下，例如 Desktop 的 dsh 不是 `0.1.6-alpha.1`、或本机 Node / pnpm 不满足第 0 步）时写「未验」并写明原因，不要写成「失败」；若还走了收窄那一档（第 9 步末尾）再写明收窄到哪一档与原因。本清单已在该行挂上链接。
- [ ] 结论一句话模板（按结局挑一栏，证据只填这次真有的）：
      - 通过：`G3：Desktop <版本>（dsh <版本>，pnpm <版本>）上按本清单链接 tarball 产物并启用 bundle，通过；证据：profile 里的安装副本 <路径>（「bundle 解析到 profile 内」这一半的读数）；复核记录 <路径>（判定「插件激活 + 真复核」的读数）；第 7 步 Part B 拿到的展开行——那一行在、展开含正文、切走再切回仍在 <截图/描述>（开头第 ② 条要的就是它；Part A 的结论是 `continue` 时它必然来自 Part B）；未收窄。`
      - 失败：`G3：Desktop <版本>（dsh <版本>，pnpm <版本>）上按本清单链接 tarball 产物并启用 bundle，失败在第 <N> 步：<报错或现象原文>；证据：这次真有的那些（安装副本 <路径> / profile 状态 / 复核记录 <路径> / 会话事件 / 界面截图）；<未收窄 | 已收窄到 CLI/Web/SDK，原因 …>。`
      - 未验：`G3：未验——在第 0 步停下：<原因>；未装产物、未启用 bundle、无复核记录；证据：第 0 步里你实际读到的值 <…>，日期 <日期>。`
