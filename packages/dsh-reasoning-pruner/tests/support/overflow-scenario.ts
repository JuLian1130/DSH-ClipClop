/**
 * 票 07 的**溢出场景**：闸门 B-2 与闸门 B 的摘要分支共用的一份构造。
 *
 * 它把 05 已经落地的「溢出 + 搭车重试」控制流原样用起来，**不重复 05 的判据**：05 断的是「① 的搭车语义成
 * 立」，本模块只负责把这场景的**定价读数**取出来——重试请求的输入、被裁推理量，以及摘要调用自身的
 * `inputTokens` / `cacheReadTokens` 与推理占比 `r`。
 *
 * 两处口径写死：
 *
 * - **摘要调用的两个读数不在 `assistant/message` 上**：摘要走 `ctx.llm.stream()`、不经 agent loop，其 usage
 *   由 `compaction/summary` 事件承载。第 12 条「真源是 `assistant/message` 的 usage」只约束裁剪路径上的
 *   请求，摘要那一项到这里读，**读不到时不得记 0**。
 * - **机制前提**：裁剪自己不会触发重试——compaction-basic 的重试凭证是 `replaceGeneration`，而投影式裁剪
 *   只推进 `contentGeneration`。所以 ① 只能靠**搭车**，本模块的判据是「救回」而不是稳态收益。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { LifecycleOptions, LlmCall, PersistentLifecycle, ScriptedStep } from './session-harness.ts'
import { cleanupRoots, lifecycle, surfaceReading } from './session-harness.ts'
import type { SurfaceReading } from './session-harness.ts'
import { proxySignals, reasoningTokens } from './gate-readings.ts'

/** 保留窗口（`K`）取小值让第一批非空；节流 `M` 取大值，让本场景的每一步构造都不靠 ② 触发。 */
const K = 2
const M = 50

/** 第一个 turn 的步数：4 步，于是窗口 `K = 2` 之外还剩 2 条可裁。 */
const FIRST_TURN_STEPS = 4

/** 第二个 turn 的驱动文本；`failWhen` 按它认出该 turn 的第一条请求。 */
export const SECOND_TURN_TEXT = 'second turn'

/** 溢出失败码与正文。 */
const OVERFLOW = { message: 'context window exceeded', code: CONTEXT_WINDOW_EXCEEDED_CODE }

/** 每一步推理文本逐索引不同，逐项断言靠它认出「哪一步被裁」。 */
function reasoningOf(index: number): string {
  return `thinking ${index}`
}

/** 脚本形状与 05 的同款：turn 1 前 3 步发起工具调用、第 4 步纯文本收尾，之后每次调用都纯文本收尾。 */
const SCRIPT: ScriptedStep[] = Array.from({ length: 12 }, (_unused, index) => ({
  reasoning: reasoningOf(index),
  text: `text ${index}`,
  calls: index < FIRST_TURN_STEPS - 1 ? [{ name: 'noop', arguments: '{}' }] : [],
}))

/** 逐 `agent/request-error` 的观察行。 */
export interface OverflowObservation {
  /** 该次失败的码（本插件判据读的就是它）。 */
  readonly code: string
  /** 整条链跑完之后的最终动作。 */
  readonly action: unknown
  /** 观察者被调到时立刻取到的表面读数（本插件已跑完、compaction-basic 还没跑）。 */
  readonly atListener: SurfaceReading
}

/** 一次溢出构造的现场。 */
export interface OverflowScenario {
  readonly lc: PersistentLifecycle
  readonly agent: Agent
  readonly session: Session
  readonly observed: readonly OverflowObservation[]
  /** 失败发生前取的表面读数（本插件还没跑）。 */
  readonly beforeFailure: SurfaceReading
  /** turn 2 的模型调用从 `lc.calls` 的这个下标起。 */
  readonly secondTurnFrom: number
  /**
   * 摘要调用自身的推理占比 `r`（推理 token / 该次请求总量）。
   *
   * 没有摘要调用时为 `NaN`——不折成 0：0 意味着「摘要里一点推理也没有」，而 `NaN` 让任何比较当场失败，
   * 于是「没测到」不会被静默读成一个数。摘要调用的 usage 另由 {@link summaryUsage} 从
   * `compaction/summary` 事件读，读不到时返回 `undefined`。
   */
  readonly summaryReasoningShare: number
  /** 该 turn 的收尾原因（`completed` 即重试成功；但它**不是**任务达成信号）。 */
  readonly turnEnds: readonly string[]
  /** 释放整个 context（落盘根由 `cleanupRoots` 删）。 */
  dispose(): Promise<void>
}

