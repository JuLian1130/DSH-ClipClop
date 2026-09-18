/**
 * 票据 08：并行模式 —— 复核不阻塞主会话、建议稍后送达、`stop` 只是建议、过期标注。
 *
 * 观察面按票面写死：建议从 `agent.inbox.nextStep`（队列读数）与随后一次 pre-step 的请求 `messages`
 * （送达读数）两处读，停止与否读 `turnEndReasons()` 全表；快照冻结的参照物是**触发点那一步主会话
 * 请求**的 `ObservedCall.snapshotIds`（不得在闸门处现读主会话快照，也不得复用复核请求自己的快照）。
 *
 * 闸门复用 07 交付的 `reviewGate`：只停住第一次复核，之后的复核直接放行；「放行之后这次复核收场、
 * 建议已注入队列」的等待手段是公开的 `agent/inbox/inserted` 事件（`agent.inject` 与正文改写各发一次），
 * 用例不轮询、也不读时间窗。夹具本身不改。
 *
 * 作废（07）只适用等待模式：并行在途复核遇到真实用户消息不作废，处置是过期标注——第 4、5 条的构造
 * 就是这条边界句的可证伪面。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as navigator from '../src/index.ts'
import { SCRIPTED_TOOL_NAME, userMessage, type ScriptedResponse } from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import {
  isReviewRequest,
  mountNavigatorLoop,
  type NavigatorLoop,
  type ObservedCall,
} from './support/loop-fixture.ts'

/** 每个用例一套独立 context：投影与事件监听都是全局的，串用会互相干扰。 */
afterEach(disposeTrackedContexts)

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** `adjust` 结论里的建议内容。 */
const RECOMMENDATION = '先把范围缩到导航插件的注入路径'

/** 一条 `adjust` 结论。 */
const ADJUST_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'adjust', reason: '主会话仍在推进', recommendation: RECOMMENDATION }),
}

/** `stop` 结论的原因。 */
const STOP_REASON = '主会话已经偏离目标'

/** 一条 `stop` 结论。 */
const STOP_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'stop', reason: STOP_REASON, recommendation: '停下来重新对齐' }),
}

/** 一条 `continue` 结论：不产生任何消息，用于让后续复核安静收场。 */
const CONTINUE_VERDICT: ScriptedResponse = {
  text: JSON.stringify({ verdict: 'continue', reason: '看起来正常', recommendation: '无' }),
}

/**
 * 过期标注那一句（规格 `实现决策 · 三种结论各自做什么` 逐字要求写出的句子）。
 * 刻意在本文件里写死字面量：从实现里 import 常量再断言同一处常量是恒真断言。
 */
const EXPIRY_PHRASE = '它来自上一段执行、可能已不适用'

/** 一次可放行的并行夹具。 */
interface ParallelRig {
  readonly fixture: NavigatorLoop
  /** 放行停在闸门上的第一次复核；未到闸门或已放行时为 no-op。 */
  releaseFirstReview(): void
  /** 第一条本插件建议进入待处理队列时兑现。 */
  readonly firstSuggestion: Promise<Message>
}

/** 一个可外部兑现的 Promise。 */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** 一条消息是不是本插件的干预消息（`form: 'notice'`）。 */
function isNavigatorNotice(message: Message): boolean {
  return message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === navigator.name
    && message.source.form === 'notice'
}

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

/** 主会话自己的请求（复核自己那次请求不计入）。 */
function mainRequests(fixture: NavigatorLoop): readonly ObservedCall[] {
  return fixture.main.calls().filter(call => !isReviewRequest(call.request))
}

/**
 * 真正的复核请求的触发步骤，按请求顺序。
 *
 * 夹具的 `isReviewRequest` 只看「末条是本插件注入的插件消息」，而建议被同一次 claim 取走、又排在批次
 * 末尾时，主请求的末条正好是带 `form: 'notice'` 的建议——它会被误认成复核请求并计入 `main.reviews()`
 * （06 的用例注释已记这一条）。所以读「到点有没有发复核」时按**复核指令**（本插件注入、不带 `form`）
 * 判别，不借夹具那个启发式。
 * @param fixture - 夹具。
 * @returns 每条真复核请求的触发步骤。
 */
function reviewTriggerSteps(fixture: NavigatorLoop): readonly number[] {
  return fixture.main.calls().flatMap((call) => {
    const last = call.request.messages.at(-1)
    const carriesInstruction = last?.role === 'user'
      && last.source.kind === 'plugin'
      && last.source.plugin === navigator.name
      && last.source.form === undefined
    return carriesInstruction ? [call.steps] : []
  })
}

/** 待处理队列里本插件的建议，按 `nextStep` 后 `nextTurn` 的顺序。 */
function pendingSuggestions(fixture: NavigatorLoop): readonly Message[] {
  return [...fixture.agent.inbox.nextStep, ...fixture.agent.inbox.nextTurn].filter(isNavigatorNotice)
}

