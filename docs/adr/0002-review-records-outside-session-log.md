# 复核记录存放在会话日志之外

状态：已接受。

dsh-navigator 需要可回放的复核生命周期记录（触发步骤、快照消息 id、配置快照、结论、用量、耗时、失败原因、取消原因、状态）。DSH 插件的常规做法是声明合并 `SessionEventMap` 后 `session.append()`，但这条路对仓库外插件是破坏性的：仓库外插件声明的类型不在生成的 `KNOWN_SESSION_EVENT_TYPES` 内，而 `Session.append` 无法写入 `ignorable: true` 信封标记，于是 `validateStoredEvents` 会在下次打开会话时拒绝**整个日志**，用户的会话直接无法加载（`packages/session/session-persistence/src/storage-contract.ts:74-80`、`packages/core/session/src/index.ts:719-723`）。

因此记录写入插件自有的 storage 域：`ctx.storageDomain.open(defineDomain({ name: 'clipclop_review', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { … } }))`，按 `SessionId` 键控（完整形状见设计文档的「复核记录的存放位置」；`version` 与 `tables` 是 `DomainSpec` 的必填项，见 `packages/storage/storage-domain/src/spec.ts:35-72`）。该入口对仓库外插件公开、无白名单（`packages/storage/storage-domain/src/index.ts:103-118`），同构先例是仓库内的插件 `session-projection-cache`（`packages/session/session-projection-cache/src/spec.ts:98-105`）。

代价是复核记录不在会话日志里：不参与会话 replay、不被 session-query 检索、需要插件自己负责清理。收益是不修改 DSH 源码、不破坏用户会话的可加载性。若 DSH 未来开放插件事件的 `ignorable` 写入路径，可以重新评估把记录搬回会话日志。
