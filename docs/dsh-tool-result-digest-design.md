# dsh-tool-result-digest 调研：历史工具结果的缩减

状态：**调研结论，未进入设计定稿**。机制逐条按最新版本 `0.2.0-rc.1` 核实（路径为 DSH 仓内相对路径）；收益量级由本机 `~/.dsh/sessions/` 的 **1173 个真实会话**实测，口径与偏差在下文逐项写明。

本文件是「下一步做不做、按什么形状做」的取证结论，不是规格。没有验收标准、没有票据拆分；它回答的是**收益是否存在、机制挂哪里、哪些前提还没验**。

## 为什么会有这一份

起因是 `dsh-reasoning-pruner` 之外的一个问题：历史步骤的**推理**已经不占输入了（那是 reasoning-pruner 的范围），但**工具结果**还在。用户提出的判断是——工具结果成为历史轮后，此后每次请求都按它计入输入，因此缩减它能省很多次缓存读取；如果后续轮需要的只是一个结论，就应该缩成结论。

这个判断**成立**，但其中「等它成为历史轮再缩减」这个**时机**是错的，代价很大。本文件把对的部分、错的部分、以及量级都固定下来。

## 范围与约束

- 与 `dsh-reasoning-pruner` 同源约束：**只开发插件，不修改 DSH 源码**。所有接缝都是已有扩展点。
- 本文件只覆盖**工具结果**（`tool/result` 的模型可见内容），不覆盖推理块（已有插件负责）、不覆盖用户消息与 assistant 正文。
- 基准是**最新版本 `0.2.0-rc.1`**（`AGENTS.md` 的「DSH 版本基准」；已核对：DSH 源码 checkout 与 `~/.dsh/profiles/node_modules/@deepseek-ai/` 里 **230 个 `dsh-*` 包全部是 `0.2.0-rc.1`**，另有 8 个 vendored cordis/cosmokit/schemastery 等包按自身版本走，共 252 个目录）。**注意 `AGENTS.md` 第 3 行仍写「当前是 `0.1.7-rc.2`」，已过期**；`docs/dsh-reasoning-pruner-design.md` 的 5 处该版本号同样过期（该文件不在本次改动范围，仅登记）。

## 一、收益的量级（本机实测）

### 口径

- 解 zstd 帧还原每个会话的完整 `SessionEvent` 流；按 `surfaceOp` 的 `append`/`replace` 折叠出**每个请求时刻**的模型可见面。
- v3 会话的 `tool/result` 按 `session-format-v3-to-v4/src/tool-role.ts` 的规则升为一等 `tool` 消息后再计价，否则旧会话的工具结果全部计为零（第一版统计即栽在这里）。
- 定价用 DSH 自己的启发式（`packages/llm/token-meter/src/estimate.ts:13,16,19`：4 字符/token、每块 4、每条消息 4），**只用于量级比较，不是账单预测**。
- 样本：48 个 provider 实际 prompt 峰值 ≥ 300K 的会话（另有 79 个 ≥ 250K、217 个 ≥ 150K）。

### 「携带量」是唯一正确的度量

对每条已进入历史的内容，定义它的**携带量** = `它的 token 数 × 它之后还发生了多少次模型请求`。这正是「此后每次请求都按它计入输入」的严格形式。

| 项 | 携带量 | 占比 |
|---|---|---|
| 历史步骤的推理（reasoning 块） | 3,024,257,386 | **45.5%** |
| 工具结果 | 2,092,798,776 | **31.5%** |
| 其余（系统提示词、工具定义、用户消息、assistant 正文） | 1,529,844,645 | 23.0% |
| 合计 | 6,646,900,807 | 100% |

同一批会话的 provider 实测合计输入 3,416,047,858 token（`cacheReadTokens + inputTokens`），其中 `cacheReadTokens` 占 **95.7%**——这就是「省很多次缓存读取」这句话的实际规模。

**⇒ 工具结果是推理之后第二大的可缩项，占携带量的 31.5%。**

### 一个必须记下的测量偏差（否则结论会反向）

第一版统计用的是**会话结束时的最终保留面**，得出「工具结果只值 21%、中位数只省 3.7%」。那个口径是错的，而且错在两个层面：

