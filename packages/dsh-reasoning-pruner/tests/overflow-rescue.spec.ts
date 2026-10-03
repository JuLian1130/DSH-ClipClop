/**
 * 票 05：激活点 ① —— 溢出救援与搭车重试。
 *
 * 票据判据逐条落在这里（编号照票面 `- [ ]`）。三条口径先写死，否则用例会自己骗自己：
 *
 * - **失败必须是真实的**：`failWhen` 让适配器真的抛 `LlmError`，运行期把它归一化成
 *   `agent/request-error` 的 `payload.failure`；伪造一条事件绕不过 `assistant/attempt` 与终局 `throw`。
 * - **取样窗口**：本插件以 `{prepend: true}`（`unshift`）恒在 hooks 队首；夹具的 `onRequestError` 观察面
 *   以普通 `push` 注册在 compaction-basic 之前、本插件之后装载，所以链条是
 *   `[本插件, 观察面, compaction-basic]`。观察面在委托之前先取 `atListener` 读数 = 「裁剪已落盘、
 *   compaction-basic 还没跑」；晚于 compaction-basic 注册的快照会落到它之后，把它的 `replace` 进展算到
 *   我们头上。委托之后它拿到的 `action` 是**整条链**的最终动作——不是本插件自己的返回值（本插件是链上
 *   最外层，`return next()` 时两者恒等），所以「本插件有没有自己改成 retry」只能由第 8 条钉住。
 * - **收益对照的两臂**：挂裁剪 vs 不裁（同一构造里把保留窗口放到极大，于是本批为空、零写入）。规模一律从
 *   请求的消息文本量读（适配器的 `usage` 是常量，读它没有区分度），而「裁剪省了什么」落在**摘要调用自身的
 *   输入**上——见第 5 条注释里记下的因果链。
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { pruneAtRequestError } from '../src/persist.ts'
import { CARRIER_EVENT_TYPE } from '../src/types.ts'
import type { LifecycleOptions, PersistentLifecycle, ScriptedStep, SurfaceReading } from './support/session-harness.ts'
import {
  cleanupRoots,
  lifecycle,
  persistedPrunes,
  reasoningTexts,
  recordedAssistants,
  surfaceReading,
} from './support/session-harness.ts'

afterEach(cleanupRoots)

/** 保留窗口（`K`）：本票只关心「窗口外的那几步被裁掉」，取小值是为了让第一批非空。 */
const K = 2
/** 节流 `M` 取大值：① 与 ② 的触发无关，本票的每一步构造都不该靠 ② 触发。 */
const M = 50

/** 第 `index` 步的推理文本；逐项断言靠它认出「哪一步被裁」。 */
function reasoningOf(index: number): string {
  return `thinking ${index}`
}

/** 第一个 turn 的步数：4 步，于是历史里有 4 条候选，窗口 `K = 2` 之外还剩 2 条。 */
const FIRST_TURN_STEPS = 4
/** 第二个 turn 的驱动文本；`failWhen` 就按它认出「turn 2 的第一条请求」。 */
const SECOND_TURN_TEXT = 'second turn'

/** 每次构造一个唯一会话身份（同一落盘根里 `id` 只能用一次）。 */
let sessionCounter = 0

/** 让某次请求以这个失败收场。 */
const OVERFLOW = { message: 'context window exceeded', code: CONTEXT_WINDOW_EXCEEDED_CODE }

/**
 * 一步一步的脚本：turn 1 前 3 步发起工具调用、第 4 步纯文本收尾（于是 turn 1 恰好 4 步、4 条历史），
 * 之后每次调用都纯文本收尾。
 *
 * 段数取得比用例驱动的最长 turn 多，所以每一步的推理文本都不同，逐项断言才能靠文本认出是哪一步。
 */
const SCRIPT: ScriptedStep[] = Array.from({ length: 12 }, (_unused, index) => ({
  reasoning: reasoningOf(index),
  text: `text ${index}`,
  calls: index < FIRST_TURN_STEPS - 1 ? [{ name: 'noop', arguments: '{}' }] : [],
}))

