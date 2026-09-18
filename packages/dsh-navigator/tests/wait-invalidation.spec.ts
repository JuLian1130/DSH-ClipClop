/**
 * 票据 07：等待期作废 —— 等待复核期间到达的真实用户消息让本次复核作废。
 *
 * 「作废」= 中止在途复核（本次结论不被应用）+ 经 04 的写入入口落一条状态为「取消」、原因为
 * 「作废」的记录；**不调用 `agent.cancel`**（默认清空待处理队列，会把用户刚发的话丢掉）。
 *
 * 观察面按票面第 1 条写死为四条，两个窗口、两条送法共用、同形断言不重写：
 *  (a) 没有新的插件来源 `user/message` 落盘，`deriveMessages()` 里也没有新 notice —— 不注入、不追加停止说明；
 *  (b) `turnEndReasons()` 全表里不出现 hook 触发的 `aborted` —— 不停止；
 *  (c) 这条真实用户消息随后进入会话历史并被正常处理；
 *  (d) 按会话 id 读回被作废那次复核的取消记录：`triggerStep` 钉到触发点值、状态「取消」、原因为「作废」。
 * 本票第 4 项另按**原始存储文档**复验取消态的 `verdict` / `failureReason` 是 `undefined`（读回入口经
 * 声明 schema 解析、会剥掉未声明的键，只按它断等于空转）。
 *
 * 五个用例：窗口一（复核在途到达）× `followup` / `steer` 各一条，另加一条 `continue` 结论——在途那一支
 * 不看结论，任何结论都作废；窗口二（消息在触发点之前入队、被那次 pre-step 的 claim 取走）× `steer`
 * 一条；窗口三（消息在触发点那次 claim 之后、复核发起之前到达，由插入监听器置位）× `steer` 一条。
 * 五条都挂真实存储栈，否则 (d) 读不回取消记录。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as navigator from '../src/index.ts'
import {
  REVIEW_DOMAIN_NAME,
  REVIEW_TABLE,
  readReviewRecords,
  reviewRecordKey,
} from '../src/index.ts'
import { SCRIPTED_TOOL_NAME, userMessage, type ScriptedResponse } from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import { isReviewRequest, mountNavigatorLoop, type NavigatorLoop } from './support/loop-fixture.ts'

/** 每个用例一套独立 context；磁盘根也逐用例回收。 */
const roots: string[] = []

afterEach(async () => {
  await disposeTrackedContexts()
  await Promise.all(roots.splice(0).map(
    root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
})

/**
 * 造一个空的 JSON 后端根。
 * @returns 临时目录路径。
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-invalidation-'))
  roots.push(root)
  return root
}

/** 间隔 2：插件早于第 1 步就已挂载，第一次复核的触发点值是 2。 */
const EVERY_STEPS = 2

/**
 * 被作废那次复核的触发点值。触发点值是触发点那一刻的**已完成步数**，不指步号；两条送法都取 2
 * （复核在步骤数走到 2 那一刻的 pre-step、也就是第 3 步的 pre-step 发出）。
 */
const TRIGGER_STEP = 2

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** 让会话正常收尾的一步：承载复核那一步之后用它收尾，本轮在下一次到点之前结束。 */
const DONE: ScriptedResponse = { text: '收到' }

/** `stop` 结论的原因：结论取 `stop`，一条构造同时兑现「不追加停止说明」与「不停止」。 */
const STOP_REASON = '主会话已经偏离目标'

/** 一条 `stop` 结论。 */
const STOP_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'stop', reason: STOP_REASON, recommendation: '停下来重新对齐' }),
}

/** 一条 `continue` 结论：在途到达那一支不看结论，照作废；claim 检查那一支才过滤它。 */
const CONTINUE_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'continue', reason: '看起来正常', recommendation: '无' }),
}

/** 本插件写入的 user 消息（`source.kind === 'plugin'` 且插件名是本插件），按 `deriveMessages()` 顺序。 */
function pluginUserMessages(fixture: NavigatorLoop) {
  return fixture.agent.session.deriveMessages().filter(
    message => message.role === 'user'
      && message.source.kind === 'plugin'
      && message.source.plugin === navigator.name,
  )
}

/** 本插件落盘的 `user/message` 事件数。 */
function pluginUserMessageEvents(fixture: NavigatorLoop): number {
  return fixture.events().filter(
    event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === navigator.name,
  ).length
}

