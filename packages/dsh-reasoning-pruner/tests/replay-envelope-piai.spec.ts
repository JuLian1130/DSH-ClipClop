/**
 * 票 04 第 1–3 条的 **pi-ai 半边**：在真实 `PiAiAdapter` 上观测 replay 信封退化。
 *
 * 第 1 条是本票的存亡点，它的判据必须是非空的**后果**：只改内容不改信封时，适配器吞掉
 * `INVALID_REPLAY_STATE` 并把**整条消息**降级成 provider-neutral 重建——不该丢的文本签名与工具调用
 * 签名一起没了，且全程不报错。第 2 条是同一条消息的正确裁剪，与第 1 条是同一对照的两端。第 3 条补上
 * 「块数相等但第 i 位类型不同」这一种：两个适配器都是先查块数、再逐位查类型。
 *
 * 反例一律**显式构造**（不靠「先 prune 再反转」，也不用 `pruneReasoning` 造反例——它是对照组的正面路径）。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import { pruneReasoning } from '../src/index.ts'
import {
  assistantMessage,
  piAiReplayState,
  PRUNABLE_BLOCKS,
  PRUNABLE_CONTENT,
  prunableAssistantMessage,
} from './support/fixtures.ts'
import { PiAiReplayDriver } from './support/piai-replay-driver.ts'
import type { WireAssistantMessage } from './support/piai-replay-driver.ts'

/** pi-ai 在线上的三种签名，各自绑一块。 */
const SIGNATURE_FIELDS = ['thinkingSignature', 'textSignature', 'thoughtSignature'] as const

/**
 * 线上一条 assistant 消息里出现的签名字段名，按块顺序。
 * @param message - 线上那条 assistant 消息。
 * @returns 存在的签名字段名；整条降级后为空数组。
 */
function signatureFields(message: WireAssistantMessage): string[] {
  return message.content.flatMap(block => SIGNATURE_FIELDS.filter(field => field in block))
}

/**
 * 把一条消息交给真实适配器走一次请求，取回驱动与线上那条 assistant 消息。
 * @param message - 该请求唯一的 assistant 消息。
 * @returns 驱动实例与线上形状。
 * @throws 请求没走到 `streamSimple`（两个观察面都还没固定）时。
 */
async function drive(message: AssistantMessage): Promise<{ driver: PiAiReplayDriver, wire: WireAssistantMessage }> {
  const driver = new PiAiReplayDriver()
  await driver.run([message])
  const wire = driver.wireAssistant(0)
  if (wire === undefined) throw new Error('piai-replay-driver: the request never reached streamSimple')
  return { driver, wire }
}

describe('第 1 条：只改内容不改信封 ⇒ 退化，且整条消息的签名全丢', () => {
  it('内容已移除推理块（2 块）而信封原样（3 块）⇒ 块数不符触发退化，线上无任何签名字段', async () => {
    // 显式构造：内容 [text, tool-call]，信封仍是 [reasoning, text, tool-call]。
    const contentOnly: AssistantMessage = {
      ...prunableAssistantMessage(),
      content: structuredClone(PRUNABLE_CONTENT).filter(block => block.type !== 'reasoning'),
    }
    expect(contentOnly.content.map(block => block.type)).toEqual(['text', 'tool-call'])
    expect((contentOnly.source.replayState as { blocks: unknown[] }).blocks).toHaveLength(3)

    const { driver, wire } = await drive(contentOnly)

    expect(driver.degradeCalls).toHaveLength(1)
    expect(driver.degradeCalls[0].reason).toContain('block count does not match assistant content')

    // 后果判据：整条消息跌落成 provider-neutral 重建，存活块的签名也没了。
    expect(signatureFields(wire)).toEqual([])
    expect(wire.content.map(block => block.type)).toEqual(['text', 'toolCall'])
  })
})

describe('第 2 条：同一条消息按正确做法裁剪 ⇒ 零退化且存活块签名仍在', () => {
  it('内容与信封同步过滤后，文本签名与工具调用签名都留在线上', async () => {
    // 与第 1 条同一来源（`prunableAssistantMessage` 的 [text, reasoning, tool-call]），这里是它的正面路径。
    const { driver, wire } = await drive(pruneReasoning(prunableAssistantMessage()))

    expect(driver.degradeCalls).toEqual([])

    // 被裁的推理块已不在线上；幸存的文本与工具调用带着各自的签名。
    expect(wire.content.map(block => block.type)).toEqual(['text', 'toolCall'])
    expect(signatureFields(wire)).toEqual(['textSignature', 'thoughtSignature'])
    expect(wire.content[0]).toMatchObject({ type: 'text', text: 'the answer', textSignature: 'sig-text' })
    expect(wire.content[1]).toMatchObject({
      type: 'toolCall',
      id: 'call-1',
      name: 'read_file',
      thoughtSignature: 'sig-tool',
    })
  })
})

describe('第 3 条：跨块数的两种退化构造都要测', () => {
  it('A 块数不等（内容比信封多）：内容 3 块、信封 2 块 ⇒ 块数不符，线上无任何签名字段', async () => {
    // 第 1 条是「信封比内容多」那一侧，这里是另一侧。
    const contentHeavier = assistantMessage({
      content: structuredClone(PRUNABLE_CONTENT),
      replayState: piAiReplayState('openai-completions', PRUNABLE_BLOCKS.slice(0, 2)),
    })
    expect(contentHeavier.content).toHaveLength(3)

    const { driver, wire } = await drive(contentHeavier)

    expect(driver.degradeCalls).toHaveLength(1)
    expect(driver.degradeCalls[0].reason).toContain('block count does not match assistant content')
    expect(signatureFields(wire)).toEqual([])
    expect(wire.content.map(block => block.type)).toEqual(['text', 'thinking', 'toolCall'])
  })

  it('B 块数相等但第 0 位类型不同（内容 reasoning、信封 text）⇒ 逐位比较触发退化，签名全丢', async () => {
    const sameCount: AssistantMessage = assistantMessage({
      content: [
        { type: 'reasoning', text: 'the thinking' },
        { type: 'text', text: 'the answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
      replayState: piAiReplayState('openai-completions', [
        { type: 'text', textSignature: 'sig-text' },
        { type: 'text', textSignature: 'sig-text-2' },
        { type: 'tool-call', thoughtSignature: 'sig-tool' },
      ]),
    })
    expect((sameCount.source.replayState as { blocks: unknown[] }).blocks)
      .toHaveLength(sameCount.content.length)

    const { driver, wire } = await drive(sameCount)

    expect(driver.degradeCalls).toHaveLength(1)
    expect(driver.degradeCalls[0].reason).toContain('block 0 does not match assistant content')
    expect(signatureFields(wire)).toEqual([])
    expect(wire.content.map(block => block.type)).toEqual(['thinking', 'text', 'toolCall'])
  })
})