- **量的层面**：最终保留面上的工具结果携带量只有 449,482,959，占整个日志工具结果携带量（2,092,798,776）的 **21.5%**——**近八成的工具结果携带量已经被手工 `/compact` 删掉了**，不在最终面上。
- **质的层面**：剩下的那 21.5% 恰恰是「出现在会话后段、后面没几次请求」的那批，所以按它算出来的「中位数只省 3.7%」是**幸存者偏差**——被删掉的那八成正是本该缩减的对象。

按整个日志统计才是 append 时刻决策应有的口径，工具结果占**总携带量的 31.5%**。**同一份数据、仅换统计口径就能让结论反向**，这是本调研里最容易重犯的错误。

用户对此的判断是对的：**「大部分工具结果出现在会话后段、后面没剩几次调用」是压缩造成的，不是任务的真实形态。** 实测这 48 个会话的 49 次压缩**全部是 `/compact` 手动触发，自动压缩 0 次**；全库也是 71 次手动 vs 4 次自动。

自动压缩确实没触发，但**原因不只是窗口大**——阈值被上限夹住，比 `window × 0.8` 低得多：

- 阈值 = `min(contextWindow × thresholdRatio, messageBudget − headroomTokens)`（`packages/compaction/compaction-basic/src/config.ts:190-193`），其中 `messageBudget = contextWindow − reservedCompletionTokens`、`headroomTokens` 默认 65,536（`:75`）、`thresholdRatio` 默认 0.8（`:20`）、`reservedCompletionTokens` 取该次请求的 `maxTokens`（`packages/compaction/compaction-basic/src/index.ts:65-68`）。
- 这些会话是 `contextWindow: 1000000` + `maxTokens: 384000` ⇒ 阈值 = `min(800000, 1000000−384000−65536)` = **550,464**，不是 800,000。

按该阈值折算，48 个会话里**最大的一个到达了阈值的 95.9%**，8 个超过 80%，中位数是 49.1%——**差一点就触发了**。所以：

**推论（独立成立，值得单列）**：在 1M 上下文 + 384K 输出的部署上，自动压缩与 tool-result pruner 长期处在「恰好不触发」的区间里，是**实际上的死代码**。这不只影响本调研——它意味着「压力触发型」的省 token 机制在长窗口部署里整体失效，而且**失效的方式是静默的**（什么都不发生，没有警告）。

### 剩余调用次数 `N` 的分布

18,025 条工具结果，各自之后还剩多少次请求：

| 分位 | p10 | p25 | 中位 | p75 | p90 | 最大 |
|---|---|---|---|---|---|---|
| 剩余调用数 `N` | 36 | 90 | **192** | 362 | 577 | 1035 |

**没有任何一条的 `N ≤ 1`。** 这个分布是下面「摘要是否划算」的决定性输入。

## 二、机制：缩减必须发生在 append 时刻

### 两个时机，代价完全不同

工具结果有一次被写进日志（`tool/result` 事件），此后被每一次请求携带。缩减它有两个时机：

| 时机 | 一次性代价 | 说明 |
|---|---|---|
| **① append 时刻**（结果还没进过任何请求） | **零缓存代价** | 模型可见的从头就是缩减版；完整版从未进入缓存前缀 |
| ② 回溯改写历史轮 | **从被改位置起的整个前缀重算一次** | 改的是已缓存前缀的中间部分 |

时机 ② 的代价在 DSH 里有明文契约：tool-result-pruner 的 `README.md:125` 写着「Replacing an earlier result invalidates reuse from the first changed token」。本机实测这份代价：**26 个发生过压缩重写的会话，命中率中位数掉 21.5 个百分点**（有会话从 99.9% 掉到 0–85%）。

对照之下，spill-policy 的 `README.md:138` 写明它的形态是「Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries」——**因为它在 append 时刻替换，而不是事后改写。**

### 结论

**用户方案的机制是对的，时机要改。** 必须在 append 时刻下判断，而不是等结果成为历史轮再回头判断。这不削弱方案——它让方案从「省 `h×S×N` 但要付一次全前缀重算」变成「省 `h×S×N` 且只付一次小模型成本」。

### 落点：`tools/post-execute`

append 时刻唯一能改模型可见内容的接缝是 `tools/post-execute` 瀑布（`packages/core/tools/src/index.ts:176`）。它有两个已验证的性质正好是这件事需要的：

