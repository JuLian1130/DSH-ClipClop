# dsh-reasoning-pruner 设计

状态：机制已逐条核实，**实现未开始**，且**存在一处未解的机制阻塞**（运行期耐久写入路径，见「阻塞」一节）。四张闸门见[实施规格](../.scratch/historical-reasoning-pruning/spec.md)：A（端点接受度，实现前必须关闭）、B（缓存净收益）、C（回放与不变式）、D（任务质量不下降），后三张是实现后的判据。文中标注「待闸门背书」的默认值在闸门关闭前不得写死。

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
     * 让指定历史步骤的推理块自此次记录起不再进入模型可见历史。
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

### **阻塞：运行期写不出 `ignorable`，而种子路径只在构造期生效**

上一条的前提是「我们能在**运行期**写出带 `ignorable: true` 的事件」。**这条前提在当前版本不成立**，必须先解决，否则整条耐久路线不成立。证据：

- `Session.append` 的第三个参数类型只有 `SurfaceIntent`（`surfaceOp`/`sourceEventSeqs`），**没有任何 envelope 通道**；它构造事件时硬编码 `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`——**没有 `ignorable` 字段**（`packages/core/session/src/index.ts:722-726` 签名、`:745-751` 构造）。
- 写入路径**不校验**事件类型：`persistBatch` 直接 `appendLines`，而 `appendLines` 只做编码与落盘（`packages/session/session-persistence-jsonl/src/index.ts:856-868`、`:1324-1348`）。所以 append 会**成功**，问题被推迟到下次打开。
- 读取路径**校验并拒绝**：`validateStoredEvents` 对未知类型且 `ignorable !== true` 直接抛 `SessionFormatUnsupportedError`（`packages/session/session-persistence/src/storage-contract.ts:69-80`）。调用点是读路径（`session-persistence-jsonl/src/index.ts:675`、`:807`、`generation.ts:528`）。
- ⇒ **失败形态是最坏的组合：写入静默成功，重载时整段会话被拒绝。** 这正是本仓 ADR 0002（`docs/adr/0002-review-records-outside-session-log.md`）记录过的同一个坑——dsh-navigator 当时因此把复核记录搬到会话日志之外。

**种子路径确实存在，但它救不了本设计**（这一点经独立复核、且已实测：真正的两进程往返能把一个带 `ignorable: true` 的自有事件种进去并重载成功）：

- `CreateSessionOptions.seed` / `CreateAgentOptions.seed` **接受**手写 envelope，`assertSessionEventEnvelope` 的键白名单含 `ignorable` 且接受 `ignorable === true`（`packages/core/session/src/index.ts:218`、`:231`）；未知的 ignorable 记录在表面折叠里被放行（`packages/core/session/src/surface.ts:312`），再被按类型字串命中的投影消费（`:529-534`）。
- **但它只在构造/恢复时生效。** 全仓只有两处写入 `log`：种子循环（`index.ts:587`）与 `append`（`:761`）；前者是构造期，运行期唯一的写入点就是 `append`——而它写不出 `ignorable`。`resume` 走的也是「冷读既存日志 + 作为 seed 重建」（`agent-loop/src/index.ts:858`），不是运行期追加。
- 本插件的裁剪是**运行期中途的决策**（挂在 `agent/pre-step` / `agent/request-error` 上），不可能等到下一次构造会话才落地。所以种子路径是一条**真实但用不上**的能力：它适合「构造时就已知道全部决策」的场景，不适合本插件。
- 因此**上一条「存在读取约定、不存在公开写入路径」的措辞需要收窄**：准确说法是「**运行期**没有写入 `ignorable` 的公开路径；构造期（seed）有」。

**其余候选路径的核实结果**：

- `KNOWN_SESSION_EVENT_TYPES` 是运行时**未冻结**的普通 `Set`（`known-event-types.ts:22`，无 `Object.freeze`），也经 `@deepseek-ai/dsh-session` 导出（`index.ts:36`）。同进程 `add` 确实能让 `validateStoredEvents` 从拒绝转为接受——**但重载是另一个进程**，生成集合不含它。**不作为耐久方案**；不过它是一个真实的同进程完整性缺口，值得单独记一笔。
- `registerMessageProjection` 只按**类型**去重（`index.ts:943-945`），对「注册在哪个类型上」**没有约束**——实测可为 `user/message`（表面类型）与 `session/title`（log-only 类型）注册而不报错。所以「借用已知类型」这条路是**可用的**，但需要一次类型普查：追加某个类型的额外事件会进入该类型自己的读取者（`sessionStats` 数 `step/*`、重试投影折叠 `llm/retry`、`goal/change`/`todo/write`/`hook/*` 同理），选错会让别人的读数错乱。

