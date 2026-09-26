# dsh-reasoning-pruner 设计

状态：机制已逐条核实，**实现未开始**。闸门 A（端点接受度）与闸门 B（缓存净收益）见[实施规格](../.scratch/historical-reasoning-pruning/spec.md)，两者均未关闭；文中标注「待闸门背书」的默认值在闸门关闭前不得写死。

本文件引用的 DSH 扩展点按 **`0.1.7-rc.2`** 逐条核实，路径为 DSH 仓内相对路径。未来版本**乐观地先视为兼容**：升级后按下文「验证状态」的核对清单重跑一遍，而不是预先写防御分支或版本判断——不存在一条按版本号判断的机制，那种写法既无代码支撑也无法验收。

本文件记录**取舍与机制**：为什么这样定、挂哪个钩子、事件字段形状、源码依据与待实测项。**需求陈述与验收标准在[实施规格](../.scratch/historical-reasoning-pruning/spec.md)里**，规格只写操作性定义、可观察判据与交付约束，不复制本文件的机制描述。判断一句话该放哪边：**删掉它之后，有没有验收标准变得无法判断**——会，属于规格；不会，属于本文件。两者冲突时：需求以规格为准，取舍与机制以本文件为准。

## 范围与约束

- 只开发插件，不修改 deepseek-harness 源码。所有接缝都是已有扩展点：`agent/pre-step` 与 `agent/request-error`（waterfall，可 `prepend`）、`ctx.sessions.registerMessageProjection`、`ctx.settings` / `ctx.configForms`（手动入口的界面）。
- 服务依赖交给原生 `inject`：Cordis 在依赖就绪前不会激活插件（`vendor/cordis/src/fiber.ts:611-623` 把缺依赖的插件置为 INACTIVE），所以在 `apply` 里查服务是否存在是死代码。缺服务的表现是「插件不激活」，由 DSH 启动审计报告。
- 包名：插件是 `dsh-reasoning-pruner`（功能命名，同 `dsh-navigator` 的先例）；`dsh-smarter-context` 只是**未来**的容器名，当前不建、不为它预留任何结构。

## 已决定的设计选择

### 裁剪的表达：message projection，不是 surface replace

表面上唯一能改历史节点的机制是 `surfaceOp: { op: 'replace', … }`，但它**用不了**，证据是两条互斥的规则：

- replace 要求 `sourceEventSeqs` 覆盖每一个被遮蔽的表面节点，缺一个就抛 `surface replace: sourceEventSeqs must include every shadowed surface node`（`packages/core/session/src/surface.ts:367-370`）。
- `assistant/message` **被禁止**携带 `sourceEventSeqs`：`throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')`（`packages/core/session/src/surface.ts:341-343`；类型层同样把它写成 `sourceEventSeqs?: never`，`packages/core/session/src/types.ts:470-478`）。

⇒ **assistant 消息不可被 replace 遮蔽。** 这不是可以绕过的校验：replace 的引用规则与 assistant 的自带流语义互斥。

同一份代码给了插件专用的第二条路，而且是为这件事设计的：

- `SessionMessageProjection`（`packages/core/session/src/surface.ts:35-46`）+ `SurfacePlan` 的 `project` 分支（`:277-280`）。planner **先查投影**（`:529-534`）再处理 surfaceOp（`:538` 起）：投影命中就直接返回，不经过 replace 的三条断言。
- 投影把**投影后的消息**挂到既有的表面节点上（`:265` `projectedMessages`，`:576-578` 只加 `contentGeneration`），不新增节点、不遮蔽节点。
- agent loop 正是按 `contentGeneration` 判断请求快照失效（`packages/core/agent-loop/src/agent.ts:396` 比较 `requestSurfaceGeneration !== session.surface.contentGeneration`），所以投影落地后下一次请求会看到裁剪版消息。
- 出厂先例（同一个形状，可直接照抄）：`compaction-image-offload` —— 自有事件类型 + `@messageProjection` + `registerMessageProjection`，见 `packages/compaction/compaction-image-offload/src/projection.ts:23,40`、`src/index.ts:26`、`src/image-offload.ts:44`。

