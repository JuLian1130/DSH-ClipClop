# dsh-navigator 设计讨论

状态：需求已收敛；仓库内已有骨架（配置类型、包元数据、构建配置），但还没有插件运行时。G1、G2、G5 已实测通过，仅 G3 待验证，详见「验证状态」。术语以 [CONTEXT.md](../CONTEXT.md) 为准。

本文件引用的 DSH 扩展点均按 `0.1.6-alpha.1`（本地检出 `dsh-v0.1.6-alpha.1-5-g0d1f50007f`）逐条核实。

本文件记录**取舍与机制**：为什么这样定、调用哪个钩子、消息字段形状、源码依据与实测证据。**需求陈述在[实施规格](../.scratch/dsh-navigator/spec.md)里**；规格只写操作性定义、可观察的验收标准和交付约束，不复制本文件的机制描述。判断一句话该放哪边：**删掉它之后，有没有验收标准变得无法判断**——会，属于规格；不会，属于本文件。两者冲突时：需求以规格为准，取舍与机制以本文件为准。

## 范围与约束

- 只开发插件，不修改 deepseek-harness 源码。需要 DSH 不具备的扩展点时，在插件激活阶段或首次取得主会话时直接报错，不静默降级。
  - **服务依赖全部交给原生 `inject`。** Cordis 在依赖就绪前不会激活插件，所以服务缺失时 `apply` 根本不会执行（`vendor/cordis/src/fiber.ts:611-623` 的 `_refresh()` 在任一注入服务缺失时把该插件置为 INACTIVE），「在 `apply` 里检查服务是否存在」是死代码。缺服务时的表现是「插件不激活」，由 DSH 启动审计报告（`packages/boot/app-boot/src/index.ts:779-784` 汇总缺哪个服务，`:801` 打印 `warning: N entries did not activate`；必需条目直接启动失败）。这不是静默降级——插件根本不会运行，只是报告者从插件换成了框架。
  - **`apply` 里只检查 `inject` 表达不了的部分**：我们要调用的 API 形状（`ctx.llm.stream`、`ctx.sessions.get` 是否为函数），以及第一次拿到主会话时的会话级方法（`deriveMessages`、`requestHeader`）。不检查 `agent/pre-step` 事件是否存在——DSH 没有这种查询接口。对 agent loop 行为的依赖改为锁定版本：本版插件针对 `0.1.6-alpha.1`，换成别的版本时**行为不做保证**。不要写成「版本不符就复核不触发」——并不存在一条按版本号判断的机制，那种说法既没有代码支撑也无法验收。
- 复核请求是只读的：它唯一的写入路径是按「各结论的上下文策略」把结论作为 plugin notice 消息追加到主会话。

## 已决定的设计选择

### 观察范围

只观察用户发起的顶层会话——会话头部没有 `parentSession` 的会话（`packages/core/session/src/types.ts:106`）。子 agent 的子会话不触发复核，也不参与计数。

理由有两条：DSH 里子会话是常态，每个都按同一个间隔触发会让调用量与副作用放大一个量级；更要紧的是语义不通——子 agent 的初始提示是用 `source: { kind: 'user' }` 投递的（`packages/subagent/subagent-in-process-driver/src/index.ts:181`），按判别式会被当成用户介入，重置计数、开启新的自主执行区间，而子会话里几乎不会有真正的用户消息。首版不覆盖子会话；要覆盖得单独评估成本与语义。

### 计数口径

计数只在主会话**成功提交一次 `assistant/message`**（不带 `interrupted`）后 +1。失败与被中止的请求、以及所有 navigator 辅助请求都不计数。

可观察的判别信号是必要的：`step/start` 与 `step/end` 对失败和中止的步骤同样会写（`packages/core/agent-loop/src/agent.ts:303,313`），不能用来计数；宿主投影 `turnBoundary`（`packages/core/agent-loop/src/index.ts:44-89`）只含 `openTurnStartSeq` / `lastStepStartSeq` / `lastStepBoundary` / `lastTurn`，**不含步数**，同样不能用来计数。计数从会话日志的事件推导，压缩不截断日志、恢复时按日志重折叠。

### 触发节奏

运行期间触发点始终是「上次触发点 + `triggerEverySteps`」，到点时若已有复核在跑就跳过：不重置节奏、不顺延、也不补打。慢复核因此不会无限推迟后续复核。

