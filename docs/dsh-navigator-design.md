# dsh-navigator 设计讨论

状态：需求已收敛；仓库内已有骨架（配置类型、包元数据、构建配置），但还没有插件运行时。G1、G2、G5、G6、G7 已实测通过，仅 G3 待验证，详见「验证状态」。术语以 [CONTEXT.md](../CONTEXT.md) 为准。

本文件引用的 DSH 扩展点均按 `0.1.6-alpha.1`（本地检出 `dsh-v0.1.6-alpha.1-5-g0d1f50007f`）逐条核实。

本文件记录**取舍与机制**：为什么这样定、调用哪个钩子、消息字段形状、源码依据与实测证据。**需求陈述在[实施规格](../.scratch/dsh-navigator/spec.md)里**；规格只写操作性定义、可观察的验收标准和交付约束，不复制本文件的机制描述。判断一句话该放哪边：**删掉它之后，有没有验收标准变得无法判断**——会，属于规格；不会，属于本文件。两者冲突时：需求以规格为准，取舍与机制以本文件为准。

## 范围与约束

- 只开发插件，不修改 deepseek-harness 源码。需要 DSH 不具备的扩展点时，在插件激活阶段或首次取得主会话时直接报错，不静默降级。
  - **服务依赖全部交给原生 `inject`。** Cordis 在依赖就绪前不会激活插件，所以服务缺失时 `apply` 根本不会执行（`vendor/cordis/src/fiber.ts:611-623` 的 `_refresh()` 在任一注入服务缺失时把该插件置为 INACTIVE），「在 `apply` 里检查服务是否存在」是死代码。缺服务时的表现是「插件不激活」，由 DSH 启动审计报告（`packages/boot/app-boot/src/index.ts:779-784` 汇总缺哪个服务，`:801` 打印 `warning: N entries did not activate`；必需条目直接启动失败）。这不是静默降级——插件根本不会运行，只是报告者从插件换成了框架。
  - **`apply` 里只检查 `inject` 表达不了的部分**：我们要调用的 API 形状（`ctx.llm.stream`、`ctx.sessions.get` 是否为函数），以及第一次拿到主会话时的会话级方法（`deriveMessages`、`requestHeader`）。不检查 `agent/pre-step` 事件是否存在——DSH 没有这种查询接口。对 agent loop 行为的依赖改为锁定版本：本版插件针对 `0.1.6-alpha.1`，换成别的版本时**行为不做保证**。不要写成「版本不符就复核不触发」——并不存在一条按版本号判断的机制，那种说法既没有代码支撑也无法验收。
  - **「API 形状分两处检查」为什么一处用不上了也还留两处**：从 03 起 `ctx.sessions.get` 只服务**激活门禁**——复核取主会话改走 pre-step 载荷的 `agent.session`（下一条），插件里已经没有 `ctx.sessions.get` 的调用方。但「激活时它必须是函数」是规格明写的验收（`测试决策` ①：激活阶段报错并点出缺的是哪个）：删掉这条检查，`loading-config.spec.ts` 的「sessions.get 缺失时激活阶段报错」变红，所以它保留；变的只是它不再是取主会话的路径。
  - **复核取主会话走 pre-step 载荷的 `agent.session`**：快照（`session.deriveMessages()`）、路由（`session.requestHeader()?.config`）与结论应用都从这个会话取，不经 `ctx.sessions.get`。载荷里的 `agent` 由派发器注入（`packages/core/agent/src/dispatch.ts` 的 `agentEvents`：`fused` 把 `agent` 并进载荷，且展开在调用方字段之后，调用方盖不掉它）；DSH 自己的 pre-step 监听器同样从载荷取 `agent.session`（`packages/context/tmux-context/src/index.ts`、`packages/context/time-context/src/index.ts`、`packages/session/session-checkpoint-policy/src/index.ts` 等十来处）。因此插件既不需要 `inject` `agent`，也不需要自己按 id 去找会话。
  - **监听 `agent/pre-step` 不需要新增服务**：事件派发按作用域过滤，未打 scope 标记的监听器**全收**——`packages/core/scope/src/index.ts` 的 `scopeTarget` 在 `tag === undefined` 时直接返回 true。同类先例是 `packages/compaction/compaction-basic/src/index.ts`（它的 `inject` 不含 `agent`，照样 `ctx.on('agent/pre-step', …)`）。这条原先只有源码核对；03 的集成夹具把它变成运行时保证（见「验证状态」G12），所以插件的 `inject` 保持 `['llm', 'sessions', 'sessionProjections']` 不变。
- 复核请求是只读的：它唯一的写入路径是按「各结论的上下文策略」把结论作为 plugin notice 消息追加到主会话。

## 已决定的设计选择

### 观察范围

只观察用户发起的顶层会话——判别式是会话头部的 `origin !== 'subagent'`。**不能**用「没有 `parentSession`」判别：`parentSession` 是 fork 血缘，用户自己 fork 出来的会话照样带它而不带 `origin`（`packages/api/session-controller/src/commands.ts:258-272` 只写 `parentSession` 与 `isSeeded`；核心 `Sessions.fork` 同样只写这两个，`packages/core/session/src/index.ts:1244-1249`），只有子 agent 子会话才写 `origin: 'subagent'` 与 `delegationDepth`（`packages/subagent/subagent/src/child-agent.ts:149-155`；字段语义见 `packages/core/session/src/types.ts:105-122`：`parentSession` 是 lineage，`origin` 才是子会话分类）。按旧判别式，用户 fork 出来的会话会被当成子会话，不触发复核也不计数——G6 实测：fork 出来的会话头是 `parentSession=<源会话>`、`origin=undefined`。子 agent 的子会话不触发复核，也不参与计数。

理由有两条：DSH 里子会话是常态，每个都按同一个间隔触发会让调用量与副作用放大一个量级；更要紧的是语义不通——子 agent 的初始提示是用 `source: { kind: 'user' }` 投递的（`packages/subagent/subagent-in-process-driver/src/index.ts:181`），按判别式会被当成用户介入，重置计数、开启新的自主执行区间，而子会话里几乎不会有真正的用户消息。首版不覆盖子会话；要覆盖得单独评估成本与语义。

### 计数口径

计数只在主会话**成功提交一次 `assistant/message`**（不带 `interrupted`）后 +1。失败与被中止的请求、以及所有 navigator 辅助请求都不计数。

可观察的判别信号是必要的：`step/start` 与 `step/end` 对失败和中止的步骤同样会写（`packages/core/agent-loop/src/agent.ts:303,313`），不能用来计数；宿主投影 `turnBoundary`（`packages/core/agent-loop/src/index.ts:44-89`）只含 `openTurnStartSeq` / `lastStepStartSeq` / `lastStepBoundary` / `lastTurn`，**不含步数**，同样不能用来计数。计数由插件自己注册的一个 **session projection** 折叠（`ctx.sessionProjections.register`），**不读历史日志**：三个同步历史读取器已被 DSH 禁止新调用，而现成投影都不等于上面的口径（`turnBoundary` 不含步数；`sessionStats.steps` 数的是 `step/end`，其文件头注释明说数 `assistant/message` 会多算 max-tokens 的空消息、少算被取消的步）。投影在恢复时由框架重折叠，正是那份 Agent Note 指定的替代路径。它是注册成服务的：`ctx.sessionProjections`（`packages/session/session-projection/src/index.ts:199-208` 的 `super(ctx, 'sessionProjections')`），所以 `@deepseek-ai/dsh-session-projection` 同时进 `peerDependencies` 与 `devDependencies`，并且插件的 `inject` 必须列出 `sessionProjections`（同 `packages/session/session-stats/src/index.ts:20`）——只把它列进 `package.json` 而不 `inject`，取 `ctx.sessionProjections` 会直接抛 `cannot get property "sessionProjections" without inject`（G11 实测），插件根本用不上投影。**锚点也由同一个投影折叠**：`apply` 由框架在每个已提交的会话事件上驱动（`packages/session/session-projection/src/index.ts:220-222` 订阅 `session/event` 后调 `drive`），折叠到真实 `user/message` 时就记下当时的已完成步数，所以锚点不靠监听某个事件现取，重载重折叠后得到的值与运行期一致。**这个折叠读数的口径写在这里（票面只引用本节，不在别处另立一套坐标）**：它是折叠器推进到那条 `user/message` 时的 `steps`——投影只看已提交事件，而一条消息在第 N+1 步的 pre-step 里被 claim、要到该步打开提交时才作为 `user/message` 落盘（`agent.ts:376`），此刻本步的 `assistant/message` 还没提交（`:475-477`），所以这个读数取的是「写这条消息时已提交的助手消息条数」，与口语里的「第几步来了这条消息」可能差一格。规格那一幕（第 70 步来消息、下一次 120）按规格自己的坐标读，**插件用的锚点就是这个折叠值，运行期与重载两侧共用同一个量**；差一格的取舍与实测证据见「验证状态」，票据不得把这个读数在别处再定义一遍。投影的 `stateSchema` 与存储记录的值校验都用 zod（DSH 用 `^4.4.3`，需同大版本），所以 `zod` 属于普通库依赖。G7 实测：投影在事件全部写完之后才注册，仍折出整段历史并给出正确口径。