1. **在落盘之前**。`postExecute`（`packages/core/tools/src/index.ts:1781` 起）在管线内运行，其返回的 `content` 就是随后写进 `tool/result` 的内容——不是改写，是塑造。
2. **拿得到调用身份与参数**。`ToolExecution`（`:393`）带 `name`、`arguments`、`callId`、`agent`，所以「这条结果是什么工具、参数是什么」在判定时完全已知。

出厂先例就是同一个位置：spill-policy 挂在 `tools/post-execute` 且 `{ prepend: true }`（`packages/spill/spill-policy/src/index.ts:133` 注册、`:150` 的 `prepend`）。`prepend` 走 `unshift`（`vendor/cordis/src/events.ts:255`），所以同位置多个监听器的先后是可裁决的。

### 判定所需的三类信息在 append 时刻的可得性

| 信息 | append 时刻可得？ |
|---|---|
| 结果是什么工具、参数是什么 | ✅ `exec.name` / `exec.arguments` |
| 结果的正文能否被重新获取 | ✅ 由工具不变量决定（见第四节） |
| 它之后还会被携带多久（`N`） | ❌ **本质未知** |

第三条是这套方案的**根本不确定性**，必须写清楚：`N` 只能在事后测量。但这不否决方案——因为实测 `N` 的中位是 192、p10 是 36，而回本门槛只有十几次（见下），所以**「默认认为它会被长期携带」是安全的，不需要预测 `N`**。真正需要 `N` 的场景是「要不要为了一条结果等一次小模型调用」，那是延迟问题，不是收益问题。

## 三、小模型摘要：划算，且几乎总是划算

用户的问题：「小模型摘要给主模型不可以吗？」

**可以，而且在这个工作负载下几乎没有不划算的情形。** 盈亏平衡推导（设结果大小 `S`、剩余调用数 `N`、缓存命中折扣 `h`）：

- 不缩减：`h × S × N`
- 缩减（小模型按全价读一遍原文 `S`，产出 `k×S` 的摘要，此后按 `h × k×S × N` 携带）：`S + h × k × S × N`
- **回本条件：`N > 1 / (1 − k) / h`**；取 `k = 0.1`、`h = 0.1` ⇒ **`N ≳ 11`**

代入实测分布（中位 `N = 192`，p10 = 36）：**97% 的工具结果在 `N ≥ 11` 一档**；如果把小模型单价压到目标模型的 0.3 倍，门槛降到 `N ≈ 3.3`，覆盖率 99%。

### 聚合口径：摘要全部结果的成本约占其节省的 4%

| 缩减门槛 `T`（token） | 触发条数 | 覆盖携带量 | 需送进小模型的原文（估算器单位） |
|---|---|---|---|
| 0（全部） | 18,025 | 100% | 7,656,785 |
| 1024 | 1,526 | 54.3% | 4,271,423 |
| 2048 | 547 | 33.7% | 2,902,132 |
| 4096 | 250 | 22.1% | 2,091,034 |
| 8192（现有 pruner 阈值附近） | 111 | 11.1% | 1,317,657 |

「需送进小模型的原文」与「携带量」之比是 `sumS / carry ≈ 0.0037`（全量）。把它换成钱：原文按全价 `1.0` 读，携带按 `h = 0.1` 计——**成本/收益 ≈ `sumS / (h × carry) ≈ 3.7%`**，再加小模型的产出 token（按输入的量级假设，约翻倍）仍在 5–10% 以内。

**⇒ 门槛应该设得很低甚至不设。** 与现有 pruner 的对比要注意单位：它的阈值是 `thresholdChars: 8192`（`packages/bundle/base/cordis.patch.yml:418`），按估算器的 4 字符/token 折算约等于 **`T = 2048` token** 那一档，覆盖 **33.7%** 的携带量。也就是说它已经覆盖了三分之一，剩下的三分之二**全部低于它的阈值**——因为它是**尺寸驱动**的，而正确的驱动量是携带量，它对小结果同样成立。

### 成本模型是配置，不是常量

`h` 与「小模型单价」都是**部署相关的价格比**，不是从 token 数里测量出来的量。`dsh-reasoning-pruner` 的规格已经为同类问题定过结论：`h` 必须由使用者按端点公开定价**外部声明**，本仓库没有任何 cost 消费者（`packages/llm/llm/src/types.ts:170-171` 只给计数；pi-ai 目录里的 `cost` 无人读取）。因此缩减门槛、最小尺寸、小模型 route 都应是 `Config` 字段，不是 `DEFAULT_*` 常量。

