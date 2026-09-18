/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * 等待模式的「到点发起一次复核」：监听 `agent/pre-step`，到触发点时取主会话快照、按主会话继承的
 * 路由发一次辅助请求，并把收场结算成一条记录（装配输出、严格解析取结论、收用量与耗时，按终止原因
 * 分完成 / 失败）。复核的结论交回调用点，由监听器按 `verdict` 分派：`adjust` 把复核建议追加进本步
 * 的 `decision.messages`，`stop` 先追加停止说明再取消当前 turn；失败 / 取消（没有结论）与 `continue`
 * 都不触碰会话。并行模式与失败表其余格由后续票据实现。
 *
 * **等待期作废**（07）：等待复核期间到达的真实用户消息让本次复核作废——不注入、不追加停止说明、
 * 不停止，也不调用 `agent.cancel`（默认清空待处理队列，会把用户刚发的话丢掉）。作废只有一条判定：
 * 消息在复核在途时到达，由唯一的 `agent/inbox/inserted` 监听器在送消息那一次同步调用里置位；
 * 消息在触发点那次 pre-step 的 claim 之前就已入队，则由应用点检查本步被 claim 的消息逮住。作废时
 * 只落那条取消记录（原因 `invalidated`），完成态不落盘——所以完成态写入挪到了收场之后、作废判定与
 * 干预动作之后（判定到干预之间不隔 await，否则此间到达的真实用户消息会被停止动作的 `cancel` 清掉）。
 * verdict 过滤只加在 claim 检查那一支（本实现的取舍，理由见设计文档该节）：在途到达不看结论、一律
 * 作废；claim 检查那一支只在 `adjust` / `stop` 上作废，`continue` 照旧落完成态（触发点那次 pre-step
 * 正常会 claim 到用户自己那条消息，04 的完成态用例建在这条上）。
 *
 * 记录域在**加载路径上**打开（`openReviewStore`）：坏记录正是在 `open` 的装载路径上被跳过的，
 * 惰性打开会让「坏记录不挡加载」落空。
 *
 * 主会话取自 pre-step 载荷的 `agent.session`，不经 `ctx.sessions.get`；`ctx.sessions.get` 的函数
 * 检查仍保留，它只服务激活门禁。取法、理由与那条检查为何不删，见设计文档「范围与约束」。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import { openReviewStore, readReviewRecords, type ReviewWriter } from './records.ts'
import { composeAdjustNotice, name, noticeMessage, stopWithNotice } from './interventions.ts'
import { composeReviewInstruction } from './review-prompt.ts'
import { advanceTriggerStep, deriveNextTriggerStep, resetTriggerStepAtUserMessage } from './trigger.ts'
import type { Config } from './types.ts'
import { parseReviewOutcome, type ReviewOutcome } from './verdict.ts'

export * from './types.ts'
export * from './records.ts'
export * from './replay.ts'

export { name }

/**
 * 四个必需服务。任一缺失时 Cordis 让插件停在 PENDING 而不是带着缺能力运行——`inject` 没列的服务
 * 在取用时直接抛错，所以「服务缺失时不激活」由框架兑现，缺哪个服务由 DSH 启动审计报告。
 *
 * 监听 `agent/pre-step` 不需要额外服务——机制、源码依据与先例见设计文档「范围与约束」。
 */
export const inject = ['llm', 'sessions', 'sessionProjections', 'storageDomain']

/** 复核超时的取消代码，写进 `deadline` 的 `TimeoutReason`；测试也用它判别超时。 */
export const REVIEW_TIMEOUT_CODE = 'NAVIGATOR_REVIEW_TIMEOUT'

/**
 * 注册计数投影、打开记录域、检查本版要调用的 API 形状，并在触发点发起等待模式复核。
 * @param ctx - 插件的 context；`inject` 的四个服务此时都已就绪。
 * @param config - 解析后的配置（六个字段都已落值）。
 * @throws 当 `ctx.llm.stream` 或 `ctx.sessions.get` 不存在或不是函数时，错误信息点名缺的那个。
 */
