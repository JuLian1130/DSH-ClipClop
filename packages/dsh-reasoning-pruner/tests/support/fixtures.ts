/**
 * 四条基准逻辑的用例共用的构造器。
 *
 * 只放构造、不放断言：宿主 replay 信封的键名（`response`/`blocks`/`api`）与承载事件的形状在这里写一份，
 * 免得每个 spec 各写一遍。消息一律造**未冻结**的字面量——纯函数用例要在调用后对输入做深比较。
 *
 * @module
 */

import { createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjectionContext } from '@deepseek-ai/dsh-session/surface'
import { CARRIER_EVENT_TYPE } from '../../src/index.ts'

/** 一条含 `[text, reasoning, tool-call]` 的消息内容；裁剪后应为 `[text, tool-call]`。 */
export const PRUNABLE_CONTENT: ContentBlock[] = [
  { type: 'text', text: 'the answer' },
  { type: 'reasoning', text: 'the thinking' },
  { type: 'tool-call', id: ToolCallId('call-1'), name: 'read_file', arguments: '{"path":"a.txt"}' },
]

/** 与 {@link PRUNABLE_CONTENT} 逐位对齐的 pi-ai 信封块，三种签名各一。 */
export const PRUNABLE_BLOCKS: readonly unknown[] = [
  { type: 'text', textSignature: 'sig-text' },
  { type: 'reasoning', thinkingSignature: 'sig-think' },
  { type: 'tool-call', thoughtSignature: 'sig-tool' },
]

/**
 * 造一个 pi-ai 耐久 replay 信封。
 * @param api - 传输字面量；`openai-completions` 才有裁剪资格。
 * @param blocks - 与内容块逐位对齐的信封块。
 * @returns 裸信封值（`AssistantMessage.source.replayState` 收 `unknown`）。
 */
export function piAiReplayState(api: string, blocks: readonly unknown[]): unknown {
  return {
    response: {
      kind: 'pi-ai',
      version: 2,
      api,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      stopReason: 'stop',
    },
    blocks,
  }
}

/**
 * 造一条**未冻结**的 assistant 消息。
 * @param input - 内容块与可选的 replay 信封。
 * @returns 一条 role 为 assistant 的消息字面量。
 */
export function assistantMessage(input: { content: ContentBlock[], replayState?: unknown }): AssistantMessage {
  return {
    id: MessageId('assistant-1'),
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      ...input.replayState === undefined ? {} : { replayState: input.replayState },
    },
  }
}

/** 造一条有裁剪资格（pi-ai + `openai-completions`）的 assistant 消息。 */
export function prunableAssistantMessage(): AssistantMessage {
  return assistantMessage({
    content: structuredClone(PRUNABLE_CONTENT),
    replayState: piAiReplayState('openai-completions', structuredClone(PRUNABLE_BLOCKS)),
  })
}

/** 一条 `assistant/message` 表面事件。 */
export function assistantEvent(seq: number, message: AssistantMessage): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: 0,
    data: { turn: 1, step: 1, message, stream: [] },
    surfaceOp: 'append',
  }
}

/** 一条 `user/message` 表面事件。 */
export function userEvent(seq: number, message: UserMessage): SessionEvent<'user/message'> {
  return { type: 'user/message', seq: SessionSeq(seq), time: 0, data: message, surfaceOp: 'append' }
}

/** 一条 `tool/result` 表面事件。 */
export function toolResultEvent(seq: number, message: ToolResultMessage): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: SessionSeq(seq), time: 0, data: { turn: 1, step: 1, message }, surfaceOp: 'append' }
}

/** 造一条真实用户消息。 */
export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * 造一条承载类型的事件。`data` 收 `unknown`：宿主真实形状、我们的 payload 与各种非法形状都由用例给。
 * @param seq - 事件序号。
 * @param data - 事件 payload。
 * @returns 一条 `web/deepseek-search-llm-request` 事件。
 */
export function carrierEvent(seq: number, data: unknown): SessionEvent<typeof CARRIER_EVENT_TYPE> {
  return {
    type: CARRIER_EVENT_TYPE,
    seq: SessionSeq(seq),
    time: 0,
    data: data as SessionEventMap[typeof CARRIER_EVENT_TYPE],
  }
}

/**
 * 读一条消息的 replay 信封两半（用例断言用；生产侧不导出这种访问器）。
 * @param message - 带信封的 assistant 消息。
 * @returns `response` 与 `blocks` 两半。
 */
export function envelopeOf(message: AssistantMessage): { response: Record<string, unknown>, blocks: Record<string, unknown>[] } {
  return message.source.replayState as { response: Record<string, unknown>, blocks: Record<string, unknown>[] }
}

/**
 * 造投影的输入 context。
 * @param events - 从 `baseSeq` 起的连续事件窗口（真实的窗口含候选事件本身）。
 * @param nodes - 当前表面节点序号。
 * @returns 一个纯数据 context。
 */
export function projectionContext(
  events: SessionEvent[],
  nodes: SessionSeq[],
): SessionMessageProjectionContext {
  return { nodes, events, baseSeq: SessionLogOffset(0), messages: new Map() }
}