## 四、按什么缩减：可重取性，不是工具名

用户提出的两条设计——「摘要里留一个 id」和「提供按 id 查全文的工具」——**都成立，而且 DSH 已经建好了这两个东西**：

- **id 已存在**：`ctx.spillStore.saveText()` 返回 `SpillRef { locator, bytes, retrievalHint }`（`packages/spill/spill/src/types.ts:76`），`locator` 是品牌化的不透明句柄，本地后端渲染成文件路径，远程后端可以渲染成 URI——消费方按 `retrievalHint` 渲染，不假定检索机制。
- **查全文的工具已存在**：spill 通知里直接给模型的是 ` Full formatted result stored at: <locator> … <retrievalHint>`（`packages/spill/spill-policy/src/notice.ts:7,21`），`retrievalHint` 告诉模型用 `read`（带 offset/limit）或 `grep`。**不需要新造一个检索工具。**

⇒ **用户方案的「摘要 + 可查全文」不是新设计，而是把已有的 spill 从「超大才做、头尾保留」换成「值得做就做、摘要保留」。** 这是本调研最重要的一个收窄：要交付的代码量比看起来小。

### 正确的分类维度

「哪些能缩」的判据不是工具名，而是**正文能否由工具不变量重新获取**：

| 类别 | 例子 | 能否重取 | 实测 |
|---|---|---|---|
| 正文可由不变量重取 | `read`（路径 + offset）、`web_fetch`（URL）、`bash`（命令可重跑） | ✅ | 三类合计占工具结果 **95%** |
| 正文不可重取 | 一次性构建/测试输出、`job_output` 的增量段 | ❌ 或重跑代价高于收益 | — |
| 正文本就是 ack | `edit` 的「已改」、`write` 的确认、`list_agents` | 无需摘要，本身极小 | 重复率最高（`edit` 81%），但绝对量只占约 2% |

按工具结果 token 计的构成（**口径：整个日志里出现过的全部工具结果**，与第一节的携带量口径一致）：`bash` 47%、`read` 24%、`web_fetch` 24%、`edit` 2%、其余约 3%。**三个工具覆盖 95%**，这是很集中的靶面。

（换一个口径会得到不同的排序：若只统计**峰值请求那一刻的保留面**，则是 `bash` 41%、`web_fetch` 29%、`read` 25%——因为长输出更容易被压缩优先删掉。两个口径都真实，**引用时必须写明用的是哪一个**。）

### 为什么这个判据属于工具作者而不是全局策略

「这段输出之后是否还需要全文」只有工具作者能答：`bash` 知道退出状态与输出主体的分工（`packages/shell/tool-bash/src/render.ts:43` 起构造标记、`:59` 追加 `[exit code: N]` 作为末尾标记，`packages/shell/shell/src/render.ts:37,40` 的 `parseExitStatus` 能把它解析回来），`web_fetch` 知道正文可重取，`read` 知道自己是窗口化的确定格式。

DSH 里表达这种意图的位置已经有了形状先例——工具 `output` 声明里的 `render` / `presentationMeta`（`.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.md`）。**这是首版应走的形状**：策略插件提供机制，工具声明可重取性，插件对未声明的工具保守不缩。

### 与现有两个机制的关系（以及它们各自的缺口）

| 机制 | 位置 | 触发 | 形态 | 缺口 |
|---|---|---|---|---|
| `dsh-spill-policy` | `tools/post-execute`，`prepend` | **每次**，超 `maxInlineTokens: 12500` | 头/尾保留 + locator | 尺寸驱动；**硬编码豁免 `read`**；阈值以下完全没有 locator |
| `dsh-compaction-tool-result-pruner` | 由 compaction-basic 调用 | **仅 compaction 够格之后** | 头 4096 + 标记 + 尾 1024 | append 时刻不运行；**替换不带 locator**（切掉的中段没有恢复入口）；不看工具名也不看参数 |

两条缺口正好是本调研的靶心：

1. **pruner 的替换不可恢复。** 它只改 `content`（`packages/core/session/src/surface.ts:462` 的 `assertToolResultRewrite`，`:488` 抛 `'tool/result surface replacement may change only content'`），没有 locator，被切掉的中段**没有查回的入口**——这与用户「留一个 id 查全文」的设计正相反。
2. **spill 的豁免与 pruner 的不豁免不一致。** 见下节。

## 五、`read` 的不对称（现存矛盾，必须裁决）