### 触发节奏

在同一个自主执行区间内，触发点始终是「上次触发点 + `triggerEverySteps`」，到点时若已有复核在跑就跳过：不重置节奏、不顺延、也不补打。慢复核因此不会无限推迟后续复核。

**重新观察一个会话时（插件刚加载、或会话被重新打开）不能沿用内存里的「上次触发点」**，必须重新推导——否则真实用户消息带来的重置会在重载后丢失。这是一个真实缺口：第 50 步触发过、第 70 步用户发了消息（下一次应为 120），第 80 步插件重载时若只按「最后一条复核记录」取基线，会得到 50，下一次变成 100，重置被丢掉。

推导式取三个候选的最大值，再加一个间隔：

```
下一次触发点 = max(最后一条复核记录里的触发步骤,
                   最后一条真实用户消息记入会话日志时的已完成步数,
                   floor(当前步数 / triggerEverySteps) × triggerEverySteps)
             + triggerEverySteps
```

第三个候选是为了「不立刻补打」：重载时当前步数可能正好落在间隔的整数倍上，只用前两项会算出一个已经过去的触发点。代价是重载会把节奏重新锚定到当前间隔的整数倍，可能比原节奏晚一次——比丢掉重置或立刻补打都小。

不能在插件加载时就算：插件是全局加载一次的，主会话通常在它之后才出现，所以每次重新观察一个会话时算一次。真实用户消息开启新的自主执行区间，运行期间的下一次触发点 = 「这条消息记入会话日志时的已完成步数 + `triggerEverySteps`」——例如第 50 步触发过、第 70 步用户发了消息，下一次是第 120 步。**运行期这一侧与重载那一侧不是同一条写法，衔接处是「取较大者」而不是直接覆盖**：每个步边界先取内存里的触发点，非空时只做 `max(内存触发点, 锚点 + triggerEverySteps)`（这一步要轻量，因为它每个步边界都跑，不重算推导式里的另外两项）；内存值为空（首次观察）时才按上面那个三项取最大的推导式写入。**为什么必须如此**：锚点只在新的真实用户消息落盘时移动，如果每个步边界都无条件用「锚点 + 间隔」覆盖内存值，同一个自主执行区间内会把触发点反复钉回「锚点 + 间隔」——第 5 步来消息、锚点 5 时触发点是 55，锚点此后不再移动，第 55 步那次复核刚推进到 105 就会被覆盖回 105 以下的某个值，**第 105 步那次复核永远触发不了**；反过来，只在重置发生时把触发点直接写成「锚点 + 间隔」在推导上等价，但会把「比较」与「写入」拆成两处状态，而它本来就是同一个判据的两面。**重载那一侧恰好相反**：重载后内存触发点已经失效，按推导式覆盖写，**不能**对旧值做提升——推导值可能小于旧内存触发点（间隔改小的那幕里旧值是 155、推导值 125），提升会把离网格的旧触发点又拉回来。实现在这一点上不会踩到冲突：重载走的是新建实例、内存为空，不存在旧值可提升。锚点的取值方式见「计数口径」：由那个投影折叠到这条 `user/message` 时记下当时的步数，重载重折叠得到同一个值。**不能取插件注意到消息那一刻的计数**：`agent/inbox/inserted` 在 splice 时就发出（`packages/core/agent-loop/src/inbox.ts:238-243`），而这条消息作为 `user/message` 由某一步打开时的提交写出（`packages/core/agent-loop/src/agent.ts:376`），中间可能夹着一次步骤完成（本步的 `assistant/message` 要到 `:475-477` 才提交）——按 splice 时刻计数会比落盘时少至少一步（`steer` 差一步；`followup` 进下一轮，其间可完成多步），于是重载后从日志重新推导会算出不同的触发点。另有一层：本步的 pre-step 若返回 `reject`，`agent.ts:291-293` 直接返回，提交循环永不执行，这条消息**根本不会落盘**，splice 时刻记下的锚点在日志里就没有对应物。监听该事件的目的只是及时判定「等待期间的复核要作废」，与锚点取值是两件事。

### 真实用户消息的判别

判别式固定为 `role === 'user' && source.kind === 'user'`（`packages/llm/llm/src/message.ts:98-128`）。插件注入的建议是 `source.kind === 'plugin'`，工具结果是 `source.kind === 'tool'`，因此复核自己注入的建议不会重置计数。判别式只认这一个来源，**不枚举其它 kind**——`MessageSourceMap` 是可合并扩展的，DSH 自己就有十来个 kind（webhook、agent-team、agent-instructions、session-reference、skill、tool-skill、session-controller、subagent 等各自扩过），遇到不认识的 kind 一律按「不是真实用户消息」处理。

真实用户消息有两条到达路径，由 `packages/api/session-controller/src/commands.ts:360-361` 按 `request.mode` 分流：`followup` 进入「下一轮」（`packages/core/agent-loop/src/agent.ts:137-139`），`steer` 进入「下一步」（`agent.ts:141-143`）。两条路径由同一个事件覆盖——`agent/inbox/inserted`（`packages/core/agent/src/runtime-types.ts:288`，由 inbox 的 splice 发出），所以监听它一处即可，不需要分别处理。注意我们自己的 `inject` 也会触发它，因此必须按 `source.kind === 'user'` 过滤。

### 辅助请求的消息构成

- 消息序列 = `session.deriveMessages()` **原样**（`packages/core/session/src/index.ts:841`）**加末尾一条 user 消息**；**不设 `system` 字段**、**不传 `tools`**。主会话的消息一个字节都不改，整段对话因此成为真前缀（缓存问题见 G5）。快照在触发点冻结：并行模式若推迟到发送请求时才取，会看到触发点之后的新步骤。
- 末尾那条 user 消息 = **可替换的复核提示词在前、固定的复核角色与输出契约在后**。插件内置默认提示词，YAML 配置 `prompt` 即替换前半段；后半段固定，用户改不掉。
- 选这个形态而不是「自带 system 指令 + 把历史压平成 JSON」的理由：它是 DSH `compaction-basic` 在生产里使用的形态（注释在 `packages/compaction/compaction-basic/src/summarizer.ts:24-29`，明写「把对话自己的 system prompt、tools 与消息前缀留在前面，使辅助调用成为上次请求的真前缀，从而复用 KV 缓存」；构造在 `:144-150`），保真度最高（tool call/result 配对不被压平），也不需要搬运主会话的 system prompt。
- 已知风险：复核会先读到主会话自己的 system 指令，可能误以为自己是主 agent 而继续任务。缓解是末尾固定指令显式声明复核者角色 + 严格结构化校验——最坏情况是一次复核失败（按规格的失败表，默认让主会话继续），不会损坏会话。
- 不传 `tools` 是刻意的：规格里「复核不执行工具」这条要求就靠它落实。compaction 传 `header.tools` 的做法不能照抄。

### 结构化输出的强制方式

