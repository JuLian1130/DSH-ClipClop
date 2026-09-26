/**
 * 裁剪资格判定与裁剪算子。
 *
 * 两条都只读一条已记录的 assistant 消息本身，不读会话历史：资格写在它自己的耐久 replay 信封上
 * （逐步骤），裁剪则必须**连同信封一起**改，否则两个适配器都会把这整条消息静默降级成
 * provider-neutral 重建（丢掉签名、不报错）。机制与源码依据见设计文档「裁剪资格」「必须与 replay
 * 信封同步」。
 *
 * @module
 */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock } from '@deepseek-ai/dsh-llm'

/** 一个 JSON 对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** pi-ai 信封的 response 半部；Messages 信封的 `kind` 是 `deepseek-messages`，因此这里返回 undefined。 */
function piAiResponse(message: AssistantMessage): Record<string, unknown> | undefined {
  const state = message.source.replayState
  if (!isRecord(state)) return undefined
  const response = state['response']
  if (!isRecord(response) || response['kind'] !== 'pi-ai') return undefined
  return response
}

/**
 * 裁剪资格：这条 assistant 消息的耐久 replay 信封声明它由 `api === 'openai-completions'` 的传输产生。
 *
 * **逐步骤判定**：同一会话中途换模型会混用传输，不得按会话整体判定。没有 `replayState`、信封是
 * `deepseek-messages`（不含 `api`）、或 `api` 是别的传输，一律判为无资格，原样保留。
 * @param message - 一条已记录的 assistant 消息。
 * @returns 可裁剪时为 true。
 */
export function isReasoningPrunable(message: AssistantMessage): boolean {
  return piAiResponse(message)?.['api'] === 'openai-completions'
}

/**
 * 内容块数组与 replay 信封块数组是否**逐位对齐**（块数相等 + 逐位同类型）。
 *
 * 这正是两个适配器校验信封的口径（pi-ai `replay.ts` 的「块数相等」与逐位 `type` 比较、Messages 侧的
 * 「block count mismatch」）。不对齐时适配器吞掉 `INVALID_REPLAY_STATE` 并整条降级，所以裁剪必须让
 * 这个谓词在结果上为真——它是本设计最容易踩的坑的唯一本地信号。
 * @param message - 待检查的 assistant 消息。
 * @returns 信封块数组存在且与内容逐位同类型时为 true。
 */
export function replayEnvelopeAlignsWithContent(message: AssistantMessage): boolean {
  const state = message.source.replayState
  if (!isRecord(state) || !Array.isArray(state['blocks'])) return false
  const blocks: unknown[] = state['blocks']
  if (blocks.length !== message.content.length) return false
  return message.content.every((block, index) => {
    const entry: unknown = blocks[index]
    return isRecord(entry) && entry['type'] === block.type
  })
}

/**
 * 裁剪：移除推理块，并**同步过滤 replay 信封里对应位置的条目**，使两者继续逐位对齐。
 *
 * 不是把块内文本置空：签名随块存活，置空仍会把 `reasoning_details` 原样回放，线上零节省而本地计量
 * 报出节省。存活块（文本、工具调用）连同各自的签名留在过滤后信封的对应位置上；消息身份、`role`、
 * `source` 的身份字段（`provider`/`model`/`replayState.response`）与工具调用的
 * `id`/`name`/`arguments` 一律不变。消息本身是公开的不可变副本，不改动传入对象。
 * @param message - 一条已记录的 assistant 消息。
 * @returns 裁剪后的不可变副本；没有推理块可移除时原样返回同一条消息。
 * @throws 信封不是「块数与内容相等、逐位同类型」时——这是调用方的前置条件；投影在调它之前先按
 *   {@link replayEnvelopeAlignsWithContent} 跳过不可用的信封，所以这条抛错不会让日志读不出来。
 */
export function pruneReasoning(message: AssistantMessage): AssistantMessage {
  const state = message.source.replayState
  if (!isRecord(state) || !Array.isArray(state['blocks'])) {
    throw new Error('dsh-reasoning-pruner: cannot prune reasoning without a per-block replay envelope')
  }
  const blocks: unknown[] = state['blocks']
  if (blocks.length !== message.content.length) {
    throw new Error(
      `dsh-reasoning-pruner: replay envelope holds ${blocks.length} block(s) for ${message.content.length} content block(s)`,
    )
  }
  const content: ContentBlock[] = []
  const keptBlocks: unknown[] = []
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'reasoning') continue
    content.push(block)
    keptBlocks.push(blocks[index])
  }
  if (content.length === message.content.length) return message
  return freezeMessage({
    ...message,
    content,
    source: { ...message.source, replayState: { ...state, blocks: keptBlocks } },
  })
}