- spill-policy **硬编码豁免 `read`**：`exec.name === 'read'`（`packages/spill/spill-policy/src/index.ts:135`）。
- tool-result-pruner **完全不看工具名**（`packages/compaction/compaction-tool-result-pruner/src/index.ts` 里没有任何 `exec.name`/`toolName` 分支）。

⇒ **一份 `read` 结果现在会被 pruner 裁成 4096+1024，只要 compaction 够格。** 这 48 个会话里有 1797 条 `read` 结果，其中 222 条超过 8192 字符；但它们**没有被裁剪过**，因为自动压缩在这批部署上从不触发（见第一节）。所以这不是观察到的故障，而是「两个机制口径不一致」的隐患——**一旦部署的阈值更低，它会立刻变成实际行为**。全库 8851 条 `read` 结果里有 2482 条超过该阈值。

### 为什么 spill 豁免 `read`（以及这条理由是否仍成立）

设计记录写的理由是「避免重复读取产生循环」（`.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md:69`），README 的 Dev Note 进一步写明是占位：**「Per-tool opt-out or per-tool policy declarations remain deferred; the built-in `read` skip covers the known loop, and a second real tool need would justify configuration」**（`packages/spill/spill-policy/README.md:161`）。

即：**「按工具分流」是上游已登记、未实现的方向**，本调研正好是它等的「第二个真实需求」。

### `read` 的实测数据（支持缩减，但有前置）

- 1,797 条 `read` 结果、1,871,782 token（口径：这 48 个会话）。
- **54.0% 的 `read` token 属于「同一路径后来又读了一次」**；**15.8% 连 `offset` 都相同**。
- 被编辑过的文件里 62% 也被读过；单文件读取次数中位 4，最大 118。

⇒ `read` 是缩减收益最大的类别之一，而且它已经是窗口化的确定格式（`READ_LIMIT = 2000` 行、`READ_MAX_BYTES = 50KB`、`READ_MAX_LINE_LENGTH = 2000`，`packages/fs/tool-fs/src/read.ts:15`、`read-render.ts:11,14`），没有「无关中段」可供头尾裁剪切掉——**这正是摘要比头尾裁剪更适合它的理由**。

### 必须确认的前置：`read` 同时是 edit 的授权凭据

`fs-observation-policy` 用 `read` 作为 guarded write/edit 的 compare-and-swap 依据，因此「缩了模型可见内容会不会让 edit 变成未观测」必须回答。**答案有源码依据，方向是安全的**：

- 观测记录是 `{ kind: 'present', version }`，凭据是**版本**而非内容：`fs/edit-intent` 用观测到的 version 做 CAS（`packages/fs/fs-observation-policy/README.md:74`）。
- **发射点在 `read` 工具的 body 里、post-execute 之前**：`ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)` 紧接在 `return outcome` 之前（`packages/fs/tool-fs/src/read.ts:163`，注释写明该监听器「contractually a synchronous, side-effect-only recorder」）。而 post-execute 是随后包裹这次调用的策略阶段（`packages/core/tools/src/index.ts:1781` 起）。

**⇒ 缩减 `read` 的模型可见内容不改变已记录的观测，`FS_STALE_VERSION` / `FS_NOT_OBSERVED` 的行为不受影响。**

**但这条仍列为实现前的前置**，理由是：它由静态阅读推出，未在运行期验证；且必须先确认 `post-execute` 的缩减不会以任何方式重跑或跳过工具 body（应当不会——它只替换 `content`）。验收要覆盖「同一 turn 内 read 后 edit」与「read 被缩减后 edit」两种顺序，断言两者都不产生 `FS_NOT_OBSERVED`。

## 六、被排除的替代方案

