/**
 * 票 01 第 1 条：裁剪资格**逐步骤**判定。
 *
 * 资格 = 该 `assistant/message` 的耐久 replay 信封是 pi-ai 且 `response.api === 'openai-completions'`。
 * 用例正面构造两端的反例（Messages 信封、别的 pi-ai 传输、没有信封），并用同一条日志里混用传输的两条
 * 消息证明判定逐条不同——只断「会话整体有资格/无资格」会让「逐步骤」这条要求空转。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isReasoningPrunable } from '../src/index.ts'
import {
  assistantEvent,
  assistantMessage,
  piAiReplayState,
  PRUNABLE_BLOCKS,
  PRUNABLE_CONTENT,
  userEvent,
  userMessage,
} from './support/fixtures.ts'

/** Messages 适配器的信封：`kind` 是 `deepseek-messages`，**没有 `api`**。 */
function messagesReplayState(): unknown {
  return {
    response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-v4-flash' },
    blocks: structuredClone(PRUNABLE_BLOCKS),
  }
}

/** 读一条 assistant 事件派生出的消息，拿它的裁剪资格。 */
function verdictOf(event: SessionEvent): boolean {
  const message = deriveEventMessage(event)
  if (message === null || message.role !== 'assistant') throw new Error('fixture: expected an assistant message')
  return isReasoningPrunable(message)
}

describe('裁剪资格：按每条 assistant 消息读它自己的传输', () => {
  it('pi-ai 信封且 api 是 openai-completions 时判为有资格', () => {
    const message = assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      replayState: piAiReplayState('openai-completions', PRUNABLE_BLOCKS),
    })
    expect(isReasoningPrunable(message)).toBe(true)
  })

  it('deepseek-messages 信封（无 api 字段）判为无资格', () => {
    const message = assistantMessage({ content: structuredClone(PRUNABLE_CONTENT), replayState: messagesReplayState() })
    expect(isReasoningPrunable(message)).toBe(false)
  })

  it('pi-ai 信封但 api 是 anthropic-messages 或 openai-responses 都判为无资格', () => {
    for (const api of ['anthropic-messages', 'openai-responses']) {
      const message = assistantMessage({
        content: structuredClone(PRUNABLE_CONTENT),
        replayState: piAiReplayState(api, PRUNABLE_BLOCKS),
      })
      expect(isReasoningPrunable(message), api).toBe(false)
    }
  })

  it('没有 replayState 判为无资格', () => {
    const message = assistantMessage({ content: structuredClone(PRUNABLE_CONTENT) })
    expect(isReasoningPrunable(message)).toBe(false)
  })

  it('同一条日志里混用传输：两条 assistant/message 的判定逐条不同', () => {
    const openai = assistantEvent(1, assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      replayState: piAiReplayState('openai-completions', PRUNABLE_BLOCKS),
    }))
    const messages = assistantEvent(3, assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      replayState: messagesReplayState(),
    }))
    // 同一条会话日志：user → assistant(chat-completions) → user → assistant(messages)。
    const log: SessionEvent[] = [userEvent(0, userMessage('first')), openai, userEvent(2, userMessage('second')), messages]
    const verdicts = log.filter(event => event.type === 'assistant/message').map(verdictOf)
    expect(verdicts).toEqual([true, false])
  })
})
