# dsh-reasoning-pruner 设计

状态：机制已逐条核实，**实现未开始**。耐久记录的承载类型经类型普查选定为 **`web/deepseek-search-llm-request`**（候选排序与排除清单见「待办与上游诉求」）；**闸门 A 已关闭**（票 08 实测：A1/A2/B1/B2/C1/C2 全通过、A2 的被计费输入下降，见 `.scratch/historical-reasoning-pruning/gate-a-record.md`；结论只在被实测的网关与 chat-completions 传输上成立）。四张闸门见[实施规格](../.scratch/historical-reasoning-pruning/spec.md)：A（端点接受度，实现前必须关闭）、B（缓存净收益）、C（回放与不变式）、D（任务质量不下降），后三张是实现后的判据。文中标注「待闸门背书」的默认值在闸门关闭前不得写死。

本文件引用的 DSH 扩展点按**不低于 `0.2.0-rc.2` 的最新版本**逐条核实，路径为 DSH 仓内相对路径。基准是**下限**（`>= 0.2.0-rc.2`，不设上限）：不为旧版本留兼容路径、版本判断分支或降级行为，更高版本乐观地先视为兼容（`AGENTS.md` 的「DSH 版本基准」）。用户运行环境（`~/.dsh/profiles/`）与 DSH 源码 checkout 都是 `0.2.0-rc.2`；本仓的开发依赖另见下文说明。升级后按下文「验证状态」的核对清单重跑一遍——不存在一条按版本号判断的机制，那种写法既无代码支撑也无法验收。

本文件记录**取舍与机制**：为什么这样定、挂哪个钩子、事件字段形状、源码依据与待实测项。**需求陈述与验收标准在[实施规格](../.scratch/historical-reasoning-pruning/spec.md)里**，规格只写操作性定义、可观察判据与交付约束，不复制本文件的机制描述。判断一句话该放哪边：**删掉它之后，有没有验收标准变得无法判断**——会，属于规格；不会，属于本文件。两者冲突时：需求以规格为准，取舍与机制以本文件为准。

## 范围与约束

- 只开发插件，不修改 deepseek-harness 源码。所有接缝都是已有扩展点：`agent/pre-step` 与 `agent/request-error`（waterfall，可 `prepend`）、`ctx.sessions.registerMessageProjection`、以及手动入口所需的设置面（`ctx.settings` / `ctx.configForms`）。
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

**结论先行**：借用一个**已知（在生成集合内）的 log-only 事件类型**承载我们的 payload，并为该类型注册自有投影。已知类型无需 `ignorable`、天然可重载，于是「阻塞」一节的两难消失。

**承载类型（普查选定）：`web/deepseek-search-llm-request`**。理由：全仓没有任何 payload 读取者、不在 `RELATIONSHIP_TYPES` 里、不是表面类型、生产者存在且是宿主自己的（所以真实事件与我们的事件共存是既成事实）。第一顺位的残余风险是「将来有人开始读它」，第二顺位是 `session-log-deepseek` 的原样上传——见「两条必须在实现前处理的约束」。

- payload 形状（**三条硬约束**见下）：

```ts
/** 自有命名空间信封。顶层只有这一个键——结构上不可能带出 `turn`/`step` 坐标。 */
interface ReasoningPrunePayload {
  clipclop: {
    /** 要裁剪的历史步骤，按它们的 assistant/message seq 列出。 */
    targets: SessionSeq[]
  }
}
```

**三条硬约束**（前两条来自类型普查，第三条是普查补正）：

1. **不得表面可见**：不带 `surfaceOp`/`sourceEventSeqs`——非表面类型带这些会直接抛（`surface.ts:310-319`）。
2. **不得是 `@messageProjection` 类型**，也不要相信 `MESSAGE_PROJECTION_EVENT_TYPES`：投影查找只按**类型**（`surface.ts:529`），而对一个已有投影的活跃类型再注册会抛（`index.ts:942-945`）。所以**永不**复用 `image/offload`。
3. **payload 必须无坐标**：客户端时间线索引对**每一个**事件都读 `data.turn` / `data.step`，不看类型（`packages/client/ui-conversation/src/client/conversation/location-index.ts:139-149`），并用它**重指** `currentTurn`/`currentStep` 游标（`:318-322`、`:528-539`）。⇒ 顶层出现数字 `turn` 会把后续无坐标事件**归错轮次**，UI 时间线分组错误。这就是上面为什么用**单个命名空间键**：让约束由结构保证，而不是靠记住。
   - 另有一个特例值得知道：`data.turn === null` 表示**会话作用域**（`:141`）。
   - 附带记录一个「至多一次」消费者：`agent-team` 的 `roster.ts:360-364` 用「该会话第一条任意类型事件」来兑现一个一次性屏障；它对第二条事件会提前兑现。它在没有 bundle 引用的实验包里，且是提交后（contained）监听器，只在挂载该组合时才是正确性风险。

4. **payload 不得含会话内容**：`session-log-deepseek` 默认开启（`enabled` 默认 `true`，`packages/session/session-log-deepseek/src/index.ts:52`；base bundle 挂载于 `packages/bundle/base/cordis.patch.yml:43`）并把 `data` **原样上传**到远端。我们的 payload 只有 seq 数组，天然满足——但这条要写成硬约束，因为它会随「顺手多记一点上下文」而破。

- **类型侧的代价（已核；不是缺陷，而是「借用已知类型」这条取舍的价格）**：`append<T>(type: T, data: SessionEventMap[T])` 把 `data` 严格约束到宿主声明的 `DeepSeekSearchLlmRequest`（`packages/core/session/src/index.ts:722-726`；`SessionEvent<T>` 的 `data` 见 `packages/core/session/src/types.ts:493-500`），而为同一个 key 再声明一个不同类型是 interface 合并的重复属性错误——**所以只能 cast**，而 cast 又必须在不改 DSH 源码的前提下做。于是**投影自己的校验成为唯一的形状闸门**：编译期没有（类型是宿主的），运行时也没有——`validateSessionEventData` 只分支表面类型 / `request/header` / `tool/result`（`packages/core/session/src/surface.ts:172-226`），v4 读门禁 `assertReleasedV4Relationships` 对内层无消息槽的类型原样放行（`packages/session/session-format-v3-to-v4/src/validation.ts:110-130`：逐事件只查 developer / message-source / delivery / catalog 四类事实；`src/sources.ts:12-34` 的 `mapEventMessages` 对名单外类型原样返回）。
- **为什么不能自建一个新类型（这条取舍的根据）**：`KNOWN_SESSION_EVENT_TYPES` 的生成头注释写死「Downstream（**out-of-repo**）插件事件**按构造就在这个列表之外**。持久化的 `ignorable` 标记才是兼容机制」（`packages/core/session/src/known-event-types.ts:15-16`）——不在该列表里的类型会被 v4 读路径拒收，这正是必须借用一个**已在本仓声明**的已知类型的原因。

