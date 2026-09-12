# dsh-navigator

`dsh-navigator` 在主任务连续执行若干步骤后，使用主任务当前模型可见上下文发起一次辅助航向复核。复核不创建子 Session、不执行工具；它可以在等待模式下停止主任务，也可以在并行模式下向主任务提供带触发步骤的建议。

当前目录包含配置 schema 和 Session 事件协议。运行时插件接线仍在实现中；本包不会修改 DeepSeek Harness 源码。

## 配置

默认值见 [`cordis.patch.yml`](./cordis.patch.yml)。配置通过 DSH 原生 profile patch 加载，不使用独立的配置加载器。

## 事件

- `navigator/review-start` 记录复核触发步骤、模式和上下文消息序号。
- `navigator/review-end` 记录复核完成、失败或取消，以及结构化结论和用量。
