# dsh-navigator

`dsh-navigator` 在主会话连续执行若干步骤后，使用主会话当前模型可见上下文发起一次辅助航向复核。复核不创建子 Session、不执行工具；它可以在等待模式下停止主会话，也可以在并行模式下向主会话提供带触发步骤的建议。

当前目录包含配置 schema 和结论类型。运行时插件接线仍在实现中；本包不会修改 DeepSeek Harness 源码。

## 配置

默认值见 [`cordis.patch.yml`](./cordis.patch.yml)。配置通过 DSH 原生 profile patch 加载，不使用独立的配置加载器。

## 复核记录

复核生命周期记录（触发步骤、被引用消息 seq、配置快照、结论、用量、耗时、状态）写入插件自有的 storage 域 `clipclop_review`，按 SessionId 键控。不使用 Session 事件，原因见 [ADR 0002](../../docs/adr/0002-review-records-outside-session-log.md)。