export async function apply(ctx: Context, config: Required<Config>): Promise<void> {
  if (typeof ctx.llm.stream !== 'function') {
    throw new Error('dsh-navigator requires ctx.llm.stream to be a function')
  }
  if (typeof ctx.sessions.get !== 'function') {
    throw new Error('dsh-navigator requires ctx.sessions.get to be a function')
  }
  ctx.sessionProjections.register(navigatorStepsProjection)
  // 运行时写入的唯一入口：绑到本实例的域与它自己的 disposer（设计文档「读写入口与 writer 的关闭次序」）。
  const writeReviewRecord = await openReviewStore(ctx)

  /** 每个主会话的下一次触发点（已完成步数）。按 `Session` 弱引用持有，重新观察时重新推导。 */
  const triggerSteps = new WeakMap<Session, number>()
  /** 每个主会话当前在途的复核：值是这次复核的作废标记。每次复核新建一个单元格，逐次覆盖。 */
  const inFlightReviews = new WeakMap<Session, InFlightReview>()

  // 唯一的 `agent/inbox/inserted` 监听器（08 的并行建议过期改写在这里追加，不另注册一份）。
  // 判别式只认真实用户消息，不放宽成「任何插入事件都作废」；只有**在途**复核会被置位——消息在
  // 触发点那次复核发起之前入队时，这里没有可作废的对象，那一格由应用点检查 claim 批次认领。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isRealUserMessage(message)) return
    const review = inFlightReviews.get(agent.session)
    if (review !== undefined) review.invalidated = true
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const { session } = agent
    // 只观察用户发起的顶层会话：子 agent 的子会话不触发复核、也不参与计数（设计文档「观察范围」）。
    // 判别式是会话头部的 `origin`，不是「没有 parentSession」——用户 fork 出来的会话带 parentSession
    // 却不带 `origin`，照样算顶层。
    if (session.header.origin === 'subagent') return next()
    const observed = ctx.sessionProjections.stateOf(session, 'navigatorSteps')
    let triggerStep = triggerSteps.get(session)
    if (triggerStep === undefined) {
      // 第一次取得主会话：能力缺失在这里直接报错，当前 turn 以 error 收尾。检查必须落在第一次
      // pre-step——loop 自己对这些方法的调用都在 pre-step 之后，拖到第一个触发点就轮不到插件点名。
      assertSessionMethods(session)
      // 首次观察时内存里没有触发点，才按三项取最大的推导式写入；记录项取读回入口的列表末条
      // （最后一条复核记录里的触发步骤），没有记录时为 null。
      triggerStep = deriveNextTriggerStep({
        lastReviewStep: readReviewRecords(session.id).at(-1)?.triggerStep ?? null,
        anchorStep: observed?.anchorStep ?? null,
        currentSteps: observed?.steps ?? 0,
        everySteps: config.triggerEverySteps,
      })
      triggerSteps.set(session, triggerStep)
    } else {
      // 运行期：锚点只在新的真实用户消息落盘时移动，所以每个步边界只把内存触发点**提升**到
      // 「锚点 + 间隔」——推导式的另外两项不在这里重算（设计文档「触发节奏」）。
      const anchorStep = observed?.anchorStep
      if (anchorStep !== null && anchorStep !== undefined) {
        triggerStep = Math.max(triggerStep, resetTriggerStepAtUserMessage(anchorStep, config.triggerEverySteps))
        triggerSteps.set(session, triggerStep)
      }
    }
    if ((observed?.steps ?? 0) < triggerStep) return next()
    // 到点。节奏只按「触发点 + 间隔」推进：不重新计时、不顺延、也不补打。
    triggerSteps.set(session, advanceTriggerStep(triggerStep, config.triggerEverySteps))
    // 先取回内层决策，再按结论追加通知：waterfall 的内层默认返回「本步被 claim 的消息 +
    // runtime-context 消息」，自造 `{ kind: 'enter', messages }` 会静默丢掉后者。
    const decision = await next()
    // 复核在途期间到达的真实用户消息由插入事件监听器在那一次同步调用里置位。先登记在途对象，
    // 让监听器找得到它；收场之后注销。
    const review: InFlightReview = { invalidated: false }
    inFlightReviews.set(session, review)
    let settlement: ReviewSettlement | null
    try {
      settlement = await reviewOnce({ ctx, config, session, upstream: signal, triggerStep, writeReviewRecord })
    } finally {
      inFlightReviews.delete(session)
    }
    // 失败 / 取消（没有结论）不触碰会话。
    if (settlement === null) return decision
    // 作废只有一条判定语义，两处信号合成它：在途置位，或本步被 claim 的消息里有真实用户消息。
    // 判定落在收场之后；09 的失败策略停止与它共用这一条（作废优先、不停止）。verdict 过滤只加在
    // claim 检查那一支——在途到达按规格「一律作废」，而 claim 检查的规格前提是「注入建议、追加
    // 停止说明或停止 turn 之前」，`continue` 什么也不做，照旧落完成态（04 的完成态三态格建在这条上：
    // 触发点那次 pre-step 正常会 claim 到用户自己那条消息，不过滤则 04 的完成态用例必红）。
    const invalidated = review.invalidated
      || (settlement.outcome.verdict !== 'continue' && messages.some(isRealUserMessage))
    // 完成态写入挪到作废判定之后：作废时只落那条取消记录，不落完成态——先落完成态再同键覆盖正是
    // 04 要避免的。
    if (invalidated) {
      // 也不调用 `agent.cancel`——它默认清空待处理队列，会把用户刚发的话一起丢掉。
      await writeReviewRecord(session.id, {
        ...settlement.base,
        durationMs: settlement.durationMs,
        status: 'cancelled',
        cancelReason: 'invalidated',
      })
      return decision
    }
    // 干预动作紧跟判定、中间不隔 await：`stopWithNotice` 是同步的，判定与 cancel 之间因此没有可插入
    // 真实用户消息的间隙——留出间隙时，那条消息会被 cancel 清掉。完成态写入落在干预之后。
    // `reject` 决策意味着这一步不打开、不会有模型请求，通知无处落地，所以只在 `enter` 上追加。
    if (settlement.outcome.verdict === 'adjust' && decision.kind === 'enter') {
      decision.messages.push(noticeMessage(composeAdjustNotice(triggerStep, settlement.outcome.recommendation)))
    } else if (settlement.outcome.verdict === 'stop') {
      stopWithNotice(agent, triggerStep, settlement.outcome.reason)
    }
    await writeReviewRecord(session.id, {
      ...settlement.base,
      durationMs: settlement.durationMs,
      status: 'completed',
      verdict: settlement.outcome,
      ...settlement.usage === undefined ? {} : { usage: settlement.usage },
    })
    return decision
  })
}

