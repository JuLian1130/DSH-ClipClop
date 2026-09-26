/**
 * 票 01 第 4、6、7、8 条与第 5 条的投影侧：承载类型上的消息投影。
 *
 * 四块断言：
 * - **合法 payload 真的产出裁剪版**（本票核心交付）：同一个 `(event, context)` 调两次结果逐项相等、不改
 *   输入，且结果等于「移除推理块 + 同步过滤信封」。
 * - **宿主事件安全穿过**：判别规则写死为「顶层有没有 `clipclop` 键」，返回空 Map 且不抛。
 * - **我们的事件形状非法时当场抛**：两层键集合相等 + 非空 targets；错误必须是普通 `Error` 且点名承载
 *   类型与具体违规。
 * - **target 校验**：必须是当前表面节点、必须是 `assistant/message`、不得重复；且整体成功或整体失败。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  CARRIER_EVENT_TYPE,
  pruneReasoning,
  reasoningPrunerProjection,
} from '../src/index.ts'
import {
  assistantEvent,
  assistantMessage,
  carrierEvent,
  piAiReplayState,
  PRUNABLE_CONTENT,
  prunableAssistantMessage,
  projectionContext,
  toolResultEvent,
  userEvent,
  userMessage,
} from './support/fixtures.ts'

/** 合法 payload：裁掉 seq 0 那条 assistant 消息的推理块。 */
const VALID_PAYLOAD = { clipclop: { targets: [SessionSeq(0)] } }

/** 宿主自己写的真实形状（照 `web-search-deepseek` 的 `recordRequest` 三字段，用例直接写字面量）。 */
const HOST_PAYLOAD = {
  endpoint: 'https://api.deepseek.com/anthropic/messages',
  apiVersion: '2023-06-01',
  body: {
    model: 'deepseek-v4-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'search: dsh' }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  },
}

/**
 * 造一个「一条已记录的 assistant 消息 + 一条承载事件」的连续窗口（真实的投影窗口就是这样，候选事件
 * 自己也在窗口里）。
 * @param data - 承载事件的 payload。
 * @returns 消息、事件窗口与投影 context。
 */
function logFor(data: unknown) {
  const message = prunableAssistantMessage()
  const events: SessionEvent[] = [assistantEvent(0, message), carrierEvent(1, data)]
  return { message, events, context: projectionContext(events, [SessionSeq(0)]) }
}

describe('投影：合法 payload 产出裁剪版（纯函数）', () => {
  it('同一个 (event, context) 调两次结果逐项相等，且等于裁剪算子的结果', () => {
    const { message, events, context } = logFor(VALID_PAYLOAD)
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    const snapshot = structuredClone(message)

    const first = reasoningPrunerProjection.project(event, context)
    const second = reasoningPrunerProjection.project(event, context)

    // 恰含目标 seq，且消息等于「移除推理块 + 同步过滤信封」的结果。
    expect([...first.keys()]).toEqual([SessionSeq(0)])
    expect(first.get(SessionSeq(0))).toEqual(pruneReasoning(message))
    // 两次调用的每一项（含消息内容）逐字节相等。
    expect([...first]).toEqual([...second])

    // 不修改传入的消息对象。
    expect(message).toEqual(snapshot)

    // 走真实折叠路径同样产出裁剪版（不是只有直接调用才对）。
    const folded = foldSurface(events, [reasoningPrunerProjection])
    expect(folded.projectedMessages.get(SessionSeq(0))).toEqual(pruneReasoning(message))
  })
})

describe('投影：不是我们写的该类型事件安全穿过', () => {
  it('宿主真实形状返回空 Map、不抛错，模型可见历史零变化', () => {
    const { message, events, context } = logFor(HOST_PAYLOAD)
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    const messages = foldSurface(events, [reasoningPrunerProjection])
    expect(reasoningPrunerProjection.project(event, context).size).toBe(0)
    expect(messages.nodes).toEqual([SessionSeq(0)])
    expect(messages.projectedMessages.size).toBe(0)
    expect(foldSurface(events, [])).toEqual(messages)
    expect(message.content).toHaveLength(3)
  })

  it('data 不是对象或没有 clipclop 键都落进宿主分支（不是抛错用例）', () => {
    for (const data of [null, 42, 'clipclop-free', [1, 2], { endpoint: 'e', apiVersion: 'v', body: {} }]) {
      const { events, context } = logFor(data)
      const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
      expect(() => reasoningPrunerProjection.project(event, context), JSON.stringify(data)).not.toThrow()
      expect(reasoningPrunerProjection.project(event, context).size).toBe(0)
    }
  })
})

describe('投影：我们的事件形状非法时当场抛', () => {
  const invalidShapes: Array<{ label: string, data: unknown, violation: string }> = [
    { label: 'clipclop 不是对象', data: { clipclop: 42 }, violation: 'clipclop must be an object' },
    { label: '顶层多出一个键', data: { clipclop: { targets: [SessionSeq(0)] }, turn: 1 }, violation: 'exactly the one clipclop key' },
    { label: 'clipclop 里多出一个键', data: { clipclop: { targets: [SessionSeq(0)], turn: 1 } }, violation: 'exactly the targets key' },
    { label: 'targets 缺失', data: { clipclop: {} }, violation: 'targets must be a nonempty array' },
    { label: 'targets 不是数组', data: { clipclop: { targets: 'seq-0' } }, violation: 'targets must be a nonempty array' },
    { label: 'targets 是空数组', data: { clipclop: { targets: [] } }, violation: 'targets must be a nonempty array' },
  ]

  for (const { label, data, violation } of invalidShapes) {
    it(`${label}：抛普通 Error、点名承载类型与具体违规`, () => {
      const { events, context } = logFor(data)
      const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
      let thrown: unknown
      try {
        reasoningPrunerProjection.project(event, context)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).constructor).toBe(Error)
      expect(String(thrown)).toContain(CARRIER_EVENT_TYPE)
      expect(String(thrown)).toContain(violation)
      // 校验先于产出：抛错时没有任何替换被折叠进去。
      expect(() => foldSurface(events, [reasoningPrunerProjection])).toThrow()
    })
  }
})

