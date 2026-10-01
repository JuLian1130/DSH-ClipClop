# 工具结果插件只替换 content

状态：接受（2026-10-01 确认）。

`dsh-result-clipper` 使用现有 DSH 工具策略接缝，只替换工具结果的 `content`，保留 `additionalContexts` 的原有顺序、来源和持久化语义，不修改 DSH 源码或公开契约。`accept` 决策的 `additionalContexts` 只能追加、传空数组也清不掉，所以“原样保留”是接缝强制的语义，不是可取舍的实现细节；判定敏感时改走原生 `{kind:'block', feedback}`——结果按失败标记、反馈为固定文案、工具附带的上下文一并丢弃。

这样牺牲了正文摘要与附加消息的完全一致性，但保持插件可独立安装，并把隐私保护明确限定为普通 `tools/post-execute` 结果及可观察的 PTC 日志副本的尽力而为处理；`final-result` 和其他旁路不保证。
