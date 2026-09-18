/**
 * 票据 10：在途复核取消 —— 任务结束与任务取消。
 *
 * 观察面按票面写死：在途那一段一律用 07 交付的复核闸门把复核请求钉住，凡要等「这次复核写下了它那唯一
 * 一条记录」的读数一律用 09 交付的收场回执 `settled(triggerStep)`，不轮询、不读时间窗；记录按会话 id
 * 读回、按该次 `triggerStep` 定位，取消态的两个结论字段按**原始存储文档**复验（第 6 条）。
 *
 * 六条验收项落成五条用例（第 6 条不另立构造，由 `expectCancelledRecord` 在任务结束与任务取消两条真实
 * 路径上各复验一次，见 `describe` 标题与各条注释）：
 *  ① `并行 · 任务结束`：复核停在闸门上不放行，主会话走到 turn 正常收尾、会话转入空闲，等取消记录兑现
 *     后再放行，断放行后这次 `adjust` 成功收场也不生效（记录仍只有取消那条；两处待处理队列与随后那次
 *     请求的 `messages` 三处都没有建议）。
 *  ② `任务取消`：等待模式由 `agent.cancel` 中止在途复核（复核槽取**普通回复**，不放 `hang`——中止后
 *     适配器照脚本成功收场，只认 `settlement === null` 的实现会把这一格落成完成态）；并行模式把复核
 *     停在闸门上不放行（并行复核不融合本步信号，取消放行不了它），确保 `whenIdle()` 先兑现，且取消落在
 *     触发步那一次驱动内（跨 turn 的信号面见设计文档 `注入与停止机制`）。两格原因都取 `task-cancelled`。
 *  ③ `已入队建议的两种去向`：只对并行模式成立，两半都取「主会话停在步边界 + 建议已入队、尚未被取走」
 *     那一帧——正常那半仍在队列里、随后照常送达；取消那半经 `agent.cancel` 后队列里不再有它。首句
 *     「取消在途复核不会连带丢掉已入队的建议」是交付约束，不另立构造。
 *  ④ `既失败又取消取取消`：与第 ①②条并行那两次同帧，脚本槽改取失败，终态落下取消记录之后再放行 →
 *     按原始存储文档读，断仍只有那条状态为「取消」的记录。
 *  ⑤ `07 窗口一（在途到达）＋ 复核失败`：复核停在闸门上时经 `agent.steer` 送真实用户消息（作废由唯一的
 *     `agent/inbox/inserted` 监听器置位），再放行让它以失败收场，构造取缺省 `failurePolicy: continue`。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
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
import { mountNavigatorLoop, type NavigatorLoop } from './support/loop-fixture.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-cancel-'))
  roots.push(root)
  return root
}

/** 间隔 2：插件早于第 1 步就已挂载，第一次复核的触发点值是 2。 */
const EVERY_STEPS = 2

/**
 * 被读的那次复核的触发点值：触发点值是触发点那一刻的**已完成步数**，不指步号——复核在第 3 步的 pre-step
 * 发出，所以驱动要走满 3 步才轮到它，脚本里复核回复占第 3 槽。
 */
const TRIGGER_STEP = 2
const STEPS_TO_TRIGGER = 3

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** 让会话正常收尾的一步。 */
const DONE: ScriptedResponse = { text: '收到' }

/** 一条 `adjust` 结论：第 ①⑤ 条用它验证「终态取消后结论不生效」。 */
const ADJUST_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'adjust', reason: '主会话仍在推进', recommendation: '先把范围缩到注入路径' }),
}

/** 正常收场、但过不了严格解析的文本：第 ④ 条要的失败收场。 */
const UNPARSEABLE: ScriptedResponse = { text: '这段不是 JSON' }

/** 一条消息是不是本插件的干预消息（`form: 'notice'`）；复核指令不带 `form`，不算。 */
function isNavigatorNotice(message: Message): boolean {
  return message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === navigator.name
    && message.source.form === 'notice'
}

/** 待处理队列里本插件的建议，按 `nextStep` 后 `nextTurn` 的顺序。 */
function pendingSuggestions(fixture: NavigatorLoop): readonly Message[] {
  return [...fixture.agent.inbox.nextStep, ...fixture.agent.inbox.nextTurn].filter(isNavigatorNotice)
}

/** 等第一条本插件建议进入待处理队列（`agent/inject` 的落点）。 */
function waitForFirstSuggestion(fixture: NavigatorLoop): Promise<Message> {
  return new Promise((resolve) => {
    fixture.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (isNavigatorNotice(message)) resolve(message)
    })
  })
}

