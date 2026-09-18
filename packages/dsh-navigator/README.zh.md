# dsh-navigator

`dsh-navigator` 在主会话连续执行若干步骤后，使用主会话当前模型可见上下文发起一次辅助航向复核。复核不创建子 Session、不执行工具；它可以在等待模式下停止主会话，也可以在并行模式下向主会话提供带触发步骤的建议。

当前目录包含配置 schema、结论类型和可装载的插件入口（`name`、`inject`、`Config`、`apply`）：等待模式已能到点发起复核、把收场结算成一条记录，并按会话 id 读回与回放。三类结论对主会话的干预（建议注入、停止说明）与并行模式已落地，等待期作废亦已落地；任务结束与任务取消时会取消在途复核并落下原因正确的取消记录，重载 / 卸载时同样如此，并按 `failurePolicy` 放行或停止正在等待的那一步；本包不会修改 DeepSeek Harness 源码。

## 配置

默认值见 [`cordis.patch.yml`](./cordis.patch.yml)。配置通过 DSH 原生 profile patch 加载，不使用独立的配置加载器。

## 复核记录

复核生命周期记录（触发步骤、快照里每条消息的 id 列表、配置快照、结论、用量、耗时、失败原因、取消原因、状态）写入插件自有的 storage 域 `clipclop_review`，**一会话多条**（键 = 会话 id 的路径安全变换 + 触发步骤，读回按触发步骤升序）。不使用 Session 事件，原因见 [ADR 0002](../../docs/adr/0002-review-records-outside-session-log.md)。

这个存储域由 profile 提供的存储栈承载：`storage` 服务、一个存储后端（JSON 后端，`storage-json`）与 `storage-domain`（`backend: 'json'`）。本包只声明域 `clipclop_review`（`per-record` 布局、`invalidRecords: 'backup-and-skip'`），不提供这三者，也不把它们的条目写进自己的 bundle patch——[`cordis.patch.yml`](./cordis.patch.yml) 只列本插件自己的条目，与 DSH 其他插件一致。
