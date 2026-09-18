/**
 * 票据 11：重载 / 卸载时的取消 —— 插件释放时在途复核被取消、等待步按 `failurePolicy` 放行或停止；
 * 已经开始的停止流程不被打断。
 *
 * 观察面按票面写死：在途那一段一律用 07 的复核闸门把复核请求钉住；凡要等「这次复核那唯一一条记录已
 * 落盘」的读数一律用 09 的收场回执 `settled(triggerStep)`，不轮询、不读时间窗；记录按会话 id 读回、
 * 按该次 `triggerStep` 定位，取消态的两个结论字段按**原始存储文档**复验（第 3 条，由
 * `expectCancelledRecord` 在等待与并行两条真实释放路径上各复验一次）。释放动作按票面备注「释放路径的
 * 前置核实」钉死：把释放取**重载**（夹具的 `remountPlugin`），不取裸卸载——裸卸载后读回入口会抛。
 *
 * 六条用例覆盖第 1、2 条（第 3 条不另立构造）：
 *  ① `等待 × continue`：第 3 步的复核停在闸门上，释放（重载）落下取消记录后放行；这次 `adjust` 成功
 *     收场也不注入（对话、两处待处理队列与随后那次请求都没有它）、不再写第二条记录，该步原样放行。
 *  ② `等待 × stop`：同一帧，`failurePolicy: stop` 时释放让等待步追加写取消原因的停止说明并停止本 turn
 *     （正文不写「复核失败」）。
 *  ②b 同一帧 ＋ 未处理的消息里有真实用户消息：停止前那道检查照跑——不追加说明、不停止，这条消息不丢
 *     （规格「等待模式下注入建议、追加停止说明或停止 turn 之前——包括失败策略触发的停止」）。
 *  ③ `并行`：复核停在闸门上、turn 停在步边界（未空闲）时释放，记录取 `plugin-disposed`；放行后按同一
 *     读法把记录再读最终一次（并行这一帧上「结论不生效」没有独立读数——释放一开始旧实例的 `ctx` 就已
 *     失活，续体取不到注入所需的锚点、writer 也随域关闭，所以那一读数按票面在 ① 上构造）。
 *  ④ `第 2 条`：停止说明已落盘、`turn/end` 未到时释放（释放由用例自挂的 `session/event` 监听器在说明
 *     落盘那一刻发起），`turn/end` 仍以 hook 原因到达，说明仍在会话里、并出现在随后那次请求的 `messages`。
 *  ⑤ 释放落在等待步 `await next()` 期间：登记已立、快照还没取，仍落一条 `messageIds` 缺省的取消记录
 *     （记录表「取到快照之前就结束则没有」），该步原样放行。
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
  type ReviewCancelReason,
} from '../src/index.ts'
import { SCRIPTED_TOOL_NAME, userMessage, type ScriptedResponse } from './support/scripted-adapter.ts'
import { ACTIVE } from './support/fiber-state.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import { mountNavigatorLoop, type NavigatorLoop, type ObservedCall } from './support/loop-fixture.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-release-'))
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

/** 一条 `adjust` 结论：放行后这次复核以它成功收场，用来断「结论不生效」。 */
const ADJUST_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'adjust', reason: '主会话仍在推进', recommendation: '先把范围缩到注入路径' }),
}

/** `stop` 结论里的原因：第 2 条那一帧要一条与释放无关的停止流程用它产生说明。 */
const STOP_REASON = '主会话已经偏离目标'

/** 一条 `stop` 结论。 */
const STOP_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'stop', reason: STOP_REASON, recommendation: '停下来重新对齐' }),
}

/** 本票这一格的取消原因取值，取自 04 导出的闭集。 */
const PLUGIN_DISPOSED: ReviewCancelReason = 'plugin-disposed'

/** 等待模式 `failurePolicy: stop` 的说明写的是「复核失败」；本票这一格必须写取消原因。 */
const REVIEW_FAILED = '复核失败'

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

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

/**
 * 停止说明：先从落盘的 `user/message` 事件取 id，再按 id 从 `deriveMessages()` 取回真实追加路径上的那条
 * 消息（不退化成消息构造函数）。
 * @param fixture - 夹具。
 * @returns 那条停止说明；还没落盘时为 undefined。
 */