DSH 没有 JSON mode、response schema、`tool_choice` 或解析助手（`packages/llm/llm/src/types.ts:453-493`）。因此「不能删除结构化字段」由末尾固定指令 + 校验失败即复核失败保证，不由模型保证。

输出契约固定在末尾指令里：只输出一个 JSON 对象，含 `verdict`（取 `continue` / `adjust` / `stop`）、`reason`、`recommendation`，后两者为非空字符串。不是 JSON、缺字段、枚举非法，任一项都按复核失败处理。

**解析从严**：整段输出去掉首尾空白后必须本身就是那一个 JSON 对象；带代码块围栏、前后夹带文字、出现第二个顶层 JSON 值都算失败；对象内部多出契约之外的字段不算失败。不做「从文本里提取 JSON」的宽松解析——宽松解析会让「用户删不掉固定字段」这条契约失效，而且模型偶尔加围栏的习惯会变成隐性的格式漂移。

### 各结论的上下文策略（第一版固定，不提供配置项）

| 模式 \ 结论 | `continue` | `adjust` | `stop` |
| --- | --- | --- | --- |
| 等待 | 不进入主模型上下文 | 注入建议 | 追加可见说明并停止当前 turn |
| 并行 | 不进入主模型上下文 | 注入建议 | 注入建议（携带触发步骤与过期标注） |

第一版不把这张表做成配置项：没有具体场景证明需要改默认值，配置项只会增加契约面。关闭复核的方式是不加载插件，不为「关闭」增加配置值。

### 失败处理

失败、超时或输出无法解析时只写诊断记录，不注入建议，也不追加用户可见说明。`failurePolicy: stop` 仅对等待模式生效，且复用与 `stop` 结论相同的停止机制，说明为复核失败。并行模式一律 `continue`，不做降级注入。

**失败与取消的判别式**：两者都要写记录，靠两个信号分开。超时由 `deadline` 用带 `REVIEW_TIMEOUT_CODE` 的 `TimeoutReason` 中止融合信号，判别式是 `timeoutOf(signal, REVIEW_TIMEOUT_CODE)` 命中——命中算超时（失败）；未命中的 `aborted` 是任务结束 / 任务取消 / 插件释放（取消），结算不为它落失败记录，否则取消记录会被同键的迟到失败写入覆盖。输出无法解析走正常收场（`finish { kind: 'stop' }` + 文本过不了 `parseReviewOutcome`），算失败。**失败分类的输入有两条来源**：流的终止 `finish`（适配器抛错 / 输出无法解析 / 超时）与 `ctx.llm.stream(...)` 调用或消费循环抛出的异常（中间件 / 下游抛错）——后者的机制见「测试决策」的「中间件失败保持抛出」：`llm/stream` 是 waterfall，监听器在调用点同步跑，而回退返回的是尚未迭代的异步生成器，所以中间件的抛错落在 `ctx.llm.stream(...)` 这个调用表达式上（`next()` 之前），根本到不了迭代，必须由结算自己 catch 并把它归成这次复核的失败（**写入落点见下一段**，不在结算里落盘）；适配器侧抛错则由 `adapterFailureChunk` 归一成终态块，插件侧 catch 不到。拿不到路由（会话还没有路由信息）也是失败之一，按同一张表落记录，但触发点必然已写入 `request/header`，构造不出可证伪的用例。

**失败结算的落点**：失败与完成态走**同一个落点**——结算只做分类（超时 / 输出无法解析 / 拿不到路由）并把结算数据交回调用点，**不在结算里落盘**。写入落在应用点，因为只有应用点看得到本次复核收场那一刻「尚未被任何一步处理的消息」（定义见「注入与停止机制」）；失败路径还必须照读在途作废信号 `review.invalidated`（同上那唯一的 `agent/inbox/inserted` 监听器置位），为真时落取消记录、取「取消」优先（规格 `实现决策 · 记录与诊断`「同一次复核既满足失败又满足取消时，取「取消」」）。结算内落盘会让失败记录早于这次读取落下，随后被同键的取消写入覆盖——正是 04 禁止的「先落后覆盖」。**并行模式没有可以回去的应用点**（那一步的 pre-step 早已返回，续体是脱离本步跑的），所以并行两格的失败记录由续体自己落、一条；并行不注入任何消息，也**不读** `review.invalidated`——在途到达的真实用户消息在并行模式下的处置是给已入队建议补过期标注（见「注入与停止机制」），不是作废，「等待期到达的真实用户消息一律让本次复核作废」只覆盖等待模式。逐格分工：

| 格 | 谁落盘 | 落盘前读什么 | 「未处理的消息」那道检查 |
| --- | --- | --- | --- |
| 等待 × `continue` | 应用点 | `review.invalidated` | 不跑 |
| 等待 × `failurePolicy: stop` | 应用点 | `review.invalidated`，外加未处理的消息 | 跑：命中就落取消记录，不加说明、不停止 |
| 并行 × `continue` / `stop` | 复核续体 | 无 | 不跑 |

**那道检查只挂在会产生干预动作的那一支**（等待 × `failurePolicy: stop`，即追加停止说明、停止 turn 之前），与「注入与停止机制」里「`verdict` 过滤只加在应用点检查那一支」同源：它是干预动作的前置检查，不产生干预动作的格不做。做成「所有失败路径都跑」会让 04 的失败列（同样是失败输入，触发点那次 pre-step 照旧 claim 到真实用户消息）被读成取消态、整列变红。落点改动不改变 04 失败列的读数——那一列按真实收场读记录，等待 × 默认策略仍恰一条。

### 注入与停止机制

