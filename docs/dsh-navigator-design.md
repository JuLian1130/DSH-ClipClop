# dsh-navigator 设计讨论

状态：需求讨论阶段。尚未开始实现；未解决的技术选择需要确认。

## 已确认需求

- DSH-ClipClop 是插件集合。第一个插件名为 dsh-navigator，目录为 `packages/dsh-navigator/`。
- 航向复核通过一次辅助模型请求完成，请求携带主任务模型可见上下文的快照，并继承主任务的模型配置。它不创建运行时 Agent 或子 Session；独立上下文判断者不在当前范围内。
- 复核只依据已记录的对话证据，不执行工具。
- 复核在主任务步骤完成后触发，默认每 50 步一次，可配置。真实用户消息重置计数；插件消息、工具结果、批准操作和助手更新不重置。恢复会话和上下文压缩沿用持久化计数。
- 一个主 Session 同时最多运行一次复核。触发时已有复核运行，则跳过本次触发，不排队。
- 已结束的任务不会为了复核重新启动。
- 用户配置使用原生 Cordis 插件配置和 YAML patch，并提供完整示例及字段校验。配置包括触发频率、复核提示词、复核期间的主任务行为和各结论的主上下文策略。
- 默认配置为 `mode: wait`、`triggerEverySteps: 50`、`reviewTimeoutMs: 120000`、`maxOutputTokens: 4096` 和 `failurePolicy: continue`。并行模式没有最大滞后步数配置。
- 第一版支持等待模式和并行模式，默认使用等待模式。等待模式在下一步开始前等待复核；并行模式继续执行，忽略结论时不回退执行。
- continue 默认不进入主模型上下文；等待模式在触发位置继续，但不追加复核对话。
- 结论分为 continue、adjust 和 stop。等待模式下 stop 直接取消主任务，并说明原因后等待用户决定。并行模式下 stop 作为建议注入，明确说明该建议依据截至第几步的上下文，由主任务自行决定是否停止。
- 并行复核遇到真实用户消息、任务结束或任务取消时失效，并请求取消。并行结论不设置最大滞后步数；建议始终明确写出触发步骤，由主任务自行判断当前是否仍适用。
- adjust 用于建议缩小范围、改变方案或考虑回滚；复核不能执行回滚。
- 复核证据、结论和用量保留用于诊断，但默认不进入主模型上下文；复核不显示为子 Session。
- 复核生命周期使用 `navigator/review-start` 和 `navigator/review-end` 两个 log-only Session 事件，分别记录启动快照以及完成、失败或取消结果。
- 复核失败、超时或输出无法解析时，默认记录失败并允许主任务继续；失败策略和超时可配置，默认超时 120 秒且不重试，评估输出上限为 4096 token。
- 复核输出必须是结构化数据，包含 `verdict`、`reason` 和 `recommendation`；用户可编辑提示词不能改变该输出要求。
- 每次复核固定使用触发时的配置。配置更新影响后续复核；插件重载或销毁会取消运行中的复核，不使主任务永久等待。
- 实现技术栈采用 strict TypeScript、ESM、原生 Cordis 插件、pnpm workspace 和 Vitest，并通过 DSH profile 加载。Desktop、Web 和 SDK 使用同一套 Agent 层逻辑；headless one-shot CLI 不作为多轮验收入口。

## 仍待确认

- 第一版省略辅助请求的 `navigator` purpose；等需要用途统计、限流或路由时再评估修改 DSH。
- 由插件通过 declaration merging 添加自己的 Session log-only 事件；事件字段和校验由插件负责，不修改 DSH 核心。
- 插件目录为 `packages/dsh-navigator/`，包名采用 `@dsh-clipclop/dsh-navigator`。
- 插件提供 `cordis.patch.yml` 作为原生 Cordis 配置示例，不另行实现 `navigator.yml` 加载器。
- 并行模式建议固定包含触发步骤、结论和依据；YAML 可以修改提示词主体，但不能删除这些字段。
- 第一版针对当前本地 DSH 源码和明确版本范围；缺少所需扩展点时在插件启动时直接报错。
- 核心测试和实现留在 DSH-ClipClop；使用本地 DSH profile 做 Desktop、Web、SDK 联调，不修改 DSH 的测试和快照。
- 等待模式 stop 的用户界面展示和 Desktop、Web、SDK 的诊断呈现。
- ACP 第一版沿用不修改 DSH 的边界：保留完整 navigator 事件供诊断，协议只返回现有的普通结束状态，不要求 ACP 客户端显示详细 stop 原因。未来若要让 ACP 直接传递原因，需要单独修改 DSH ACP 适配。

## 技术路线

使用 `agent/pre-step` 在下一次模型请求被接受前执行等待复核，并使用辅助 LLM API 评估已经完成步骤的上下文快照。该路线不创建真实 Session 子树；真实子树需要 DSH 支持在活动 turn 内分叉。

旁路评估路线的取舍记录在 [ADR 0001](adr/0001-auxiliary-navigation-review.md) 中。