**结论**：耐久记录在当前版本只有两条真正可行的路——**复用已知事件类型 + 自有投影**（需类型普查），或**请上游加运行期写入通道**。四条候选路径的代价见「待办与上游诉求」。**这条阻塞解除前，规格不得标 `ready-for-agent`。**

**连带更正 ADR 0002 的前提**：那条 ADR 写「`Session.append` 无法写入 `ignorable`，于是整段日志被拒绝」——**对 `append` 正确，但它漏了 `seed`**。如果将来要重估复核记录的存放位置，应以「运行期 vs 构造期」这个区分重述，而不是笼统地说「无法写入」。

### 裁剪资格：按每条 assistant 消息读它自己的传输

- 传输写在耐久的 replay 信封里，随 `assistant/message` 落盘：`{ response: { kind: 'pi-ai', version: 2, api, provider, model, … }, blocks }`（`packages/llm/llm-pi-ai/src/replay.ts:20-30,77-89`；落盘链 `packages/llm/llm-pi-ai/src/stream.ts:213` → `packages/core/agent-loop/src/agent.ts:442,500` → `packages/llm/llm/src/message.ts:20`）。
- Messages 适配器的信封是 `{ response: { kind: 'deepseek-messages', version: 1, model }, blocks }`，**没有 `api`**（`packages/llm/llm-deepseek/src/replay.ts:29-31`）。
- 因此资格判定 = 「信封是 pi-ai 且 `response.api === 'openai-completions'`」，**逐步骤**。这是唯一能拿到「这一步由哪个传输产生」的地方：`resolveModelInfo` 把 api 丢掉了（`packages/llm/llm-pi-ai/src/adapter.ts:300-315`），`requestHeader()`/`requestContext()` 也没有它。
- 注意措辞：本仓的传输字面量是 `'openai-completions'`，不是 `chat-completions`。

### 裁剪操作本身：移除块，不是把文本置空

- DSH 侧的块类型是 `{ type: 'reasoning', text }`（`packages/llm/llm/src/types.ts:67-71`）。
- pi-ai 组装历史 assistant 消息时先过滤：`thinkingBlocks.filter(block => block.thinking.trim().length > 0)`（pi-ai 的 `dist/api/openai-completions.js:979`），再由**存活的**块的 `thinkingSignature` 决定写哪个线上字段（`:998-1005`）。
- 因此**把文本置空**仍有签名存活，会走 `preservedReasoningDetails` 分支把 `reasoning_details` 原 blob 照送（`:1041-1042`）——线上零节省，而本地计量会报出节省。空格更差：`trim()` 让它与空串完全等价。
- 结论：裁剪 = **移除块**。移除后字段由 pi-ai 的 compat 补丁补 `""`（`:1044-1047`，`requiresReasoningContentOnAssistantMessages: isDeepSeek` 在 `:1286`）；不满足该条件时字段干脆缺席，即规格闸门 A 的 C 变体。

### **必须与 replay 信封同步**（本设计最容易踩的坑）

只移除内容里的推理块**不够**，它会撞上一条静默的降级路径。两个适配器都校验「耐久 replay 信封」与「消息内容」**逐位对齐**：

- pi-ai：`if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')`，随后逐位要求 `replay.type === block.type`（`packages/llm/llm-pi-ai/src/replay.ts:190-192`）。
- DeepSeek Messages：`if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return fail('block count mismatch')`（`packages/llm/llm-deepseek/src/replay.ts:55`）。

