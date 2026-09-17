/**
 * 票据 06：等待模式的干预 —— `adjust` 注入复核建议、`stop` 追加停止说明并停止当前 turn。
 *
 * 观察面按票面写死：消息字段从 `deriveMessages()` 取那条真实追加路径上的消息（不退化成单测消息构造
 * 函数），「主模型能读到」断在同一会话随后一次模型请求的 `messages` 里。`stop` 侧的两半（落盘与
 * 模型可读）由停后那次请求一并覆盖；停止那一步不发模型请求、`turn/end` 带 hook 原因、说明先于
 * `turn/end` 落盘、停后会话仍可用，都落在同一次停止上。
 *
 * 第 8 条（`continue` 仍然什么都不做）是回归断言：03 的用例已断言它，本票只保证改完 `reviewOnce`
 * 的调用点之后既有用例仍绿——由门禁 `vitest run` 覆盖，不另写用例。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { boundContextSummary, type Message } from '@deepseek-ai/dsh-llm'
import * as navigator from '../src/index.ts'
import { SCRIPTED_TOOL_NAME, type ScriptedResponse } from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import {
  isReviewRequest,
  mountNavigatorLoop,
  type NavigatorLoop,
} from './support/loop-fixture.ts'

/** 每个用例一套独立 context：投影与事件监听都是全局的，串用会互相干扰。 */
afterEach(disposeTrackedContexts)

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** 让会话正常收尾的一步。 */
const DONE: ScriptedResponse = { text: '收到' }

/** `adjust` 结论里的建议内容：断言它出现在注入消息的正文里。 */
const RECOMMENDATION = '先把范围缩到导航插件的注入路径'

/** 一条 `adjust` 结论。 */
const ADJUST_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'adjust', reason: '主会话仍在推进', recommendation: RECOMMENDATION }),
}

/** `stop` 结论里的原因：它必须直接出现在对话里，同时是 `turn/end` 记下的 hook 原因。 */
const STOP_REASON = '主会话已经偏离目标'

/** 一条 `stop` 结论。 */
const STOP_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'stop', reason: STOP_REASON, recommendation: '停下来重新对齐' }),
}

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

/** 会话里本插件的干预消息（`form: 'notice'`），按落盘顺序。 */
function notices(fixture: NavigatorLoop): Message[] {
  return fixture.agent.session.deriveMessages().filter(
    message => message.source.kind === 'plugin'
      && message.source.plugin === navigator.name
      && message.source.form === 'notice',
  )
}

/** 一条干预消息的 `summary`（字段合规的两条判据都断在真实追加路径上取回的这条消息上）。 */
function summaryOf(message: Message | undefined): string {
  return message?.source.kind === 'plugin' && message.source.form === 'notice' ? message.source.summary : ''
}

/** 主会话自己的请求（复核自己那次请求不计入）。 */
function mainCalls(fixture: NavigatorLoop): number {
  return fixture.main.calls().filter(call => !isReviewRequest(call.request)).length
}

describe('等待模式 adjust：注入复核建议', () => {
  it('建议落盘进对话且字段合规，并出现在随后一次模型请求的 messages 里', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1 },
      script: [STEP, ADJUST_VERDICT, STEP],
    })
    await fixture.main.drive(2, '出发')

    const notice = notices(fixture).at(-1)
    expect(notice).toBeDefined()
    const body = textOf(notice)

    // 第 2 条：注入之后含这条消息的那次模型请求也在同一条会话上——`adjust` 把建议追加在本步
    // `decision.messages` 的末尾，所以本步自己的请求以它收尾。按末条消息定位，不借 `isReviewRequest`
    // 排除复核请求：建议是末条 plugin 消息，夹具按「末条是 plugin 消息」认复核请求，本步的请求会被
    // 误认成复核。
    const carrying = fixture.main.calls().find(
      call => call.request.messages.at(-1)?.id === notice?.id,
    )
    expect(carrying).toBeDefined()
    const triggerStep = carrying?.steps ?? -1

    // 第 3 条：字段合规只看消息字段，且断在真实追加路径上取回的那条消息上。
    expect(notice?.role).toBe('user')
    expect(notice?.source.kind).toBe('plugin')
    expect(summaryOf(notice).length).toBeGreaterThan(0)
    // 触发步骤写在正文开头；`summary` 是正文按上限的截断，因此也以触发步骤开头。
    expect(body.startsWith(`第 ${triggerStep} 步`)).toBe(true)
    expect(body).toContain(RECOMMENDATION)
    expect(summaryOf(notice)).toBe(boundContextSummary(body))
    expect(summaryOf(notice).startsWith(`第 ${triggerStep} 步`)).toBe(true)
  })
})