function stopNotice(fixture: NavigatorLoop): Message | undefined {
  const event = fixture.events().find(
    candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'plugin'
      && candidate.data.source.plugin === navigator.name,
  )
  const id = event?.type === 'user/message' ? event.data.id : undefined
  return fixture.agent.session.deriveMessages().find(message => message.id === id)
}

/** 全表里有没有 hook 触发的 `aborted`（`{ kind: 'aborted', reason: { kind: 'hook' } }`）。 */
function hasHookAbort(fixture: NavigatorLoop): boolean {
  return fixture.main.turnEndReasons().some(
    reason => reason.kind === 'aborted' && reason.reason.kind === 'hook',
  )
}

/** 一条请求是不是本插件的复核请求：末条是本插件注入、不带 `form` 的复核指令。 */
function carriesReviewInstruction(call: ObservedCall): boolean {
  const last = call.request.messages.at(-1)
  return last?.role === 'user'
    && last.source.kind === 'plugin'
    && last.source.plugin === navigator.name
    && last.source.form === undefined
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
 * 并按**原始存储文档**复验取消态（第 3 条）——`verdict` 与 `failureReason` 两个键必须缺省。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 该次复核的触发步骤。
 * @param cancelReason - 期望的取消原因。
 */
async function expectCancelledRecord(
  root: string,
  sessionId: SessionId,
  triggerStep: number,
  cancelReason: ReviewCancelReason,
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

describe('① 等待 × continue：释放取消在途复核，等待步原样放行', () => {
  it('只写一条取消记录（原因取 plugin-disposed），晚到的 adjust 不生效、不再写第二条', async () => {
    const root = await tempRoot()
    let gateReached!: () => void
    const reached = new Promise<void>((resolve) => { gateReached = resolve })
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      // 第 3 槽是复核回复（放行后取 adjust）；第 4 槽让这一步正常收尾。
      script: [STEP, STEP, ADJUST_VERDICT, DONE, STEP],
      storageRoot: root,
      // 在途那一段的唯一同步点：复核请求到达闸门时把控制权交回用例，释放因此落在「复核已在途」。
      reviewGate: (r) => {
        if (release === undefined) {
          release = r
          gateReached()
        } else {
          r()
        }
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    const driving = fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await reached

    // 释放取重载：释放回调在域关闭之前按登记里的记录基底落这条取消记录。
    await fixture.remountPlugin()
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)

    // 放行：这次复核以 adjust 成功收场，但释放已经落下取消记录——结论不生效、不再写第二条。
    release?.()
    await driving
    // 「等待的这一步按 failurePolicy 放行」：该步正常收尾，没有停止，对话里不留内容。
    expect(fixture.main.steps()).toBe(STEPS_TO_TRIGGER)
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
    expect(fixture.agent.session.deriveMessages().filter(isNavigatorNotice)).toEqual([])
    // 只读「记录是取消」挡不住「记录取消、建议照注入」，所以两处待处理队列与随后那次请求的 messages
    // 三处都断；记录按同一读法再读最终一次（晚到的同键写入由它兜住）。
    expect(pendingSuggestions(fixture)).toEqual([])
    expect(fixture.main.calls().flatMap(call => call.request.messages).filter(isNavigatorNotice)).toEqual([])
    expect(fixture.main.calls().filter(carriesReviewInstruction)).toHaveLength(1)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)
  })
})

describe('② 等待 × failurePolicy: stop：释放让等待步追加说明后停止', () => {
  it('说明正文以触发步骤开头、写取消原因而不是复核失败，当前 turn 停止', async () => {
    const root = await tempRoot()
    let gateReached!: () => void
    const reached = new Promise<void>((resolve) => { gateReached = resolve })
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, failurePolicy: 'stop' },
      script: [STEP, STEP, ADJUST_VERDICT, DONE, STEP],
      storageRoot: root,
      reviewGate: (r) => {
        if (release === undefined) {
          release = r
          gateReached()
        } else {
          r()
        }
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    const driving = fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await reached

    await fixture.remountPlugin()
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)

    release?.()
    await driving

    // 说明正文写取消原因而不是「复核失败」，仍含触发步骤。
    const notice = stopNotice(fixture)
    expect(notice).toBeDefined()
    expect(textOf(notice).startsWith(`第 ${TRIGGER_STEP} 步`)).toBe(true)
    expect(textOf(notice)).toContain(PLUGIN_DISPOSED)
    expect(textOf(notice)).not.toContain(REVIEW_FAILED)

    // 当前 turn 停止：hook 原因取同一个取消原因取值；停止发生在该步的模型请求之前。
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: PLUGIN_DISPOSED },
    })
    expect(fixture.main.steps()).toBe(TRIGGER_STEP)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)
  })
})