/** 每次构造一个唯一会话身份（同一落盘根里 `id` 只能用一次）。 */
let sessionCounter = 0

/**
 * 驱动两个 turn：turn 1 正常收尾，turn 2 的第一条请求以 `CONTEXT_WINDOW_EXCEEDED` 失败。
 *
 * `failWhen` 只命中一次，所以搭车重试那一次不会再失败——「重试成功」才是可观察的。
 * @param options - 失败码、保留窗口、是否挂 tool-result pruner，以及是否让 pruning 臂关闭。
 * @returns 现场，见 {@link OverflowScenario}。
 */
export async function overflowScenario(options: {
  /** 保留窗口；给大值即「裁不掉任何东西」的对照臂。 */
  readonly keepRecentSteps?: number
  /** 是否挂 tool-result pruner（构造「它落了 replace」的分支）。 */
  readonly mountToolResultPruner?: boolean
  /** 是否挂本插件；`false` 即「同场景不裁剪」的对照。 */
  readonly withPlugin?: boolean
  /** 额外的同侪配置。 */
  readonly compaction?: Record<string, unknown>
  /**
   * 让**摘要调用本身**失败，用来造出「tool-result pruner 落了 replace、摘要没成，compaction-basic 仍
   * 从替换后的表面重试」那条分支。
   *
   * 该分支是 ① 判据唯一非空的地方：摘要成功时它自己会把整段区间遮蔽掉，重试请求带的是**摘要产物**，于是
   * 「被裁推理块不在」在裁剪臂与对照臂上都成立（05 已把这条口径写实）。摘要失败时重试请求直接带替换后的
   * 表面，裁剪是否真的进了模型可见历史才可分辨。
   */
  readonly summaryFails?: boolean
  /**
   * 让工具返回一段大结果（≥ tool-result pruner 的 8192 字符阈值），使它在溢出路径上真的落一条 replace。
   *
   * 没有它时 pruner 一条 replace 都不落，`replaceGeneration` 不前进，compaction-basic 也就不会重试。
   */
  readonly largeToolResults?: boolean
} = {}): Promise<OverflowScenario> {
  const observed: OverflowObservation[] = []
  // 失败只发生在 turn 2 的第一条请求上：用「请求里出现 turn 2 的文本」辨认，触发一次之后就撤掉。
  let armed = false
  const failWhen: LifecycleOptions['failWhen'] = request => {
    // 摘要失败是常开的（它每次都在 `armed` 之外，属于同侪自己的失败路径）。
    if (options.summaryFails === true && request.purpose === 'compaction') {
      return { message: 'summary failed', code: 'UNKNOWN' }
    }
    if (!armed) return undefined
    if (!request.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text === SECOND_TURN_TEXT))) return undefined
    armed = false
    return { message: OVERFLOW.message, code: OVERFLOW.code }
  }
  const lc = await lifecycle(SCRIPT, {
    config: { everySteps: M, keepRecentSteps: options.keepRecentSteps ?? K },
    withPlugin: options.withPlugin ?? true,
    compaction: options.compaction ?? {},
    ...options.mountToolResultPruner === true ? { toolResultPruner: true } : {},
    failWhen,
    onRequestError: ({ failure, action, atListener }) => {
      observed.push({ code: failure.code, action, atListener })
    },
  })
  registerNoop(lc.ctx, options.largeToolResults === true)
  const { agent, session } = await lc.createSession(`overflow-${sessionCounter}`)
  sessionCounter += 1
  await lc.step(agent, 'first turn')
  const beforeFailure = surfaceReading(session)
  const secondTurnFrom = lc.calls.length
  armed = true
  agent.followup(createUserMessage({ content: [{ type: 'text', text: SECOND_TURN_TEXT }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const summaryCall = lc.calls.slice(secondTurnFrom).find(call => call.purpose === 'compaction')
  return {
    lc,
    agent,
    session,
    observed,
    beforeFailure,
    secondTurnFrom,
    // 没有摘要调用时给 `NaN`（见字段文档）：不折成 0，让「没测到」无法被当成读数。
    summaryReasoningShare: summaryCall === undefined ? Number.NaN : reasoningShare(summaryCall),
    turnEnds: proxySignals(session.snapshotEvents()).turnEnds,
    dispose: async () => {
      await lc.dispose()
      await cleanupRoots()
    },
  }
}

/** 一条只有名字的工具，让脚本里的工具调用能派发。 */
function registerNoop(ctx: Context, largeResults: boolean): void {
  // 大结果是**模型可见**的那份文本：tool-result pruner 裁的是 `tool/result` 的模型可见内容，
  // 所以体积必须落在 `render` 上，`execute` 的返回值不算数。
  const body = largeResults ? 'y'.repeat(20_000) : 'ok'
  ctx.tools.register({
    name: 'noop',
    description: 'noop tool',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: body }] },
    execute: async () => ({}),
  })
}