**重新观察一个会话时（插件刚加载、或会话被重新打开）不能沿用内存里的「上次触发点」**，必须重新推导——否则真实用户消息带来的重置会在重载后丢失。这是一个真实缺口：第 50 步触发过、第 70 步用户发了消息（下一次应为 120），第 80 步插件重载时若只按「最后一条复核记录」取基线，会得到 50，下一次变成 100，重置被丢掉。

推导式取三个候选的最大值，再加一个间隔：

```
下一次触发点 = max(最后一条复核记录里的触发步骤,
                   最后一条真实用户消息记入会话日志时的已完成步数,
                   floor(当前步数 / triggerEverySteps) × triggerEverySteps)
             + triggerEverySteps
```

第三个候选是为了「不立刻补打」：重载时当前步数可能正好落在间隔的整数倍上，只用前两项会算出一个已经过去的触发点。代价是重载会把节奏重新锚定到当前间隔的整数倍，可能比原节奏晚一次——比丢掉重置或立刻补打都小。

不能在插件加载时就算：插件是全局加载一次的，主会话通常在它之后才出现，所以每次重新观察一个会话时算一次。真实用户消息开启新的自主执行区间，运行期间把下一次触发点重置为「这条消息记入会话日志时的已完成步数 + `triggerEverySteps`」——例如第 50 步触发过、第 70 步用户发了消息，下一次是第 120 步。**不要取插件注意到消息那一刻的计数**：`agent/inbox/inserted` 在 splice 时就发出（`packages/core/agent-loop/src/inbox.ts:238-243`），而这条消息作为 `user/message` 由某一步打开时的提交写出（`packages/core/agent-loop/src/agent.ts:376`），中间可能夹着一次步骤完成（本步的 `assistant/message` 要到 `:476` 才提交）——按 splice 时刻计数会比落盘时少一步，于是重载后从日志重新推导会算出不同的触发点。另有一层：本步的 pre-step 若返回 `reject`，`agent.ts:291-293` 直接返回，提交循环永不执行，这条消息**根本不会落盘**，splice 时刻记下的锚点在日志里就没有对应物。监听该事件的目的只是及时判定「等待期间的复核要作废」，与锚点取值是两件事。

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

### 注入与停止机制

- **建议注入**（`adjust`、并行 `stop`）统一用 `form: 'notice'` 的 user 消息（`packages/llm/llm/src/message.ts:90-94`），**必须带可读的 `summary`**，并用 `boundContextSummary()` 截断到 120 字符上限（`packages/llm/llm/src/message.ts:114-125`）：客户端把它渲染成默认折叠的「上下文注入」行，没有可读 summary 就降级成不透明内容（`packages/client/ui-chat/src/client/chat/ContextBody.tsx:533-574`）。消息正文固定包含触发步骤；若投递时触发点已不属于当前自主执行区间，还必须写出「该建议依据第 N 步、产生于上一段自主执行区间，可能已不适用」，由模型和用户自行判断。**过期的判据**：插件为每个主会话维护一个执行区间编号，每收到一条真实用户消息加一；建议与说明携带产生时的编号，送达时编号不同即视为过期。等待模式 `stop` 与 `failurePolicy: stop` 追加的**停止说明**走同一种消息形态（同样是 `form: 'notice'` 且必须带可读 `summary`），正文写明触发步骤与停止原因。
- 等待模式在触发点的 `agent/pre-step` 里把建议追加进返回的 `decision.messages`。
- 并行模式用 `agent.inject(msg)` 排入下一次 pre-step，不唤醒主会话、不打断当前步骤。排入的消息留在 durable inbox：主会话仍在运行时在最近的 step 边界被 claim，已经 idle 时保留到下一次 followup/steer 唤醒才投递。**任务正常结束时因此不会丢**，跨执行区间送达时靠过期标注说明。但 `cancel` 默认清空待处理队列（`packages/core/agent-loop/src/agent.ts:149-155`），而取消的调用方（用户按停止、API 层、进程退出）不由插件控制，所以**任务被取消时这条建议随之丢失**——这是规格里明确接受的例外；要兑现「取消也不丢」就得插件自己持久化待投递的建议并在下次唤醒时重投，代价不划算。
- **停止**分两步：先用 `session.append('user/message', notice, { surfaceOp: 'append' })` 追加一条面向用户的说明，再调 `agent.cancel({ kind: 'hook', reason })`。注意 `surfaceOp` 是字符串 `'append'`，写成 `{ op: 'append' }` 会在 append 时直接抛错（`packages/core/session/src/surface.ts:269-305`）。
- **应用任何结论前，先检查本步被 claim 的消息。** 探针实测：在 `agent/pre-step` 阶段停止（`cancel` 和 `reject` 都一样），本步被 claim 的消息**不会**写入会话历史——claim 已经把消息取走，而 step 从未打开。如果用户消息正好落在这一批里，它会被静默丢弃。因此只要 claimed 批次里存在真实用户消息（`source.kind === 'user'`），本次复核即视为失效：不注入、不停止，让该步正常继续。这同时落实了规格里「等待复核期间的真实用户消息让复核作废」与「任务取消时取消在途复核」两条。
- **等待复核期间到达的真实用户消息走的是另一条路径，必须单独处理。** 用户消息经 `followup` 进入「下一轮」（`packages/core/agent-loop/src/agent.ts:137-139`）或经 `steer` 进入「下一步」（`agent.ts:141-143`），两条路径都不在本步被 claim 的那一批里，所以上面那条检查看不到它们；而 `cancel` 默认清空整个待处理队列（`agent.ts:149-155`），一旦在此时停止，用户刚发的话就没了。因此等待期间要监听 `agent/inbox/inserted`（两条路径都覆盖），出现 `source.kind === 'user'` 的消息就中止复核、不作任何干预。
- 因此**不需要客户端插件**：`aborted` 在客户端本来就没有专属渲染节点，而追加的 notice 消息会以可回放的折叠行呈现（`packages/client/ui-chat/src/client/conversation-nodes/message.ts:47-64`、`packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx:31-71`）。代价是说明文本进入主模型上下文，规格里记录与上下文的边界已按此调整。
- ACP 侧不做任何修改：DSH 的 `turnEndToStopReason` 会把非客户端取消压平成 `end_turn`（`packages/acp/acp/src/codec.ts:14-33`）；而且 ACP 只转发助手消息与工具调用/结果，不转发 `user/message`（`packages/acp/acp/src/updates.ts`），所以那条追加的说明对 ACP 客户端不可见。这与首版「ACP 只返回普通结束状态、不要求显示详细原因」的边界一致。