/** 逐 `agent/request-error` 的观察行。 */
interface Observed {
  /** 该次失败的码（本插件判据读的就是它）。 */
  readonly code: string
  /** 本插件的返回动作（观察面排在它之后、compaction-basic 之前）。 */
  readonly action: unknown
  /** 观察者被调到时立刻取到的表面读数（本插件已跑完、compaction-basic 还没跑）。 */
  readonly atListener: SurfaceReading
}

/** 一次溢出构造的现场。 */
interface Driven {
  readonly lc: PersistentLifecycle
  readonly agent: Agent
  readonly session: Session
  readonly observed: Observed[]
  /** 失败发生前取的表面读数（本插件还没跑）。 */
  readonly beforeFailure: SurfaceReading
  /** turn 1 与 turn 2 的分界：turn 2 的模型调用从 `calls` 的这个下标起。 */
  readonly secondTurnFrom: number
  /** turn 2 结束时是否留下了成功的 `assistant/message`（重试成功的观察面）。 */
  readonly secondTurnCommitted: boolean
}

/**
 * 驱动两个 turn：turn 1 正常收尾，turn 2 的第一条请求以 `code` 失败。
 *
 * `failWhen` 只在 turn 2 的第一条请求上命中一次，所以搭车重试那一次不会再失败——「重试成功」才是可观察的。
 * `code` 为别的码时 compaction-basic 不介入，该 turn 直接以失败收尾（第 1 条的反例就靠它）。
 * @param options - 失败码、保留窗口、turn 2 的文本、是否挂 tool-result pruner，以及额外的同侪配置。
 * @returns 现场。
 */