- 事件**不带 `surfaceOp`**（它必须是 log-only 类型）。投影在折叠期把这些 seq 的消息换成「移除推理块」的副本。
- 校验全放在 `project()` 里，照 `image-offload` 的做法：payload 形状、target 必须是**当前表面节点**（`context.nodes`）、重复 seq 抛错、目标事件必须是 `assistant/message`（否则裁剪会作用到错误对象上）。投影必须是纯函数：它在运行期增量折叠与重载全量折叠两条路径上都会被调用，两侧结果必须一致，且**不得抛「信息不足」类错误**——一旦抛错，那条日志就再也读不出来。
- 追加走 `session.append(<承载类型>, payload)`；`Session.append` 对**已知**类型没有任何障碍。
- **注意投影拦截的副作用**：为某类型注册投影后，该类型的**每一个**事件在每次折叠时都会走投影（`surface.ts:529-534` 先于所有其他分支）。所以投影必须对「不是我们写的」该类型事件也安全返回（返回空 Map、不抛错）——否则会把宿主自己的事件拦下来。**判别规则写死**：payload **顶层出现 `clipclop` 键** ⇒ 这是我们的事件，按下文严格校验（违规抛）；**没有该键** ⇒ 宿主事件，返回空 Map、不抛错。**不得**用「是否符合 `DeepSeekSearchLlmRequest` 的字段（`endpoint`/`apiVersion`/`body`）」来判别——那会把放行分支绑死在外部包的 schema 上，宿主改字段就会让我们对宿主事件抛错，而投影一抛错那条日志就再也读不出来（见上一条）。选定承载类型后必须用用例钉住这一点。

- **注册本身还有一个不可避免的代价（已核；这是承载类型选择的实际价格，不是缺陷）**：投影命中就推进 `contentGeneration`，**与投影返回什么无关**——`applySurfacePlan` 的 `project` 分支无条件 `state.contentGeneration += 1`（`packages/core/session/src/surface.ts:579-583`）。承载体是宿主自己也在用的类型（每次辅助搜索都 append，`packages/web/web-search-deepseek/src/index.ts:117-121`），所以**宿主每产生一条该类型事件**，下一步请求的 `startsSeries` 就为真（`packages/core/agent-loop/src/agent.ts:396`），从而落一条 `request/header`：header 未变时是 `reason: 'series'`（`:615-616`），同一次还改了 header 则是 `reason: 'change'` 加 `startsSeries: true`（`:609-614`）；无论哪支，工具基线都会被重置且 `updates` 清空（`packages/core/session/src/tool-history.ts:36`），系统提示词走替换分支（`packages/core/agent-loop/src/runtime-context.ts:95`）。**不注册投影时不会发生**：该类型非表面类型，`if (surfaceOp === undefined) return`（`surface.ts:538`）让 `plan` 为空，两个计数都不动。**规避不了**：推进发生在投影之前，返回空 Map 无用。⇒ 上文把「生产者存在且是宿主自己的」当作好处（共存是既成事实），准确的说法是**它同时是坏处**——共存有代价。代价的量级**尚未量化**；观察面写在票 01 第 5 条与票 02 第 12 条，两处都要求把它逐条断死，以免无声扩大。

**两种分发机制的成败语义**（决定了坏 payload 在哪一步炸，普查补正）：

- **提交后**的 `session/event` 观察者**不能**否决一次 append：`invokeContainedSessionObservers` 是 try/catch + `logger.warn`（`packages/core/session/src/index.ts:403-419`）。最坏是记一条警告并留下卡住的状态，**不会**让 append 失败。
- **提交前**的 `internal/dispatch` 监听器**可以**否决：`collectSessionCallbacks` 在 append 的 try 内、`this.log.push`（`:761`）**之前**运行（`:759`）。这是唯一的硬失败路径——测试期的 invariant 伴侣正是在这里 stage 并 `fail()`。
- 我们的投影属于**提交前**：`planSurfaceEvent` 由 `surfaceManager.validateNext`（`:752`）调用，也在 push 之前。⇒ 坏 payload 会让 **append 本身失败**，但原因是 **SurfaceManager 校验**，不是监听器。这对实现有直接含义：**校验失败是当场大声的，不会留下坏日志**。

### `ignorable: true`：**已作废的路线**，留档以免后人重走

下面这一节记录的是**最初选定的路线**（自有事件类型 + `ignorable: true`）及其全部依据。它现在**不再采用**，保留原因有二：一是契约层面的分析仍成立、对任何想走这条路的人有价值；二是它解释了我们为什么不走这条路。

