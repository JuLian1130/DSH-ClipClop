# 复核记录存放在会话日志之外

状态：已接受。

dsh-navigator 需要可回放的复核生命周期记录（触发步骤、快照消息 id、配置快照、结论、用量、耗时、失败原因、取消原因、状态）。DSH 插件的常规做法是声明合并 `SessionEventMap` 后 `session.append()`，但这条路对仓库外插件是破坏性的：仓库外插件声明的类型不在生成的 `KNOWN_SESSION_EVENT_TYPES` 内，而 `Session.append` 无法写入 `ignorable: true` 信封标记，于是 `validateStoredEvents` 会在下次打开会话时拒绝**整个日志**，用户的会话直接无法加载（`packages/session/session-persistence/src/storage-contract.ts:74-80`、`packages/core/session/src/index.ts:722-726`）。

**前提的准确范围是「运行期」，不是「不存在写入路径」。** 后来核实（2026-09）发现全仓只有两处写入会话日志：种子循环（`packages/core/session/src/index.ts:587`，构造期）与 `append`（`:761`，运行期）。前者能带 `ignorable` —— `assertSessionEventEnvelope` 的键白名单含 `ignorable` 且接受 `ignorable === true`（`:218`、`:231`），并且已两进程实测通过：种入 `ignorable: true` 的仓外事件后重载成功、插件缺席的冷读也不拒绝整段会话。此外 `SessionHandle.append`（经 `ctx.sessionPersistence`）能把任意 envelope 写上盘，写入路径只查 JSON 可序列化、不查事件类型（`storage-contract.ts:128-138`；出厂先例 `packages/feedback/message-feedback/src/index.ts:261-268` 手搓 `{...event, seq, time}` 后调 `handle.append`）。

因此准确说法是：**运行期没有写入 `ignorable` 的公开路径（`append` 硬编码的信封里没有该字段），构造期（seed）有；另有 `SessionHandle.append` 这一条绕过 `Session.append` 的通道，但它要求该会话的写所有权，而活跃 agent 会话的所有权已被占用**（写入按会话 id 独占：`packages/session/session-persistence-jsonl/src/storage.ts:429-432` 的 `claimWrite` 抛 `SessionAlreadyOwnedError`，`session-persistence-jsonl/src/index.ts:377` 的读路径同样拒绝）。本 ADR 的结论不受影响——复核记录是运行期中途产生的，种子路径帮不上；但引用这条 ADR 时不应再说「无法写入 `ignorable`」。

因此记录写入插件自有的 storage 域：`ctx.storageDomain.open({ name: 'clipclop_review', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { … } })`（裸对象字面量，不引入 `defineDomain`——它是运行期导出，会让包产物多一个运行期 import），**一会话多条**：键 = 会话 id 的路径安全单射变换 + 触发步骤（完整形状见设计文档的「复核记录的存放位置」；`version` 与 `tables` 是 `DomainSpec` 的必填项，见 `packages/storage/storage-domain/src/spec.ts:35-72`）。该入口对仓库外插件公开、无白名单（`packages/storage/storage-domain/src/index.ts:103-118`），同构先例是仓库内的插件 `session-projection-cache`（`packages/session/session-projection-cache/src/spec.ts:98-105`）。

代价是复核记录不在会话日志里：不参与会话 replay、不被 session-query 检索、需要插件自己负责清理。收益是不修改 DSH 源码、不破坏用户会话的可加载性。若 DSH 未来开放插件事件的 `ignorable` 写入路径，可以重新评估把记录搬回会话日志。