/**
 * 读某次复核的原始存储文档里的 `record`（不经读回入口、不复制 schema）。
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
 * 恰一条取消记录：按会话 id 读回该次 `triggerStep` 上恰一条 `status === 'cancelled'`、原因取闭集取值；
 * 并按**原始存储文档**复验取消态（第 6 条）——`verdict` 与 `failureReason` 两个键必须缺省。任务结束与
 * 任务取消两条真实路径都经它复验一次。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 该次复核的触发步骤。
 * @param cancelReason - 期望的取消原因。
 */
async function expectCancelledRecord(
  root: string,
  sessionId: SessionId,
  triggerStep: number,
  cancelReason: string,
): Promise<void> {
  const records = readReviewRecords(sessionId)
  expect(records.map(record => [record.triggerStep, record.status, record.cancelReason]))
    .toEqual([[triggerStep, 'cancelled', cancelReason]])

  const record = await rawRecord(root, sessionId, triggerStep)
  expect(record['triggerStep']).toBe(triggerStep)
  expect(record['status']).toBe('cancelled')
  expect(record['cancelReason']).toBe(cancelReason)
  expect(record['verdict']).toBeUndefined()
  expect(record['failureReason']).toBeUndefined()
}

describe('① 并行 · 任务结束：复核未返回时会话转入空闲', () => {
  it('取消记录取 task-ended；放行后这次 adjust 成功收场也不生效、不再写第二条记录', async () => {
    const root = await tempRoot()
    let release: (() => void) | undefined
    let gated = 0
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      // 第 3 槽是复核回复（放行后取 adjust）；第 4 槽让 turn 正常收尾、会话转入空闲。
      script: [STEP, STEP, ADJUST_VERDICT, DONE, STEP],
      storageRoot: root,
      // 把复核请求停在闸门上不放行：「whenIdle() 与复核收场先后不可依赖」，不钉住它「还没返回」就不受控。
      reviewGate: (r) => {
        gated += 1
        if (gated === 1) release = r
        else r()
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    expect(fixture.main.steps()).toBe(STEPS_TO_TRIGGER)
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-ended')

    // 放行：这次复核以 adjust 成功收场；终态取消已经落下，结论不生效、也不会再写第二条记录。
    release?.()
    // 会话此刻已空闲：由用例带一条新用户消息驱动一步到下一个步边界。
    await fixture.main.drive(1, '继续')
    // 只读「记录是取消」挡不住「记录取消、建议照注入」，所以两处待处理队列与随后那次请求的 messages
    // 三处都断。
    expect(pendingSuggestions(fixture)).toEqual([])
    expect(fixture.main.calls().flatMap(call => call.request.messages).filter(isNavigatorNotice)).toEqual([])
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-ended')
  })
})

describe('② 任务取消：等待模式与并行模式各一次，取消原因取 task-cancelled', () => {
  it('等待模式由 agent.cancel 中止在途复核（复核槽取普通回复，放行后照脚本成功收场）', async () => {
    const root = await tempRoot()
    let fixture!: NavigatorLoop
    let cancelled = false
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      // 复核槽刻意取普通回复而不是 `hang`：用 hang 会让中止以 `finish.kind === 'aborted'` 收场，
      // 只认 `settlement === null` 的实现照旧全绿。
      script: [STEP, STEP, ADJUST_VERDICT, STEP, DONE],
      storageRoot: root,
      reviewGate: (release) => {
        if (cancelled) {
          release()
          return
        }
        cancelled = true
        fixture.main.agent.cancel({ kind: 'user' })
        release()
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')
  })

  it('并行模式把复核停在闸门上不放行，取消落在触发步那一次驱动内，whenIdle() 先兑现', async () => {
    const root = await tempRoot()
    let fixture!: NavigatorLoop
    let releaseReview: (() => void) | undefined
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      script: [STEP, STEP, UNPARSEABLE, STEP, DONE],
      storageRoot: root,
      // 并行复核不融合本步信号，取消放行不了它——请求留在闸门上，`whenIdle()` 因此先兑现。
      reviewGate: (release) => {
        if (releaseReview !== undefined) {
          release()
          return
        }
        releaseReview = release
        fixture.main.agent.cancel({ kind: 'user' })
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')

    releaseReview?.()
  })

  it('并行的取消与放行挤在同一次同步回调里：取消照常落下，放行后的结算不注入、也不覆盖记录', async () => {
    const root = await tempRoot()
    let fixture!: NavigatorLoop
    let released = false
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      script: [STEP, STEP, ADJUST_VERDICT, STEP, DONE],
      storageRoot: root,
      // 取消与放行在同一次同步调用里做完：复核收场与 `whenIdle()` 谁先兑现不做约定（G10），
      // 断的是两者的共同结论——这次在途复核被取消、放行后的 `adjust` 不生效。
      reviewGate: (release) => {
        if (released) {
          release()
          return
        }
        released = true
        fixture.main.agent.cancel({ kind: 'user' })
        release()
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')

    await fixture.main.drive(1, '继续')
    expect(pendingSuggestions(fixture)).toEqual([])
    expect(fixture.main.calls().flatMap(call => call.request.messages).filter(isNavigatorNotice)).toEqual([])
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')
  })
})

describe('③ 已入队建议的两种去向（只对并行模式成立）', () => {
  /** 复核在第 2 步的 pre-step 触发，主会话随后停在步边界 2（turn 未结束）。 */
  const script: readonly ScriptedResponse[] = [STEP, ADJUST_VERDICT, STEP, STEP, DONE]

  it('任务正常结束：建议仍在队列里，并在下一个步边界照常送达', async () => {
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1, mode: 'parallel' },
      script,
      reviewGate: (r) => {
        if (release === undefined) release = r
        else r()
      },
    })
    const suggestion = waitForFirstSuggestion(fixture)
    await fixture.main.drive(2, '出发')
    release?.()
    const injected = await suggestion

    // 帧：主会话停在步边界（turn 未结束）＋ 建议已入队、尚未被取走。
    expect(pendingSuggestions(fixture).map(message => message.id)).toContain(injected.id)
    // 随后驱动一步：仍在运行的 turn 会在下一个步边界取走它。
    await fixture.main.drive(1)
    expect(
      fixture.main.calls().flatMap(call => call.request.messages).some(message => message.id === injected.id),
    ).toBe(true)
  })

  it('任务取消：同一帧经 agent.cancel 取消后，队列里不再有它', async () => {
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1, mode: 'parallel' },
      script,
      reviewGate: (r) => {
        if (release === undefined) release = r
        else r()
      },
    })
    const suggestion = waitForFirstSuggestion(fixture)
    await fixture.main.drive(2, '出发')
    release?.()
    const injected = await suggestion
    expect(pendingSuggestions(fixture).map(message => message.id)).toContain(injected.id)

    // 同一帧的任务取消：`cancel` 默认清空待处理队列，这条建议随之丢失（规格明确接受的例外）。
    fixture.main.agent.cancel({ kind: 'user' })
    expect(pendingSuggestions(fixture)).toEqual([])
    expect([...fixture.agent.inbox.nextStep, ...fixture.agent.inbox.nextTurn]).toEqual([])
  })
})

