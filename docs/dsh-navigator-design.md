# dsh-navigator 设计讨论

状态：需求已收敛；仓库内已有骨架（配置类型、事件声明、包元数据），运行时尚未实现。术语以 [CONTEXT.md](../CONTEXT.md) 为准。

本文件引用的 DSH 扩展点均按 `0.1.6-alpha.1`（本地检出 `dsh-v0.1.6-alpha.1-5-g0d1f50007f`）逐条核实。

## 范围与约束

- 只开发插件，不修改 deepseek-harness 源码。需要 DSH 不具备的扩展点时，在插件启动阶段直接报错，不静默降级。
- DSH-ClipClop 是插件集合。第一个插件名为 dsh-navigator，目录 `packages/dsh-navigator/`，包名 `@dsh-clipclop/dsh-navigator`。
- 复核不创建运行时 Agent、不创建子 Session、不执行工具、不修改主会话历史。独立上下文的判断者不在当前范围内。
- 实现技术栈：strict TypeScript、ESM、原生 Cordis 插件、pnpm workspace、Vitest，通过 DSH profile 加载。Desktop、Web 和 SDK 共用同一套 Agent 层逻辑；headless one-shot CLI 只做插件加载与配置检查，不作为多轮验收入口。

## 已确认需求

1. 航向复核通过一次辅助模型请求完成，请求携带触发点上主会话对模型可见的上下文快照，并继承主会话的模型配置。
2. 复核只依据已记录的对话证据，不读取新文件、不验证外部状态。
3. 复核在主会话的自主执行区间内按已完成的步骤间隔触发，默认每 50 步一次，可配置。
4. 真实用户消息重置步骤计数；插件消息、工具结果、批准操作和助手更新不重置。恢复会话和上下文压缩沿用持久化计数。
5. 一个主会话同时最多运行一次复核；触发时已有复核在运行则跳过本次触发，不排队。
6. 已结束的任务不会为了复核重新启动。
7. 用户配置使用原生 Cordis 插件配置和 YAML patch，并提供完整示例及字段校验。可配置项为触发频率、模式、超时、输出上限、失败策略和复核提示词。
8. 默认配置为 `mode: wait`、`triggerEverySteps: 50`、`reviewTimeoutMs: 120000`、`maxOutputTokens: 4096`、`failurePolicy: continue`。并行模式没有最大滞后步数配置。
9. 第一版支持等待模式和并行模式，默认等待模式。等待模式在下一步开始前等待复核；并行模式继续执行，忽略结论时不回退执行。
10. 结论分为 `continue`、`adjust` 和 `stop`，每条结论都包含原因与建议。
11. `continue` 默认不进入主模型上下文；等待模式在触发位置继续，不追加复核对话。
12. 等待模式下 `stop` 取消主会话，并说明原因后等待用户决定。并行模式下 `stop` 作为建议注入，明确写出该建议依据截至第几步的上下文，由主会话自行决定是否停止。
13. `adjust` 用于建议缩小范围、改变方案或考虑回滚；复核不能执行回滚。
14. 并行复核遇到真实用户消息、任务结束或任务取消时失效，并请求取消。并行结论不设置最大滞后步数。
15. 复核证据、结论和用量保留用于诊断，默认不进入主模型上下文；复核不显示为子 Session。
16. 复核失败、超时或输出无法解析时，默认记录失败并允许主会话继续；失败策略和超时可配置，默认超时 120 秒且不重试，评估输出上限 4096 token。
17. 复核输出必须是结构化数据，包含 `verdict`、`reason` 和 `recommendation`；用户可编辑提示词不能改变该输出要求。
18. 每次复核固定使用触发时的配置。配置更新影响后续复核；插件重载或销毁会取消运行中的复核，不使主会话永久等待。
19. 等待模式 `stop` 的原因必须对用户可见，而不是只留在诊断记录里。

## 已决定的设计选择

### 计数口径

计数只在主会话**成功完成一次模型请求并把结果写入会话历史**后 +1。失败与被中止的请求、以及所有 navigator 辅助请求都不计数。

步骤与计数都不需要插件自建存储：`step/start` 事件本身持久（`packages/core/session/src/types.ts:287`），并有宿主投影 `turnBoundary`（`packages/core/agent-loop/src/index.ts:44-89`）可用于读取，压缩不截断日志、恢复时按日志重折叠。

### 触发节奏

触发点始终是「上次触发点 + `triggerEverySteps`」，被跳过的触发点不重置节奏，也不顺延。慢复核因此不会无限推迟后续复核。

### 真实用户消息的判别