- **建议注入**（`adjust`、并行 `stop`）统一用 `form: 'notice'` 的 user 消息（`packages/llm/llm/src/message.ts:90-94`），**必须带可读的 `summary`**，并用 `boundContextSummary()` 截断到 120 字符上限（`packages/llm/llm/src/message.ts:114-125`）：客户端把它渲染成默认折叠的「上下文注入」行，没有可读 summary 就降级成不透明内容（`packages/client/ui-chat/src/client/chat/ContextBody.tsx:533-574`）。消息正文固定包含触发步骤，且写在正文开头——摘要就是正文的截断（`boundContextSummary()` 作用于正文），折叠行里才看得到触发步骤；若投递时触发点已不属于当前自主执行区间，还必须写出「它来自上一段执行、可能已不适用」，由模型和用户自行判断。**过期的判据与落点**（只对并行建议）：判据是「从触发点算起、到建议送达为止，主会话收到过真实用户消息」——不论那条消息落在建议产生之前还是之后；它与「触发点已不属于当前执行区间」等价，因为真实用户消息就是执行区间的边界。落点分两段，都不依赖内存状态：（a）**产生时**——复核返回、准备注入之前，先比较锚点（最后一条真实用户消息记入会话日志时的已完成步数，由「计数口径」的投影折叠得到）与建议携带的触发步骤：锚点 ≥ 触发步骤就直接把标注写进正文再注入（相等意味着那条用户消息正好落在触发点上；新执行区间里触发的复核不会满足这一条，因为触发点至少比锚点晚一个间隔）；（b）**待投递期间**——观察到真实用户消息时（`agent/inbox/inserted`，按 `source.kind === 'user'` 过滤），遍历 `agent.inbox.nextStep` 与 `agent.inbox.nextTurn`（`packages/core/agent/src/runtime-types.ts:47-52`），把其中属于本插件（`source.kind === 'plugin'` 且 `source.plugin` 是本插件名，`packages/llm/llm/src/message.ts:104`）、还没带标注的消息用 `agent.inbox.replace(messageId, 改写后的消息)`（`runtime-types.ts:71-77`，返回该消息是否仍在 pending）补上标注。**不能用步数比较代替（b）**：真实用户消息在 `agent/inbox/inserted` 那一刻还没落盘（它作为 `user/message` 由某一步打开时的提交写出，`agent.ts:376`），锚点还是旧值，所以「锚点 > 触发步骤」在唯一还能改写正文的那个窗口里恒为假（G9 实测：插入事件时锚点 0、建议触发步骤 1、`replace` 返回 true、判据为假；投递之后锚点变 2，但 `replace` 已经返回 false）。建议正文在 `agent.inject()` 那一刻就随 splice 落进 durable inbox（`inbox.ts:229-238`），而送达时这一步的 pre-step 已经把它 claim 走（`agent.ts:245` 早于 `:250` 的 waterfall），所以补标注只能在 claim 之前做。等待模式的说明没有这个窗口——等待期间出现真实用户消息时本次复核直接作废，说明不会迟到。等待模式 `stop` 与 `failurePolicy: stop` 追加的**停止说明**走同一种消息形态（同样是 `form: 'notice'` 且必须带可读 `summary`），正文写明触发步骤与停止原因。
- 等待模式在触发点的 `agent/pre-step` 里把建议追加进返回的 `decision.messages`。
- 并行模式用 `agent.inject(msg)` 排入下一次 pre-step，不唤醒主会话、不打断当前步骤。排入的消息留在 durable inbox：主会话仍在运行时在最近的 step 边界被 claim，已经 idle 时保留到下一次 followup/steer 唤醒才投递。**任务正常结束时因此不会丢**，跨执行区间送达时靠过期标注说明。但 `cancel` 默认清空待处理队列（`packages/core/agent-loop/src/agent.ts:149-155`），而取消的调用方（用户按停止、API 层、进程退出）不由插件控制，所以**任务被取消时这条建议随之丢失**——这是规格里明确接受的例外；要兑现「取消也不丢」就得插件自己持久化待投递的建议并在下次唤醒时重投，代价不划算。
- **停止**分两步：先用 `session.append('user/message', notice, { surfaceOp: 'append' })` 追加一条面向用户的说明，再调 `agent.cancel({ kind: 'hook', reason })`。注意 `surfaceOp` 是字符串 `'append'`，写成 `{ op: 'append' }` 会在 append 时直接抛错（`packages/core/session/src/surface.ts:269-305`）。
- **等待期到达的真实用户消息一律让本次复核作废。** 判据只认 `role === 'user' && source.kind === 'user'`。危害有两处：在 `agent/pre-step` 阶段停止时本步被 claim 的消息**不会**写入会话历史（探针实测：claim 已把消息取走，而 step 从未打开），而 `cancel` 默认清空整个待处理队列（`agent.ts:149-155`）——两者都会让用户刚发的话静默丢掉。因此应用任何结论前先检查**尚未被任何一步处理的消息**：本步被 claim 的批次 ∪ `nextStep` / `nextTurn` 待处理队列。**队列那一半不能省**：`followup` 落「下一轮」、`steer` 落「下一步」（`agent.ts:137-139`、`:141-143`），而 claim 早于 waterfall 派发（中间还隔着 `systemPrompt.assemble` 与排在本插件之前的 handler 的序言），消息落在在途登记之前时既进不了 claim 批次、也没有在途对象可置位，只剩队列上看得见。另一条信号是唯一的 `agent/inbox/inserted` 监听器（在途登记从触发点决定起，覆盖 `next()` 与复核请求，收场后注销），管的是「到达时复核已在途」那一半——并行模式用的是同一个事件，但目的是改写已入队建议的过期标注，见上面「建议注入」。命中的处置是作废：不注入、不停止，让该步正常继续。**verdict 过滤只加在应用点检查那一支**：在途到达那一支任何结论都作废，应用点检查那一支只在 `adjust` / `stop` 上作废——`continue` 不产生干预，照旧落完成态。规格三处（「一律」、测试决策里「这种情况下写出的记录状态是「取消」」、「状态怎么取」）都没给结论加限定，所以这条过滤是本实现的取舍而非规格的读法：等待模式的触发点那次 pre-step 正常会 claim 到用户自己那条消息，`continue` 不过滤则普通复核也会被记成取消，04 的完成态三态格就会读到取消态而变红。规格的记录表按状态取值（完成 = 拿到结论并解析成功）。这落实了规格里「等待复核期间的真实用户消息让复核作废」这条。**任务取消与任务结束都从另一条路径来，应用点检查看不到它们。** 任务取消会先清空整个待处理队列再 abort（`agent.ts:149-155`），不产生新的 claim；此时 pre-step payload 的 `signal` 会 abort（`agent.ts:244` 取 `phase.abort.signal`，`:251` 传进 payload），可以从它察觉。**但任务结束（turn 正常收尾、会话转入空闲）不会 abort 这个 signal**：`kick` 的 finally 把 phase 置为 idle 且不 abort（`agent.ts:231-238`），而 `cancel` 只 abort 非 idle 的 phase（`:149-155`）。所以照「只监听 signal」实现，并行复核会在会话已经空闲之后照常跑完并投递建议，「任务结束一律取消在途复核」静默失效，规格里「任务结束」这种取消原因也永远取不到。任务结束的察觉信号是 `agent.whenIdle()`（`packages/core/agent/src/runtime-types.ts:191`）：它的语义是「整个 agent 的活动到达静止，并跟随此前启动的替代工作」，因此不会把「idle 后同一 tick 又被新输入唤醒」误判成任务结束。并行复核与它赛跑——`whenIdle()` 兑现时按 `signal.aborted` 决定写哪种取消原因：已 abort 就是「任务取消」，否则是「任务结束」。**不能用「谁先到」判定**：任务取消总是先 abort `signal`，但复核自己的请求什么时刻收场由传输层决定，可能早于也可能晚于 `whenIdle()`（G10 实测：abort 后 0ms 结算时复核先到、30ms 结算时 `whenIdle()` 先到，而那时 `signal.aborted` 已经是 true），按到达顺序会把它误记成「任务结束」。**这份 `signal` 还必须跨 turn 边界的控制器替换仍成立**：`turn()` 末尾在有待领输入时整体换掉控制器（`packages/core/agent-loop/src/agent.ts` 的 `phase.abort = new AbortController()`），**旧 controller 不被 abort**——触发步捕获的那份 pre-step signal 因此只覆盖「其间没有跨过这个边界」的取消，跨过之后用户取消 abort 的是新 controller、旧的那份仍读作未中止，会把「任务取消」误记成「任务结束」。会话已经空闲时 `cancel` 更不产生任何 abort（只 `inbox.clear()`），此时信号面上两种原因不可区分。所以判据要取一个跨这次替换仍成立的信号面（`turn/end` 的 aborted 原因是候选之一），或把「只覆盖同一次驱动」这一边界写明。
- **取消原因要按 `signal.reason` 的 `kind` 分开**：取消原因是 `AgentCancelCause`（`packages/core/session/src/types.ts`）——`{ kind: 'user' | 'parent' | 'hook' | 'disposed' }`。用户取消与 Agent 释放走**同一条 abort**（`cancel` 对非 idle 的 phase 只做 `phase.abort.abort(cause)`），差别只在 cause：用户停止那条路径是 `{ kind: 'user' }`，本插件自己的停止动作传 `{ kind: 'hook' }`。`{ kind: 'disposed' }` 的调用点是 agent-loop 的 **Agent 实例释放**——`packages/core/agent-loop/src/index.ts` 里 reverse teardown 的 `dispose` 闭包（`machine.cancel({ kind: 'disposed' })`）与同文件 `prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })`。**卸载插件不中止 Agent**（插件自己的 fiber 释放不经过这两处），所以「任务结束 / 任务取消」那条路径的判据在 `signal.aborted` 之上再看 `signal.reason`，是为了把 Agent 级取消与用户取消分开（票据 10）；插件重载 / 卸载那条释放路径拿不到这条 abort，要由**插件自己的释放路径**察觉并收口（票据 11）；同理，`turn()` 末尾换掉控制器时旧 controller 不被 abort，跨过 turn 边界之后连这条 `disposed` 也不再进入信号面（旧那份仍读作未中止）——**跨边界**取哪种取消原因另按上一条的边界处理。两条释放路径共用「中止在途复核 + 落取消记录」这同一个入口，分开它们的不是 `signal.reason`（插件释放没有它），而是各路径自己的触发点（票据 10 与 11 的分工见各自票面）。
- 因此**不需要客户端插件**：追加的 notice 消息本身会以可回放的折叠行呈现（`packages/client/ui-chat/src/client/conversation-nodes/message.ts:47-64`、`packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx:31-71`），无需新增渲染节点。代价是说明文本进入主模型上下文，规格里记录与上下文的边界已按此调整。
- ACP 侧不做任何修改：DSH 的 `turnEndToStopReason` 会把非客户端取消压平成 `end_turn`（`packages/acp/acp/src/codec.ts:14-33`）；而且 ACP 只转发助手消息与工具调用/结果，不转发 `user/message`（`packages/acp/acp/src/updates.ts`），所以那条追加的说明对 ACP 客户端不可见。这与首版「ACP 只返回普通结束状态、不要求显示详细原因」的边界一致。