- **回溯改写历史轮**（等成为历史轮后再缩）：见第二节。代价是从被改位置起的全前缀重算，实测掉 21.5pt 命中率。**除非该前缀因其他原因已经变冷**（例如同一批里 tool-result pruner 已落了 replace，那下一次请求本就全价）——这时回溯改写变成免费，可作为后续优化，不作为首版机制。
- **复用 `compaction/prune` 的影子计价通道做事后裁剪**：可行（该协议存在且被 pruner 使用），但它同样受第二节的时机代价约束，且必须在 compaction 够格后才有机会，覆盖不到 append 时刻。
- **把工具结果按工具名查表缩**：判据错位（见第四节）。名字不带「正文可否重取」，而且按仓库规则这属于把可调项硬编码。
- **直接调小模型做「要不要缩」的二分类**：`N` 在 append 时刻未知，而实测表明默认「缩」在 97% 的情况下正确，所以这次判断的边际价值很低，却要为每条结果增加一次调用与一次失败模式。
- **等小模型异步完成后在下一次 pre-step 施加**：这是一个**真实可行的替代时机**（`agent/pre-step`，`packages/core/agent/src/runtime-types.ts:320`），代价是「赶不上下一次请求」时完整版已经被发出去，之后缩就要付第二节的重算代价。**是否采用取决于小模型延迟，属于待裁决项**（见第八节）。

## 七、未验证事项（实现前必须验）

只有源码依据、**需要在运行期确认**的：

1. **缩减 `read` 不影响 `fs-observation-policy` 的授权语义**（运行期确认）。静态方向已有源码依据（观测以 version 为凭据、发射点在工具 body 内、早于 post-execute，见第五节），但必须跑一遍：覆盖「同一 turn 内 read 后 edit」与「read 被缩减后 edit」两种顺序，断言都不产生 `FS_NOT_OBSERVED`。
2. **摘要内容对 `tokenMeter.measure` 不可见**。`dsh-reasoning-pruner` 已为此记录过同类事实：计量器按**原始表面事件**定价，不读投影（`packages/llm/token-meter/src/index.ts` 的 `measure()` 走 `priceSurface`，`token-meter/src/**` 不引用 `projectedMessages`）。但本方案在 post-execute 改的是**落盘内容本身**，所以计量器**应当**看到缩减后的值——必须验，因为它决定了自动压缩是否随之推迟。
3. **`tools/post-execute` 内做异步小模型调用的时序**。`postExecute` 在 `execute` 的外层 try/catch 内（`packages/core/tools/src/index.ts:1779` 注释明写「a throwing listener → isError」）。⇒ **小模型失败绝不能抛**，必须降级为「保留原文」并落一条 warn，否则一次摘要失败会把工具调用整个变成错误结果。这条是判据级要求，不是风格问题。
4. **`ctx.spillStore` 在缩小的结果上是否仍可用**。现有 spill-policy 对**低于** `maxInlineTokens` 的结果不做任何事（README：「Results within budget … pass through」），因此**小结果目前没有 locator**。本方案要给所有被缩结果提供 locator，就必须自己持有存储调用（`saveText`），而不是复用 spill-policy 的产物。两个机制同挂 `tools/post-execute`，**先后顺序必须显式裁决**，否则会出现双重 locator 或双重占位。
5. **`contextBreakdown` 没有工具结果这一维**。该投影只分 `systemTokens / toolsTokens / messageTokens` 三类（`packages/llm/token-meter/src/breakdown-projection.ts:25-27`），**reasoning 与工具结果都被折进 `messageTokens`**。因此界面上的上下文占比既不反映 reasoning-pruner 的收益，也不会区分本插件的收益。这不是缺陷，但意味着**「省了钱但界面不动」会再次出现**；文档不得把它说成「降低上下文占用」。

**明确不断言**：

- 本机这 1173 个会话偏向调研型工作流（大量 `web_fetch`/`read`）。纯「写代码、少搜索」的任务里 `bash`/`edit` 的相对关系会变；`sumS/carry` 之类的比值可迁移，绝对值不可外推。
- 携带量模型与 provider 实测的比值是 **0.739**（用 6 个会话做重放校验：重放面合计 409,041,974 vs 实测 prompt 合计 553,394,242）。差额来自消息框架、工具 schema 与分词密度。**本文件的百分数是量级判断，不是账单预测。**
- 48 个会话全部跑在 `contextWindow: 1000000` + `maxTokens: 384000` 的端点上，阈值 550,464，所以它们**天然见不到 pruner 的行为**（最大一个到了 95.9%，仍差 22,625 token）。pruner 的真实效果只在阈值更低的部署上可观察，样本里只有 2 个 256K 窗口的会话出现过 prune，不足以给结论。

## 八、待裁决