不对齐时抛的是 `INVALID_REPLAY_STATE`，而**两端都把它吞掉**：pi-ai 的 `toPiAssistant` 捕获后调 `onDegrade` 再返回 `foreignAssistant(message)`（`packages/llm/llm-pi-ai/src/replay.ts:249-260`），Messages 侧同理返回 `undefined` 信封（`llm-deepseek/src/replay.ts:39-45`）。后果是**整条消息**（连同一个不该丢的文本签名与工具调用签名）跌落到 provider-neutral 重建：不报错、不失败、只是丢掉签名。`onReplayDegrade` 是**可选配置**，出厂没有任何 bundle 配它（`packages/llm/llm-pi-ai/src/adapter.ts:98-104,366-367`），所以默认完全静默。

**因此裁剪的定义必须包含信封**：内容块数组与信封块数组**同步过滤、保持逐位对齐**。`readReplayState` 对每个块的要求很宽（类型属于 text/reasoning/tool-call，签名是字符串，`redacted` 是布尔；`replay.ts:135-144`），所以「同步删掉对应条目」既合法也足够——存活的文本与工具调用块保留各自签名，这正是我们要的。

**这条同时决定了验证方式**：闸门 C 必须**显式构造反例**（只改内容不改信封），断言它触发退化；否则这个坑在实现时看不出来。可用 `onReplayDegrade` 作为断言钩子（它在适配器 config 上，测试夹具可配）。

### 激活点 ①：溢出救援

- 挂 `ctx.on('agent/request-error', h, { prepend: true })`。`prepend` 走 `unshift`（`vendor/cordis/src/events.ts:255`），所以我们排在 compaction-basic 的监听器之前（它注册于 `packages/compaction/compaction-basic/src/index.ts:190`），裁剪因此在**选区之前**落盘。这里不需要任何阈值策略——失败本身就是触发器。
- 那次请求已经失败，重试本来就是无缓存的全价请求，所以表面内容变更**不额外付缓存代价**。
- **但它自己不会触发重试。** compaction-basic 的重试凭证是 `replaceGeneration`（`index.ts:202` 取基线、`:212-219` 与 `:229-233` 判进展），而投影只推进 `contentGeneration`。所以：
  - 通行做法是**搭它的车**：若 compaction-basic 自己决定重试（tool-result pruner 落了 replace，或摘要成功提交），我们的裁剪已经先落盘，重试请求就带着裁剪版历史，这可能正是让重试成功的原因。这条路径**可行且够用**。
  - 若它不重试（`selectCompactableRange` 返回 `null` 且 tool-result pruner 没落任何 replace，或摘要在我们的裁剪之后失败），请求仍然失败——我们的裁剪只对**后续**步骤生效。
- **可选加强（需裁决）**：我们自己「拥有恢复」并返回 `{kind: 'retry'}`。契约明确允许这么做——`RequestErrorAction = { kind: 'retry' } | undefined`，文档写着「listener 拥有恢复时返回 `{kind:'retry'}`，或调 `next()` 委托」（`packages/core/agent/src/runtime-types.ts:121-122,341-353`）。因为我们是最外层，可以 `const action = await next()`，在拿到非 retry 结果而本次确有裁剪落盘时改返回 `{kind:'retry'}`。**代价**：必须自带一个有界计数（照 compaction-basic 的 `overflowRetries` 形状，含 `agent/status → idle` 重置），否则会在裁剪救不回来的请求上无限重试。首版建议**先不做**，等闸门 B-2 的实测说明「搭车」够不够。

### 激活点 ②：批量推进

- 挂 `ctx.on('agent/pre-step', h, { prepend: true })`。同样 `prepend`：裁剪必须在 compaction-basic 自己测量/选区之前落盘，否则被裁的区间可能已经被摘要遮蔽。
- 与 ① 不同类：它不是补救，而是让裁剪**存活到后续每个请求**；代价是每次推进边界要按全价重算一次边界尾，靠步数间隔 `M` 摊薄。`M` 由闸门 B 背书（成本），保留窗口 `K` 由闸门 D 背书（质量）；两者在实测前取保守默认。
- **不能用 `ctx.tokenMeter.measure` 判压**。计量器按**原始表面事件**定价，不读投影：`measure()` 走 `priceSurface(state.surface, …)`（`packages/llm/token-meter/src/index.ts:146-157`），而 `token-meter/src/**` 全仓不引用 `messageProjections`/`projectedMessages`；同一个包的 `surface-projection.ts:1-10` 说明 replace 走的是一套 shadow-price 协议，与本插件无关。所以 ② 的节奏只能由自己的步数计数决定。
- 连带的事实（必须记录，因为是可观察的差异）：**裁剪不会降低 `tokenMeter.measure` 的读数**。`deriveMessages()` 会应用投影（请求确实变小），但计量器与压缩压力读数不会随之下降。表现是「省了钱，界面上的上下文占比不动」。这不是缺陷而是机制事实，规格不为其设判据，但实现时不要在文档里把它说成「降低上下文占用」。