### 模型配置继承粒度

继承 `provider` + `model` + `reasoningEffort`，`maxTokens` 用 `maxOutputTokens` 覆盖，`temperature` 固定为 0。理由：复核是判断题，推理强度直接影响判断质量；但复核不需要创作随机性，固定 0 减少随机性、便于复现（不保证逐字一致）。注意仓库内没有任何辅助调用转发过 `reasoningEffort`，这是一条新行为，见 G2。

### 复核记录的存放位置

复核生命周期记录**不使用 Session 事件**，写入插件自有的 storage 域。声明形状用裸对象字面量（不引入 `defineDomain`——它是运行期导出，会让产物多一个运行期 import，见「预构建产物的装载与启动审计」的运行期 import 清单）：`ctx.storageDomain.open({ name: 'clipclop_review', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { … } })`。取 `backup-and-skip` 而不是默认的「整个域打开失败」，是因为记录是诊断数据，一条坏记录不该让插件加载不了（该选项见 `packages/storage/storage-domain/src/spec.ts:67,129-132`；它需要后端提供 `KvUnit.backupRecord`，缺这个能力的后端会退回整个域打开失败）。`per-record` 在 JSON 后端下是一条记录一个文档，记录的值需要 schema 校验（该能力用 zod）。取舍与证据见 [ADR 0002](adr/0002-review-records-outside-session-log.md)。

**域在插件加载路径上 open**：`apply` 里 `open` 并持有句柄，由该 fiber 的释放回调 `close`。惰性打开会让「坏记录不挡加载」落空——坏记录正是在 `open` 的装载路径上被 `backup-and-skip` 跳过的。代价两句：`open` 会 `loadAll` 把整张记录表读进内存，而首版不做记录清理；`internal/update` 重启（改配置）会先 `close` 再重新 `apply`（→ 再 `open` → 再 `loadAll`），把整张表再读一次。夹具改配置时因此要把 `ctx.plugin` 返回的 fiber 暴露给用例，并在 `fiber.update()` 之后用 `fiber.await()` 等待这次重启 settle——`update()` 在 ACTIVE 时返回内部 `internal/update` waterfall 的结果（缺省那条即 `restart()` 的 promise），不 await 就在 `apply` 还没跑完时读记录。

**键的形状是一会话多条**：一次复核一条记录、一条记录一个 JSON 文档，所以同一会话的多次复核各占一个文档；表只有一张，键 = 会话 id 的路径安全变换 + `_` + 按次递增的十进制判别值（用触发步骤）。`SessionId` 是任意字符串、可能自带 `_`，所以读回时按键的**最右**一个 `_` 解析出会话 id 再**精确比较**，不做前缀匹配——前缀会让会话 `a` 读到会话 `a_1` 的记录。键还必须 path-safe：`per-record` 布局的 JSON 后端在写入时断言键匹配 `[a-zA-Z0-9_-]+`（不匹配直接抛错，见 `packages/storage/storage-json/src/per-record-unit.ts`），载入侧静默跳过不匹配的键；而会话 id 允许调用方自带（`session-controller` 的 `request.sessionId ?? session-<uuid>`，`SessionId()` 只是品牌转换），任意字符串会同时踩「写不进」与「读不回」。所以会话判别段取会话 id 的**确定性路径安全变换**：字母表落在 `[a-zA-Z0-9_-]` 内、不产出 `_`、**且必须单射**，首版用十六进制；「把危险字符换成 `-`」这类非单射写法会把两个不同会话混成一个键，与「不做前缀匹配」防的是同一类错。读回列表按触发步骤升序，「最后一条复核记录的触发步骤」取这个列表的末条。

**读写入口与 writer 的关闭次序**：记录在插件自有存储域里，外部行为观察不到，所以本包导出两个函数——写入入口（接受完整参数、落一条记录、用唯一的存储域）与读回入口（按会话 id 返回该会话的记录列表，已按声明 schema 解析、按触发步骤升序）。两者都是**随包发布的对外表面**，不只是测试面。运行时写入不得依赖模块级可变量：`apply` 内部持有的 writer 才是运行时唯一入口，它绑到本实例的域与自己的 disposer。次序不变式两条：①writer 承诺「记录已落盘」时本实例的域仍开着；②fiber 释放（`internal/update` 重启、卸载、重挂载）时，取消结算要么在域关闭之前落盘，要么按「无法落盘」处理，绝不写进一个已关闭或已换代的句柄。

**记录的形状（读写两个入口共用的公开契约，域声明的 zod schema 按它写）**：记录内容为触发步骤、快照里每条消息的 id 列表、配置快照、结论、用量、耗时、失败原因、取消原因、状态；逐状态不变式与规格的记录表同源，票面按它逐格断——**唯一例外是完成态的 `usage`**：规格表的完成格写「有值」，而 `usage` 块只能来自流本身（`BlockAssembler.usage` 在收到该块前为 undefined，DSH 也不为缺失的 `usage` 合成一块），票面因此把这一格收窄成「流里出现 `usage` 块时有值」，规格表是否同步由规格方决定。要点三条：`messageIds` 可空（取到快照之前就结束则整个字段缺省），`verdict` 完成态必有、`usage` 完成态在流里出现 `usage` 块时有值、失败 / 取消可空，`cancelReason` 用 `'invalidated' | 'task-ended' | 'task-cancelled' | 'plugin-disposed'` 这个封闭联合表达、取消态必有（用封闭联合，三条取消路径才不必各写一份字符串字面量）。`ReviewOutcome` 是 `src/verdict.ts` 的既有类型，`TokenUsage` 取 `@deepseek-ai/dsh-llm`；**读取入口的完整参数 = 会话 id + 这个形状**，会话 id 只进键、不进记录值（规格的记录字段表里没有它）。**完整字段定义（形状即决定）内联在票据 04，本节只留机制与理由**。不复制消息正文（按 id 从当前投影取回）；发给复核的快照不截断。

**回放**是插件导出的诊断用纯函数（运行时不被插件自己调用）：输入记录里的消息 id 列表与会话当前的模型可见消息，返回两个列表——命中的 id 序列、定位不到的 id 列表。它只保证命中的 id 与顺序，不比内容（存在保留 id、只改写内容的投影），被压缩替换掉的消息取不回；记录本身不进会话日志、也不参与会话检索。首版不做记录清理，代价是记录随会话长期累积，需要时手工删除。

### 省略辅助请求的 purpose

`purpose` 是可扩展性为零的内联闭合联合（`packages/llm/llm/src/types.ts:487-492`），新增取值必须修改 DSH 核心类型与 deepseek adapter。因此首版省略 `navigator` purpose 不是取舍，而是「不修改 DSH 源码」约束下的必然结果。

### 发行与联调

第一版只承诺「本地 profile 内 `node_modules` 链接 + 预构建产物」：Desktop 的插件安装 UI 只接受 npm registry 包且以 `--ignore-scripts` 安装（`apps/desktop/src/project-manager.ts:387-391` 的 `pnpm add <spec> --ignore-scripts`），不发 prepare，因此必须提供构建产物；registry 发布留到契约稳定之后。

### 预构建产物的装载与启动审计

产物验收（02b）不经过真实 bin，也不用 DSH 仓内那套 profile 夹具——它是仓内测试夹具、不随包发布。夹具用发布态 `@deepseek-ai/dsh-app-boot` 的公开符号在本仓库自行装树，再调它的审计。以下各条按发布态 `0.1.6-alpha.1` 的**源码核对**得出，探针实测与源码依据的分界见「验证状态」。

