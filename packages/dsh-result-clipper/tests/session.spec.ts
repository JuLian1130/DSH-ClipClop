/**
 * 票 03 第 10、11 条：替换后的落盘内容被 token 计量器读到（自动压缩的触发随之推迟），且启用摘要不改变既有
 * 助手消息（推理裁剪器的输入面）。
 *
 * 观察面是**真会话**：`tool/result` 事件的落盘投影与 `ctx.tokenMeter.measure(session)` 的表面读数。两臂
 * （摘要开 / 关）用同一份脚本驱动，除那条工具结果外同形，因此计量器读数之差就是这条结果被计价的那部分。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import { composeEntry } from '../src/entry.ts'
import { runLoop } from './support/loop.ts'
import type { LoopFixture } from './support/loop.ts'

const open: LoopFixture[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

/** 刚过摘要下限的正文。 */
const BODY = 'x'.repeat(5000)

/** 摘要模型回的短说明。 */
const SUMMARY = '这是一段短说明'

/**
 * 跑一个 turn 并登记收场。
 * @param config - 被测插件的配置。
 * @returns 夹具。
 */
async function tracked(config: Schemastery.TypeS<typeof Config>): Promise<LoopFixture> {
  const fixture = await runLoop(config, BODY, SUMMARY)
  open.push(fixture)
  return fixture
}

/** 会话里第一条 `tool/result` 事件。 */
function toolResult(fixture: LoopFixture): SessionEvent {
  const event = fixture.agent.session.snapshotEvents().find(candidate => candidate.type === 'tool/result')
  if (event === undefined) throw new Error('fixture: the turn produced no tool/result event')
  return event
}

/** 一条 `tool/result` 事件的模型可见消息。 */
function toolResultMessage(fixture: LoopFixture): Message {
  return (toolResult(fixture).data as { message: Message }).message
}

/**
 * 一条 `tool/result` 事件的模型可见文本。
 * @param fixture - 夹具。
 * @returns 文本块拼接结果。
 */
function toolResultText(fixture: LoopFixture): string {
  return toolResultMessage(fixture).content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** 全部 `assistant/message` 事件的内容块，按序。 */
function assistantContent(fixture: LoopFixture): readonly (readonly ContentBlock[])[] {
  return fixture.agent.session.snapshotEvents()
    .filter(event => event.type === 'assistant/message')
    .map(event => (event.data as { message: { content: readonly ContentBlock[] } }).message.content)
}

describe('票 03 第 10 条：替换后的落盘内容被 token 计量器读到', () => {
  it('会话里落盘的是入口说明 + 摘要，且计量器的表面读数按它计价（阴性对照：关闭摘要时按原文计价）', async () => {
    const on = await tracked({ summarize: true, routeProvider: 'mock', routeModel: 'mock' })
    const off = await tracked({ summarize: false })

    expect(toolResultText(on)).toBe(composeEntry(on.spill.refs[0]!) + SUMMARY)
    expect(toolResultText(off)).toBe(BODY)

    // 两臂除这条结果外同形；差值必须恰好等于「原文 vs 摘要」在计量器眼里的差价——不是「小了一点」。
    const priced = on.ctx.tokenMeter.measure(on.agent.session)
    const baseline = off.ctx.tokenMeter.measure(off.agent.session)
    expect(baseline.surfaceTokens - priced.surfaceTokens)
      .toBe(on.ctx.tokenMeter.estimateMessage(toolResultMessage(off)) - on.ctx.tokenMeter.estimateMessage(toolResultMessage(on)))
    expect(priced.surfaceTokens).toBeLessThan(baseline.surfaceTokens)
  })
})

describe('票 03 第 11 条：启用摘要不改变既有助手消息', () => {
  it('助手消息（含推理块）在摘要开与关两臂逐字相同', async () => {
    const on = await tracked({ summarize: true, routeProvider: 'mock', routeModel: 'mock' })
    const off = await tracked({ summarize: false })

    expect(assistantContent(on)).toEqual(assistantContent(off))
    expect(JSON.stringify(assistantContent(on))).toContain('reasoning-kept')
  })
})