/** 摘要调用自身与随后的重试请求各一次模型调用。 */
export interface RetryPair {
  readonly summary: LlmCall
  readonly retry: LlmCall
}

/**
 * 摘要调用自身的推理占比 `r` = 该次请求里推理块的 token 量 / 该次请求总量。
 *
 * 它只在摘要调用**自身这一次请求**上可量：摘要走 `ctx.llm.stream()`、不落 `assistant/message`，所以体积只能
 * 在请求侧读。`r` 用来判定「先裁再摘要」是否划算（`h > 1 − r` 才更便宜）。
 * @param call - 摘要那一次调用的观察行。
 * @returns 推理占比；该次请求为零 token 时为 0。
 */
export function reasoningShare(call: LlmCall): number {
  if (call.requestTokens === 0) return 0
  return reasoningTokens(call.reasoning) / call.requestTokens
}

/**
 * 取出「compaction-basic 自己发起的那两次调用」：第一次是摘要（`purpose === 'compaction'`），第二次是它
 * 重试的模型请求。数组顺序即时间顺序——摘要先于重试，这条同时是「重试确实发生在摘要之后」的读数。
 * @param scenario - 溢出现场。
 * @returns 摘要与重试两次调用。
 */
export function retryPair(scenario: OverflowScenario): RetryPair {
  const calls = scenario.lc.calls.slice(scenario.secondTurnFrom)
  const summaryIndex = calls.findIndex(call => call.purpose === 'compaction')
  if (summaryIndex < 0) throw new Error('本场景没有摘要调用：`purpose === "compaction"` 是认出它的唯一方式')
  const retry = calls[summaryIndex + 1]
  if (retry === undefined) throw new Error('摘要之后没有重试请求：搭车重试没有发生')
  return { summary: calls[summaryIndex]!, retry }
}

/**
 * `compaction/summary` 事件里承载的 usage（规格「测量协议」末条要求的观测）。
 *
 * 摘要调用不经 agent loop，所以它的 usage 不落 `assistant/message`；本函数从事件里把它读出来，
 * **读不到时返回 `undefined`**（调用方不得折成 0——那会把「没测到」记成「没花钱」）。
 * @param session - 会话。
 * @returns 摘要事件的 usage，或 `undefined`。
 */
export function summaryUsage(session: Session): { readonly inputTokens?: number, readonly cacheReadTokens?: number } | undefined {
  const event = session.snapshotEvents().find(entry => entry.type === 'compaction/summary')
  return (event?.data as { usage?: { inputTokens?: number, cacheReadTokens?: number } } | undefined)?.usage
}