- **装载入口**：`mountRootInclude(ctx, absoluteConfigPath, patches?, bareModuleBaseUrl?)` 挂根 include 并注册 `cordis:include`/`cordis:group` 内建；`boot` 是同一条路径的封装（`ctx.plugin(Loader)` → `mountRootInclude` → 等 Loader 结算 → `auditStartupEntries`），并额外把 `ctx.baseUrl` 设为配置目录。`boot` 固定用默认 `warn`（写 stderr）、注入不了收集器，所以夹具自己调 `mountRootInclude`，再调 `auditStartupEntries(ctx, binName, warn?)`。
- **审计策略**：`auditStartupEntries` 只把**非必需条目**的失败交给 `warn`，必需条目与 bootstrap include 的失败直接抛；`warn` 在 `throw` **之前**调用。必需 id 是一小组固定值（`requiredStartupEntryIds`：`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`），本插件不在其中；停在 PENDING 的条目按 `pending (waiting for service(s): …)` 报出，单复数由缺失项个数决定。`inactiveEntries`、`activationDiagnostic` 是内部函数，不依赖。
- **`loadProfile` 一族不装树**：`loadProfile`、`loadProfileDirectory`、`PluginPackages`、`healProfilesModuleFallback` 虽公开导出，但不挂载、不返回 ctx，拿不到条目与 `fiber.state`。
- **裸包名的解析基点**：条目模块的 import 有两层。根 include 是 `Include extends EntryTree` 的实例；传了 `bareModuleBaseUrl` 时 `mountRootInclude` 把 `cordis:include` 内建换成裸名走 `internal.import(name, bareModuleBaseUrl, {})` 的子类，没传就退回 `EntryTree.import`——后者用 `ctx.baseUrl`（`mountRootInclude` 不设它），或直接 `import(name)`（以 loader 包自身的位置为基点）。嵌套 `cordis:group` 复用同一棵树，不改变基点。
- **`internal` 的来源**：`Loader.internal` 由 `cordis-plugin-loader` 用 `createRequire(import.meta.url)` 从**它自己的位置**解析 `node-addon-require-builtin` 得到，而后者是该 loader 的**可选 peer**（`auto-install-peers` 不装可选 peer）；`@deepseek-ai/dsh-app-boot` 的 `dependencies` 只是把它带进 store，能否解析到取决于 pnpm 的 `hoistPattern`。
- **从工作副本装载会假绿**：`internal` 缺失时基点参数被忽略，裸名退回 `import(name)`，而 pnpm 把 workspace 包提升进 `.pnpm/node_modules`（`@dsh-clipclop/dsh-navigator` → `packages/dsh-navigator`），于是加载工作副本同样进入 ACTIVE。所以「装载的是安装副本」必须由构造与断言共同保证：先断 `ctx.loader.internal !== undefined`，再用一条裸名只存在于本仓 store、临时 profile 里没有的对照条目正面证明基点——对照条目若能 import 成功，就说明基点落到了本仓 store。
- **不用真实 bin**：`@deepseek-ai/dsh` 的 `dsh` 入口与 `@deepseek-ai/dsh-loader-smoke` 的 `runLoaderSmoke` 只能给出「审计输出里没有该条目」这类否定式判据——漏挂、包名写错、被静默忽略时同样为真，证明不了条目真的激活。
- **接线怎么观察**：`SessionProjectionRegistry` 的公开读法只有 `stateOf(session, key)`、`snapshot(session, keys?)`、`cachedSnapshot(session, …)`、`checkpoint(session)` 等，全都要真实 `Session`；注册表字段是 private，没有「列出已注册单元」的读法。产物验收没有 Session（到 03 才有），所以「真的完成接线」用桩 `sessionProjections` 记录 `register` 的 `key` 来观察——注册成功即 `apply` 跑到了最后一步。（这是对规格「只验证外部行为、不断言函数调用次数」的有意例外：`register` 是插件对宿主服务的对外契约，不是内部计数器。）
- **服务缺失的正向观测为什么必须用最小 composition**：本插件的三个注入服务同时是必需条目 `agent-loop` 的注入集（`packages/bundle/base/cordis.patch.yml` 声明 `id: agent-loop`，`packages/core/agent-loop/src/index.ts` 的 `inject` 含 `llm`、`sessions`、`sessionProjections`）。在含它的组合里抽掉任一注入服务，`agent-loop` 会先停 PENDING 并被归入必需条目：审计先把可选条目（含本插件）warning 出去，随后直接抛错——「启动不失败」变红，那条 warning 也落在一次注定失败的审计里，不能当正向读数。
- **Cordis 的同一性**：夹具的桩与本仓库的 `@deepseek-ai/cordis` 同源；从临时 profile 按包名装载时两侧必须解析到同一份 cordis，否则桩 `provide` 的服务对插件不可见。**产物的运行时 import 有四个**：`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/dsh-timeout`（`deadline`）、`zod`、`schemastery`；其余服务包仍是 type-only。`@deepseek-ai/dsh-llm` 是 peer、`@deepseek-ai/dsh-timeout` 是普通依赖，临时 profile 都要能解析到，否则「条目 ACTIVE」这条断言直接红——所以它仍是环境前提，只是前提比 02b 时多。

## 验证状态

一次性探针在 DSH `0.1.6-alpha.1` 上实测通过的项目、仍未验证的项目，以及只有源码核对的项目。

### 已实测通过