1. **包名**。候选取功能名（与 `dsh-navigator`、`dsh-reasoning-pruner` 的先例一致），如 `dsh-tool-result-digest`。与 `dsh-reasoning-pruner` 是否最终同属一个容器包（`dsh-smarter-context` 在 `reasoning-pruner` 的设计里被保留为未来容器名）留到第二个成员真正落地时裁决。
2. **同步还是异步**。post-execute 内同步调小模型会阻塞每一步；异步 + 在 pre-step 施加则可能赶不上下一次请求。**这是首版最需要裁决的一条**，且它的答案依赖实测小模型延迟分布，不依赖本文件的任何数据。**已移到第十节备忘**（10.2 给出两个选项的代价对照、判定所需的证据、以及一个折中方案），当前不裁决。
3. **`read` 是否进入缩减范围**。数据支持进入（54% 被重读），前置是第七节第 1 条。
4. **是否替换现有的 spill-policy 与 tool-result-pruner**，还是只做「第三个 listener」。替换会让 `read` 的豁免口径统一，但会改动已发布的默认组合；只做增量则保留口径不一致（第五节）。按 `reasoning-pruner` 的先例，**默认不改别人的插件**，但这条要显式记下来。
5. **`h` 与门槛的取值由谁声明**。按第三节，必须是使用者外部声明的 `Config` 字段；首版可以只提供 token 判据（等价于 `h = 0.5` 的特例）并在文档里写明用的是哪一个。
6. **干跑监听器的产出如何回填**。第三节的压缩比 `k = 0.1` 与门槛表都是估算；第十节 10.1 给它一个实测路径，但「跑不跑、什么时候跑」尚未决定。

## 九、上游诉求（可选改进，不阻塞本地实现）

1. **「按工具分流」已在上游登记为未实现方向**（`packages/spill/spill-policy/README.md:161`）。本插件是第二个真实需求，可作为推动该配置面落地的依据。
2. **tool-result-pruner 的替换没有恢复入口**（中段被切掉且不带 locator）。这是它作为「语义缩减」载体的结构性限制；上游 Dev Note 已把「语义中段选择」标为 **undecided**（需模型或结构化启发式，两者都未 ship）。本调研给出的答案是「摘要 + locator」，若上游要吸收，应先解决 locator 归属。
3. **`contextBreakdown` 不加维度的后果**是「省了钱、界面不动」重复出现。是否为其补一维，属于上游决定。
4. **1M 上下文部署下自动压缩与 pruner 实际是死代码**（第一节末）。这是独立于本插件的发现，值得单独提。

## 十、备忘：后续再议

两项都**不在本次范围**，记在这里以免下次重新推导。

### 10.1 干跑监听器：实测摘要的压缩比、延迟与失败率

（最初的设想措辞是「量出若摘要可省多少的准确数字」；核实后范围要收窄——见下面「它不提供什么」。）

**它要回答什么。** 本文件第三节的收益是**估算**——4 字符/token 启发式、且假设摘要压缩比 `k = 0.1`。干跑要给出估算给不出的三样：

1. **真实的摘要压缩比 `k`**——对真实的工具结果正文跑一次摘要，量实际输出/输入 token 比，取代假设值。
2. **小模型调用延迟分布**——这是 10.2 的**唯一**决策输入，只能实测。
3. **摘要的失败形态与失败率**——超时、返回垃圾、空摘要各占多少。

**它不提供什么（避免建错预期）。** **携带量 `N` 与 `S` 不需要干跑**：两者都能从会话日志离线算出（本文件第一节就是这么做的，而且干跑在 append 时刻也压根不知道 `N`）。因此干跑的产出**不是**「能省多少」的总数，而是「摘要本身有多贵、多慢、多不可靠」。

**边界：它绝不改变任何模型可见内容。** 必须同时满足：

- 监听器把 `next()` 的 decision **原样返回**，不替换 `content`、不加 `additionalContexts`。
- **不 append 任何会话事件**——否则会推进 `contentGeneration` 或往日志里落垃圾。
- 摘要调用用**自己的 provider/model route**，独立于主请求；失败只 `ctx.logger.warn`（照 spill-policy 的失败处理，`packages/spill/spill-policy/src/index.ts:128`），**绝不抛**（见第七节第 3 条）。
- 结果写到**会话日志之外**（照 `dsh-navigator` 的「记录不进会话」先例）。原因有二：污染日志；且 `session-log-deepseek` 默认开启会把 `data` 原样上传（`dsh-reasoning-pruner` 的设计已把这条列为硬约束）。

**挂点与一个必须修正的细节：要 `prepend: true`。** 直觉上「只是观察，不需要抢在前面」，但那个直觉是错的：