describe('②b 释放 × failurePolicy: stop：未处理的消息里有真实用户消息', () => {
  it('作废优先：不追加停止说明、不停止，这条消息随后照常被取走', async () => {
    const root = await tempRoot()
    let gateReached!: () => void
    const reached = new Promise<void>((resolve) => { gateReached = resolve })
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, failurePolicy: 'stop' },
      // 第 3 槽是复核回复；第 4、5 槽撑住后续两步，让被取走的那条消息有机会出现在请求里。
      script: [STEP, STEP, ADJUST_VERDICT, STEP, STEP, DONE],
      storageRoot: root,
      reviewGate: (r) => {
        if (release === undefined) {
          release = r
          gateReached()
        } else {
          r()
        }
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    const driving = fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await reached

    await fixture.remountPlugin()
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)

    // 复核收场之前送一条真实用户消息：它落在待处理队列里。释放之后旧实例的插入事件监听器已随 fiber
    // 卸下，作废标记置不上位，所以这一格只能由「未处理的消息」那一半认领——停止前那道检查必须照跑。
    const arriving = userMessage('换个方向')
    fixture.main.agent.steer(arriving)
    release?.()
    await driving

    // 命中就作废：不追加说明、不停止（释放回调落下的那条取消记录已是这一格的记录，不另写第二条）。
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.agent.session.deriveMessages().filter(isNavigatorNotice)).toEqual([])
    // 这条消息没有被丢掉：随后那次 pre-step 把它取走，进入那次请求的 messages。
    await fixture.main.drive(1)
    expect(
      fixture.main.calls().flatMap(call => call.request.messages).some(message => message.id === arriving.id),
    ).toBe(true)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)
  })
})

describe('③ 并行：释放取消在途复核', () => {
  it('turn 停在步边界（未空闲）时释放，记录取 plugin-disposed，放行后仍是那条取消记录', async () => {
    const root = await tempRoot()
    let gateReached!: () => void
    const reached = new Promise<void>((resolve) => { gateReached = resolve })
    let release: (() => void) | undefined
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      // 复核槽取 adjust；第 4 槽让第 3 步撑住 turn（停在步边界），第 5 槽留给放行后的下一步。
      script: [STEP, STEP, ADJUST_VERDICT, STEP, STEP, DONE],
      storageRoot: root,
      reviewGate: (r) => {
        if (release === undefined) {
          release = r
          gateReached()
        } else {
          r()
        }
      },
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    // 并行复核脱离本步：驱动停在第 3 步的步边界，turn 未结束、会话不空闲，释放因此落在复核在途期间。
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await reached
    expect(fixture.main.steps()).toBe(STEPS_TO_TRIGGER)

    await fixture.remountPlugin()
    await settled
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)

    // 放行：这次复核以 adjust 成功收场。释放一开始，旧实例的 `ctx` 就已失活（投影读抛
    // 「inactive context」），续体取不到注入所需的锚点、writer 也随域关闭，所以「结论不生效」的读数
    // 按票面在等待模式那条（①）上构造；本条只按同一读法把记录再读最终一次。
    release?.()
    await fixture.main.drive(1)
    await expectCancelledRecord(root, fixture.main.session.id, TRIGGER_STEP, PLUGIN_DISPOSED)
  })
})