### 模型配置继承粒度

继承 `provider` + `model` + `reasoningEffort`，`maxTokens` 用 `maxOutputTokens` 覆盖，`temperature` 固定为 0。理由：复核是判断题，推理强度直接影响判断质量；但复核不需要创作随机性，固定 0 减少随机性、便于复现（不保证逐字一致）。注意仓库内没有任何辅助调用转发过 `reasoningEffort`，这是一条新行为，见 G2。

### 复核记录的存放位置

复核生命周期记录**不使用 Session 事件**，写入插件自有的 storage 域。声明形状：`ctx.storageDomain.open({ name: 'clipclop_review', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { … } })`，表按会话 id 键控；`per-record` 在 JSON 后端下是一条记录一个文档，记录的值需要 schema 校验（该能力用 zod）。取 `backup-and-skip` 而不是默认的「整个域打开失败」，是因为记录是诊断数据，一条坏记录不该让插件加载不了（该选项见 `packages/storage/storage-domain/src/spec.ts:67,129-132`）。取舍与证据见 [ADR 0002](adr/0002-review-records-outside-session-log.md)。

记录内容为：触发步骤、被引用消息的 seq 列表、配置快照、结论、用量、耗时、状态。不复制消息正文（按 seq 可重建）；发给复核的快照不截断。

「回放」的含义是按记录的触发步骤与消息序号回到会话日志重建当时上下文；记录本身不进会话日志、也不参与会话检索。首版不做记录清理，代价是记录随会话长期累积，需要时手工删除。

### 省略辅助请求的 purpose

`purpose` 是可扩展性为零的内联闭合联合（`packages/llm/llm/src/types.ts:487-492`），新增取值必须修改 DSH 核心类型与 deepseek adapter。因此首版省略 `navigator` purpose 不是取舍，而是「不修改 DSH 源码」约束下的必然结果。

### 发行与联调

第一版只承诺「本地 profile 内 `node_modules` 链接 + 预构建产物」：Desktop 的插件安装 UI 只接受 npm registry 包且以 `--ignore-scripts` 安装（`apps/desktop/src/project-manager.ts:131-148,391`），不发 prepare，因此必须提供构建产物；registry 发布留到契约稳定之后。

## 验证状态