describe('投影：target 必须是当前表面节点上的 assistant/message', () => {
  it('目标 seq 不在 context.nodes 里时抛', () => {
    const { events, context } = logFor({ clipclop: { targets: [SessionSeq(9)] } })
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    expect(() => reasoningPrunerProjection.project(event, context)).toThrow(
      /target seq 9 is not a current surface node/,
    )
  })

  it('目标 seq 指向 user/message 时抛', () => {
    const events: SessionEvent[] = [userEvent(0, userMessage('hi')), carrierEvent(1, VALID_PAYLOAD)]
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    expect(() => reasoningPrunerProjection.project(event, projectionContext(events, [SessionSeq(0)]))).toThrow(
      /target seq 0 must be an assistant\/message/,
    )
  })

  it('目标 seq 指向 tool/result 时抛', () => {
    const result = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    const events: SessionEvent[] = [toolResultEvent(0, result), carrierEvent(1, VALID_PAYLOAD)]
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    expect(() => reasoningPrunerProjection.project(event, projectionContext(events, [SessionSeq(0)]))).toThrow(
      /target seq 0 must be an assistant\/message/,
    )
  })

  it('同一个 seq 在 targets 里出现两次时抛', () => {
    const { events, context } = logFor({ clipclop: { targets: [SessionSeq(0), SessionSeq(0)] } })
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    expect(() => reasoningPrunerProjection.project(event, context)).toThrow(/duplicate target seq 0/)
  })

  it('整体成功或整体失败：合法目标加非法目标时不留半份替换', () => {
    const { message, events, context } = logFor({ clipclop: { targets: [SessionSeq(0), SessionSeq(9)] } })
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    const snapshot = structuredClone(message)
    expect(() => reasoningPrunerProjection.project(event, context)).toThrow(/target seq 9 is not a current surface node/)
    expect(() => foldSurface(events, [reasoningPrunerProjection])).toThrow()
    expect(message).toEqual(snapshot)
  })
})

describe('投影：资格不成立的步骤原样保留', () => {
  it('目标是无 replayState 的 assistant 消息时不产出改动，也不报错', () => {
    const events: SessionEvent[] = [
      assistantEvent(0, assistantMessage({ content: [{ type: 'reasoning', text: 'no envelope' }] })),
      carrierEvent(1, VALID_PAYLOAD),
    ]
    const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
    expect(reasoningPrunerProjection.project(event, projectionContext(events, [SessionSeq(0)])).size).toBe(0)
  })

  it('信封不可用（缺 blocks / 块数不符 / 逐位不同类型）时同样原样保留，不抛', () => {
    // 投影不得抛「信息不足」类错误：一抛那条日志就再也读不出来。三种信封都不能让折叠失败。
    const brokenEnvelopes = [
      { response: { kind: 'pi-ai', api: 'openai-completions' } }, // 没有 blocks
      piAiReplayState('openai-completions', []), // 块数不符
      piAiReplayState('openai-completions', [{ type: 'text' }, { type: 'text' }, { type: 'tool-call' }]), // 逐位不同类型
    ]
    for (const replayState of brokenEnvelopes) {
      const events: SessionEvent[] = [
        assistantEvent(0, assistantMessage({ content: structuredClone(PRUNABLE_CONTENT), replayState })),
        carrierEvent(1, VALID_PAYLOAD),
      ]
      const event = events[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>
      expect(() => reasoningPrunerProjection.project(event, projectionContext(events, [SessionSeq(0)]))).not.toThrow()
      expect(reasoningPrunerProjection.project(event, projectionContext(events, [SessionSeq(0)])).size).toBe(0)
      expect(foldSurface(events, [reasoningPrunerProjection]).projectedMessages.size).toBe(0)
    }
  })
})