- `prepend` 走 `unshift`（`vendor/cordis/src/events.ts:255`），所以 prepend 的监听器是**最外层**——它先调 `next()`，拿到**下游全部处理完之后**的 decision。
- spill-policy 自己也是 prepend（`packages/spill/spill-policy/src/index.ts:133`、`:150`），且它在 `await next()` **之后**才把头尾替换写进返回的 decision。
- ⇒ **只有 prepend 才能看到 spill-policy 处理后的最终内容**（读 `decision.content ?? result.content`）。非 prepend 处于它下游，看到的永远是 spill 之前的原始内容，量出来的 `S` 偏大、且看不到 locator。

**量什么**（每条结果一行）：`exec.name`、`callId`、参数摘要、最终 content 的估算 token 数、是否已带 locator、摘要调用的输入/输出 token、**墙钟延迟**、完成时刻。

**必须处理的两个实现细节：**

1. **同一步的兄弟调用是并发的。** 一个 assistant 步里的并行调用走 bounded rolling pool（`packages/core/agent-loop/src/tool-calls.ts:3`）。⇒ 任何跨调用的累加器都要按 session 隔离并考虑并发；最简单且不易错的做法是**每条结果独立成行**，不做共享聚合。
2. **`ctx.spillStore` 的可用性要实测**（见第七节第 4 条）：现有 spill-policy 对低于 `maxInlineTokens: 12500` 的结果不做任何事，所以**小结果目前没有 locator**——干跑若要覆盖它们，必须自己调 `saveText`。

**产出**：一张 per-result 表，外加 `k` 的分位数与延迟的 P50/P90/P99。据此回填第三节的 `k`，并为 10.2 提供依据。

### 10.2 同步还是异步（首版最需要裁决的一条）

摘要调用发生在哪一步，有两个选项，代价方向相反：

| 选项 | 形态 | 收益 | 代价 |
|---|---|---|---|
| **A：post-execute 内同步等** | 摘要完成才落盘，历史从头就是缩减版 | **零缓存代价**（第二节） | 每条结果的延迟都加到这一步上；并行兄弟可并发，但整步要等最慢的那条 |
| **B：异步 + 在 `agent/pre-step` 施加** | 不阻塞当前步；摘要完成后改模型可见内容 | 无阻塞 | 若赶不上下一次请求，**完整版已经作为请求前缀发出并被缓存**；之后替换要付第二节的重算代价（实测掉 21.5pt 命中率） |

**为什么现在不能定。** 取决于小模型延迟相对**步间隔**的相对大小，以及工具结果的大小分布。这是纯实测问题——**不能从本文件的任何数字推出**，所以这里不预设答案。

**哪条证据能定这个。** 10.1 的干跑除了延迟分位数，还应顺带记录一个更贴的判据——**「摘要完成时刻」落在「下一步请求发出时刻」之前的条数占比**，即每个摘要的完成时间与它之后第一条 `assistant/message` 的时间先后关系：

- 该占比接近 1 （例如 P90 的摘要也在下一步请求前完成）⇒ 选 **B**：无阻塞、且实际仍是零缓存代价。
- 该占比明显低于 1 ⇒ 选 **A**，或接受「一部分结果付重算代价」，用第二节的算式定价后再决定。

**第三种可能（记下以免二元化）。** 同步只等一个**很短的预算**（例如 200ms），超时就保留原文、摘要转后台且不再施加。它把「慢」的代价限制在固定的短预算内，同时保住大部分「快」的收益。代价是同一结果会有两种结局（缩/不缩），实现与验收都要覆盖两条路径。**不作为首版默认**；等 10.2 的实测出来后再评估是否值得这份复杂度。

## 相关文档

- `.agents/notes/archived/bug-fix/2026-08-19-deepseek-reasoning-passback-every-turn.zh.md` —— 推理回传的取舍；本文件的「时机」论证与它同源（都在算「改历史 vs 不改历史」的缓存账）。
- `.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md` —— spill seam 与策略的取舍，含 `read` 豁免的由来。
- `.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.md` —— 工具 `output` 声明（`render` / `presentationMeta`）的形状先例。
- 本仓 `docs/dsh-reasoning-pruner-design.md` —— 同源的插件（推理块），可复用的机制结论：`tools/post-execute` 之外它选投影的理由、缓存账的算法、以及「计量器不读投影」这条事实。
