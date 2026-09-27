/**
 * 票 04 第 1、2、3 条的 **Messages 半边**：在真实 `DeepSeekAdapter` 驱动的完整请求路径上观察退化信号
 * 与线上签名。
 *
 * Messages 的签名只能挂在 reasoning 块上（信封里给别的类型写 `signature` 会被判 `invalid signature`），
 * 线上对应 `thinking` 块。两条退化构造都写死：块数不等、块数相等但逐位类型不同。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { pruneReasoning, replayEnvelopeAlignsWithContent } from '../src/index.ts'
import { driveMessagesRequest, MESSAGES_MODEL } from './support/messages-replay-driver.ts'
import type { MessagesDriveObservation, MessagesWireBody } from './support/messages-replay-driver.ts'

/** 信封块；Messages 只允许 reasoning 带 `signature`。 */
type EnvelopeBlock = { type: 'text' | 'reasoning' | 'tool-call'; signature?: string }

/** 造一个 Messages 耐久 replay 信封。 */
function messagesEnvelope(blocks: readonly EnvelopeBlock[]): unknown {
  return { response: { kind: 'deepseek-messages', version: 1, model: MESSAGES_MODEL }, blocks }
}

/** 造一条待观察的 assistant 消息。 */
function targetMessage(content: readonly ContentBlock[], blocks: readonly EnvelopeBlock[]): AssistantMessage {
  return createAssistantMessage({
    content,
    source: { provider: 'deepseek', model: MESSAGES_MODEL, replayState: messagesEnvelope(blocks) },
  })
}

/** 一个 user 分隔轮，让相邻的 assistant 消息在线上不被合并。 */
function userTurn(): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
}

/**
 * 同一条请求里一条**不参与构造**的对照 assistant：内容与信封对齐，签名应当原样到线上。
 *
 * 有它才能断「签名丢失」不是抓不到签名的假象；没有它，`body` 里没有任何签名也全绿。
 */
const CONTROL = createAssistantMessage({
  content: [{ type: 'text', text: 'control answer' }, { type: 'reasoning', text: 'control thinking' }],
  source: {
    provider: 'deepseek',
    model: MESSAGES_MODEL,
    replayState: messagesEnvelope([{ type: 'text' }, { type: 'reasoning', signature: 'sig-control' }]),
  },
})

/** 历史 = 待观察的 assistant + 可选插入消息 + 分隔轮 + 对照；驱动一次请求。 */
function drive(target: Message, between: readonly Message[] = []): Promise<MessagesDriveObservation> {
  return driveMessagesRequest([target, ...between, userTurn(), CONTROL])
}

/** 请求体里的 assistant 消息，按顺序：第一条是待观察消息，第二条是对照。 */
function assistantHistory(body: MessagesWireBody) {
  const sent = body.messages.filter(message => message.role === 'assistant')
  return { sent: sent[0], control: sent[1] }
}

/** 该消息是否在线上带了签名。 */
function hasSignature(message: { content: readonly { signature?: string }[] }): boolean {
  return message.content.some(block => block.signature !== undefined)
}

describe('票 04 第 1–3 条 Messages 半边：真实 DeepSeekAdapter 上的退化与签名', () => {
  it('第 1 条 · 反例：只改内容不改信封（块数不等）时整条消息静默退化，存活推理块的签名也没了', async () => {
    // 内容只留 [text, reasoning]，信封仍原样声明 3 块。
    const target = targetMessage(
      [{ type: 'text', text: 'the answer' }, { type: 'reasoning', text: 'the thinking' }],
      [{ type: 'text' }, { type: 'reasoning', signature: 'sig-dropped' }, { type: 'reasoning', signature: 'sig-also-dropped' }],
    )
    const observation = await drive(target)

    expect(observation.degradeReasons).toHaveLength(1)
    expect(observation.degradeReasons[0]).toContain('block count mismatch')

    const { sent, control } = assistantHistory(observation.body)
    expect(sent.content.map(block => block.type)).toEqual(['text', 'thinking'])
    // 退化后整个信封被丢弃（readReplay 返回 undefined）：存活的 reasoning 块线上不带签名。
    expect(hasSignature(sent)).toBe(false)
    // 同一请求里未受影响的对照消息签名仍在。
    expect(control.content.find(block => block.type === 'thinking')?.signature).toBe('sig-control')
  })

  it('第 2 条 · 同一形状按 pruneReasoning 同步裁剪后不退化，信封仍逐位对齐', async () => {
    const original = targetMessage(
      [{ type: 'text', text: 'the answer' }, { type: 'reasoning', text: 'first thinking' }, { type: 'reasoning', text: 'second thinking' }],
      [{ type: 'text' }, { type: 'reasoning', signature: 'sig-first' }, { type: 'reasoning', signature: 'sig-second' }],
    )
    const pruned = pruneReasoning(original)
    expect(replayEnvelopeAlignsWithContent(pruned)).toBe(true)

    const observation = await drive(pruned)

    expect(observation.degradeReasons).toHaveLength(0)
    const { sent, control } = assistantHistory(observation.body)
    expect(sent.content.map(block => block.type)).toEqual(['text'])
    // Messages 的签名只能挂在 reasoning 上（给别的类型写 `signature` 会被判 `invalid signature`），而
    // `pruneReasoning` 恰好移除全部 reasoning，所以这条被裁消息在线上**不可能**再有任何签名——「存活块
    // 签名仍在」在本传输上没有正面实例，正面实例只在 pi-ai 侧（那里 text/tool-call 块各自带签名）。这一
    // 侧可断的是「同步裁剪后不退化」，以及同一请求里对照消息的签名照样到得了线上。
    expect(hasSignature(sent)).toBe(false)
    expect(control.content.find(block => block.type === 'thinking')?.signature).toBe('sig-control')
  })

  it('第 3 条 A · 块数不等的另一个方向（信封比内容少）同样退化并丢签名', async () => {
    const target = targetMessage(
      [{ type: 'text', text: 'the answer' }, { type: 'reasoning', text: 'the thinking' }],
      [{ type: 'text' }],
    )
    const observation = await drive(target)

    expect(observation.degradeReasons).toHaveLength(1)
    expect(observation.degradeReasons[0]).toContain('block count mismatch')

    const { sent, control } = assistantHistory(observation.body)
    expect(sent.content.map(block => block.type)).toEqual(['text', 'thinking'])
    expect(hasSignature(sent)).toBe(false)
    expect(control.content.find(block => block.type === 'thinking')?.signature).toBe('sig-control')
  })

  it('第 3 条 B · 块数相等但第 i 位类型不同（信封仍是 reasoning，内容已是 tool-call）同样退化并丢签名', async () => {
    const callId = ToolCallId('call-b')
    const target = targetMessage(
      [{ type: 'reasoning', text: 'the thinking' }, { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' }],
      [{ type: 'reasoning', signature: 'sig-live' }, { type: 'reasoning', signature: 'sig-unused' }],
    )
    const observation = await drive(target, [
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false }),
    ])

    expect(observation.degradeReasons).toHaveLength(1)
    expect(observation.degradeReasons[0]).toContain('block type mismatch')

    const { sent, control } = assistantHistory(observation.body)
    expect(sent.content.map(block => block.type)).toEqual(['thinking', 'tool_use'])
    // 第 0 位内容块是 reasoning，信封同位置也声明 reasoning 并带签名——对齐时它会到线上，退化后不会。
    expect(hasSignature(sent)).toBe(false)
    expect(control.content.find(block => block.type === 'thinking')?.signature).toBe('sig-control')
  })
})