**这不是退而求其次。** 投影只改模型可见内容，记录（推理全文与签名）原样留在日志里，正好是规格闸门 C 要的形状；replace 反而会把记录也遮蔽掉。

### 一条必须先记住的区分：`replaceGeneration` ≠ `contentGeneration`

- `replaceGeneration`：只数 `replace`（`surface.ts:254-255`、`:578`）。
- `contentGeneration`：数 `replace` **与**插件投影变更（`surface.ts:256-257`、`:578`、`:582`）。

DSH 里凡是「历史是否被改动过」的判据都要分清用的是哪一个。已核实的消费者：agent loop 的请求快照用 `contentGeneration`（`agent.ts:396`）；compaction-basic 的溢出重试凭证用 `replaceGeneration`（`packages/compaction/compaction-basic/src/index.ts:202,230`）。**这一区分直接决定了激活点 ① 的强度**，见下。

### 耐久记录的形状

- 自有事件类型 `reasoning-prune/applied`，在 `SessionEventMap` 上以 `@messageProjection` 声明，数据形状照 `image/offload` 的 `targets` 数组（每个 target 至少含 `seq`）：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 让指定历史回合的推理块自此次记录起不再进入模型可见历史。
     * 目标是当前表面节点；记录本身不变。
     * @messageProjection
     */
    'reasoning-prune/applied': { targets: { seq: SessionSeq }[] }
  }
}
```

- `project()` 在折叠期把每个 target seq 的消息换成「移除推理块」的副本。校验全放在 `project()` 里，照 `image-offload` 的做法：data 形状、target 必须是**当前表面节点**（`context.nodes`）、重复 seq 抛错、目标事件类型受限。投影必须是纯函数：它会在运行期增量折叠与重载全量折叠两条路径上被调用，两侧结果必须一致。
- 追加时不带 `surfaceOp`（非表面事件），但要带 `ignorable: true`——原因见下。

### `ignorable: true`：一个必须显式记录的限制

- 外部插件的事件类型**永远不在** `KNOWN_SESSION_EVENT_TYPES` 里：该集合由 `scripts/gen-persistence-catalog.ts` 从本仓源码生成，其文件头注释明说 out-of-repo 事件「by construction」不在其中（`packages/core/session/src/known-event-types.ts:1-21`）。
- 持久化 seam 对未知事件**只在** envelope 显式带 `ignorable: true` 时才接受（`packages/core/session/src/surface.ts:311-312`；`packages/session/session-log-deepseek/src/index.ts:102`）；absent 即 required-on-read，会拒绝整段会话。
- 上游有明确决策记录：`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。它保留该字段**正是**为了外部插件，并明确否决了两条替代方案——「把仓外事件一律当 ignorable」（理由：读者无法推断未知耐久事件是信息性的）与「注册挂载插件的事件名」（理由：事件名注册不分类「省略是否安全」）。
- **张力，必须写清楚**：本事件不是纯信息性的——它改变模型可见重建，而那正是它存在的理由；而字段契约写的是 `ignorable` 表示「loss cannot affect reconstruction」（`packages/core/session/src/types.ts:501-511`）。我们是在**用一个为信息性记录设计的机制换取可重载性**，代价是未装载本插件的读者会跳过它、重建出**未裁剪**版历史。
- 降级方向是安全的：推理全文仍在日志里，不会产生损坏的会话，也不会出现「两端都不报错却内容分叉」——最坏情况只是白花 token。所以判据（规格闸门 C）写成：有插件时重载与运行期一致；无插件时**不得拒绝整个会话**，只能得到未裁剪版。
- 这是**需要向上游提的**一条：按那份 note 的措辞，替代机制尚不存在，而本插件是第一个真正需要「仓外、改变重建、但必须可重载」的外部事件生产者。