describe('④ 既失败又取消取取消（终态两格各一次，都取并行构造）', () => {
  it('任务结束 ＋ 复核失败：先落取消、后到的失败结算不覆盖，仍只有那条取消记录', async () => {
    const root = await tempRoot()
    let release: (() => void) | undefined
    let gated = 0
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      // 与第 ① 条同帧，只把脚本里的复核槽改取失败。
      script: [STEP, STEP, UNPARSEABLE, DONE, STEP],
      storageRoot: root,
      reviewGate: (r) => {
        gated += 1
        if (gated === 1) release = r
        else r()
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-ended')

    // 放行请求，让它以失败收场：后到的失败结算不覆盖取消记录、也不再写第二条。
    release?.()
    await fixture.main.drive(1, '继续')
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-ended')
  })

  it('任务取消 ＋ 复核失败：同一帧先落取消记录，再放行失败收场，仍只有那条取消记录', async () => {
    const root = await tempRoot()
    let fixture!: NavigatorLoop
    let releaseReview: (() => void) | undefined
    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      script: [STEP, STEP, UNPARSEABLE, STEP, DONE],
      storageRoot: root,
      reviewGate: (release) => {
        if (releaseReview !== undefined) {
          release()
          return
        }
        releaseReview = release
        fixture.main.agent.cancel({ kind: 'user' })
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')

    releaseReview?.()
    await fixture.main.drive(1, '继续')
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'task-cancelled')
  })
})

describe('⑤ 07 窗口一（在途到达）＋ 复核失败', () => {
  it('缺省 failurePolicy: continue → 恰一条取消、原因取 invalidated、两键缺省', async () => {
    const root = await tempRoot()
    let fixture!: NavigatorLoop
    const arriving = userMessage('换个方向')
    let sent = false
    fixture = await mountNavigatorLoop({
      // 缺省 `failurePolicy: continue`：没有干预动作时失败路径才只剩 `review.invalidated` 这一半。
      config: { triggerEverySteps: EVERY_STEPS },
      script: [STEP, STEP, UNPARSEABLE, DONE, DONE],
      storageRoot: root,
      reviewGate: (release) => {
        if (!sent) {
          sent = true
          // 在途到达的真实用户消息：唯一的 `agent/inbox/inserted` 监听器把这次复核置为作废。
          fixture.main.agent.steer(arriving)
        }
        release()
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, 'invalidated')
  })
})