/**
 * 送达读数：某条消息进了某次主会话请求的 `messages` 时，返回请求里的那一份。
 *
 * 在**全部请求**里找，不借夹具的 `isReviewRequest` 启发式——建议被 claim 且排在批次末尾时，承载它的
 * 主请求会被那个启发式误认成复核请求。
 * @param fixture - 夹具。
 * @param messageId - 要找的消息 id。
 * @returns 请求 messages 里的那条消息；还没被送达时为 undefined。
 */
function deliveredMessage(fixture: NavigatorLoop, messageId: string): Message | undefined {
  return fixture.main.calls()
    .flatMap(call => call.request.messages)
    .find(message => message.id === messageId)
}

/** 一条干预消息的 `summary`；不是 notice 时为空串。 */
function summaryOf(message: Message | undefined): string {
  return message?.source.kind === 'plugin' && message.source.form === 'notice'
    ? message.source.summary
    : ''
}

/** 全表里有没有 hook 触发的 `aborted`（并行模式的 `stop` 不得产生它）。 */
function hasHookAbort(fixture: NavigatorLoop): boolean {
  return fixture.main.turnEndReasons().some(
    reason => reason.kind === 'aborted' && reason.reason.kind === 'hook',
  )
}

/**
 * 挂一套并行模式的夹具：`mode` 强制 `parallel`，闸门只停第一次复核。
 * @param config - 除 `mode` 外的配置。
 * @param script - 适配器脚本，按请求调用序位。
 * @returns 夹具、放行第一次复核的把手，以及第一次建议入队的 Promise。
 */
async function mountParallel(
  config: { readonly triggerEverySteps: number },
  script: readonly ScriptedResponse[],
): Promise<ParallelRig> {
  const suggestion = deferred<Message>()
  let releaseFirst: (() => void) | undefined
  let gated = 0
  const fixture = await mountNavigatorLoop({
    config: { ...config, mode: 'parallel' },
    script,
    reviewGate: (release) => {
      gated += 1
      // 只有第一次复核要停在闸门上；之后的复核直接放行，用例不关心它们的收场时刻。
      if (gated === 1) releaseFirst = release
      else release()
    },
  })
  fixture.ctx.on('agent/inbox/inserted', ({ message }) => {
    if (isNavigatorNotice(message)) suggestion.resolve(message)
  })
  return {
    fixture,
    releaseFirstReview: () => {
      const release = releaseFirst
      releaseFirst = undefined
      release?.()
    },
    firstSuggestion: suggestion.promise,
  }
}

describe('并行模式下复核不阻塞主会话', () => {
  it('复核在途时主会话照常推进、当前步骤照常收尾，建议稍后留在 nextStep', async () => {
    const rig = await mountParallel({ triggerEverySteps: 1 }, [STEP, ADJUST_VERDICT, STEP])

    // 复核停在闸门上不放行：主会话仍走到第 2 步的步边界（等待模式会在这里停住）。
    await rig.fixture.main.drive(2, '出发')
    expect(rig.fixture.main.steps()).toBe(2)
    expect(rig.fixture.main.reviews()).toHaveLength(1)
    expect(hasHookAbort(rig.fixture)).toBe(false)

    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion

    // 建议已入队（`agent.inject` 排的是「下一步」，主会话停在步边界上还没取走它）；没有为这次注入
    // 再发第二次复核请求。
    expect(rig.fixture.agent.inbox.nextStep.map(message => message.id)).toContain(suggestion.id)
    expect(textOf(suggestion)).toContain(RECOMMENDATION)
    // notice 形态：`summary` 非空（规格「两者都必须是带 `form: 'notice'` 的 user 消息，`summary` 非空」）。
    expect(summaryOf(suggestion).length).toBeGreaterThan(0)
    expect(rig.fixture.main.reviews()).toHaveLength(1)
  })

  it('复核请求的快照停在触发点：主会话其后已推进，内容仍是触发点快照原顺序 + 末尾一条', async () => {
    const rig = await mountParallel({ triggerEverySteps: 2 }, [STEP, STEP, ADJUST_VERDICT, STEP, STEP])

    // 触发点 2 的复核停在闸门上，主会话越过触发点走到第 4 步。
    await rig.fixture.main.drive(4, '出发')
    expect(rig.fixture.main.steps()).toBe(4)

    const review = rig.fixture.main.reviews()[0]
    // 参照物只能取触发点那一步的主会话请求快照：复核请求自己的快照与请求同源同时刻，任何实现都绿。
    const triggerCall = mainRequests(rig.fixture).find(call => call.steps === 2)
    expect(triggerCall).toBeDefined()
    const snapshotIds = triggerCall?.snapshotIds ?? []

    expect(review?.request.messages.slice(0, -1).map(message => message.id)).toEqual([...snapshotIds])
    expect(review?.request.messages).toHaveLength(snapshotIds.length + 1)
    expect(review?.request.messages.at(-1)?.role).toBe('user')

    rig.releaseFirstReview()
    await rig.firstSuggestion
  })

  it('并行 stop 只是建议：不停止当前 turn，带触发步骤的建议照常送达', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, STOP_VERDICT, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')

    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion
    // 建议正文以触发步骤开头（`summary` 就是正文开头的截断）。
    expect(textOf(suggestion).startsWith('第 1 步')).toBe(true)

    // 送达那一半：建议进入下一次 pre-step 主会话请求的 messages。在全部请求里按 id 找承载它的那条
    // （夹具的 `isReviewRequest` 启发式在这一帧会把承载请求误认成复核请求，不能借它过滤）。
    await rig.fixture.main.drive(1)
    expect(deliveredMessage(rig.fixture, suggestion.id)).toBeDefined()
    // 停止那一半：全表里没有 hook 触发的 aborted。
    expect(hasHookAbort(rig.fixture)).toBe(false)
  })

  it('与刚到的一条真实用户消息被同一次 claim 取走：建议不从批次里去掉、带标注送达', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, ADJUST_VERDICT, STEP, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')
    // 第一条真实用户消息落盘，锚点移到触发点之后：建议产生时就带标注。
    rig.fixture.main.agent.steer(userMessage('第一条'))
    await rig.fixture.main.drive(1)
    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion
    expect(textOf(suggestion)).toContain(EXPIRY_PHRASE)

    // 刚到的第二条与已排队的建议被同一次 claim 取走。
    const arriving = userMessage('第二条')
    rig.fixture.main.agent.steer(arriving)
    await rig.fixture.main.drive(1)

    const carrying = rig.fixture.main.calls().find(
      call => call.request.messages.some(message => message.id === arriving.id),
    )
    expect(carrying).toBeDefined()
    const delivered = carrying?.request.messages.find(message => message.id === suggestion.id)
    expect(delivered).toBeDefined()
    expect(textOf(delivered)).toContain(EXPIRY_PHRASE)
  })
})