一次性探针在 DSH `0.1.6-alpha.1` 上实测通过的项目，以及仍未验证的项目。

### 已实测通过

| # | 结论 | 实测证据 |
| --- | --- | --- |
| G1 | `cancel({ kind: 'hook', reason })` 的取消原因确实进入 `turn/end`；停止发生在模型请求之前；在 `agent/pre-step` 监听器里直接追加 `user/message` 可行 | `turn/end` 的 reason 实测为 `{"kind":"aborted","reason":{"kind":"hook","reason":"navigator stop"}}`；适配器请求数为 0；notice 在 seq 3、`turn/end` 在 seq 4；notice 出现在 `deriveMessages()` 里 |
| G2 | 辅助请求的字段原样透传 | `reasoningEffort`、`temperature: 0`、`maxTokens` 均到达适配器；`system` 与 `tools` 都未设置 |
| G5 | 前缀缓存确实可复用：主会话请求带 `tools`、复核请求不带，两者共用同一段消息前缀时，复核请求仍能读到主请求建立的缓存 | 在 DeepSeek 兼容的第三方网关上用同一段前缀做对照：带 `tools` 的首次请求 `cached_tokens=0`；随后**不带 `tools`** 的复核形态请求 `cached_tokens=640`；重复带 `tools` 的请求 `cached_tokens=2816`；重复复核形态 `cached_tokens=1408`。说明 `tools` 字段不影响消息前缀的缓存复用 |

### 仍未验证

| # | 待验证 | 验证方法 | 失败退路 |
| --- | --- | --- | --- |
| G3 | Desktop 本地联调路径（bundle 必须解析到 profile 内，且安装时不发 prepare） | 在 Desktop 上链接预构建产物实测一次 | 联调范围收窄到 CLI / Web / SDK |

## 技术路线

使用 `agent/pre-step`（`packages/core/agent/src/runtime-types.ts:320`）在下一次模型请求被接受前执行等待模式复核。该 hook 会被 `await`，返回 `{ kind: 'enter', messages }` 可追加 user 消息，返回 `{ kind: 'reject' }` 可拒绝该步。

- 上下文快照：`session.deriveMessages()`（`packages/core/session/src/index.ts:841`），system prompt 为 surface 节点 0。注意 snapshot 在会话的第一步触发时尚无 system 消息（system 是在 `step/start` 与路由解析之后才提交的，见 `docs/architecture.md` 的 agent loop 一节）；默认 50 步间隔下不会碰到，只有把间隔配成 1 才会。
- 消息序号：`Message` 本身不带序号。序号来自 `session.surface.nodes`（`packages/core/session/src/surface.ts:624`），配合 `eventAt(seq)` 与 `deriveEventMessage(event)`（`surface.ts:612-621`，可以为 `null`）成对取出并跳过 `null` 节点。**不能**把 `deriveMessages()` 的下标与 `surface.nodes` 直接对齐——两者长度不保证一致。
- 辅助请求：`ctx.llm.stream(GenerateOptions)` + `BlockAssembler`；路由取自 `session.requestHeader()?.config`；超时用 `deadline(signal, ms, code)`（`packages/util/timeout/src/index.ts:91-113`）。
- 建议投递：等待模式走 pre-step 决策；并行模式走 `agent.inject()`。
- 停止与说明：`session.append('user/message', notice, { surfaceOp: 'append' })` + `agent.cancel({ kind: 'hook', reason })`。

该路线不创建真实 Session 子树；真实子树需要 DSH 支持在活动 turn 内分叉。

旁路评估路线的取舍记录在 [ADR 0001](adr/0001-auxiliary-navigation-review.md) 中。

## 测试决策

断言清单在规格的「测试决策」里，本节只留做这些测试时需要的判断与约束，避免同一份清单维护两遍。

- 只验证外部行为——触发时机、送进复核的消息、结论如何影响主会话、记录内容、停止与失败处理；不测内部计数器，也不断言函数调用次数。
- 「结论断言用确定值」的前提是温度固定为 0；若将来改为继承主会话温度，就放宽为「结论属于确定集合」。确定性断言只对 mock LLM 成立。
- testkit 只提供 `mountAgentLoopTestDependencies` 与 `mountAgentLoopTestHarness`，不提供 pre-step 驱动，也不导出 mock adapter（`packages/test-support/agent-loop-testkit/src/index.ts`），所以脚本化 adapter 必须在本仓库自备。
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