判别式固定为 `role === 'user' && source.kind === 'user'`（`packages/llm/llm/src/message.ts:98-128`）。插件注入的建议是 `source.kind === 'plugin'`，工具结果是 `source.kind === 'tool'`，因此复核自己注入的建议不会重置计数。

### 各结论的上下文策略（第一版固定，不提供配置项）

| 模式 \ 结论 | `continue` | `adjust` | `stop` |
| --- | --- | --- | --- |
| 等待 | 不进入主模型上下文 | 注入建议 | 取消当前 turn |
| 并行 | 不进入主模型上下文 | 注入建议 | 注入建议（携带触发步骤） |

第一版不把这张表做成配置项：没有具体场景证明需要改默认值，配置项只会增加契约面。关闭复核的方式是不加载插件，不为「关闭」增加配置值。

### 失败处理

失败、超时或输出无法解析时只写诊断记录，不注入主模型上下文，也不做额外的用户提示。`failurePolicy: stop` 仅对等待模式生效，且复用与 `stop` 结论相同的停止机制，原因说明为复核失败。并行模式一律 `continue`，不做降级注入。

### 提示词与结构化输出

- 辅助请求的**固定 system 指令**承载角色定义与结构化输出契约。
- **复核提示词**以 user 消息加入对话：插件内置一份默认文本，YAML 中配置 `prompt` 即**替换**该默认文本。
- 证据快照由插件**固定追加**，不属于可替换的提示词内容，用户无法通过改提示词把证据挤掉。
- DSH 没有 JSON mode、response schema、`tool_choice` 或解析助手（`packages/llm/llm/src/types.ts:453-493`）。因此「不能删除结构化字段」由固定 system 指令 + 校验失败即复核失败保证，不由模型保证。

### 注入与停止机制

- **建议注入**统一用 `form: 'notice'` 的 user 消息（`packages/llm/llm/src/message.ts:90-94`，仓库内 `guard`、`plan`、`goal`、`jobs` 均为此惯例）。等待模式在触发点的 `agent/pre-step` 里直接把建议追加进返回的 `decision.messages`；并行模式用 `agent.inject(msg)` 排入下一次 pre-step，不唤醒主会话、不打断当前步骤。
- **停止**用 `agent.cancel({ kind: 'hook', reason })`，原因进入 `turn/end`（`packages/core/session/src/types.ts:191`），SDK 已显式校验该形态（`packages/sdk/client/src/api.ts:237-259`）。`{ kind: 'reject' }` 虽然会让 turn 以 `blocked` 结束且不发模型请求，但不携带自由文本原因，无法满足需求 19。
- 为了让原因在 Web/Desktop 可见，插件额外提供一个**客户端插件**注册 conversation node（`ctx.uiConversation.events.register(...)`，模板是 `ui-chat` 的 turn-max-tokens "Notice Definition"），并合并一个 `TurnEndReasonMap` variant。这不修改 DSH 源码。
- ACP 侧不做任何修改：DSH 的 `turnEndToStopReason` 会把非客户端取消压平成 `end_turn`（`packages/acp/acp/src/codec.ts:14-33`），与本项目首版「ACP 只返回普通结束状态」的边界一致。

### 模型配置继承粒度

继承 `provider` + `model` + `reasoningEffort`，`maxTokens` 用 `maxOutputTokens` 覆盖，`temperature` 固定为 0。理由：复核是判断题，推理强度直接影响判断质量；但复核不需要创作随机性，固定 0 才可复现。注意仓库内没有任何辅助调用转发过 `reasoningEffort`，这是一条新行为，见「待确认的验证门」。

### 复核记录的存放位置

复核生命周期记录**不使用 Session 事件**，写入插件自有的 storage 域（`ctx.storageDomain.open()`，域名单 `clipclop_review`、`layout: 'per-record'`、按 `SessionId` 键控）。取舍与证据见 [ADR 0002](adr/0002-review-records-outside-session-log.md)。

记录内容为：触发步骤、被引用消息的 seq 列表、配置快照、结论、用量、耗时、状态。不复制消息正文（按 seq 可重建）；发给复核的快照不截断。

### 省略辅助请求的 purpose

`purpose` 是可扩展性为零的内联闭合联合（`packages/llm/llm/src/types.ts:487-492`），新增取值必须修改 DSH 核心类型与 deepseek adapter。因此首版省略 `navigator` purpose 不是取舍，而是「不修改 DSH 源码」约束下的必然结果。

### 发行与联调