| # | 结论 | 实测证据 |
| --- | --- | --- |
| G1 | `cancel({ kind: 'hook', reason })` 的取消原因确实进入 `turn/end`；停止发生在模型请求之前；在 `agent/pre-step` 监听器里直接追加 `user/message` 可行 | `turn/end` 的 reason 实测为 `{"kind":"aborted","reason":{"kind":"hook","reason":"navigator stop"}}`；适配器请求数为 0；notice 在 seq 3、`turn/end` 在 seq 4；notice 出现在 `deriveMessages()` 里 |
| G2 | 辅助请求的字段原样透传 | `reasoningEffort`、`temperature: 0`、`maxTokens` 均到达适配器；`system` 与 `tools` 都未设置 |
| G5 | 前缀缓存确实可复用：主会话请求带 `tools`、复核请求不带，两者共用同一段消息前缀时，复核请求仍能读到主请求建立的缓存 | 在 DeepSeek 兼容的第三方网关上用同一段前缀做对照：带 `tools` 的首次请求 `cached_tokens=0`；随后**不带 `tools`** 的复核形态请求 `cached_tokens=640`；重复带 `tools` 的请求 `cached_tokens=2816`；重复复核形态 `cached_tokens=1408`。说明 `tools` 字段不影响消息前缀的缓存复用 |
| G6 | 「顶层会话」的判别式必须是 `origin !== 'subagent'`，不能用「没有 `parentSession`」 | 探针造一个会话（写一次完整 turn）再 `Sessions.fork`：fork 出来的头部为 `parentSession=<源会话 id>`、`origin=undefined`、`delegationDepth=undefined`、`isSeeded=true`；两个判别式分别给出 false 与 true。子会话侧（`origin: 'subagent'` ＋ `delegationDepth`）为源码核对，未跑探针 |
| G7 | 步数可由插件自注册的 session projection 折叠得到，不需要读历史日志 | 探针在事件**全部写完之后**才注册投影：`checkpoint()` 给出 `seq: 10`、`counted: 1`，与口径一致——它看到 `assistant/message` 2 条（其中 1 条带 `interrupted`）、`assistant/attempt` 1 条，只有不带 `interrupted` 的那条被计数。恢复时的重折叠没有本仓库探针，但同一段路径由 DSH 自身的契约测试覆盖：`packages/session/session-projection/tests/registry.spec.ts:213`（事件流完之后才注册的单位按整段日志惰性折叠）、`:590`/`:612`（restore 折叠尾部、版本不符时从 init 重折叠）、`packages/session/session-projection-cache/tests/cache.spec.ts:664`（没有缓存行时按日志 hydrate）；本插件自己的「关闭再打开」断言在规格的测试决策里，该条按**在后端根下重挂载插件**构造（域在加载路径上 open、`loadAll` 的结果留在内存，只重开会话不重开域） |
| G8 | turn 正常收尾**不会** abort pre-step payload 的 `signal`（所以「任务结束」得另找察觉信号） | 探针 `g8-task-end-signal.mjs`：`captured_signal_aborted_after_turn_end: false`、`detached_review_outcome: still-pending-after-turn-end`、`turn_end_in_log: true` |
| G9 | 并行建议的过期标注只能在 `agent/inbox/inserted` 那一刻写；「锚点 > 触发步骤」这个判据在那个窗口恒为假 | 探针 `g9-expiry-anchor.mjs`：插入事件时锚点 0、建议触发步骤 1、`replace` 返回 true、判据为假；投递之后锚点变 2、`replace` 返回 false，建议（seq 21）落在用户消息（seq 22）之前 |
| G10 | `whenIdle()` 与「复核请求收场」的先后不可依赖；任务取消时 `whenIdle()` 兑现时 `signal.aborted` 已经是 true | 探针 `g10-whenidle-race.mjs`：abort 后 0ms 结算 → 复核先到；30ms 结算 → `whenIdle()` 先到且 `signal.aborted === true` |
| G11 | 没把服务列进 `inject` 时取它**不是** undefined，而是直接抛错 | 探针 `g11-inject-access.mjs`：`cannot get property "sessionProjections" without inject` |
| G12 | 未打 scope 标记的监听器收得到 agent 作用域事件，所以监听 `agent/pre-step` 不需要额外服务、`inject` 不必含 `agent` | 机制侧只做过源码核对（`packages/core/scope/src/index.ts` 的 `scopeTarget` 在 `tag === undefined` 时返回 true）；03 的集成夹具把它变成运行时保证：插件（`inject = ['llm','sessions','sessionProjections']`）挂进真实 agent loop 后，把缺失方法只遮蔽在 pre-step 载荷的 `agent.session` 上，插件在**第一次 pre-step** 就抛出并让 `turn/end` 走 `error`（`tests/review-request.spec.ts`）；未打标记的监听器若被过滤掉，这条与其余全部复核用例一起变红 |
| G13 | 记录依赖的存储能力：`per-record` 布局一条记录一个文档、`invalidRecords: 'backup-and-skip'` 需要后端提供 `KvUnit.backupRecord`（缺这个能力的后端退回「整个域打开失败」）、JSON 后端 `per-record` 的键断言 `[a-zA-Z0-9_-]+`（写入时断言、载入侧静默跳过）、**per-record 文档契约**（一条记录一个带版本戳的信封 `{ version, record }`，畸形或版本戳不在接受集合内的文档在读路径上被静默读作 absent、**到不了 `backupRecord`**，所以 `backup-and-skip` 实际只备份「版本戳合法、`record` 不过域 schema」那一种） | 机制侧只做过源码核对（`packages/storage/storage-domain/src/index.ts`、`packages/storage/storage-json/src/per-record-unit.ts` 与同目录 `format.ts`）；04 的集成夹具把它跑成运行时保证：真实 JSON 后端根下先落一条好记录、从它的信封取版本戳，再往同一张表塞一条「版本戳合法、`record` 不过域 schema」的文档——重挂载后插件仍 ACTIVE、坏文档被移成 `<key>.json.bak.<stamp>`、按会话 id 读回只剩那条好记录（`packages/dsh-navigator/tests/records.spec.ts`）；同文件另两条用例覆盖同一个根下重挂载仍读得回、`update` 重启后记录仍在。域若改回惰性 open，或坏记录走静默丢弃那条路径，这两条一起红 |
| G14 | 锚点的折叠读数与口语里的「第几步来了这条消息」可能差一格；夹具的投影注册晚于第一次请求 | 票据 05 第 4 轮 review 的一次性探针（挂在集成夹具上，未落成可重跑文件）：同一会话逐条 `followup` 时，每次请求到达那一刻读 `ctx.sessionProjections.stateOf(session, 'navigatorSteps')` 得到 `{steps: N, anchor: N-1}`；另外 `mountEagerly` 下第 1、2 次请求读到 `undefined`（插件/投影在第一次请求之后才注册），此后才折出历史。该探针文件已删，**复跑方式**：在 `packages/dsh-navigator/tests/` 下临时加一条用 `observeRequest` 打印投影读数的用例，跑完即删；本行只声明这一格差存在且实测，**规格那一幕（70 → 120）以哪一侧为准由规格方定**，在裁定前票面不改读数 |
| G15 | 多步驱动与请求归属的机制（见「测试决策」的两条机制）成立 | 02c 的集成夹具把它跑成运行时保证：脚本 49 次 tool-call 撑住 turn、末段纯文本收尾，`drive(50)` 得到 50 步 / 50 条非复核请求 / 1 条真实用户消息；归属走 `currentInitiator()`，并发驱动主 / 子 / fork 三条会话（各 6 步、`triggerEverySteps: 1`）33 条请求 / 15 条复核**零错归**（每条按请求体判真值，不读夹具自己的归属），且无时间上界（在 pre-step 里 `setTimeout` 排出的无 `sessionId` 请求仍归该会话）。反证：夹具自己开「当前那一个窗口」时，主会话的复核请求会整批记到子会话名下（`main.reviews()` 恒为 0）——这正是 02c 第 3 条要防的假绿。该探针文件已删，**复跑方式**：在 `packages/dsh-navigator/tests/` 下临时加一条用 `mountNavigatorLoop` + `main.drive` / `createSubSession` / `createForkSession` 的用例，按请求体判每条请求的归属，跑完即删；05 与 08 的用例落地后，这两节的机制随门禁的 `vitest run` 一起重跑 |
可重跑性：G6、G7、G8、G9、G10、G11 的探针都在 `.scratch/probes/` 下，可以直接用 `node` 重跑。G1、G2 的探针没落成文件，G5 需要第三方网关，G14、G15 是一次性探针、文件已删（复跑方式见表内那一格），这几条无法直接重跑——表里那一次观测就是它们的全部证据。G12 的证据不是一次性探针，而是 03 的集成测试（`packages/dsh-navigator/tests/review-request.spec.ts`）；G13 的也一样，是 04 的集成测试（`packages/dsh-navigator/tests/records.spec.ts`），两者随门禁的 `vitest run` 一起重跑。

### 仍未验证

| # | 待验证 | 验证方法 | 失败退路 |
| --- | --- | --- | --- |
| G3 | Desktop 本地联调路径（bundle 必须解析到 profile 内，且安装时不发 prepare） | 在 Desktop 上链接预构建产物实测一次 | 联调范围收窄到 CLI / Web / SDK |

### 仅源码核对（无探针）

- 「预构建产物的装载与启动审计」一节各条：装载入口与审计策略、`loadProfile` 一族不装树、裸名基点与 `internal` 的来源、从工作副本装载会假绿、真实 bin 的判据缺陷。依据是发布态 `0.1.6-alpha.1` 的源码与产物，没有探针。
- G6 的子会话侧、G7 的恢复重折叠（同上表备注）。
- `phase.abort` 在 turn 边界被整体替换、旧 controller 不被 abort（`packages/core/agent-loop/src/agent.ts` 的 `turn()` 末尾），以及「会话空闲后 `cancel` 只 `inbox.clear()`、不产生任何 abort」（同文件 `cancel`）：只有源码核对——G10 的探针只覆盖同一次驱动内的取消，不覆盖跨 turn 的控制器替换。
- 用到这些结论的验收（02b）把「拿不到 `Loader.internal`」和「基点落到了本仓 store」变成夹具的硬失败前置，不把源码结论当运行时保证。

## 技术路线

使用 `agent/pre-step`（`packages/core/agent/src/runtime-types.ts:320`）在下一次模型请求被接受前执行等待模式复核。该 hook 会被 `await`，返回 `{ kind: 'enter', messages }` 可追加 user 消息，返回 `{ kind: 'reject' }` 可拒绝该步。