describe('④ 停止流程已经开始（说明已落盘）时释放', () => {
  it('turn/end 仍以 hook 原因到达，说明仍在会话里、并出现在随后那次请求的 messages 里', async () => {
    let fixture!: NavigatorLoop
    /** 说明落盘那一刻发起的释放；由用例的 `session/event` 监听器钉在「说明已落盘、turn/end 未到」。 */
    let release: Promise<void> | undefined
    /** 那一刻 turn/end 是不是还没到——这一帧的构造保护，帧不成立时用例必红。 */
    let turnEndSeenAtRelease: boolean | undefined
    /** 那条说明的 id 与正文，从落盘事件上取下。 */
    let noticeId: string | undefined
    let noticeText: string | undefined

    fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      // 第 3 槽是复核回复（取 stop 结论）；说明由这条与释放无关的停止流程产生。
      script: [STEP, STEP, STOP_VERDICT, DONE, DONE],
    })
    const sessionId = fixture.main.session.id
    fixture.ctx.on('session/event', (subject, event) => {
      if (release !== undefined || subject.id !== sessionId) return
      if (event.type !== 'user/message') return
      const message = event.data
      if (message.source.kind !== 'plugin' || message.source.plugin !== navigator.name) return
      turnEndSeenAtRelease = fixture.events().some(candidate => candidate.type === 'turn/end')
      noticeId = message.id
      noticeText = textOf(message)
      release = fixture.remountPlugin()
    })

    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')

    // 帧：说明已落盘、turn/end 尚未到达——这一帧上没有在途复核可中止。
    expect(turnEndSeenAtRelease).toBe(false)
    await release

    // (a) 那次停止照常兑现，末条仍是 hook 原因。
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: STOP_REASON },
    })
    expect(fixture.main.turnEndReasons().some(reason => reason.kind === 'error')).toBe(false)
    expect(fixture.pluginFiber()?.state).toBe(ACTIVE)

    // (b) 说明仍在会话里：重载后按 id 与正文在 deriveMessages() 里取得到。
    const reread = fixture.agent.session.deriveMessages().find(message => message.id === noticeId)
    expect(reread).toBeDefined()
    expect(textOf(reread)).toBe(noticeText)

    // (c) 停后再送一条消息，该次请求的 messages 里仍含这条说明。
    await fixture.send('继续')
    expect(fixture.main.calls().at(-1)?.request.messages.some(message => message.id === noticeId)).toBe(true)
  })
})

describe('⑤ 释放落在等待步 `await next()` 期间（基底只差快照）', () => {
  it('仍落一条 messageIds 缺省的取消记录，该步原样放行', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      script: [STEP, STEP, ADJUST_VERDICT, DONE, STEP],
      storageRoot: root,
    })
    // 注册在插件之后的 pre-step 监听器跑在插件 handler 的 `next()` 里；把触发步（已完成 2 步）那一次挂住，
    // 释放因此钉在「登记已立、快照还没取」的那一小段上。
    let armed = false
    let held: (() => void) | undefined
    let reached!: () => void
    const atNext = new Promise<void>((resolve) => { reached = resolve })
    fixture.ctx.on('agent/pre-step', async (payload, next) => {
      const steps = fixture.ctx.sessionProjections.stateOf(payload.agent.session, 'navigatorSteps')?.steps
      if (armed && steps === TRIGGER_STEP) {
        armed = false
        reached()
        await new Promise<void>((resolve) => { held = resolve })
      }
      return next()
    })

    armed = true
    const driving = fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await atNext
    await fixture.remountPlugin()
    held?.()
    await driving

    // 记录表允许消息 id 列表缺省（「取到快照之前就结束则没有」），所以这一格仍恰一条取消记录。
    const records = readReviewRecords(fixture.main.session.id)
    expect(records.map(record => [record.triggerStep, record.status, record.cancelReason]))
      .toEqual([[TRIGGER_STEP, 'cancelled', PLUGIN_DISPOSED]])
    expect(records[0]?.messageIds).toBeUndefined()
    const raw = await rawRecord(root, fixture.main.session.id, TRIGGER_STEP)
    expect(raw['messageIds']).toBeUndefined()
    expect(raw['verdict']).toBeUndefined()
    expect(raw['failureReason']).toBeUndefined()

    // 等待步按失败表那一格放行：复核请求根本没发出去，该步照常收尾，没有永久等待。
    expect(fixture.main.reviews()).toHaveLength(0)
    expect(fixture.main.steps()).toBe(STEPS_TO_TRIGGER)
    expect(hasHookAbort(fixture)).toBe(false)
  })
})