/** (a)：不注入复核建议、也不追加停止说明。 */
function expectNoPluginIntervention(fixture: NavigatorLoop): void {
  expect(pluginUserMessages(fixture)).toEqual([])
  expect(pluginUserMessageEvents(fixture)).toBe(0)
}

/** (b)：不停止——全表里不出现 hook 触发的 `aborted`（`{ kind: 'aborted', reason: { kind: 'hook' } }`）。 */
function expectNoHookAbort(fixture: NavigatorLoop): void {
  expect(
    fixture.main.turnEndReasons().some(
      reason => reason.kind === 'aborted' && reason.reason.kind === 'hook',
    ),
  ).toBe(false)
}

/** (c)：这条真实用户消息进入会话历史，并出现在随后一次主会话（非复核）模型请求的 `messages` 里。 */
function expectProcessed(fixture: NavigatorLoop, messageId: string): void {
  expect(fixture.agent.session.deriveMessages().some(message => message.id === messageId)).toBe(true)
  expect(
    fixture.main.calls().some(
      call => !isReviewRequest(call.request)
        && call.request.messages.some(message => message.id === messageId),
    ),
  ).toBe(true)
}

/**
 * 读某个会话某一步的原始存储文档里的 `record`（不经读回入口、不复制 schema）。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 触发步骤。
 * @returns 文档里的 `record` 原值。
 */
async function rawRecord(
  root: string,
  sessionId: SessionId,
  triggerStep: number,
): Promise<Record<string, unknown>> {
  const path = join(root, REVIEW_DOMAIN_NAME, REVIEW_TABLE, `${reviewRecordKey(sessionId, triggerStep)}.json`)
  const document = JSON.parse(await readFile(path, 'utf8')) as { record: Record<string, unknown> }
  return document.record
}

/**
 * (d) 与本票第 4 项：按会话 id 读回本次构造里被作废那次复核的取消记录，并按原始存储文档复验
 * 取消态的两个结论字段缺省。条数按「本次构造实际被作废的复核条数」——本次只作废在途那一次。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 被作废那次复核的触发点值。
 */
async function expectCancelledRecord(
  root: string,
  sessionId: SessionId,
  triggerStep: number,
): Promise<void> {
  const records = readReviewRecords(sessionId)
  expect(records.map(record => [record.triggerStep, record.status, record.cancelReason]))
    .toEqual([[triggerStep, 'cancelled', 'invalidated']])

  // 第 4 项：按原始存储文档复验取消态；读回入口会剥掉未声明的键，只按它断等于空转。
  const record = await rawRecord(root, sessionId, triggerStep)
  expect(record['triggerStep']).toBe(triggerStep)
  expect(record['status']).toBe('cancelled')
  expect(record['cancelReason']).toBe('invalidated')
  expect(record['verdict']).toBeUndefined()
  expect(record['failureReason']).toBeUndefined()
}

describe('窗口二 · 已取走：消息在触发点那次 pre-step 的 claim 之前就已入队', () => {
  it('steer 送出的消息被同一次 claim 取走时作废，结论不应用、消息照常处理，只落一条取消记录', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      storageRoot: root,
      script: [STEP, STEP, STOP_VERDICT, DONE],
    })

    // 停在「已完成 2 步、reviews() 仍为 0、正要进第 3 步」的步边界：触发点那次复核还没发起。
    await fixture.main.drive(2, '出发')
    expect(fixture.main.steps()).toBe(2)
    expect(fixture.main.reviews()).toHaveLength(0)

    // 在这条边界上同步送出真实用户消息：它进 nextStep，被第 3 步的 pre-step 与复核同批 claim。
    const interjection = userMessage('换个方向')
    fixture.main.agent.steer(interjection)

    // 放行：触发点的复核发起、收场；作废只能由应用点的 claim 检查逮住——消息入队时监听器没有
    // 可作废的对象（那一刻 reviews() 仍为 0）。
    await fixture.main.drive(1)

    expect(fixture.main.reviews()).toHaveLength(1)
    expectNoPluginIntervention(fixture)
    expectNoHookAbort(fixture)
    expectProcessed(fixture, interjection.id)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })
})

