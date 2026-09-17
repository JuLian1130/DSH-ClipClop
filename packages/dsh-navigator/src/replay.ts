/**
 * 回放：按一条记录里的消息 id 列表，在会话当前的模型可见消息里挑出仍然存在的那些。
 *
 * 诊断用纯函数，运行时不被插件自己调用（规格「记录与诊断」）。它只保证命中的 id 与顺序，不比内容
 * ——投影存在保留 id、只改写内容的情形（如 `image/offload`），被压缩替换掉的消息也取不回。
 *
 * @module
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/** 一次回放的结果。 */
export interface ReplayResult {
  /** 在会话当前的模型可见消息里命中的 id，按记录里的原顺序。 */
  readonly hit: readonly string[]
  /** 定位不到的 id，按记录里的原顺序。 */
  readonly missing: readonly string[]
}

/**
 * 回放一条记录。
 * @param messageIds - 记录里的消息 id 列表。
 * @param messages - 会话当前的模型可见消息（`session.deriveMessages()`）。
 * @returns 命中的 id 序列与定位不到的 id 列表。
 */
export function replayReviewRecord(
  messageIds: readonly string[],
  messages: readonly Message[],
): ReplayResult {
  // id 在记录里是字符串（JSON 文档里也只有字符串），这里按同一个口径比较。
  const present = new Set(messages.map(message => String(message.id)))
  const hit: string[] = []
  const missing: string[] = []
  for (const id of messageIds) {
    if (present.has(id)) hit.push(id)
    else missing.push(id)
  }
  return { hit, missing }
}