describe('等待模式 stop：追加停止说明并停止当前 turn', () => {
  it('说明先于 turn/end 落盘、写明原因、停止那一步不发请求，且停后会话仍可用', async () => {
    const K = 1
    const fixture = await mountNavigatorLoop({
      // 构造写死：`mountEagerly: false` 后把会话推进 K 步再挂插件，插件第一次 pre-step 求值时已完成
      // K 步；触发点由推导式给出（K=1 时是 2K），停止因此落在插件到点的那一次 pre-step 上。
      config: { triggerEverySteps: K },
      mountEagerly: false,
      script: [STEP, STEP, STOP_VERDICT, DONE],
    })
    await fixture.main.drive(K, '出发')
    await fixture.mountPlugin()
    // 推到插件触发点的步边界：到这一步为止主会话自己的请求数就是停止前的读数。
    await fixture.main.drive(K)
    expect(fixture.main.steps()).toBe(2 * K)
    const before = mainCalls(fixture)

    // 放行这一步：插件在触发点的 pre-step 里发复核、拿到 stop，追加说明后取消当前 turn。
    await fixture.main.drive(1)

    // 第 7(a) 条：复核自己那次请求必须发；主会话自己的请求数增量为 0——停止发生在模型请求之前。
    expect(fixture.main.reviews()).toHaveLength(1)
    expect(mainCalls(fixture) - before).toBe(0)
    const triggerStep = fixture.main.reviews()[0]?.steps ?? -1

    const notice = notices(fixture).at(-1)
    expect(notice).toBeDefined()
    const body = textOf(notice)

    // 第 3、4 条：字段合规、正文以触发步骤开头、正文写明本次结论的 reason。
    expect(notice?.role).toBe('user')
    expect(notice?.source.kind).toBe('plugin')
    expect(body.startsWith(`第 ${triggerStep} 步`)).toBe(true)
    expect(body).toContain(STOP_REASON)
    expect(summaryOf(notice)).toBe(boundContextSummary(body))
    expect(summaryOf(notice).startsWith(`第 ${triggerStep} 步`)).toBe(true)

    // 第 5(a) 条：这条 user/message 的 seq 严格小于随后 turn/end 的 seq。
    const events = fixture.events()
    const noticeIndex = events.findIndex(
      event => event.type === 'user/message' && event.data.id === notice?.id,
    )
    expect(noticeIndex).toBeGreaterThanOrEqual(0)
    const turnEnd = events.slice(noticeIndex).find(event => event.type === 'turn/end')
    expect(turnEnd).toBeDefined()
    expect(Number(events[noticeIndex]?.seq)).toBeLessThan(Number(turnEnd?.seq))

    // 第 5(b) 条：重新读取会话（同一个会话对象再 deriveMessages 一次）能按 id 与正文原样重建。
    const reread = fixture.agent.session.deriveMessages().find(message => message.id === notice?.id)
    expect(textOf(reread)).toBe(body)

    // 第 7(b) 条：停止这一步的 turn/end 带 hook 原因，原因文本就是传进去的那条。
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: STOP_REASON },
    })

    // 第 6 条：停后会话仍可继续接收新消息——这个 turn 以 completed 收尾，不再多出一条 aborted。
    const assistantsBefore = fixture.agent.session.deriveMessages()
      .filter(message => message.role === 'assistant').length
    const callsBefore = mainCalls(fixture)
    await fixture.send('继续')

    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
    expect(fixture.main.turnEndReasons().filter(reason => reason.kind === 'aborted')).toHaveLength(1)
    expect(mainCalls(fixture)).toBe(callsBefore + 1)
    expect(
      fixture.agent.session.deriveMessages().filter(message => message.role === 'assistant').length,
    ).toBe(assistantsBefore + 1)

    // 第 2、5(c) 条：停后那次请求的 messages 里有这条说明（按 id）——停止中止了上一个 turn，只有
    // 停后再发一条消息触发的请求才能正面证明它进了上下文。
    const after = fixture.main.calls().filter(call => !isReviewRequest(call.request)).at(-1)
    expect(after?.request.messages.some(message => message.id === notice?.id)).toBe(true)
  })
})