### 回合资格：按每条 assistant 消息读它自己的传输

- 传输写在耐久的 replay 信封里，随 `assistant/message` 落盘：`{ response: { kind: 'pi-ai', version: 2, api, provider, model, … }, blocks }`（`packages/llm/llm-pi-ai/src/replay.ts:20-30,77-89`；落盘链 `packages/llm/llm-pi-ai/src/stream.ts:213` → `packages/core/agent-loop/src/agent.ts:442,500` → `packages/llm/llm/src/message.ts:20`）。
- Messages 适配器的信封是 `{ response: { kind: 'deepseek-messages', version: 1, model }, blocks }`，**没有 `api`**（`packages/llm/llm-deepseek/src/replay.ts:29-31`）。
- 因此资格判定 = 「信封是 pi-ai 且 `response.api === 'openai-completions'`」，**逐回合**。这是唯一能拿到「这一轮由哪个传输产生」的地方：`resolveModelInfo` 把 api 丢掉了（`packages/llm/llm-pi-ai/src/adapter.ts:300-315`），`requestHeader()`/`requestContext()` 也没有它。
- 注意措辞：本仓的传输字面量是 `'openai-completions'`，不是 `chat-completions`。

### 裁剪操作本身：移除块，不是把文本置空

- DSH 侧的块类型是 `{ type: 'reasoning', text }`（`packages/llm/llm/src/types.ts:67-71`）。
- pi-ai 组装历史轮时先过滤：`thinkingBlocks.filter(block => block.thinking.trim().length > 0)`（pi-ai 的 `dist/api/openai-completions.js:979`），再由**存活的**块的 `thinkingSignature` 决定写哪个线上字段（`:998-1005`）。
- 因此**把文本置空**仍有签名存活，会走 `preservedReasoningDetails` 分支把 `reasoning_details` 原 blob 照送（`:1041-1042`）——线上零节省，而本地计量会报出节省。空格更差：`trim()` 让它与空串完全等价。
- 结论：裁剪 = **移除块**。移除后字段由 pi-ai 的 compat 补丁补 `""`（`:1044-1047`，`requiresReasoningContentOnAssistantMessages: isDeepSeek` 在 `:1286`）；不满足该条件时字段干脆缺席，即规格闸门 A 的 C 变体。

### 激活点 ①：溢出救援

- 挂 `ctx.on('agent/request-error', h, { prepend: true })`。`prepend` 走 `unshift`（`vendor/cordis/src/events.ts:255`），所以我们排在 compaction-basic 的监听器之前（它注册于 `packages/compaction/compaction-basic/src/index.ts:190`），裁剪因此在**选区之前**落盘。这里不需要任何阈值策略——失败本身就是触发器。
- 那次请求已经失败，重试本来就是无缓存的全价请求，所以表面内容变更**不额外付缓存代价**。
- **但它自己不会触发重试。** compaction-basic 的重试凭证是 `replaceGeneration`（`index.ts:202` 取基线、`:212-219` 与 `:229-233` 判进展），而投影只推进 `contentGeneration`。所以：
  - 通行做法是**搭它的车**：若 compaction-basic 自己决定重试（tool-result pruner 落了 replace，或摘要成功提交），我们的裁剪已经先落盘，重试请求就带着裁剪版历史，这可能正是让重试成功的原因。这条路径**可行且够用**。
  - 若它不重试（`selectCompactableRange` 返回 `null` 且 tool-result pruner 没落任何 replace，或摘要在我们的裁剪之后失败），请求仍然失败——我们的裁剪只对**后续**回合生效。
