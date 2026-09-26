/**
 * 票 01 第 2、3 条：裁剪算子。
 *
 * 断言写死为「块数相等 + 逐位同类型」，并**正面构造两种不一致**：只改内容不改信封（块数不等）、以及块数
 * 相等但第 i 位类型不同。没有这两条反例，「同步过滤」被实现成「过滤内容、信封原样」也全绿——而那正是
 * 会静默降级、丢掉签名的那个坑。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { pruneReasoning, replayEnvelopeAlignsWithContent } from '../src/index.ts'
import {
  assistantMessage,
  envelopeOf,
  piAiReplayState,
  PRUNABLE_BLOCKS,
  PRUNABLE_CONTENT,
  prunableAssistantMessage,
} from './support/fixtures.ts'

describe('裁剪：移除推理块，且与 replay 信封同步过滤', () => {
  it('裁剪后内容为 [text, tool-call]，信封块数组长度同样为 2 且逐位同类型', () => {
    const pruned = pruneReasoning(prunableAssistantMessage())
    expect(pruned.content.map(block => block.type)).toEqual(['text', 'tool-call'])
    const { blocks } = envelopeOf(pruned)
    expect(blocks).toHaveLength(2)
    expect(blocks.map(block => block.type)).toEqual(['text', 'tool-call'])
    expect(replayEnvelopeAlignsWithContent(pruned)).toBe(true)
  })

  it('正面反例：只移除内容块、信封原样（块数不等）必须判为不一致', () => {
    const original = prunableAssistantMessage()
    const contentOnly: AssistantMessage = {
      ...original,
      content: original.content.filter(block => block.type !== 'reasoning'),
    }
    expect(contentOnly.content).toHaveLength(2)
    expect(envelopeOf(contentOnly).blocks).toHaveLength(3)
    expect(replayEnvelopeAlignsWithContent(contentOnly)).toBe(false)
  })

  it('正面反例：块数相等但第 i 位类型不同必须判为不一致', () => {
    const mismatched = assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      // 第 1 位内容块是 reasoning，信封却声明 text；块数仍相等。
      replayState: piAiReplayState('openai-completions', [
        { type: 'text', textSignature: 'sig-text' },
        { type: 'text', textSignature: 'sig-think' },
        { type: 'tool-call', thoughtSignature: 'sig-tool' },
      ]),
    })
    expect(envelopeOf(mismatched).blocks).toHaveLength(mismatched.content.length)
    expect(replayEnvelopeAlignsWithContent(mismatched)).toBe(false)
  })

  it('裁剪不改变消息身份与其余内容，存活块连签名一起留在信封的对应位置', () => {
    const original = prunableAssistantMessage()
    const pruned = pruneReasoning(original)

    expect(pruned.id).toBe(original.id)
    expect(pruned.role).toBe('assistant')
    expect(pruned.source.provider).toBe(original.source.provider)
    expect(pruned.source.model).toBe(original.source.model)
    expect(pruned.source.kind).toBe('model')

    // 信封只有 blocks 按同一规则同步过滤，其余（含 response 半部）逐字段不变。
    const before = envelopeOf(original)
    const after = envelopeOf(pruned)
    expect(after.response).toEqual(before.response)
    expect({ ...after, blocks: before.blocks }).toEqual(before)
    expect(after.blocks).toEqual([PRUNABLE_BLOCKS[0], PRUNABLE_BLOCKS[2]])

    // 存活内容块逐字段不变；文本签名与工具调用签名仍在过滤后信封的对应位置。
    expect(pruned.content[0]).toEqual(original.content[0])
    expect(pruned.content[1]).toEqual(original.content[2])
    expect(after.blocks[0]).toEqual({ type: 'text', textSignature: 'sig-text' })
    expect(after.blocks[1]).toEqual({ type: 'tool-call', thoughtSignature: 'sig-tool' })

    // 工具调用配对不受影响：id / name / arguments 三者逐字段相等。
    const call = pruned.content[1] as ToolCallBlock
    expect({ id: call.id, name: call.name, arguments: call.arguments })
      .toEqual({ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' })
  })

  it('没有推理块可移除时原样返回同一条消息（重复折叠幂等）', () => {
    const pruned = pruneReasoning(prunableAssistantMessage())
    expect(pruneReasoning(pruned)).toBe(pruned)
  })

  it('信封块数与内容不符时当场抛，不产出半份裁剪', () => {
    const broken = assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      replayState: piAiReplayState('openai-completions', PRUNABLE_BLOCKS.slice(0, 2)),
    })
    expect(() => pruneReasoning(broken)).toThrow(/replay envelope holds 2 block\(s\) for 3 content block\(s\)/)
  })
})