- 上下文快照：`session.deriveMessages()`（`packages/core/session/src/index.ts:841`），system prompt 为 surface 节点 0。system 消息在该步的 `step/start` 与路由解析之后、模型请求之前提交（`agent.ts:371-373`），而最早一次复核发生在第 `triggerEverySteps + 1` 步的 pre-step，那时它已经存在——不存在「快照里没有 system 消息」的触发点。
- 记录的标识用消息 id，**不用事件序号**：`Message` 自带稳定 `id`（`packages/llm/llm/src/message.ts:133`），而快照就是 `deriveMessages()` 的返回值，所以取 id 不需要任何额外读取。反过来，要把快照的消息与 `session.surface.nodes`（`packages/core/session/src/surface.ts:624`）的事件序号对齐，就得按序号把事件取出来（`eventAt`），而该方法已标 `@deprecated`「new calls are prohibited」（`packages/core/session/src/index.ts:632`；Agent Note `2026-09-09-deprecate-synchronous-session-event-reads.md` 禁止新代码调用三个同步历史读取器，例外只覆盖 DSH 自己的测试文件，替代方向是投影状态 + 异步分页）。代价有两层：压缩会用替换型消息改写投影，旧 id 因此定位不到；而保留 id、只改写内容的投影（如 `image/offload`，其 `project()` 返回同一个 `id`、只换掉 blocks）会让「定位得到」不等于「内容相同」。所以回放验收只看命中的 id 与顺序，定位不到的 id 单独输出成第二个列表。
- 辅助请求：`ctx.llm.stream(GenerateOptions)` + `BlockAssembler`；路由取自 `session.requestHeader()?.config`；超时用 `deadline(signal, ms, code)`（`packages/util/timeout/src/index.ts:91-113`）。
- 建议投递：等待模式走 pre-step 决策；并行模式走 `agent.inject()`。
- 停止与说明：`session.append('user/message', notice, { surfaceOp: 'append' })` + `agent.cancel({ kind: 'hook', reason })`。

该路线不创建真实 Session 子树；真实子树需要 DSH 支持在活动 turn 内分叉。

旁路评估路线的取舍记录在 [ADR 0001](adr/0001-auxiliary-navigation-review.md) 中。

## 测试决策

断言清单在规格的「测试决策」里，本节只留做这些测试时需要的判断与约束，避免同一份清单维护两遍。

- 只验证外部行为——触发时机、送进复核的消息、结论如何影响主会话、记录内容、停止与失败处理；不测内部计数器，也不断言函数调用次数。
- 「结论断言用确定值」的前提是温度固定为 0；若将来改为继承主会话温度，就放宽为「结论属于确定集合」。确定性断言只对 mock LLM 成立。
- testkit 提供 `mountAgentLoopTestDependencies` 与 `mountAgentLoopTestHarness`（另有 `createInboxStub`、`unsupportedInbox`，`packages/test-support/agent-loop-testkit/src/index.ts:21,67,87`），但不提供 pre-step 驱动，也不导出 mock adapter，所以脚本化 adapter 必须在本仓库自备。
- **中间件失败保持抛出、不会变成终态 chunk**：`adapterStream` 只把适配器选择、调度、迭代器构造与迭代的失败收成一个终态 chunk，**中间件与下游消费者的失败照原样抛出**（`packages/llm/llm/src/index.ts:1009-1014`）。`streamWithRegistration` 是 `waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`（同文件 `:1113-1122`），而回退返回的是尚未迭代的异步生成器——适配器要到迭代时才被调用。03 的用例在 `next()` 之前抛错，生成器从未被迭代，所以那条请求到不了适配器，只能挂在 `llm/stream` 钩子上数次数。
- **多步驱动的机制**（02c 的集成夹具建在这上面；三处「形状即决定」的形状留在票面 02c 第 1 条，本节只写机制与出处，不重复形状）：turn 有三个退出口——assistant 消息不含 `tool-call`（`packages/core/agent-loop/src/agent.ts:488`）、某个工具的成功结果带 `concludesTurn`（同文件 `:489` 取回、`:493` 据此以 `completed` 收尾；置位入口 `ToolRunContext.concludeTurn()` 在 `packages/core/tools/src/index.ts:417,1401`）、该步以 max-tokens 收尾（同文件 `:485`）。夹具注册的工具**不调** `concludeTurn()`，因此那一步成功收尾而 turn 继续——多步驱动靠的就是这一条。工具定义为什么必须手写（本包解析不到 `@deepseek-ai/dsh-tools`，只在 `.pnpm` 里经 testkit 传递）与 `output.schema` 的把关者（`packages/core/tools/src/json-schema.ts` 的 `assertSupportedJsonSchema`）是这条机制的两处出处。**步边界闸门的落位与理由写在夹具 `ctx.tools.register(...)` 处**，本节与票面都不复述。
- **复核收场的公开回执**（夹具能力；09 的并行各格与 1.8 那条读数用它当唯一的收场同步点，10 在终态路径上收口时同样用它）：并行复核脱离本步，失败与成功都不注入消息，`drive` 的步边界与 `whenIdle()` 都不覆盖它（G8 的 `detached_review_outcome: still-pending-after-turn-end`），夹具里原本没有可等的收场信号。**收场的定义是「这次复核写下了它那唯一一条记录」**：完成 / 失败 / 取消三条路径都恰好写一条，且都经过插件从 `ctx.storageDomain.open(...)` 拿到的表句柄上的 `put`（`src/records.ts` 的 `writeReviewRecord` 是唯一写入入口）。兑现点是存储域自己的落盘事件：`put` 先 `await` 后端落盘、再改内存、然后发一次 `domain/changed`，载荷带 `domain` / `table` / `key`（`packages/storage/storage-domain/src/domain.ts` 与同目录 `events.ts` 的契约——「emitted once per write strictly after the backend acknowledged durability」、按写链顺序），夹具按这三个字段对上本次复核那一条即兑现，既不包 DSH 的服务、也不改插件。**不能**兑现在复核请求的流结束时（失败记录在流结束之后才写，按流结束放行会读到空记录），也**不能**靠轮询或时间窗（同上面「只验证外部行为」；回执只声明收场，不携带结论）。插件侧不为测试新增事件或记账型 API。`domain/changed` 只在 `storageRoot` 的真实存储栈档存在（缺省桩不经过真域、不发它），所以用这个回执的用例一律给 `storageRoot`。
- **请求归属到会话的机制**（02c 第 3 条）：loop 自己建的请求带 `sessionId`，插件自建的复核请求**不带**（`packages/dsh-navigator/src/index.ts` 那次 `ctx.llm.stream({ … })` 没有这个字段），所以夹具按 agent 的 initiator 归属——loop 用 `withInitiator(this, () => this.kick())`（`packages/core/agent-loop/src/agent.ts:208`）把整段 driver 链标上发起者，`currentInitiator()` 读这条异步链上的 agent（`packages/core/agent/src/index.ts:292`，ALS 实现；`packages/core/agent-loop/src/tool-calls.ts:68,131` 也用它取当前 agent）。它按异步链继承、**没有时间上界**：链上后到的请求仍归这条会话。夹具**不**自己开「当前那一个窗口」：两条会话的 pre-step 交叠时窗口互相覆盖，主会话的复核请求会整批记到子会话名下（G15 的反证）。
- 参考 DSH 现有的 pre-step、辅助 LLM 与 guard 插件测试，但不修改 DSH 的测试与快照。

## 范围外

- 不创建独立上下文的判断者 Agent，不创建真实 Session 子树或可浏览的复核分支。
- 复核不执行工具、读取新文件、修改文件或验证外部状态。
- 不自动检测跑偏并保证结论正确；不自动回滚、缩小范围或更换实现方案。
- 首版不增加费用预算、时间预算、最大任务步骤或工具重复检测能力。
- 不增加 `navigator` purpose，不修改 DSH 核心 Agent loop、Session 持久化或 ACP 协议。
- 不实现客户端插件：停止说明与复核建议都通过追加 notice 消息呈现，客户端沿用既有渲染。
- 不实现独立 `navigator.yml` 加载器、独立 Web 页面或 navigator 专属面板。
- 不要求 ACP 首版显示详细 stop 原因。