- **可选加强（需裁决）**：我们自己「拥有恢复」并返回 `{kind: 'retry'}`。契约明确允许这么做——`RequestErrorAction = { kind: 'retry' } | undefined`，文档写着「listener 拥有恢复时返回 `{kind:'retry'}`，或调 `next()` 委托」（`packages/core/agent/src/runtime-types.ts:121-122,341-353`）。因为我们是最外层，可以 `const action = await next()`，在拿到非 retry 结果而本次确有裁剪落盘时改返回 `{kind:'retry'}`。**代价**：必须自带一个有界计数（照 compaction-basic 的 `overflowRetries` 形状，含 `agent/status → idle` 重置），否则会在裁剪救不回来的请求上无限重试。首版建议**先不做**，等闸门 B-2 的实测说明「搭车」够不够。

### 激活点 ②：批量推进

- 挂 `ctx.on('agent/pre-step', h, { prepend: true })`。同样 `prepend`：裁剪必须在 compaction-basic 自己测量/选区之前落盘，否则被裁的区间可能已经被摘要遮蔽。
- 与 ① 不同类：它不是补救，而是让裁剪**存活到后续每个请求**；代价是每次推进边界要按全价重算一次边界尾，靠步数间隔 `M` 摊薄。`M` 与保留窗口 `K` 的默认值**待闸门 B 背书**。
- **不能用 `ctx.tokenMeter.measure` 判压**。计量器按**原始表面事件**定价，不读投影：`measure()` 走 `priceSurface(state.surface, …)`（`packages/llm/token-meter/src/index.ts:146-157`），而 `token-meter/src/**` 全仓不引用 `messageProjections`/`projectedMessages`；同一个包的 `surface-projection.ts:1-10` 说明 replace 走的是一套 shadow-price 协议，与本插件无关。所以 ② 的节奏只能由自己的步数计数决定。
- 连带的事实（必须记录，因为是可观察的差异）：**裁剪不会降低 `tokenMeter.measure` 的读数**。`deriveMessages()` 会应用投影（请求确实变小），但计量器与压缩压力读数不会随之下降。表现是「省了钱，界面上的上下文占比不动」。这不是缺陷而是机制事实，规格不为其设判据，但实现时不要在文档里把它说成「降低上下文占用」。

### 激活点 ④：手动入口与主界面开关

- 入口是一个插件自有命令（如 `/prune-reasoning`），**不劫持 `/compact`**：命令表按名字插入，重名直接抛（`packages/core/scope/src/store.ts:43-46`），且劫持会把内建命令的文案与错误映射复制一份。
- 主界面开关需要一个**双面包**（这是本设计里唯一的额外交付物）：
  - host 半：`Config` 里的布尔字段，命名空间即 patch 行的 `id`，字段必须标 `.volatile()`（settings 的写入路径拒绝非 volatile 路径）。
  - 浏览器半：`dsh.client { platform: 'web' }` + `exports["./client"]` 产物，把开关注册为 `settings.general.item` 这一行（契约 `packages/client/ui-settings/src/client/contract/slots.ts:92`：**单个偏好**的 additive seat，文案、当前值、写入路径都归注册者），经 `ctx.configForms` 写回命名空间。
  - **没有**「声明 Config 就自动长出 UI」的通路：`autoGenerate` 在客户端零消费者，出厂的插件清单页是只读的。所以浏览器半是必需的，不是优化。
- **置灰按保守闸门**：判不准就不给。可用的现成事实只有两个——`ctx.remote.llm.listConfigurableProviders()` 给出的 `settingsNs`（`llm-deepseek` 确定是 Messages，可确定置灰）与显式 route 级 `api`（`packages/llm/llm-pi-ai/src/config.ts:329`，读得到的就是确定的）。从 catalog 继承协议的 pi-ai 路由**判不准**，保守闸门把它当未知置灰，代价是可能误伤一条本可受益的路由；它会在该路由跑过一个回合后用 replay 信封自愈。
- 服务端另有硬强制作：裁剪只作用于**回合资格成立**的回合（逐回合读 replay 信封），资格不成立的回合原样保留。界面的置灰只是提前告知，不是安全保证。

## 被排除的替代方案