async function driveOverflow(options: {
  readonly code?: string
  readonly keepRecentSteps?: number
  readonly secondTurnText?: string
  readonly mountToolResultPruner?: boolean
  readonly compaction?: Record<string, unknown>
  readonly beforePlugin?: LifecycleOptions['beforePlugin']
} = {}): Promise<Driven> {
  const observed: Observed[] = []
  const code = options.code ?? OVERFLOW.code
  const secondTurnText = options.secondTurnText ?? SECOND_TURN_TEXT
  // 失败只发生在 turn 2 的第一条请求上：用「请求里出现 turn 2 的文本」辨认，触发一次之后就撤掉。
  let armed = false
  const failWhen: LifecycleOptions['failWhen'] = request => {
    if (!armed) return undefined
    if (!request.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text === secondTurnText))) return undefined
    armed = false
    return { message: OVERFLOW.message, code }
  }
  const lc = await lifecycle(SCRIPT, {
    config: { everySteps: M, keepRecentSteps: options.keepRecentSteps ?? K },
    // 同侪挂真的 compaction-basic（走它自己的默认阈值）；第 6 条另挂 tool-result pruner。
    compaction: options.compaction ?? {},
    ...options.mountToolResultPruner === true ? { toolResultPruner: true } : {},
    ...options.beforePlugin === undefined ? {} : { beforePlugin: options.beforePlugin },
    failWhen,
    onRequestError: ({ failure, action, atListener }) => {
      observed.push({ code: failure.code, action, atListener })
    },
  })
  registerNoop(lc.ctx)
  const { agent, session } = await lc.createSession(`overflow-${sessionCounter}`)
  sessionCounter += 1
  await lc.step(agent, 'first turn')
  const beforeFailure = surfaceReading(session)
  const secondTurnFrom = lc.calls.length
  const messageBefore = countEvents(session, 'assistant/message')
  armed = true
  agent.followup(createUserMessage({ content: [{ type: 'text', text: secondTurnText }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return {
    lc,
    agent,
    session,
    observed,
    beforeFailure,
    secondTurnFrom,
    secondTurnCommitted: countEvents(session, 'assistant/message') > messageBefore,
  }
}

/** 一条只有名字的工具，让脚本里的工具调用能派发。 */
function registerNoop(ctx: Context): void {
  ctx.tools.register({
    name: 'noop',
    description: 'noop tool',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
  })
}

/** 日志里某类事件的条数。 */
function countEvents(session: Session, type: string): number {
  return session.snapshotEvents().filter(event => event.type === type).length
}

/** 摘要调用自身与随后的重试请求各一次模型调用。 */
interface RetryPair {
  readonly summary: { readonly messages: number, readonly chars: number }
  readonly retry: { readonly messages: number, readonly chars: number }
}

/**
 * 取出「compaction-basic 自己发起的那两次调用」：第一次是摘要（`purpose === 'compaction'`），第二次是它
 * 重试的模型请求。数组顺序即时间顺序——摘要先于重试，这条同时是「重试确实发生在摘要之后」的读数。
 * @param lc - 生命周期（`calls` 已累计两个 turn 的调用）。
 * @param from - 起始调用下标。
 * @returns 摘要与重试两次调用的输入规模。
 */
function retryPair(lc: PersistentLifecycle, from: number): RetryPair {
  const calls = lc.calls.slice(from)
  const summaryIndex = calls.findIndex(call => call.purpose === 'compaction')
  expect(summaryIndex).toBeGreaterThanOrEqual(0)
  const summary = calls[summaryIndex]!
  const retry = calls[summaryIndex + 1]
  expect(retry).toBeDefined()
  return {
    summary: { messages: summary.messages, chars: summary.chars },
    retry: { messages: retry!.messages, chars: retry!.chars },
  }
}

describe('票 05 · 第 1 条：只在 CONTEXT_WINDOW_EXCEEDED 时动作', () => {
  it('别的失败码零写入：QUOTA 与 UNSUPPORTED_CONTENT 各一条反例', async () => {
    // 正面锚点：同一构造换成溢出码时**会**写（否则「零写入」在「本插件根本不写」时也成立）。
    const positive = await driveOverflow()
    expect(positive.observed.map(entry => entry.code)).toEqual([OVERFLOW.code])
    expect(persistedPrunes(positive.session)).toHaveLength(1)
    await positive.lc.dispose()

    for (const code of [QUOTA_EXCEEDED_CODE, 'UNSUPPORTED_CONTENT']) {
      const { lc, session, observed } = await driveOverflow({ code })
      // 该失败码真的到达了本插件：观察面拿到的就是它。
      expect(observed.map(entry => entry.code)).toEqual([code])
      // 判据非空：历史里确实有窗口外的可裁步骤（4 条历史 > K = 2），所以「零写入」不是因为没有候选。
      expect(recordedAssistants(session)).toHaveLength(FIRST_TURN_STEPS)
      expect(persistedPrunes(session)).toEqual([])
      // 观察面是**事件数不变**：整条承载事件一条都没有（不是「落了一条空记录」）。
      expect(countEvents(session, CARRIER_EVENT_TYPE)).toBe(0)
      await lc.dispose()
    }
  })
})

describe('票 05 · 第 2 条：信号已中止时不动作', () => {
  it('同一状态、同一参数下，已中止的真信号一个事件都不写', async () => {
    // 一次真实的溢出构造（但这次失败码不是溢出码，所以本插件没写任何东西）：失败前会话里已有 4 条历史
    // 步骤、保留窗口 `K = 2`，所以候选非空。随后对**同一会话**用两种信号各调一次触发函数。
    const { lc, session } = await driveOverflow({ code: QUOTA_EXCEEDED_CODE })
    expect(persistedPrunes(session)).toEqual([])
    expect(recordedAssistants(session)).toHaveLength(FIRST_TURN_STEPS)

    const config = { everySteps: M, keepRecentSteps: K }
    const aborted = AbortSignal.abort()
    expect(aborted.aborted).toBe(true)
    expect(pruneAtRequestError(session, aborted, config)).toBeUndefined()
    expect(persistedPrunes(session)).toEqual([])
    // 票面 :9 的观察面是「事件数不变（不是落了一条空记录）」：只断 `persistedPrunes` 时，中止路径上落一条
    // **没有 `clipclop` 信封**的承载事件仍然全绿（实测），所以这里与第 1 条反例同形，断整类事件一条都没有。
    expect(countEvents(session, CARRIER_EVENT_TYPE)).toBe(0)
    // 判据非空：同一状态、同一参数、信号未中止时**会**写。
    expect(pruneAtRequestError(session, new AbortController().signal, config)).toBeDefined()
    expect(persistedPrunes(session)).toHaveLength(1)
    await lc.dispose()
  })
})

describe('票 05 · 第 2 条：prepend 让裁剪排在 compaction-basic 之前', () => {
  it('compaction-basic 的每一次测量都看得到本批裁剪（同侪自己的动作给出的读数）', async () => {
    // 顺序是这条判据的全部内容，所以观察面选**同侪自己的动作**：compaction-basic 的测量与选区都走
    // `ctx.tokenMeter.measure()`，所以「它测量那一刻我们的裁剪在不在日志里」直接回答「裁剪排在它之前
    // 还是之后」。已实测：把本插件的 `{prepend: true}` 撤掉（它随即排到 compaction-basic 之后），溢出
    // 那一次的读数是 0，本用例整条变红——顺序正是它测到的东西。
    //
    // 另一端的对照在同一数组里：到点之前那几次测量读数是 0（那时真没有裁剪），溢出那一次之后恒为 1——
    // 于是「读到 1」不可能来自别处的偶然。
    const carriersWhenMeasured: number[] = []
    const { lc, session } = await driveOverflow({
      beforePlugin: (ctx: Context) => {
        const meter = ctx.tokenMeter as unknown as { measure: (session: Session) => unknown }
        const original = meter.measure
        meter.measure = function (this: unknown, measured: Session) {
          carriersWhenMeasured.push(persistedPrunes(measured).length)
          return original.call(ctx.tokenMeter, measured)
        }
      },
    })

    // 判据非空：这一次真的写了。
    expect(persistedPrunes(session)).toHaveLength(1)
    // 溢出路径上的那次测量看到了裁剪：数组里第一个 1 之后不再回到 0（回到 0 就说明测量排在我们之前）。
    const firstSeen = carriersWhenMeasured.indexOf(1)
    expect(firstSeen).toBeGreaterThanOrEqual(0)
    expect(carriersWhenMeasured.slice(firstSeen).every(count => count === 1)).toBe(true)
    // 而它前面确实全是 0（到点之前的测量）。
    expect(carriersWhenMeasured.slice(0, firstSeen).every(count => count === 0)).toBe(true)
    await lc.dispose()
  })
})

describe('票 05 · 第 3 条：搭车——裁剪自己不会触发重试', () => {
  it('本插件只委托；重试由 compaction-basic 决定，且真的发生了（重试请求在摘要之后）', async () => {
    const { lc, session, observed, secondTurnFrom, secondTurnCommitted } = await driveOverflow()

    // ① 裁剪在本次 failure 处理中落盘，而且落盘早于同侪的决定：观察面夹在本插件与 compaction-basic 之间，
    //    它被调到的那一刻（`atListener`）裁剪已经在日志里，链的最终动作在那之后才产生。
    const observedOnce = observed[0]!
    expect(observedOnce.atListener.prunes).toBe(1)
    // ② 链的最终动作是 `{kind:'retry'}`，它**来自 compaction-basic**，不是本插件给的：本插件的
    //    `agent/request-error` 监听器体里只有 `pruneAtRequestError(...)` 与 `return next()`（第 8 条用源码
    //    断言钉住这件事）。这条判据能证明的部分到此为止——本插件是链上最外层，链的返回值在结构上就是
    //    `next()` 的返回值，所以「本插件自己又把它改成 retry」这种形态无法从返回值上分辨，见第 8 条。
    expect(observedOnce.action).toEqual({ kind: 'retry' })
    // 判据非空：compaction-basic 真的推进了 replace 并决定重试——这正是「搭车」本身。
    expect(countEvents(session, 'compaction/summary')).toBe(1)
    expect(session.surface.replaceGeneration).toBeGreaterThan(0)
    // ③ 重试确实发生了，而且发生在摘要**之后**：模型调用序列是「失败的请求 → 摘要 → 重试」，重试那一次
    //    成功落盘（收到 `assistant/message` 而不是再次失败）。
    const calls = lc.calls.slice(secondTurnFrom)
    expect(calls.map(call => call.purpose)).toEqual([undefined, 'compaction', undefined])
    expect(secondTurnCommitted).toBe(true)
    await lc.dispose()
  })

  it('反例（非溢出码）：本插件不动手，链的最终动作是 undefined，请求就是失败的', async () => {
    const { lc, session, observed, secondTurnCommitted } = await driveOverflow({ code: QUOTA_EXCEEDED_CODE })
    expect(persistedPrunes(session)).toEqual([])
    // 链的最终动作不是 retry（`undefined` = 默认的终局），而且日志里没有 replace：既没有人重试，
    // 也没有人兜住这次失败。
    expect(observed[0]!.action).toBeUndefined()
    expect(session.surface.replaceGeneration).toBe(0)
    // 行为面：这一 turn 没有留下任何成功的 `assistant/message`——我们没有救它。
    expect(secondTurnCommitted).toBe(false)
    await lc.dispose()
  })
})

describe('票 05 · 第 4 条：裁剪不算进展（replaceGeneration 不变）', () => {
  it('测量点在本插件之后、compaction-basic 之前：replaceGeneration 不变、contentGeneration 增一', async () => {
    const { lc, session, observed, beforeFailure } = await driveOverflow()

    // 窗口非空：观察者被调到时裁剪确实已经落盘（`targets` 逐项对得上按保留窗口算出的那一批）。
    const recorded = recordedAssistants(session)
    expect(observed).toHaveLength(1)
    // 窗口读数非空：那一刻裁剪已落盘（`prunes = 1`），且被裁的那批推理块在那时的模型可见历史里已经
    // 不在、保留窗口里的仍在。**必须**读窗口内的读数：整个 failure 处理结束后 compaction-basic 的摘要会
    // 遮蔽前几条历史节点，届时它们对 `reasoningTexts` 本来就不可见，事后断「保留窗口仍在」是空转。
    const atListener = observed[0]!.atListener
    expect(atListener.prunes).toBe(1)
    for (const target of persistedPrunes(session)[0]!.targets) {
      const entry = recorded.find(candidate => candidate.seq === target)!
      expect(atListener.reasoning).not.toContain(entry.reasoning)
    }
    // 保留窗口里那几步的推理仍然在（窗口读数里可见），只有窗口外的被裁掉：`targets` 恰是窗口外那批。
    expect(persistedPrunes(session)[0]!.targets)
      .toEqual(recorded.slice(0, FIRST_TURN_STEPS - K).map(entry => entry.seq))
    // 那一刻模型可见历史里只剩 turn 1 保留窗口那几步的推理（失败那一步还没提交任何消息）。
    expect(atListener.reasoning)
      .toEqual(recorded.slice(FIRST_TURN_STEPS - K, FIRST_TURN_STEPS).map(entry => entry.reasoning))

    // 判据：裁剪落到 `contentGeneration` 上，`replaceGeneration` 一点没动。
    expect(observed[0]!.atListener.replaceGeneration).toBe(beforeFailure.replaceGeneration)
    expect(observed[0]!.atListener.contentGeneration).toBe(beforeFailure.contentGeneration + 1)
    // 整个 failure 处理结束后 replaceGeneration 才有进展——那是 compaction-basic 的摘要（同一个 turn 里）。
    expect(session.surface.replaceGeneration).toBe(beforeFailure.replaceGeneration + 1)
    await lc.dispose()
  })
})

describe('票 05 · 第 5 条：搭车的可观察收益（重试成功；跨臂读数落在摘要输入上）', () => {
  it('重试请求小于被它取代的失败请求；跨臂对照则是摘要输入严格小于不裁那臂', async () => {
    // 两臂的差别只有一个：保留窗口。`keepRecentSteps` 放到大于历史条数时本批为空、写入侧零落盘，于是
    // 「不裁」那臂既不写承载事件、也没有投影变更——两臂都搭同一次车。
    const pruned = await driveOverflow()
    const untouched = await driveOverflow({ keepRecentSteps: 1000 })
    const prunedPair = retryPair(pruned.lc, pruned.secondTurnFrom)
    const untouchedPair = retryPair(untouched.lc, untouched.secondTurnFrom)

    // 臂的区分先立住：一臂真的裁了、另一臂一条都没写。
    expect(persistedPrunes(pruned.session)).toHaveLength(1)
    expect(persistedPrunes(untouched.session)).toEqual([])

    // ① 本臂内部的真实对照（判据非空）：被取代的那次失败请求带着全部历史，重试请求被摘要取代了一大段，
    //    所以它严格更小。先断「失败请求确实带着完整历史」，否则下面那条在失败请求本就很小时也成立。
    const failedRequest = pruned.lc.calls[pruned.secondTurnFrom]!
    expect(failedRequest.purpose).toBeUndefined()
    expect(failedRequest.messages).toBeGreaterThan(FIRST_TURN_STEPS)
    expect(prunedPair.retry.messages).toBeLessThan(failedRequest.messages)

    // ② 跨臂读数的口径（写实、不写成重言式）：重试请求 = 系统提示 + **摘要产物**，而摘要产物由脚本化适配器
    //    按调用下标给出（与喂进去的输入无关），所以两臂的重试请求本身等长（实测同为 3 条消息 / 406 字符，
    //    这一条因此**不**作为判据）。被裁推理省下的是**喂给摘要的那份输入**——它正是这次重试的输入来源，
    //    所以可观察的跨臂收益落在摘要调用自己的输入上（实测 1916 < 1936 字符）。
    expect(prunedPair.summary.chars).toBeLessThan(untouchedPair.summary.chars)
    expect(prunedPair.summary.messages).toBeLessThanOrEqual(untouchedPair.summary.messages)
    // 而且重试成功（收到 `assistant/message` 而不是再次失败）。
    expect(pruned.secondTurnCommitted).toBe(true)
    expect(untouched.secondTurnCommitted).toBe(true)

    await pruned.lc.dispose()
    await untouched.lc.dispose()
  })
})

describe('票 05 · 第 6 条：compat 稀疏情形——不重试时只对后续步骤生效', () => {
  it('compaction-basic 不重试：本次仍失败，下一次请求（新 turn）里被裁步骤的推理块已不在', async () => {
    // 构造「它不重试」：`maxOverflowRetries: 0` 是 compaction-basic 自己的开关（测试侧配置，不改它的默认
    // 值、也不是我们包里的配置项），于是它在**选区之前**就 `return next()`（`lib/index.js:868`），整个
    // failure 处理里没有任何 replace——这正是稀疏情形：搭车不成立、请求照旧失败。
    // 票面点名的另一半是 tool-result pruner 也没落 replace，所以这里把它也挂上并单独断言它没落 replace。
    // 它在本构造里不会被调用（compaction-basic 根本没走到取 pruner 的那一步）——这不削弱构造：只要没有
    // 活的选区，pruner 落不落 replace 都不改变「没有进展、请求照旧失败」这个结果。
    const { lc, agent, session, observed } = await driveOverflow({
      mountToolResultPruner: true,
      compaction: { maxOverflowRetries: 0 },
    })

    // ① 本次 failure 处理后事件已落盘。
    expect(persistedPrunes(session)).toHaveLength(1)
    const targets = persistedPrunes(session)[0]!.targets
    expect(targets.length).toBeGreaterThan(0)
    const recorded = recordedAssistants(session)
    const prunedReasoning = targets.map(target => recorded.find(entry => entry.seq === target)!.reasoning)
    expect(prunedReasoning).toHaveLength(FIRST_TURN_STEPS - K)

    // ② 请求仍失败（我们不救它）：这一 turn 没有成功提交任何 `assistant/message`，也没有任何 replace，
    //    而且挂着的 tool-result pruner 确实一条 replace 都没落。
    expect(observed[0]!.action).toBeUndefined()
    expect(session.surface.replaceGeneration).toBe(0)
    const visibleAfterFailure = reasoningTexts(session)
    for (const reasoning of prunedReasoning) expect(visibleAfterFailure).not.toContain(reasoning)

    // ③ **下一次请求**里被裁步骤的推理块已不在。终局失败冒泡终结整个 turn（agent loop 在
    //    `action?.kind !== 'retry'` 时直接 `throw`），同一 turn 不会再有请求；所以「下一次请求」必须由
    //    夹具再开一个 turn——这正是票面写死的口径。
    const callsBeforeNextTurn = lc.calls.length
    await lc.step(agent, 'next turn')
    expect(lc.calls.length).toBeGreaterThan(callsBeforeNextTurn)
    // 判据非空：后续请求看到的是裁剪版——被裁的推理块整条都不在，保留窗口里的仍在。
    const visibleNextTurn = reasoningTexts(session)
    for (const reasoning of prunedReasoning) expect(visibleNextTurn).not.toContain(reasoning)
    for (const kept of recorded.slice(FIRST_TURN_STEPS - K)) expect(visibleNextTurn).toContain(kept.reasoning)
    await lc.dispose()
  })
})

describe('票 05 · 第 8 条：首版不自持重试', () => {
  it('源码里没有在本插件自己的 `agent/request-error` 监听器上返回 retry 的分支', async () => {
    // 有意的负向判据（票据 :16、备注第 8 条）：契约允许 listener 返回 `{kind:'retry'}`，但那必须自带一个
    // 有界计数（照 compaction-basic 的 `overflowRetries` 形状，含 `agent/status → idle` 重置），否则会在
    // 裁剪救不回来的请求上无限重试。首版不做，所以断言实现里**没有**这条分支——它防的正是无界重试。
    const entry = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // 作用域写死为**① 这一个监听器**（到下一个 `ctx.on(` 为止）：09 的 ⑤ 按设计要返回 `{kind:'retry'}`，
    // 上界是「停用是一次性状态，同一会话至多重试一次」，所以「实现里没有 retry 分支」这句只对 ① 那一支成立。
    // 票 05 `:16` 已按此把判据收窄到 ①，判据本身（① 委托 `next()`，不自持重试）没有变。
    const from = entry.indexOf("ctx.on('agent/request-error'")
    const rest = entry.indexOf("ctx.on('", from + 1)
    const listener = entry.slice(from, rest === -1 ? undefined : rest)
    expect(listener).not.toContain("kind: 'retry'")
    expect(listener).not.toContain('kind: "retry"')
    // 而它确实预置了本插件的溢出监听器（否则上面那句在一个没有该监听器的实现上也成立）。
    expect(listener).toContain('pruneAtRequestError')
  })
})

describe('票 05 · 第 7 条：摘要照跑时记录该次摘要调用自身', () => {
  it('摘要调用的 inputTokens / cacheReadTokens 有读数，且该次运行里裁剪确实落盘', async () => {
    const { lc, session, secondTurnFrom } = await driveOverflow()

    // 前半个合取项：该次运行里本插件的裁剪确实落盘（照第 3 条①同款断言）。缺了它，摘要调用由
    // compaction-basic 自己发起，本插件不裁剪、甚至根本没实现也照样打勾。
    expect(persistedPrunes(session)).toHaveLength(1)

    // 后半个合取项：摘要调用自身的两个读数存在。`purpose === 'compaction'` 是认出它的唯一方式。
    // 只断「有读数」而不是断具体数值：夹具的 `usage` 是常量，写死等值只会把「读数存在」退化成
    // 「夹具常量被抄了一遍」——`undefined`（该次调用没带上 usage）仍会让这里红。
    const summaryCall = lc.calls.slice(secondTurnFrom).find(call => call.purpose === 'compaction')
    expect(summaryCall).toBeDefined()
    expect(summaryCall!.inputTokens).toBeTypeOf('number')
    expect(summaryCall!.cacheReadTokens).toBeTypeOf('number')
    // 定价不落在本票的判据里（`h` 的外部声明与代入归 07）：这里只记录这一次摘要调用自身的读数。
    await lc.dispose()
  })
})