/** 在途复核的作废标记：插入事件监听器置位，应用点在收场之后读它。 */
interface InFlightReview {
  invalidated: boolean
}

/**
 * 真实用户消息的判别式（规格「什么算真实用户消息」）：`role === 'user' && source.kind === 'user'`。
 * 工具结果、插件写入的说明与建议、批准都不算；遇到不认识的来源一律按「不是」处理。
 * @param message - 一条插入事件或本步被 claim 的消息。
 * @returns 是真实用户消息时为 true。
 */
function isRealUserMessage(message: UserMessage): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

/**
 * 会话级能力检查（规格：第一次取得主会话时查 `deriveMessages` 与 `requestHeader`）。这是能力缺失，
 * 不属于失败表：直接抛错，让当前 turn 以 `error` 收尾。
 * @param session - pre-step 载荷里的主会话。
 * @throws 错误点名缺的那个方法。
 */
function assertSessionMethods(session: Session): void {
  if (typeof session.deriveMessages !== 'function') {
    throw new Error('dsh-navigator requires session.deriveMessages to be a function')
  }
  if (typeof session.requestHeader !== 'function') {
    throw new Error('dsh-navigator requires session.requestHeader to be a function')
  }
}

/** `reviewOnce` 的全部输入。 */
interface ReviewAttempt {
  readonly ctx: Context
  readonly config: Required<Config>
  readonly session: Session
  /** 本步的取消信号，与复核超时融合。 */
  readonly upstream: AbortSignal
  /** 这次复核的触发步骤，记录里按它归位（也是键的判别值）。 */
  readonly triggerStep: number
  /** 落一条记录：本实例的 writer。 */
  readonly writeReviewRecord: ReviewWriter
}

/** 一条记录里与收场状态无关的部分（完成态与取消态共用）。 */
interface ReviewRecordBase {
  readonly triggerStep: number
  readonly config: Required<Config>
  /** 触发点那一刻快照里每条消息的 id，按原顺序。 */
  readonly messageIds: readonly string[]
}

/** 一次可解析收场的结算：结论与落完成态所需的记录字段，由调用点在作废判定之后落盘。 */
interface ReviewSettlement {
  /** 解析成功的结论。 */
  readonly outcome: ReviewOutcome
  /** 记录里与结论无关的部分。 */
  readonly base: ReviewRecordBase
  /** 复核耗时。 */
  readonly durationMs: number
  /** 流里出现 usage 块时的用量；没有该块时整个字段缺省。 */
  readonly usage?: TokenUsage
}