describe('并行建议的过期标注', () => {
  it('真实用户消息落在建议产生之前：产生时就带标注，送达的正文也含它', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, ADJUST_VERDICT, STEP, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')
    // 先 steer、驱动到这条消息落盘（锚点移动），再放行复核。
    rig.fixture.main.agent.steer(userMessage('换个方向'))
    await rig.fixture.main.drive(1)

    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion

    // 本票第 5 条的读数落在送达面上：下一次 pre-step 的请求 messages 里那条正文含标注。
    await rig.fixture.main.drive(1)
    const delivered = deliveredMessage(rig.fixture, suggestion.id)
    expect(delivered).toBeDefined()
    expect(textOf(delivered)).toContain(EXPIRY_PHRASE)
  })

  it('真实用户消息落在建议产生之后：待投递期间改写正文，送达时也带标注', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, ADJUST_VERDICT, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')
    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion
    // 产生时锚点没动。
    expect(textOf(suggestion)).not.toContain(EXPIRY_PHRASE)

    // 建议已入队、尚未被 claim 时真实用户消息到达：同一次同步调用里改写正文。
    rig.fixture.main.agent.steer(userMessage('换个方向'))
    // 改写是「同一条建议换正文」：id 不变，送达面才认得出「该条建议」。
    const rewritten = pendingSuggestions(rig.fixture).find(message => message.id === suggestion.id)
    expect(rewritten).toBeDefined()
    expect(textOf(rewritten)).toContain(EXPIRY_PHRASE)

    // 落点 (b) 的读数落在请求体上，不是队列上：送达的那条正文也带标注。
    await rig.fixture.main.drive(1)
    const delivered = deliveredMessage(rig.fixture, suggestion.id)
    expect(delivered).toBeDefined()
    expect(textOf(delivered)).toContain(EXPIRY_PHRASE)
  })

  it('期间没有真实用户消息：送达的正文不带标注（否定控制）', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, ADJUST_VERDICT, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')
    rig.releaseFirstReview()
    const suggestion = await rig.firstSuggestion

    await rig.fixture.main.drive(1)
    const delivered = deliveredMessage(rig.fixture, suggestion.id)
    expect(delivered).toBeDefined()
    expect(textOf(delivered)).not.toContain(EXPIRY_PHRASE)
  })
})

describe('到点但已有复核在跑', () => {
  it('跨过的触发点不补打，放行后下一个触发点恰好一次', async () => {
    const rig = await mountParallel(
      { triggerEverySteps: 1 },
      [STEP, ADJUST_VERDICT, STEP, STEP, CONTINUE_VERDICT, STEP],
    )
    await rig.fixture.main.drive(2, '出发')
    expect(reviewTriggerSteps(rig.fixture)).toEqual([1])

    // 跨过触发点 2：复核仍在途，跳过这一次。
    await rig.fixture.main.drive(1)
    expect(reviewTriggerSteps(rig.fixture)).toEqual([1])

    // 放行、这次复核收场；再下一个触发点（3）恰好一次，既不提前补打也不顺延。
    rig.releaseFirstReview()
    await rig.firstSuggestion
    await rig.fixture.main.drive(1)
    expect(reviewTriggerSteps(rig.fixture)).toEqual([1, 3])
  })
})