### 激活点 ④：手动入口与主界面开关

- 入口是一个插件自有命令（如 `/prune-reasoning`），**不劫持 `/compact`**：命令表按名字插入，重名直接抛（`packages/core/scope/src/store.ts:43-46`），且劫持会把内建命令的文案与错误映射复制一份。
- 主界面开关需要一个**双面包**（这是本设计里唯一的额外交付物）：
  - host 半：`Config` 里的布尔字段，命名空间即 patch 行的 `id`，字段必须标 `.volatile()`（settings 的写入路径拒绝非 volatile 路径）。
  - 浏览器半：`dsh.client { platform: 'web' }` + `exports["./client"]` 产物，把开关注册为 `settings.general.item` 这一行（契约 `packages/client/ui-settings/src/client/contract/slots.ts:92`：**单个偏好**的 additive seat，文案、当前值、写入路径都归注册者），经 `ctx.configForms` 写回命名空间。
  - **没有**「声明 Config 就自动长出 UI」的通路：`autoGenerate` 在客户端零消费者，出厂的插件清单页是只读的。所以浏览器半是必需的，不是优化。
- **置灰按保守闸门**：判不准就不给。可用的现成事实只有两个——`ctx.remote.llm.listConfigurableProviders()` 给出的 `settingsNs`（`llm-deepseek` 确定是 Messages，可确定置灰）与显式 route 级 `api`（`packages/llm/llm-pi-ai/src/config.ts:329`，读得到的就是确定的）。从 catalog 继承协议的 pi-ai 路由**判不准**，保守闸门把它当未知置灰，代价是可能误伤一条本可受益的路由；它会在该路由跑过一个步骤后用 replay 信封自愈。
- 服务端另有硬强制作：裁剪只作用于**裁剪资格成立**的历史步骤（逐步骤读 replay 信封），资格不成立的步骤原样保留。界面的置灰只是提前告知，不是安全保证。

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

1. **耐久写入路径**（当前阻塞，见上节）：先确定用哪条路径，再验它。若走「复用已知事件类型」，必须验该类型的既有不变式与消费者不被打扰；若走上游改动，先改后验。
2. **重载不退化**：裁剪后重载，被裁消息仍是裁剪版；且**未装载插件**的读者不得拒绝整段会话。**已实测的参考读数**：构造期种入一个带 `ignorable: true` 的自有事件，在两进程间往返后投影仍生效、模型可见历史被改写、且插件缺席的冷读不拒绝（`validateStoredEvents` 跳过未知但 ignorable 的行，`storage-contract.ts:75`）。这条证明了「未知但 ignorable 的事件 + 自有投影」这条链**本身**是通的——缺的只是运行期写入点。
3. **replay 信封不退化的反例**：只改内容不改信封必须触发 `onReplayDegrade`（用它作断言钩子）；同步过滤后必须不触发，且存活块签名保留。
4. **投影在两条折叠路径上一致**：运行期增量折叠与重载全量折叠得到逐字节相同的模型可见历史。
5. **`contentGeneration` 确实是请求快照失效的信号**：投影落地后，下一步请求包含裁剪版消息（`agent.ts:396` 的比较）。
6. **`ignorable` 事件的 data 在 JSONL / deepseek-log 往返后仍完整**（若最终走该路径）：`packages/session/session-log-deepseek/src/index.ts:79-110` 的 `common` 保留 `data`，但这条要端到端验。
7. **闸门 A、闸门 B、闸门 D**：见规格，尚未开始。闸门 A 的探针已就绪（`.scratch/probes/reasoning-content-empty-acceptance.mjs`，含 usage 读数）。

**未验证、明确不断言**：