- 外部插件的事件类型**永远不在** `KNOWN_SESSION_EVENT_TYPES` 里：该集合由 `scripts/gen-persistence-catalog.ts` 从本仓源码生成，其文件头注释明说 out-of-repo 事件「by construction」不在其中（`packages/core/session/src/known-event-types.ts:1-21`）。
- 持久化 seam 对未知事件**只在** envelope 显式带 `ignorable: true` 时才接受（`packages/core/session/src/surface.ts:311-312`；`packages/session/session-log-deepseek/src/index.ts:102`）；absent 即 required-on-read，会拒绝整段会话。
- 上游有明确决策记录：`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。它保留该字段**正是**为了外部插件，并明确否决了两条替代方案——「把仓外事件一律当 ignorable」（理由：读者无法推断未知耐久事件是信息性的）与「注册挂载插件的事件名」（理由：事件名注册不分类「省略是否安全」）。
- **张力，必须写清楚**：本事件不是纯信息性的——它改变模型可见重建，而那正是它存在的理由；而字段契约写的是 `ignorable` 表示「loss cannot affect reconstruction」（`packages/core/session/src/types.ts:501-511`）。我们是在**用一个为信息性记录设计的机制换取可重载性**，代价是未装载本插件的读者会跳过它、重建出**未裁剪**版历史。
- 降级方向是安全的：推理全文仍在日志里，不会产生损坏的会话，也不会出现「两端都不报错却内容分叉」——最坏情况只是白花 token。所以判据（规格闸门 C）写成：有插件时重载与运行期一致；无插件时**不得拒绝整个会话**，只能得到未裁剪版。
- 这是**需要向上游提的**一条：按那份 note 的措辞，替代机制尚不存在，而本插件是第一个真正需要「仓外、改变重建、但必须可重载」的外部事件生产者。

### **为什么不走 `ignorable`：运行期写不出，且契约不符**

按当时选定的路线（自有事件类型 + `ignorable: true`），前提是「我们能在**运行期**写出带 `ignorable: true` 的事件」。**这条前提不成立**，而且即便成立，契约也不符。证据：

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

- **`ignorable` 已被排除为方案**：即便能写，它承载的是一个「省略安全」的声明，而裁剪**改变**模型可见重建——契约与用途不符（见上一节）。
- **`SessionHandle.append`（经 `ctx.sessionPersistence`）能耐久写入任意 envelope**：写入路径只查 JSON 可序列化，不查事件类型（`storage-contract.ts:131-137`），出厂先例是 `message-feedback`（`packages/feedback/message-feedback/src/index.ts:261-268` 手搓 `{...event, seq, time}` 后调 `handle.append`）。绕过 `Session.append` 即可带上 `ignorable`。
  - **但对本设计不可用**：写入所有权按会话 id 独占（`storage.ts:429-432` 的 `claimWrite` → `SessionAlreadyOwnedError`；`index.ts:323-325` 的 `create` → `SessionAlreadyExistsError`）。经独立实测：`OWNED_DURING_OPEN = SessionAlreadyOwnedError`、只读 handle append = `SessionReadOnlyError`、关闭后才 `OK`。**活跃的 agent 会话拿不到写 handle**，而本插件的裁剪正是发生在活跃会话里。
- **复用已知事件类型 + 自有投影（当前领先方案）**。机制上成立，且**不需要 `ignorable`**：已知类型天然可重载（它们在生成集合里），所以整个阻塞消失。
  - `planSurfaceEvent` **先按类型字串查投影**，命中即返回 `kind:'project'`，早于任何 `surfaceOp` 处理（`packages/core/session/src/surface.ts:529-534`）；投影可以返回**任意表面 seq** 的消息替换。
  - 出厂测试正是这个形状：`test/project` 事件（seq 1）改写了更早的 `user/message`（seq 0）的内容（`packages/core/session/tests/message-projections.spec.ts:16-24`）。⇒ **一个 log-only 事件可以驱动对 assistant 消息的改写**，这正是本设计需要的。
  - `registerMessageProjection` 只按**类型**去重（`index.ts:942-950`），对「注册在哪个类型上」没有约束；全仓当前只有 `image/offload` 注册过投影（`compaction-image-offload/src/index.ts:26`）。
  - 插件缺席时的降级也安全：投影未命中 → 不触发 `MESSAGE_PROJECTION_EVENT_TYPES` 报错 → `surfaceOp === undefined` 直接返回（`surface.ts:535-538`），事件被**忽略**，重载得到未裁剪历史。
  - **待定的唯一问题是「借哪个类型」**：追加某类型的额外事件会进入该类型自己的读取者与结构校验。已排除的例子：`step/end` 有严格状态机校验（`session-format-v3-to-v4/src/relationships.ts:291-295` 要求「有打开步骤」，多一条就打乱 `step/start` 的配对），`compaction/*`、`command/*`、`request/*`、`session/end-seed`、`llm/retry` 皆属 `RELATIONSHIP_TYPES`；`image/offload` 的投影已被占用且重复注册直接抛。
  - 承载类型的选择见「待办与上游诉求」的普查结果（已选定 `web/deepseek-search-llm-request`）。
- `KNOWN_SESSION_EVENT_TYPES` 是运行时**未冻结**的普通 `Set`（`known-event-types.ts:22`，无 `Object.freeze`），也经 `@deepseek-ai/dsh-session` 导出（`index.ts:36`）。同进程 `add` 确实能让 `validateStoredEvents` 从拒绝转为接受——**但重载是另一个进程**，生成集合不含它。**不作为耐久方案**；不过它是一个真实的同进程完整性缺口，值得单独记一笔。

**结论**：耐久记录在**不修改 DSH** 的前提下有路可走——**复用已知事件类型 + 自有投影**，这也让 `ignorable` 整条线连同它的契约张力一起作废。上游诉求从「必须先解决」降级为「可选改进」。承载类型已由全量类型普查选定为 `web/deepseek-search-llm-request`（见「待办与上游诉求」）。

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

- pi-ai：`if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')`，随后逐位要求 `replay.type === block.type`（`packages/llm/llm-pi-ai/src/replay.ts:192-195`）。
- DeepSeek Messages：`if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return fail('block count mismatch')`（`packages/llm/llm-deepseek/src/replay.ts:55`）。

不对齐时抛的是 `INVALID_REPLAY_STATE`，而**两端都把它吞掉**：pi-ai 的 `toPiAssistant` 捕获后调 `onDegrade` 再返回 `foreignAssistant(message)`（`packages/llm/llm-pi-ai/src/replay.ts:249-260`），Messages 侧同理返回 `undefined` 信封（`llm-deepseek/src/replay.ts:39-45`）。后果是**整条消息**（连同一个不该丢的文本签名与工具调用签名）跌落到 provider-neutral 重建：不报错、不失败、只是丢掉签名。

**`onReplayDegrade` 的准确状态是「有日志信号、无程序化观测面」**（不是「完全静默」——这一处曾被写错）：回调本身是适配器 config 上的**可选**字段（`packages/llm/llm-pi-ai/src/adapter.ts:98-104`，内部包成 `onReplayDegrade(reason)`，`:366-367`），而**出厂的工厂函数都硬编码配了它、记一条 `ctx.logger.warn`**：pi-ai 见 `packages/llm/llm-pi-ai/src/index.ts:222-227`（`llm-pi-ai: unusable replay state on assistant history for route "…"`），Messages 见 `packages/llm/llm-deepseek/src/host.ts:26-28`（安装版对应 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 与 `-llm-deepseek/lib/index.js` 同处）。**但没有任何 bundle 把该警告接到可观测面、也没有消费者读取它**（`packages/bundle/**/cordis.patch.yml` 里零命中），所以排障只能翻日志。实现上仍应把它当**测试夹具的断言钩子**（那是唯一的程序化用法），不要接进插件的生产配置。

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
- 与 ① 不同类：它不是补救，而是让裁剪**存活到后续每个请求**；代价是每次推进边界要按全价重算一次边界尾，靠步数间隔 `M` 摊薄。`M` 由闸门 B 背书（成本），保留窗口 `K` 由闸门 D 背书（质量）；两者**已由 07 实测结账为 `M = 50` / `K = 10`（判定不必收紧、取值原样）**（`n` 随 `M` 增大而下降、`50` 在实测最大档 `8` 的更大一侧；`K = 10` 是首个不再恶化档，与默认一致）。**边界**：实测只覆盖 `M ∈ {3, 8}`、`M > 8` 未测，所以 `50` 是「没有下调依据」的保守保留，不是被实测为最优值。
- **不能用 `ctx.tokenMeter.measure` 判压**。计量器按**原始表面事件**定价，不读投影：`measure()` 走 `priceSurface(state.surface, …)`（`packages/llm/token-meter/src/index.ts:146-157`），而 `token-meter/src/**` 全仓不引用 `messageProjections`/`projectedMessages`；同一个包的 `surface-projection.ts:1-10` 说明 replace 走的是一套 shadow-price 协议，与本插件无关。所以 ② 的节奏只能由自己的步数计数决定。
- 连带的事实（必须记录，因为是可观察的差异）：**裁剪不会降低 `tokenMeter.measure` 的读数**。`deriveMessages()` 会应用投影（请求确实变小），但计量器与压缩压力读数不会随之下降。表现是「省了钱，界面上的上下文占比不动」。这不是缺陷而是机制事实，规格不为其设判据，但实现时不要在文档里把它说成「降低上下文占用」。

### 激活点 ④：手动入口与可用性开关

- 入口是一个插件自有命令（如 `/prune-reasoning`），**不劫持 `/compact`**：命令表按名字插入，重名直接抛（`packages/core/scope/src/store.ts:43-46`），且劫持会把内建命令的文案与错误映射复制一份。
- **开关的座位是「设置 → 内置插件」里的一个页签**（`settings.plugins.tab`）。**2026-09-29 按用户裁决从 `settings.general.item` 一行迁到这里**：内置插件那一节本就是「每个插件一页」的座位，插件的开关跟着插件走；通用设置里那一行既不在功能偏好簇的语境里，也要自己补一套行 chrome 才不显突兀。变更的影响与验收面改动见票 06「座位变更」一节。
- 开关需要一个**双面包**（这是本设计里唯一的额外交付物）：
  - host 半：`Config` 里的布尔字段，命名空间即 patch 行的 `id`，字段必须标 `.volatile()`（settings 的写入路径拒绝非 volatile 路径）。
  - 浏览器半：`dsh.client { platform: 'web' }` + `exports["./client"]` 产物，把开关注册为 `settings.plugins.tab` 这一页（契约 `packages/client/ui-settings/src/client/contract/slots.ts:58-66`：内置插件节里的**一页**；`id` 是页签键、`order` 是页签位、`label` 由 owner 投影成页签按钮上的文字，owner **不收到任何 props**（`SettingsPluginsTabOwnerProps` 只有 `children?: never`），文案、当前值、写入路径全归注册者）。节本身与页签 chrome 归 `packages/client/ui-settings-plugins/src/client/index.ts:76-84`，它用 `children: { 'settings.plugins.tab': … }` **在自身挂载时**声明该槽位——所以注册必须走 `ctx.slots.inject('settings.plugins.tab', …)` 等声明上账，`whileServed([...])` 只是叠在它外面的第二道守卫。文案按注册者自己的 locale 命名空间走：`ctx.locale.register(ns, { zh, en })` + `label: () => t('tab')`（thunk 每次投影重读，`resolveSlotLabel` 见 `packages/client/ui-slots/src/index.ts:865-867`），页内 `t` 由渲染机按注册时声明的 `locale` 命名空间合成。失败形态的先例仍是 `DeveloperToolsRow.tsx`（`Switch` + `busy`/`failed` 两态 + `role="alert"`）。
  - 读走 `ctx.configForms.get('<Host plugin entry id>')` —— 它的 `namespace` 就是 entry id（`packages/client/ui-settings/src/client/config-form.ts:290-301`），`getSnapshot()` 读、`set(field, value)` 写（`:114` 的 `set` 返回 **`Promise<boolean>`**：Host 拒绝时**返回 `false`**）。**注册还必须包在 `whileServed([...])` 里**（`:317` 起）：该守卫让「宿主从未 compose 该命名空间」的部署不显示这一页，否则会出现一个没有写入目标的死页。
  - **写回被拒绝的形态是个陷阱，两版本都不同于直觉**：实装的 `SettingsScope.set` 在 Host 业务拒绝时**照常 fulfill（resolve `undefined`），不 reject**——实装 `lib/client.js` 的 `mutate()` 里是 `if (!response.ok) { await this.recover(generation); return; }`（普通 `return`），只有 `operation()` 自身抛异常时才 reject。
    - **但也不能把「快照回退」当观察面**：`set()` **从不做乐观写入**——快照的 `value` 只在成功时由 `mirror.acceptView(response.value)` 更新，失败走 `recover()` → `mirror.load()` → `derive()`；因此**业务拒绝路径上快照本来就没变过**，断言「值回到翻转前」是**恒真的空转判据**。
    - ⇒ 正确的可观察量是**界面失败态**：照框架先例 `packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx:24-37`（行自带 `busy` / `failed` 两态、失败渲染 `role="alert"`），并注意**业务拒绝捕不到 UI 侧的 `.catch()`**——`failed` 必须在 await 之后核验结果，不能只靠 catch 置位。
  - **注册必须包在「宿主真的 serve 该命名空间」的守卫里**：`whileServed([...])`（`packages/client/ui-settings/src/client/config-form.ts:317` 起；作用是「宿主从未 compose 该命名空间时不要显示一个没有写入目标的死页」）。**按最新版本实现**——更早版本上对应的是 `SettingsScopeSnapshot.status === 'unavailable'`，本仓基准不再用它。
  - **没有**「声明 Config 就自动长出 UI」的通路：`autoGenerate` 在客户端零消费者（checkout 与已装包里均 0 命中），出厂的插件清单页是只读的。所以浏览器半是必需的，不是优化。
  - **而且浏览器半的产物格式是一条硬约束**：必须是 **CJS 闭包工厂**（`banner` 写 `window.__ModuleLoader__.load({id, factory})`、`footer` 收口，`packages/client/tsdown.client.ts:617-623`），`exports["./client"]` 只能是字符串或带字符串 `default` 的对象——别的形状直接抛。装载侧要求 `dsh.client`（`platform` 必须等于 `'web'`）+ 该导出路径的**文件已存在**（`packages/client/modules/src/index.ts:195-205,838-847`）。**本仓现有的 `tsc -p tsconfig.json` 直出 `lib/` 产不出这个格式**，所以本票要落定一个客户端打包步骤（`tsdown` 或等价物）或手写那份小产物。缺产物时**同步抛出**（`client-modules: client bundle not found; run \`pnpm run build\` before launch`，`:92,103`，聚合成 `ClientPackageCompositionError`），该 fiber FAILED——不是静默跳过。
- **置灰按保守闸门**：判不准就不给。判据需要**三个**事实，不是两个：
  1. **路由目录**——`ctx.remote.llm.listConfigurableProviders()` 给出的 `settingsNs`（`llm-deepseek` 确定是 Messages，可确定置灰；该 `@Remote` 在 `packages/llm/llm/src/index.ts:549`，返回项含 `settingsNs`，`packages/llm/llm/src/types.ts:245-263`）。
  2. **显式 route 级 `api`**（`packages/llm/llm-pi-ai/src/config.ts:329`）——读得到的就是确定的；它**只在显式给出时**才进路由（`:468,481`），所以「profile 没写 `api`」就是判不准。
  3. **当前路由是哪一条**——取 **`ctx.modelDirectories.directoryFor(sessionId)`** 快照里的 `current`（`ModelDirectoryState.current` 的文档写着「Effective selection: durable next-request projection, then Host default」——正是本条要的语义；实装包 `@deepseek-ai/dsh-client-ui-model-selection/lib/types/client/directory.d.ts`）。
     - `binding.session.projections.faceOf('modelSelection')` **是公开可达的**（`ProjectionsFace.faceOf` 声明在 `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/session.d.ts:48-62`，经同包 `lib/types/client/index.d.ts:12` 从 `./client` 子路径公开导出），**不是**包内私有。不用它的理由是**语义**：`faceOf` 给**原始投影**（`.next` 等）、**不含 Host 默认回退**，而置灰要判「这条会话实际在用哪条路由」，所以取 `current`。
     - **不得用 `remote.session.modelCatalog()` 的 `default`**：那是**部署默认**、不是会话当前路由——`buildModelCatalog` 的形参注释写明 "deployment default used before a Session selects a model"（`packages/api/session-controller/src/catalog.ts:14-22`），其值来自 `AgentDefaultModelConfig.currentSelection()` 读的部署级配置（`packages/core/agent-default-model/src/index.ts:67-73`）。会话中途换过路由时它仍指向旧默认，置灰会按错的路由判。

  从 catalog 继承协议的 pi-ai 路由**判不准**，保守闸门把它当未知置灰，代价是可能误伤一条本可受益的路由；它会在该路由跑过一个步骤后用 replay 信封自愈。
- 服务端另有硬强制作：裁剪只作用于**裁剪资格成立**的历史步骤（逐步骤读 replay 信封），资格不成立的步骤原样保留。界面的置灰只是提前告知，不是安全保证。

### 激活点 ⑤：裁剪拒收 → 裁剪还原 + 会话裁剪停用

**版本边界**：本激活点属 **0.1.1**。0.1.0 的「先发裁剪版，报错再发完整版」被否掉的是**把它当作静默分叉的保护**这个用法——静默分叉根本不报错，任何错误兜底都盖不到它；这里处理的是端点**响亮**的 400，是另一个问题，也与仓库既有先例同向（路由以结构化失败声明要减多少，插件持久记录后重试）。

**为什么需要它**：裁剪后线上发的是「字段在、内容为空」（或某些网关上是字段缺席）的形状。有外部报告表明 DeepSeek V4 Pro 类端点在思考模式 + 携带 `tools` 时**拒收空串**（见「验证状态 · 裁剪拒收的外部证据」）。一旦发生，该会话此后每个请求都带着同一个形状，会**持续 400**，而现有实现只在 `failure.code === CONTEXT_WINDOW_EXCEEDED` 上动作（`packages/dsh-reasoning-pruner/src/index.ts:87-90`）——也就是说会话会卡死，且裁掉的步骤无法自行恢复。

- **触发判据**（三把锁）：`failure.code` 命中「请求被拒」这一支、`failure.message` 命中推理回传措辞、且本会话已存在裁剪事件。第一把锁的依据：pi-ai 把 400 与 `invalid request` 归一成 `INVALID_REQUEST`（`packages/llm/llm-pi-ai/src/stream.ts:49`，字面量、非导出常量），其余码已被 `classifyPiAiError` 分流到 AUTH / QUOTA / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT；**该路径上 `failure.status` 是空的**（failure 对象只带 `message`/`code`，`stream.ts:125`），所以判据只能建在 `code` + 文本上。放宽到 `PI_AI_ERROR` 是因为网关正文不含 `400`/`invalid request` 字样时会被归到那一档。
- **还原的表达 = 追加一条新事件类型**，其投影把原文放回：`deriveEventMessage(event)` **不传**第二个参数时跳过投影、直接返回事件自带的 `event.data.message`（`packages/core/session/src/surface.ts:120-127`），而 fold 用普通 `Map.set` 写入 `projectedMessages`（`surface.ts:580`），**后来者覆盖先前的**。⇒ 不需要外部状态、不需要前瞻、增量折叠与全量折叠天然一致。两条纪律：
  - 投影**不得**读 `context.events` 里候选及其之后的事件——这只是文档契约（`surface.ts:25-26`），结构上 `events` 就是整个日志数组（`surface.ts:606-607`、`:645-650`），靠纪律而不是靠长度保证。
  - fold **不校验**投影返回的键是否仍是当前表面节点（`surface.ts:573-591` 只做 `Map.set`），任意 seq 都会被静默写入。
- **还原范围**：只还原**仍是当前表面节点**的目标。被 surface replace（compaction）遮蔽过的 seq 不会从 `projectedMessages` 里被删除（`surface.ts:576-578` 只改 `nodes`，`:614` 只做整体拷贝，全文无 `.delete(`），但它已不在 `nodes` 里、不再进入请求，所以既不是肇因、写回也无效——不动它即可。
- **停用**：`persist.ts` 的选区与去重本来就全部从日志重建，读到还原/停用事件后不再推进边界即可覆盖 ①②④ 三个入口。三个入口产生的是同一种事件与同一种线上形状，只停其一没有意义。
- **重试**：返回 `{kind: 'retry'}`（`RequestErrorAction = { kind: 'retry' } | undefined`，`packages/core/agent/src/runtime-types.ts:122`）。waterfall 取**最外层**监听器的返回值（`vendor/cordis/src/events.ts:234-243`），本插件 `{ prepend: true }` 即最外层，因此可以在 `await next()` 之后改写决议。**同一步的重试能看到还原结果**：`buildRequest` 每次都重新 `session.deriveMessages()` 取表面（`packages/core/agent-loop/src/agent.ts:671`），而「钩子里 append、随后请求即携带」这条不变量已由 ② 证明（pre-step 落盘后本步请求就是裁剪版）。上界必须是**每 `(turn, step)` 一次**，否则一个另有成因的 400 会变成死循环。
- **中止也落盘**：「端点拒收这个形状」是与「这次要不要立刻重试」无关的观测；不落盘会在下一次请求里再撞一次。
- **同时收紧裁剪资格**（本激活点的前置修正）：要求移除推理块后**至少还剩一个内容块**。pi-ai 会整条丢弃「既无 content 也无 tool_calls」的 assistant 消息（`@earendil-works/pi-ai/dist/api/openai-completions.js:1048-1058`），否则裁剪会把一条只有推理块的消息**整条从请求里删掉**——那是「移除推理块」这个承诺之外的行为。
- **用户可见提示只能由浏览器半渲染**。宿主侧没有任何提示面：113 个 `declare module '@deepseek-ai/cordis'` 里没有通知/提示服务；`session.notify` 属于 authorization 登录会话而非 chat session（`packages/credentials/authorization/src/index.ts:106,156`）。合法的瞬时提示面是客户端槽位 `shell.overlay`（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2764-2768`，文档原话把 toast stack 归在这里），注册先例 `packages/client/ui-plugin-manager/src/client/index.ts:102-108`、瞬态 toast 模板 `packages/client/ui-settings-session-log/src/client/index.ts:38-40`。该槽位是 `scope: 'root'`、**不按会话分区**，条目必须自己按当前会话过滤。
- **客户端怎么获知这件事（机制 A）**：客户端**不为后台会话保有事件流**——`binding(id)` 对未 retain 的会话返回 `undefined`（`packages/api/session-controller/src/client/sessions/service.ts:529`），只有 `retain()` 才 materialize scope、开历史并给出事件流（`:282-292`、`:594`）。所以只 retain**当前显示**的会话（用插件自己的 source 标签——`SessionReferenceSourceMap` 是声明合并可扩展的，`packages/api/session-controller/src/client/index.ts:80-88`），会话变为当前时扫它的事件窗口即可。行为是「同一页面打开期间最多展示一次；重载后再打开该会话会再显示一次」。若改成 retain 每个后台会话以做真实时未读捕获，代价是要为未打开的会话建立并维护引用/订阅生命周期，首版不做。

## 被排除的替代方案

- **用 surface replace 改 assistant 消息**：机制上不可能（见上，两条规则互斥）。这一条同时解释了为什么 DSH 要给「插件自有消息变更」单开一条 `contentGeneration` 计数。
- **搭 tool-result pruner 的车**（在它的 `compaction/prune` 事件上同步裁剪）：`session/event` 观察者是在 append **内部**被调用的，此时 `entry.appending === true`，任何 `session.append` 直接抛 `session append cannot reenter while another append is being published`（`packages/core/session/src/index.ts:742`，观察者调用点 `:764`）。所以搭车只能改成「我们自己的监听器被 prepend 到它之前」，那又回到需要自己判断压力资格。
- **压力位（激活点③）**：出树没有接缝。compaction-basic 按硬编码服务名取 pruner（`compaction-basic/src/index.ts:289-298,323-326`），压力资格判断依赖未导出的私有策略（`src/config.ts:153-198` 的 `resolveCompactSpec` 与 modelPolicies 合并）。且即便挂上，被裁区间通常会被摘要整段遮蔽，净收益可负。
- **手动 `/compact` 时排除推理**：摘要前唯一的 waterfall 是失败恢复用的 `compaction/summary-error`（`packages/compaction/compaction/src/index.ts:104`），没有前置接缝；`compactNow` 全程不调用 pruner（`compaction-basic/src/index.ts:383-435`）。无接缝的等价做法是先跑 ④ 再 `/compact`。
- **把推理文本置空 / 置为空格**：见「裁剪操作本身」。
- **按传输分别发送**：DSH 是「一份日志、一次派生」，不存在请求级改写，规格「已决定不做」已有记录。

## 验证状态

**已由源码核实**（撰写时按当时的实装版本逐条核过；按下限基准，结论在更高版本上乐观地先视为仍然有效）：上文所有带 `path:line` 的机制断言——行号是 DSH 源码 checkout 坐标，升级后按「基准」一节的核对清单重跑；`compaction-image-offload` 的投影形状可直接照抄；`registerMessageProjection` 重复注册同类型会抛（`packages/core/session/src/index.ts:942-947`）。

**只有源码依据、需要运行时确认**（实现时按此顺序验，验不过就停下改设计）：

1. **选定承载类型**（当前唯一前沿，见「待办」）：普查给定候选后，验该类型既有的结构校验与消费者不被打扰。
2. **重载不退化**：裁剪后重载，被裁消息仍是裁剪版；且**未装载插件**的读者不得拒绝整段会话。**已实测的参考读数**：构造期种入一个带 `ignorable: true` 的自有事件，在两进程间往返后投影仍生效、模型可见历史被改写、且插件缺席的冷读不拒绝（`validateStoredEvents` 跳过未知但 ignorable 的行，`storage-contract.ts:75`）。这条证明了「未知但 ignorable 的事件 + 自有投影」这条链**本身**是通的——缺的只是运行期写入点。
3. **replay 信封不退化的反例**：只改内容不改信封必须触发 `onReplayDegrade`（用它作断言钩子）；同步过滤后必须不触发，且存活块签名保留。
4. **投影在两条折叠路径上一致**：运行期增量折叠与重载全量折叠得到逐字节相同的模型可见历史。
5. **`contentGeneration` 确实是请求快照失效的信号**：投影落地后，下一步请求包含裁剪版消息（`agent.ts:396` 的比较）。
6. **`ignorable` 事件的 data 在 JSONL / deepseek-log 往返后仍完整**（若最终走该路径）：`packages/session/session-log-deepseek/src/index.ts:79-110` 的 `common` 保留 `data`，但这条要端到端验。
7. **闸门 A、闸门 B、闸门 D**：见规格。闸门 A **已拆分并已关闭**（见下），B/D 尚未开始；闸门 A 的探针（`.scratch/probes/reasoning-content-empty-acceptance.mjs`，含 usage 读数）已按其 6 个变体跑过。

**闸门 A 的拆分：接受度已有生产先例，计费下降已由票 08 实测**

接受度这一半（「端点是否接受裁剪后的形状」）**不必等真实网关**——DSH 今天就在 DeepSeek 路由上发这个形状：

- pi-ai 的官方 DeepSeek 目录把该要求写成硬约束，填充值是**空串**：`deepseek.json` 的三个 `deepseek-v4-*` 条目**全部**带 `compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek", … }`（`node_modules/.pnpm/@earendil-works+pi-ai@0.85.1*/…/dist/providers/data/deepseek.json`）。
- 字段的文档注释直接写明语义：**「Whether replayed assistant messages need an empty `reasoning_content` while reasoning is on」**（`packages/llm/llm-pi-ai/src/catalog.ts:385-386`）；DSH 自己的测试为这条继承关系背书（`packages/llm/llm-pi-ai/tests/catalog.spec.ts:823-825`）。
- 实现按此填充，条件是「该 compat 位 + `model.reasoning` + 字段仍缺席」：`assistantMsg.reasoning_content = ""`（pi-ai `dist/api/openai-completions.js:1044-1047`）；自动检测条件是 `provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com")`（同文件 `:1249`，赋给该位在 `:1286`）。
- ⇒ 只要一条历史 assistant 消息**没有非空 thinking 块**（模型切换、跨 provider 历史、降级重建都会产生），生产代码就会发 `reasoning_content: ""`，即规格闸门 A 的 **B 变体**。**若端点拒收空串，这个 compat 位就是自毁的**——它存在的唯一目的就是满足这条要求。