describe('窗口一 · 在途到达：复核请求已到达、结论尚未落盘', () => {
  it('steer 送出的消息让在途复核作废，结论不应用、消息由下一步取走，只落一条取消记录', async () => {
    const root = await tempRoot()
    let fixture: NavigatorLoop
    let interjectionId = ''
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      storageRoot: root,
      script: [STEP, STEP, STOP_VERDICT, DONE, DONE],
      reviewGate(release) {
        // 复核在途的唯一同步点：先同步送出消息、再放行。本构造只有一次复核，重复通知只放行。
        if (interjectionId !== '') {
          release()
          return
        }
        const interjection = userMessage('换个方向')
        interjectionId = interjection.id
        fixture.main.agent.steer(interjection)
        release()
      },
    })

    // 停在「已完成 2 步」的边界，再放行第 3 步：触发点的复核在途，闸门在这里送出消息。
    await fixture.main.drive(2, '出发')
    await fixture.main.drive(1)

    expect(fixture.main.reviews()).toHaveLength(1)
    expectNoPluginIntervention(fixture)
    expectNoHookAbort(fixture)
    expectProcessed(fixture, interjectionId)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })

  it('followup 送出的消息让在途复核作废，结论不应用、下一轮照常处理，只落一条取消记录', async () => {
    const root = await tempRoot()
    let fixture: NavigatorLoop
    let interjectionId = ''
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      storageRoot: root,
      script: [STEP, STEP, STOP_VERDICT, DONE, DONE],
      reviewGate(release) {
        if (interjectionId !== '') {
          release()
          return
        }
        const interjection = userMessage('换个方向')
        interjectionId = interjection.id
        // 直接调 agent 的 `followup`、不 await：夹具的 `send` 会 await `whenIdle()`，而复核在途时
        // turn 不会收尾，用例只会等到超时。这条消息落进「下一轮」，由新 turn 的第一次 pre-step 取走。
        fixture.main.agent.followup(interjection)
        release()
      },
    })

    await fixture.main.drive(2, '出发')
    await fixture.main.drive(1)

    expect(fixture.main.reviews()).toHaveLength(1)
    expectNoPluginIntervention(fixture)
    expectNoHookAbort(fixture)
    expectProcessed(fixture, interjectionId)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })

  it('continue 结论也照作废：在途到达那一支不看结论，落取消记录', async () => {
    const root = await tempRoot()
    let fixture: NavigatorLoop
    let interjectionId = ''
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      storageRoot: root,
      script: [STEP, STEP, CONTINUE_VERDICT, DONE, DONE],
      reviewGate(release) {
        if (interjectionId !== '') {
          release()
          return
        }
        const interjection = userMessage('换个方向')
        interjectionId = interjection.id
        fixture.main.agent.steer(interjection)
        release()
      },
    })

    await fixture.main.drive(2, '出发')
    await fixture.main.drive(1)

    // (a)(b) 对 `continue` 恒真，这条用例的读数在 (c)(d)：消息照常处理，记录仍取取消态。
    expect(fixture.main.reviews()).toHaveLength(1)
    expectNoPluginIntervention(fixture)
    expectNoHookAbort(fixture)
    expectProcessed(fixture, interjectionId)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })
})

describe('窗口三 · `next()` 期间：消息在触发点那次 claim 之后、复核发起之前到达', () => {
  it('steer 送出的消息一样作废，不被 stop 的 cancel 清掉，只落一条取消记录', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      storageRoot: root,
      script: [STEP, STEP, STOP_VERDICT, DONE, DONE],
    })
    // 测试侧脚手架：注册一条下游 pre-step handler，它在插件的 `await next()` 内部送消息。那一刻 claim
    // 已经发生（消息进不了本步批次），只有在途登记早于 `next()`，插入监听器才有对象可置位——否则这条
    // 消息会被随后的 stop 的 `cancel` 清掉。不新增夹具能力，只多一条测试侧 handler。
    let preSteps = 0
    let interjectionId = ''
    fixture.ctx.on('agent/pre-step', async (_payload, next) => {
      preSteps += 1
      const decision = await next()
      if (preSteps === 3) {
        const interjection = userMessage('换个方向')
        interjectionId = interjection.id
        fixture.main.agent.steer(interjection)
      }
      return decision
    })

    await fixture.main.drive(2, '出发')
    await fixture.main.drive(1)

    expect(fixture.main.reviews()).toHaveLength(1)
    expectNoPluginIntervention(fixture)
    expectNoHookAbort(fixture)
    expectProcessed(fixture, interjectionId)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })
})