/** 输出过不了严格解析时记进失败原因的那一条。 */
const OUTPUT_UNPARSEABLE = '复核输出无法解析'

/** 「拿不到路由」的防御分支记进失败原因的那一条。 */
const NO_ROUTE = '拿不到会话路由'

/**
 * 发起一次复核请求，并把这次复核的收场结算成一条记录。请求形态按设计文档「辅助请求的消息构成」
 * 「模型配置继承粒度」，超时按「技术路线」。
 *
 * **失败分类的输入有两条来源，读法不同**（机制见设计文档 `失败处理`）：适配器侧的抛错与「挂住到
 * 超时」都被 `adapterFailureChunk` 归一成终态块，`for await` 不会抛；中间件 / 下游的抛错落在
 * `ctx.llm.stream(...)` 这个调用表达式上、根本到不了迭代，只有它走异常这一支。两类都要收，
 * 且超时按 `timeoutOf` 判在**复核自己的 signal** 上：只看异常收场，超时格会落进「不是失败」；
 * 只按 `signal.aborted` 收场，任务结束 / 任务取消的迟到失败又会盖掉 10、11 的取消记录。
 *
 * 失败 / 取消在这里落盘（一次复核最多落一条记录）；可解析的收场**不在这里落完成态**——结论与
 * 记录字段交回调用点，由它在作废判定之后落完成态或取消记录，见 `apply`。
 * @param attempt - 本次复核的全部输入。
 * @returns 完成态的结算；失败 / 取消时为 null。
 */
async function reviewOnce(attempt: ReviewAttempt): Promise<ReviewSettlement | null> {
  const { ctx, config, session, upstream, triggerStep, writeReviewRecord } = attempt
  const startedAt = Date.now()
  const snapshot = session.deriveMessages()
  const base: ReviewRecordBase = { triggerStep, config, messageIds: snapshot.map(message => message.id) }
  const fail = async (failureReason: string): Promise<void> => {
    await writeReviewRecord(session.id, {
      ...base,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      failureReason,
    })
  }

  // 「拿不到路由」（会话还没有路由信息）是防御分支：等待模式的触发点必然已写入 request/header。
  const route = session.requestHeader()?.config
  if (route === undefined) {
    await fail(NO_ROUTE)
    return null
  }

  const instruction = createUserMessage({
    content: [{ type: 'text', text: composeReviewInstruction(config.prompt) }],
    source: { kind: 'plugin', plugin: name },
  })

  const timeout = deadline(upstream, config.reviewTimeoutMs, REVIEW_TIMEOUT_CODE)
  const assembler = new BlockAssembler()
  let thrown: unknown
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      temperature: 0,
      maxTokens: config.maxOutputTokens,
      messages: [...snapshot, instruction],
      signal: timeout.signal,
    })) {
      assembler.push(chunk)
    }
  } catch (error) {
    // 中间件 / 下游抛错：在 `ctx.llm.stream(...)` 调用点就抛出，必须由结算自己收。
    thrown = error
  } finally {
    timeout[Symbol.dispose]()
  }

  if (thrown !== undefined) {
    await fail(thrown instanceof Error ? thrown.message : String(thrown))
    return null
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    // 超时才算失败；其余中止（任务结束 / 任务取消 / 插件释放）的记录归 10、11，本票不为它落失败记录，
    // 否则它们写下的取消记录会被同键的迟到失败写入覆盖。
    if (timeoutOf(timeout.signal, REVIEW_TIMEOUT_CODE) !== undefined) await fail(finish.failure.message)
    return null
  }
  if (finish.kind === 'error') {
    await fail(finish.failure.message)
    return null
  }
  const outcome = parseReviewOutcome(textOf(assembler.blocks()))
  if (outcome === null) {
    await fail(OUTPUT_UNPARSEABLE)
    return null
  }
  // 完成态不保证有 usage：流里没有 usage 块时整个字段缺省（口径见设计文档「复核记录的存放位置」）。
  return {
    outcome,
    base,
    durationMs: Date.now() - startedAt,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

/**
 * 把装配好的内容块里的正文拼起来。
 * @param blocks - `BlockAssembler.blocks()` 的结果。
 * @returns 全部文本块的正文，按块顺序。
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}