- `token-meter` 之外是否还有别的读投影的计量面（如上下文占比 UI 的取数路径）——本次只核实了 `measure()` 不读投影，没有追 UI 侧的取数。
- **跨格式迁移**不在首版范围：`ignorable` 在历史格式迁移边界上更严（那份 note 的「Consequences」段提到 v0→v1 拒绝一切未知类型），本插件只承诺 equal-version append/reload。
- **`project` 计划不推进表面节点**：`applySurfacePlan` 的 `project` 分支只写 `projectedMessages` 与 `contentGeneration`，**不 push 表面节点**（`packages/core/session/src/surface.ts:573-583`）。因此「把投影注册到 `assistant/message` 上、用纯规则裁剪」这条路**不可行**——它会让该类型的事件整体不进表面。此结论由源码推出，未运行验证。

## 待办与上游诉求

### 阻塞的候选路径（**未裁决**，这是当前唯一的前沿）

1. **复用已知事件类型 + 自有 message projection。** 机制上可行：`registerMessageProjection` 只按**类型**去重，而 `planSurfaceEvent` 先按 `projections.find(item => item.type === event.type)` 命中投影（`packages/core/session/src/surface.ts:529-534`），因此插件可以为**任意已知类型**注册投影并追加该类型，不限于 `MESSAGE_PROJECTION_EVENT_TYPES`（那个集合只服务「必须提供解释器」的报错）。
   - 代价：**必须挑一个不会被既有消费者误解的类型**。追加某个类型的额外事件会进入该类型自己的读取者——`step/start`/`step/end` 被 `sessionStats` 计数、`llm/retry` 被重试投影折叠、`goal/change`/`todo/write`/`hook/*` 同理。选错会让别人的读数错乱。
   - 需要一次专门的类型普查才能定，**本文档不预先指定**。
2. **请求上游增加写入通道**（`Session.append` 可选 envelope，或运行期注册事件类型的正式机制）。最干净，但依赖外部改动，且那份 note 明确说「事件名注册」已被否决过——要提就得连带说明为什么本场景不同于被否决的那条理由（我们的事件**改变**重建，不是信息性的）。
3. **种子路径（构造期种入带 `ignorable` 的自有事件）** —— **真实存在，但本设计用不上**。独立复核已两进程实测通过（种入 `ignorable: true` 的自有事件 → 重载后投影仍生效、模型可见历史被改写；插件缺席的冷读也不拒绝）。限制是它**只在构造/恢复时生效**，而裁剪是运行期中途的决策。**列在这里是为了防止后人重新发现它时误以为本设计漏看了。**
4. **耐久记录移到会话日志之外**（ADR 0002 的路径）。proven，但**对 message projection 不适用**：投影必须是日志的纯函数（`packages/core/session/src/surface.ts:35-46`），`SessionMessageProjectionContext` 只给 `nodes`/`events`/`baseSeq`/`messages`，**没有任何外部状态通道**——用闭包去读外部缓存会让 `project` 非纯、依赖重放顺序，正是契约禁止的。所以这条路等于放弃「重载后一致」，与规格闸门 C 冲突。
   - 除非接受降级：裁剪只在**当前进程**生效，重载后回到完整版历史。那会推翻「裁剪是持久的」这条用户故事，**不推荐**。

### 其余待办

- **上游诉求（一条）**：为「仓外、**运行期**写入、改变模型可见重建、且必须可重载」的插件事件提供一个不依赖 `ignorable` 的机制。本插件是这类生产者的第一个实例；那份 note 与 ADR 0002 都指向同一个缺口，但两者都只描述了「无法用 `append` 写入」，没提「seed 可以、运行期不行」这个区分——提诉求时应按这个更准确的措辞。
- 包名与目录：`packages/dsh-reasoning-pruner/`，`dsh-smarter-context` 只作为未来的容器名保留。
- ② 的 `M` 由闸门 B 定值、`K` 由闸门 D 定值；① 是否自持重试由闸门 B-2 的实测结果决定。
- **ADR 待写**：原计划记录「用 `ignorable` 承载一个会改变重建的事件」这一取舍；**现因上述阻塞而搁置**——该取舍是否成立取决于最终选哪条路径，写早了会记下一个不存在的决定。
- **ADR 0002 前提待更正**（本仓已提交的文档）：它的结论（记录移出会话日志）大概率仍然正确，但**理由**需要按「运行期 vs 构造期」重述。这是另一份文档的改动，不折进本设计。