- **用 surface replace 改 assistant 消息**：机制上不可能（见上，两条规则互斥）。这一条同时解释了为什么 DSH 要给「插件自有消息变更」单开一条 `contentGeneration` 计数。
- **搭 tool-result pruner 的车**（在它的 `compaction/prune` 事件上同步裁剪）：`session/event` 观察者是在 append **内部**被调用的，此时 `entry.appending === true`，任何 `session.append` 直接抛 `session append cannot reenter while another append is being published`（`packages/core/session/src/index.ts:742`，观察者调用点 `:764`）。所以搭车只能改成「我们自己的监听器被 prepend 到它之前」，那又回到需要自己判断压力资格。
- **压力位（激活点③）**：出树没有接缝。compaction-basic 按硬编码服务名取 pruner（`compaction-basic/src/index.ts:289-298,323-326`），压力资格判断依赖未导出的私有策略（`src/config.ts:153-198` 的 `resolveCompactSpec` 与 modelPolicies 合并）。且即便挂上，被裁区间通常会被摘要整段遮蔽，净收益可负。
- **手动 `/compact` 时排除推理**：摘要前唯一的 waterfall 是失败恢复用的 `compaction/summary-error`（`packages/compaction/compaction/src/index.ts:104`），没有前置接缝；`compactNow` 全程不调用 pruner（`compaction-basic/src/index.ts:383-435`）。无接缝的等价做法是先跑 ④ 再 `/compact`。
- **把推理文本置空 / 置为空格**：见「裁剪操作本身」。
- **按传输分别发送**：DSH 是「一份日志、一次派生」，不存在请求级改写，规格「已决定不做」已有记录。

## 验证状态

**已由源码核实**（本次，`0.1.7-rc.2`）：上文所有带 `path:line` 的机制断言；`compaction-image-offload` 的投影形状可直接照抄；`registerMessageProjection` 重复注册同类型会抛（`packages/core/session/src/index.ts:942-947`）。

**只有源码依据、需要运行时确认**（实现时按此顺序验，验不过就停下改设计）：

1. **未装载插件的读者重载带 `reasoning-prune/applied` 的会话**：应当接受并跳过（`ignorable: true`），重建出未裁剪历史，**不得拒绝整段会话**。这是 `ignorable` 这条路的关键假设，也是最该先写用例的一条。
2. **投影在两条折叠路径上一致**：运行期增量折叠与重载全量折叠得到同一个裁剪版历史（`foldSurface` 的 `project` 分支与 `SurfaceManager` 的增量路径）。
3. **`contentGeneration` 确实是请求快照失效的信号**：投影落地后，下一步请求包含裁剪版消息（`agent.ts:396` 的比较）。
4. **`ignorable` 事件的 data 在 JSONL / deepseek-log 往返后仍完整**：投影在重载后仍能读到自己的 targets（`packages/session/session-log-deepseek/src/index.ts:79-110` 的 `common` 保留 `data`，但这条要端到端验）。
5. **闸门 A、闸门 B**：见规格，尚未开始。闸门 A 的探针已就绪（`.scratch/probes/reasoning-content-empty-acceptance.mjs`，含 usage 读数）。

**未验证、明确不断言**：`token-meter` 之外是否还有别的读投影的计量面（如上下文占比 UI 的取数路径）——本次只核实了 `measure()` 不读投影，没有追 UI 侧的取数；`ignorable` 在**历史格式迁移**边界上更严（那份 note 的「Consequences」段提到 v0→v1 拒绝一切未知类型），本插件只承诺 equal-version append/reload，跨格式迁移不在首版范围。

## 待办与上游诉求

- **上游诉求（一条）**：为「仓外、改变模型可见重建、且必须可重载」的插件事件提供一个不依赖 `ignorable` 的机制。本插件是这类生产者的第一个实例，证据是 `@messageProjection` + `ignorable` 的组合。
- 包名与目录：`packages/dsh-reasoning-pruner/`，`dsh-smarter-context` 只作为未来的容器名保留。
- ② 的 `M`/`K` 默认值、① 是否自持重试：均由闸门 B 的实测结果决定。