因此准确的验证状态是：

- **A1（端点接受裁剪后的形状）**：从「未知」降为**有生产先例的强证据**，不再否决实现。一次性确认已由票 08 的 6 个变体完成（6 个变体全 200，见下），不再阻塞。其适用范围要写明：覆盖 **chat-completions 传输 + DeepSeek 目录判定**；**不含** `llm-deepseek` 的 Messages 传输（那条走 thinking + signature，裁剪即丢掉该块，机制更简单，且已被裁剪资格排除）。
- **A2（被计费的输入真的下降）**：**已由票 08 实测**——DSH 侧两臂读 `assistant/message` 的 `usage` 三者之和，649 → 474（Δ = 175），同一命令连跑五次 Δ 全为正（151–190）；探针侧 A1↔B1 与 A2↔B2 的 `prompt_tokens` 各降 20。跑法与读数见 `.scratch/historical-reasoning-pruning/gate-a-record.md` §一 / §三。**不得外推**：结论只在该记录实测的那个网关上成立，且覆盖 chat-completions 传输——**不含** `llm-deepseek` 的 Messages 传输。
- 附带记录本机实际路由的更省形态：`cline-pass` 的自有适配器只在推理非空时才写该字段（`~/.dsh/profiles/web/node_modules/dsh-cline-pass/lib/adapter.js:204-213` 的 `...(reasoning.length > 0 ? { reasoning_content: reasoning } : {})`），即裁剪后走的是**变体 C（字段整个省略）**，比 B 更干净。