第一版只承诺「本地 profile 内 `node_modules` 链接 + 预构建产物」：Desktop 的插件安装 UI 只接受 npm registry 包且以 `--ignore-scripts` 安装（`apps/desktop/src/project-manager.ts:131-148,391`），不发 prepare，因此必须提供构建产物；registry 发布留到契约稳定之后。

## 待确认的验证门

每条都写明了验证方法与失败时的退路。

| # | 待验证 | 验证方法 | 失败退路 |
| --- | --- | --- | --- |
| G1 | `cancel({ kind: 'hook' })` 这条通道在 DSH 内**零生产者**，没有端到端先例 | Agent loop testkit 驱动一次真实循环，断言 `turn/end` 携带 `{ kind: 'aborted', reason: { kind: 'hook', reason } }`，并断言 Web/Desktop 的客户端插件节点实际渲染 | 退回 `{ kind: 'reject' }`（turn 以 `blocked` 结束）+ 仅诊断记录，需求 19 降级为「原因在 SDK 事件与诊断记录中可见」 |
| G2 | 辅助请求转发 `reasoningEffort` 在仓库内无先例 | mock LLM 断言辅助请求实际携带 provider / model / reasoningEffort / maxTokens / temperature | 退回只继承 provider + model |
| G3 | Desktop 本地联调路径未实测（bundle 必须解析到 profile 内，且不发 prepare） | 在 Desktop 上链接预构建产物实测一次 | 联调范围收窄到 CLI / Web / SDK |
| G4 | 客户端 conversation node 与 `TurnEndReasonMap` variant 的实际呈现未实现验证 | Web 与 Desktop 各跑一次 stop，确认原因可见且随 replay 重现 | 退回仅诊断记录 + SDK events |

## 技术路线

使用 `agent/pre-step`（`packages/core/agent/src/runtime-types.ts:320`）在下一次模型请求被接受前执行等待模式复核。该 hook 会被 `await`，返回 `{ kind: 'enter', messages }` 可追加 user 消息，返回 `{ kind: 'reject' }` 可拒绝该步。

- 上下文快照：`session.deriveMessages()`（`packages/core/session/src/index.ts:841`），system prompt 为 surface 节点 0。
- 辅助请求：`ctx.llm.stream(GenerateOptions)` + `BlockAssembler`；路由取自 `session.requestHeader()?.config`；超时用 `deadline(signal, ms, code)`（`packages/util/timeout/src/index.ts:91-113`）。
- 并行投递：`agent.inject()`；停止：`agent.cancel({ kind: 'hook', reason })`。

该路线不创建真实 Session 子树；真实子树需要 DSH 支持在活动 turn 内分叉。

旁路评估路线的取舍记录在 [ADR 0001](adr/0001-auxiliary-navigation-review.md) 中。

## 测试决策

- 测试只验证外部行为：触发时机、消息上下文、结论策略、记录内容、取消和失败处理，不测试内部计数器或函数调用次数。
- 使用 Agent loop testkit（`packages/test-support/agent-loop-testkit`，`mountAgentLoopTestHarness`）覆盖等待模式、并行模式、计数重置、重叠复核、用户消息导致的取消、任务结束、超时、非法输出和三种结论。testkit 不提供 pre-step 驱动，也不导出 mock adapter，需要在本仓库自备脚本化 adapter。
- 使用 mock LLM 验证辅助请求继承路由与上下文、结构化输出校验、失败通知、不重试，以及 G2。
- 验证插件重载或销毁会取消在途复核并释放等待中的主会话。
- 持久化记录：关闭并重新打开会话后，复核记录仍可读，且不会进入主模型历史。
- 使用 SDK 集成测试验证多轮交互与结构化事件；使用 Web 和 Desktop 集成测试验证原因展示（G1/G4）。
- ACP 测试只验证普通结束状态，不要求首版协议携带详细 stop 原因。
- 测试优先参考 DSH 现有的 `agent/pre-step`、辅助 LLM 和 guard 插件测试，不修改 DSH 的测试和快照。

## 范围外

- 不创建独立上下文的判断者 Agent，不创建真实 Session 子树或可浏览的复核分支。
- 复核不执行工具、读取新文件、修改文件或验证外部状态。
- 不自动检测跑偏并保证结论正确；不自动回滚、缩小范围或更换实现方案。
- 首版不增加费用预算、时间预算、最大任务步骤或工具重复检测能力。
- 不增加 `navigator` purpose，不修改 DSH 核心 Agent loop、Session 持久化或 ACP 协议。
- 不实现独立 `navigator.yml` 加载器、独立 Web 页面或 navigator 专属面板。
- 不要求 ACP 首版显示详细 stop 原因。