**裁剪拒收的外部证据（外部报告，不是本仓实测）**

- 官方语义：[Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode) 写明「请求携带 `tools` 时，所有历史轮的 `reasoning_content` 都必须回传，包括没有发生工具调用的轮次；不回传则返回 400」。它只规定「必须回传」，没有规定空串是否算回传。
- 空串被拒的报告：[hermes-agent PR #17341](https://github.com/NousResearch/hermes-agent/pull/17341)/[#18263](https://github.com/NousResearch/hermes-agent/pull/18263) 明确写着 DeepSeek V4 Pro 拒收空串并把占位从 `""` 改成 `" "`；[LiteLLM issue #37629](https://github.com/BerriAI/litellm/issues/37629) 对空的历史值注入单空格占位；[OmniRoute commit 21ad0bc](https://github.com/diegosouzapw/OmniRoute/commit/21ad0bc74f58422631a2f86578196f8d81c251f7) 改用非空文本占位。
- **反例存在**：[new-api PR #7153](https://github.com/QuantumNous/new-api/pull/7153) 的注释称「空字符串即可通过该校验」。与上述冲突，最合理的解释是**端点/模型/版本差异**。
- ⇒ 结论：接受度是**按端点**的属性，本仓**不能**对它下全局断言。这正是第五个激活点做成「运行期兜底」而不是配置开关的原因：不预判端点，谁拒收谁停用，且只影响那一个会话。注意 pi-ai 的填充条件是「DeepSeek 判定 + `model.reasoning` + 字段仍缺席」（填充在 `openai-completions.js:1044-1047`，判定在 `:1232`、赋入 compat 位在 `:1268`），非 DeepSeek 判定的网关走的是**字段缺席**那一支，同样是官方语义下会被拒收的形状。

**未验证、明确不断言**（与上一节并列，均属激活点 ⑤ 的前置）

- `retain()` 之后 host 侧是否为每个引用建立订阅（`retainedBy` 计数暗示按 `referenceCount > 0` 建，未证实）；机制 A 只 retain 当前会话，所以不依赖这条。
- 客户端半的类型图能否看到宿主半对 `SessionEventMap` 的增强（新事件类型的合并声明先例：`packages/session/session-title/src/index.ts:72`）。看不到就得在客户端半本地再合并一次；这是实现细节，不影响设计。
- 会话事件窗口带 `hasMore` 分页（`SessionEventWindow`，`packages/extensions/cordis-client-runner/src/client/api-catalog.ts:859-862`）：极端长会话 + 重载后，停用事件可能落在已加载窗口之外，机制 A 会漏提示。**不影响裁剪功能本身**，只影响那一次提示。
- 本仓**没有**任何断言「被投影消息对象身份」的测试（只有深比较、源事件不被改动、以及未投影路径的 `toBe`：`packages/core/session/tests/message-projections.spec.ts:52,59,115`）。「还原拿到的是原文对象」是插件侧新引入的契约，必须由本插件自己的测试钉住。

**基准：最新版本是一个下限**

设计文档的行号来自 DSH 源码 checkout，而该 checkout 的版本是 **`0.2.0-rc.2`**——**这是本插件的下限基准**（`AGENTS.md` 的「DSH 版本基准」），更高版本乐观地先视为兼容。已核实三处环境：

- **用户运行环境**（`~/.dsh/profiles/node_modules/@deepseek-ai/`，即 GUI 真正加载插件的层）：**230 个 `dsh-*` 包全部是 `0.2.0-rc.2`**（该目录共 252 个包，其余是 vendored 的 cordis / cosmokit / schemastery 等，按各自版本走）。
- **DSH 源码 checkout**：`0.2.0-rc.2`。
- **本仓的开发依赖**：两个包现在都在同一个 workspace 里：`packages/dsh-navigator/package.json` 的声明与实装都是 `0.2.0-rc.2`（2026-10-01 升级；该升级是仓库卫生需要，不是本规则要求的），本包 `package.json` 仍声明 `^0.2.0-rc.1` 这一下限范围内的既有选择；根 lockfile 里没有任何 `0.1.x` 的 `dsh-*` 条目，`cordis` 统一到单实例 `4.0.4`（`pnpm peers check` 无未满足项）。**新插件的依赖声明直接用不低于下限的版本（当前即 `0.2.0-rc.2`）**。

**已作废的判断**：本文件此前曾按「实装 `0.1.6-alpha.1`」记下三处「真实差异」——`TurnEndReasonMap` 无 `forked` 变体、格式世代为 v3（连带已知类型 57 条、表面类型 4 条、`assertReleasedV4Relationships` 不生效）、浏览器侧服务名为 `ctx.settingsScope` 而非 `ctx.configForms`。**这三条全部只是「开发仓依赖落后」的产物，不是设计约束**，按最新版本基准一律作废：

- 逐条对过最新版产物（本次按 `0.2.0-rc.2` 复核）：`TurnEndReasonMap` **有** `forked`（`packages/core/session/src/types.ts:228`）；`SESSION_FORMAT_VERSION` 是 **4**（`:89`；`KNOWN_SESSION_EVENT_TYPES` **59** 条、表面类型 **5** 条、`assertReleasedV4Relationships` 是常开读门——`packages/session/session-persistence-jsonl/src/format.ts:468` 无条件调用，本文件「待办与上游诉求」里那条结论**在最新版本上成立**）；浏览器侧服务名是 **`ctx.configForms`**，守卫是 `whileServed([...])`（见「激活点 ④」）。
- 唯一保留的产物级事实是**承载类型的可用性**：`web/deepseek-search-llm-request` 在最新版本的 `KNOWN_SESSION_EVENT_TYPES` 里、且**不在** `RELATIONSHIP_TYPES` 里——这是本设计成立的前提，两侧都已实测确认。
- ⇒ 实现与票据一律按**不低于下限的最新版本**（当前即 `0.2.0-rc.2`）的**源码 `path:line`** 与**同版本产物**写，不需要任何版本判断分支。

**未验证、明确不断言**：

- `token-meter` 之外是否还有别的读投影的计量面（如上下文占比 UI 的取数路径）——本次只核实了 `measure()` 不读投影，没有追 UI 侧的取数。
- **跨格式迁移**不在首版范围：`ignorable` 在历史格式迁移边界上更严（那份 note 的「Consequences」段提到 v0→v1 拒绝一切未知类型），本插件只承诺 equal-version append/reload。
- **`project` 计划不推进表面节点**：`applySurfacePlan` 的 `project` 分支只写 `projectedMessages` 与 `contentGeneration`，**不 push 表面节点**（`packages/core/session/src/surface.ts:573-583`）。因此「把投影注册到 `assistant/message` 上、用纯规则裁剪」这条路**不可行**——它会让该类型的事件整体不进表面。此结论由源码推出，未运行验证。

## 待办与上游诉求

### 当前唯一的前沿：挑哪个已知类型承载

**已定**：复用已知事件类型 + 自有 message projection（`registerMessageProjection` 只按类型去重，`planSurfaceEvent` 先按类型字串命中投影，见 `packages/core/session/src/surface.ts:529-534`；不限于 `MESSAGE_PROJECTION_EVENT_TYPES`，那个集合只服务「必须提供解释器」的报错）。

**普查已完成**（59 个已知类型全查）。两条改变实现前提的结构事实：

1. **关系折叠是常开的读门，不只是 v3→v4 迁移边**：`SessionLogScanner.finish()` **无条件**调用 `assertReleasedV4Relationships`（`packages/session/session-persistence-jsonl/src/format.ts:465-468`），而该 scanner 就是普通读路径（`format.ts:535` 明文、`index.ts:964` zstd）。⇒ 任何有结构校验的类型**每次重载都会撞上**，不是偶发。
2. **包内不变式伴侣（invariant）在出厂组合里不生效，但在测试里按「属主包」选择性挂载**（普查第一版说得过宽，此处是补正后的准确版本）：
   - **出厂**：base / web-app / headless / acp-app / sdk-app 的 bundle 里**零** invariant 行；只有 sdk-minimal 挂了 5 条，且都不是领域不变式（依据 `.agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.md`）。
   - **测试**：Vitest **默认**挂载 invariant（`vitest.config.ts:164`、`vitest.e2e.config.ts:42`、`vitest.expected.config.ts:11`、`vitest.snapshot.config.ts:50` 均含 `./scripts/test-invariants.ts`），但选择规则是**按属主包**：只挂 `../packages/<a>/<b>/src/invariant.ts`，匹配不上就挂零个（`scripts/test-invariants.ts:114-123`）。
   - **对本插件的实际含义**：插件自己的测试放在 `<我们的包>/tests/**` 时，匹配不到 `packages/<a>/<b>/` 这个模式，**拿到零个伴侣**——所以 invariant 的抛错**不会**在我们自己的测试里出现；而任何**仓内包**的测试只要经手我们借用的那个类型，就会挂上该属主包的伴侣并可能抛。**风险面是「仓内包测试」，不是「只有 sdk-minimal」。** 这直接决定第 1 候选为何安全：`packages/web` 下**不存在** invariant 文件，所以即使属主匹配成功也挂不到东西。

另：`docs/persistence-schema.json` **没有运行期消费者**（只被 `scripts/gen-persistence-catalog.ts` 及其 spec 读），它不校验任何东西。

**候选排序**（全部通过五项核查，最安全在前）：

| # | 类型 | 为何安全 | 残余风险 |
|---|---|---|---|
| 1 | `web/deepseek-search-llm-request` | 全仓**没有任何** payload 读取者；有生产者（`packages/web/web-search-deepseek/src/index.ts:118-121` 的 `recordRequest`），所以真实事件与我们的事件共存是既有事实；`packages/web` 下**不存在** invariant 文件 | 将来可能有人读 `endpoint`/`apiVersion`/`body`；且 `session-log-deepseek` 会把 `data` 原样上传。**注意**：v0→v1 迁移边**有**该类型的 payload 语义校验（要求三个字段），但它**不在**当前 v4 读路径上——已核实，见下 |
| 2 | `deliverables/presented` | 唯一消费者带守卫（`client/ui-deliverables/.../turn-deliverables.ts:170` 的 `isPresentedData`，不匹配返回 null） | 避开 `turn`/`callId`/`files` 这些键（它的真实 payload **就带** `turn`） |
| 3 | `workspace/changes` | 同上，带守卫 `isChangesEvent` | 真实 payload **是** `{turn}`，我们的必须省略；带 `turn >= 1` 的整数会触发一次无对应摘要的 changelog 拉取 |
| 4 | `schedule/change` | **全仓无生产者**，所有 bundle 里 `disabled: true`，唯一读取者 warn 兜底 | 开发面的 `schedule/invariant.ts` 会在启动时折叠全日志并 `fail()` |
| 5-6 | `hook/result`、`hook/invoked` | 出厂组合里**没挂**任何 hook 桥（6 个 bundle / 4 个 preset / apps 全零引用） | 未挂载的 `hook-protocol/invariant.ts` |
| 7-10 | `team/member`、`team/task`、`team/message/queued`、`team/message/delivered` | 消费者只在实验性的 agent-team 里，而**没有 bundle 引用它** | 那个投影对异形 payload 直接抛 |
| 11-12 | `approval/asked`、`approval/decided` | 出厂无任何消费者 | 未挂载的 `user-approval/invariant.ts` |

**已核实的一处候选风险（第 1 名）**：`web/deepseek-search-llm-request` 在 v0→v1 的迁移边上有 payload 语义校验，要求 `endpoint`/`apiVersion`/`body` 三个非空字段（`packages/session/session-format-v0-to-v1/src/payload-validation.ts:287-291`）。但该断言只从**已发布旧格式的迁移校验**调用（`session-format-v0-to-v1/src/validation.ts:216`、`session-format-v2-to-v3/src/payload.ts:71`），而当前格式是 **v4**（`packages/core/session/src/types.ts:89`），v3→v4 的 admission **不调用** payload 语义（`session-format-v3-to-v4/src/*` 零引用）。⇒ 对以 v4 写入的会话，该风险**不触发**。仍要记住：它意味着这个类型**历史上**有过语义，将来收紧格式时可能被重新加回。

**最危险的排除项**（值得单独记）：`subagent/catalog` —— `packages/session/session-format-v3-to-v4/src/validation.ts:122-127`（在 `assertReleasedV4Relationships` 内，`:110` 起）**常开**调用 `catalogFact(event.data)` 且不满足就抛（实现 `src/facts.ts:72-83`，抛 `requires a supported versioned catalog fact`），任意 payload 会让**整段会话读不出来**。**注意引用别搞错包**：`catalogFact` 在 `session-format-v1-to-v2` 里**零命中**（该包从不调用它），它是 v3→v4 的机制——这是 v4 的常开读门，正是本设计排除有结构校验类型的主要理由。

**其他被排除的原因**：表面类型 5 个（投影会拦掉、节点不入表面）；`RELATIONSHIP_TYPES` 26 个（常开读门）；消费者会脱轨的：`image/offload`（投影已占用）、`todo/write`（未守卫的 `.flatMap` → TypeError）、`feedback/message-put|delete`（无条件 parse → ZodError 弄坏 feedback Remote）、`feedback/record`（触发全日志 OTLP 上传）、`goal/change`（写入永久失败哨兵）、`agent/inbox/spliced`（解构 `...inserted` → TypeError）、`agent-preset/selected`（headless 对异形 payload 抛）、`model/selection`/`plan/mode`（wire `viewSchema.parse` 抛）、`sandbox/mode`（提交前抛）、`permission/preset`（静默漂移成 'custom'）、`approval/policy`（覆盖 + 污染 strict union）、`subagent/model-selection-policy`、`subagent/descriptor`（会**清掉**子会话身份）、`tool-workflow/*`（客户端渲染出 key 为 `undefined` 的幽灵卡片）。

**我的推荐：`web/deepseek-search-llm-request`（第 1 名）**，但有一个必须先决的隐私问题——见下。

### **两条必须在实现前处理的约束**（普查发现，我已独立复核）

1. **`session-log-deepseek` 默认开启且原样上传 `data`**（`enabled` 默认 `true`，`packages/session/session-log-deepseek/src/index.ts:52`；base bundle 挂载于 `packages/bundle/base/cordis.patch.yml:43`）。⇒ 借用的 payload **不得含会话内容**，否则会随日志上传离开本机。我们的 payload 只放 `seq` 数组，天然满足；但这条要写成硬约束，因为它会随「顺手多记一点上下文」而破。
2. **脱离折叠看不到插件注册的投影**：`session-query`（`documents.ts:60`、`index.ts:191`、`tracing.ts:187`）与迁移代际校验（`generation.ts:543`）用的是**硬编码的首方投影表** `currentSessionMessageProjections`（`session-format-catalog/src/message-projections.ts:7`，当前只有 `image-offload`）。
   - **模型可见路径是对的**：正常重载走 `SessionStore.prepare` → `Session.fromRestore(..., this.projections)`（`index.ts:1032-1038`），用的是插件注册的投影。
   - **受影响的是辅助读者**：会话检索/文档/传播与迁移校验会得到**未裁剪**的历史。这不是「日志读不出来」，而是「辅助读者降级」。
   - 后果：规格闸门 C 的「重载后一致」指的是**模型可见历史**，这一点成立；但**不得**把判据写成「任何读者都看到裁剪版」——那做不到。这是本设计的一处真实能力边界，已记入规格。

### 已核实但不采用的其他路径（留档）

1. **`SessionHandle.append`（`ctx.sessionPersistence`）**：能把任意 envelope 写上盘（写入路径只查 JSON 可序列化，`storage-contract.ts:131-137`；先例 `feedback/message-feedback/src/index.ts:261-268`）。**但对本设计不可用**：写入所有权按会话 id 独占（`storage.ts:429-432`、`index.ts:323-325`），活跃的 agent 会话拿不到写 handle。**留档理由**：它是唯一能绕过 `Session.append` 限制的写入口，将来若有「插件自有会话」的需求会用到。
2. **请求上游增加运行期写入通道**（`Session.append` 可选 envelope，或运行期注册事件类型的正式机制）。现已**降级为可选改进**——上一条已让本设计不需要它。若将来要提，措辞应是「运行期没有写入 `ignorable` 的公开路径；构造期（seed）有」，而不是笼统的「没有写入路径」；并且要说明我们的事件**改变**重建，与被否决的「事件名注册」不是同一类问题。
3. **种子路径（构造期种入带 `ignorable` 的自有事件）** —— **真实存在，但本设计用不上**。独立复核已两进程实测通过（种入 `ignorable: true` 的自有事件 → 重载后投影仍生效、模型可见历史被改写；插件缺席的冷读也不拒绝）。限制是它**只在构造/恢复时生效**，而裁剪是运行期中途的决策。**列在这里是为了防止后人重新发现它时误以为本设计漏看了。**
4. **耐久记录移到会话日志之外**（ADR 0002 的路径）。proven，但**对 message projection 不适用**：投影必须是日志的纯函数（`packages/core/session/src/surface.ts:35-46`），`SessionMessageProjectionContext` 只给 `nodes`/`events`/`baseSeq`/`messages`，**没有任何外部状态通道**——用闭包去读外部缓存会让 `project` 非纯、依赖重放顺序，正是契约禁止的。所以这条路等于放弃「重载后一致」，与规格闸门 C 冲突。
   - 除非接受降级：裁剪只在**当前进程**生效，重载后回到完整版历史。那会推翻「裁剪是持久的」这条用户故事，**不推荐**。

### 其余待办

- 包名与目录：`packages/dsh-reasoning-pruner/`，`dsh-smarter-context` 只作为未来的容器名保留。
- ② 的 `M` 由闸门 B 定值、`K` 由闸门 D 定值；① 是否自持重试由闸门 B-2 的实测结果决定。
- **ADR 待写**：原计划记录「用 `ignorable` 承载一个会改变重建的事件」这一取舍；**已作废**——路线本身不采用了。若类型普查发现「借用别人的事件类型」有值得记录的长期代价（例如与宿主类型语义冲突），那才是该写 ADR 的取舍。
- **ADR 0002 前提待更正**（本仓已提交的文档）：它的结论（记录移出会话日志）大概率仍然正确，但**理由**需要按「运行期 vs 构造期」重述，并且它漏掉了 `seed` 与 `SessionHandle.append` 两条真实写入路径。这是另一份文档的改动，不折进本设计。
