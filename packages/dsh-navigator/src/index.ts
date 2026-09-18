/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * 等待模式的「到点发起一次复核」：监听 `agent/pre-step`，到触发点时取主会话快照、按主会话继承的
 * 路由发一次辅助请求，并把收场**只做分类**（装配输出、严格解析取结论、收用量与耗时，按终止原因分完成 /
 * 失败），结算数据交回调用点。**写入落在应用点**：完成态与失败都在读完未处理的消息之后再落盘，只有
 * 等待 × `failurePolicy: stop` 那一支才跑那道检查（落点、逐格分工与理由见设计文档「失败处理」的
 * 「失败结算的落点」）。复核的结论由监听器按 `verdict` 分派：`adjust` 把复核建议追加进本步的
 * `decision.messages`，`stop` 先追加停止说明再取消当前 turn；取消（没有结算）与 `continue` 都不触碰会话。
 *
 * **并行模式**（08）：到点后复核脱离本步在续体里跑，主会话照常走下一步；收场时把结论用 `agent.inject`
 * 排进待处理队列——`adjust` 与 `stop` 都只注入建议（`stop` 不取消 turn，由主会话自己决定停不停），
 * `continue` 不注入。到点时若已有复核在跑就跳过这一次，节奏仍按「触发点 + 间隔」推进。并行复核不融合
 * 本步的取消信号：步骤 / 轮次推进时 `phase.abort` 会被重建，融合会让复核被主会话的步结束掐断；复核
 * 自己的超时仍由 `reviewOnce` 的 `deadline` 保证（任务结束 / 取消的察觉归 10）。过期标注两个落点见
 * `settleParallelReview` 与 `annotatePendingSuggestions`。
 *
 * **等待期作废**（07）：等待复核期间到达的真实用户消息让本次复核作废——不注入、不追加停止说明、
 * 不停止，也不调用 `agent.cancel`（默认清空待处理队列，会把用户刚发的话丢掉）；作废只落那条取消
 * 记录（原因 `invalidated`），完成态不落盘。两条判定信号与 verdict 过滤为何只加在其中一支，见设计
 * 文档「注入与停止机制」。这条只适用等待模式：并行在途复核遇到真实用户消息不作废，处置是过期标注。
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
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import { openReviewStore, readReviewRecords, type ReviewWriter } from './records.ts'
import {
  composeAdjustNotice,
  composeStopSuggestion,
  EXPIRY_NOTE,
  name,
  noticeMessage,
  stopWithNotice,
  withExpiryNote,
} from './interventions.ts'
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
 * 注册计数投影、打开记录域、检查本版要调用的 API 形状，并在触发点发起复核（等待模式在 `pre-step`
 * 里等它收场并应用结论，并行模式把它放到续体里、收场后注入建议）。
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
  /**
   * 每个主会话当前在途的复核：值是这次复核的作废标记。每次复核新建一个单元格，逐次覆盖。
   * 它同时是在途守卫——到点时表里已有条目就跳过这一次（等待模式下 `await` 掩盖了这个需要，
   * 并行模式下复核脱离本步，没有它「同时最多一个在途复核」不成立）。
   */
  const inFlightReviews = new WeakMap<Session, InFlightReview>()

  // 唯一的 `agent/inbox/inserted` 监听器（08 的并行建议过期改写在这里追加，不另注册一份）。
  // 判别式只认真实用户消息，不放宽成「任何插入事件都作废」；只有**在途**复核会被置位——消息在
  // 触发点那次复核发起之前入队时，这里没有可作废的对象，那一格由应用点检查未处理的消息
  // （本步被 claim 的批次 ∪ `nextStep` / `nextTurn` 队列）认领。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isRealUserMessage(message)) return
    const review = inFlightReviews.get(agent.session)
    if (review !== undefined) review.invalidated = true
    // 待投递期间的过期改写（只对并行建议有实际意义）：真实用户消息到达时，把已入队、还没带标注的
    // 本插件建议补上标注。不能用步数比较代替这一落点——这一刻那条消息还没落盘，锚点还是旧值，
    // 「锚点 ≥ 触发步骤」在那个窗口里恒为假（G9 实测）。
    annotatePendingSuggestions(agent)
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
    // 已有复核在跑：跳过这一次，不排队，节奏照旧。
    if (inFlightReviews.has(session)) return next()
    // 在途登记要早于 `next()`：claim 早于 waterfall 派发，登记晚了这一段到达的消息就只剩应用点的
    // 队列那一半认领。收场之后注销。
    const review: InFlightReview = { invalidated: false }
    inFlightReviews.set(session, review)
    if (config.mode === 'parallel') {
      // 并行：复核脱离本步，先发起再取回决策，主会话照常走下一步。续体自己收异常，绝不打断主会话。
      void settleParallelReview({
        ctx,
        config,
        session,
        agent,
        triggerStep,
        writeReviewRecord,
        inFlightReviews,
      })
      return next()
    }
    let decision: PreStepDecision
    let settlement: ReviewSettlement | null
    try {
      // 先取回内层决策，再按结论追加通知：waterfall 的内层默认返回「本步被 claim 的消息 +
      // runtime-context 消息」，自造 `{ kind: 'enter', messages }` 会静默丢掉后者。
      decision = await next()
      settlement = await reviewOnce({ ctx, config, session, upstream: signal, triggerStep })
    } finally {
      inFlightReviews.delete(session)
    }
    // 取消（没有结算）不触碰会话：取消记录归 10、11。
    if (settlement === null) return decision
    // 应用点检查尚未被任何一步处理的消息（本步被 claim 的批次 ∪ `nextStep` / `nextTurn` 队列）：
    // 判定到干预之间不隔 await，所以此刻队列里剩下的就是 `cancel` 会清掉的全部。这道检查只挂在会产生
    // 干预动作的那一支——完成态按 `verdict` 过滤，失败态只在 `failurePolicy: stop` 上跑；`review.invalidated`
    // 两条路径都照读。取舍见设计文档「注入与停止机制」与「失败处理」的「失败结算的落点」。
    const unprocessed = [...messages, ...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    const intervenes = settlement.status === 'completed'
      ? settlement.outcome.verdict !== 'continue'
      : config.failurePolicy === 'stop'
    const invalidated = review.invalidated || (intervenes && unprocessed.some(isRealUserMessage))
    // 写入挪到作废判定之后：作废 / 取消时只落那条取消记录——先落完成态或失败态再同键覆盖正是 04 要避免的。
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
    if (settlement.status === 'failed') {
      // 失败 × `stop`：干预动作紧跟判定、中间不隔 await——一旦留出间隙，落在间隙里的消息就会被停止动作的
      // `cancel` 清掉。说明正文写「复核失败」（规格四格表）。
      if (config.failurePolicy === 'stop') stopWithNotice(agent, triggerStep, REVIEW_FAILED)
      await writeReviewRecord(session.id, {
        ...settlement.base,
        durationMs: settlement.durationMs,
        status: 'failed',
        failureReason: settlement.failureReason,
      })
      return decision
    }
    // 干预动作紧跟判定、中间不隔 await：一旦留出间隙，落在间隙里的消息就会被停止动作的 `cancel` 清掉。
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

/** 在途复核的作废标记：插入事件监听器置位，等待模式的应用点在收场之后读它。 */
interface InFlightReview {
  invalidated: boolean
}

/** 并行复核续体的全部输入。 */
interface ParallelAttempt {
  readonly ctx: Context
  readonly config: Required<Config>
  readonly session: Session
  /** 本步的 agent：建议用 `agent.inject` 排进待处理队列。 */
  readonly agent: Agent
  /** 这次复核的触发步骤。 */
  readonly triggerStep: number
  /** 落一条记录：本实例的 writer。 */
  readonly writeReviewRecord: ReviewWriter
  /** 在途登记表：复核一收场就注销，下一次到点才不再跳过。 */
  readonly inFlightReviews: WeakMap<Session, InFlightReview>
}

/**
 * 并行模式的复核续体：脱离本步跑完复核，收场后把结论作为建议注入待处理队列。
 *
 * 两处机制要点：
 * - **不融合本步的取消信号**（`upstream: undefined`）：步骤 / 轮次推进时 `phase.abort` 会被重建，
 *   融合会让复核被主会话的步结束掐断；复核自己的超时仍由 `reviewOnce` 里的 `deadline` 保证，
 *   任务结束 / 取消的察觉归 10。
 * - **复核一收场就注销在途登记**，不等建议注入与落记录跑完：守卫看的是「复核在跑」，否则这段收尾
 *   时间会把下一个触发点顺延。
 *
 * **并行模式没有可以回去的应用点**（那一步的 pre-step 早已返回，续体是脱离本步跑的），所以失败记录由
 * 续体自己落、一条，也不读 `review.invalidated`（并行模式不把在途到达的真实用户消息读成作废，见设计
 * 文档「失败处理」的「失败结算的落点」）。
 *
 * 过期标注的两个落点在这里只做**产生时**那个：比较锚点与触发步骤。待投递期间那个（真实用户消息
 * 在建议已入队之后才到达，这一步还没落盘、锚点未动）由 `annotatePendingSuggestions` 兜住。
 * @param attempt - 本次并行复核的全部输入。
 */
async function settleParallelReview(attempt: ParallelAttempt): Promise<void> {
  const { ctx, config, session, agent, triggerStep, writeReviewRecord, inFlightReviews } = attempt
  let settlement: ReviewSettlement | null = null
  try {
    settlement = await reviewOnce({ ctx, config, session, upstream: undefined, triggerStep })
  } catch {
    settlement = null
  }
  inFlightReviews.delete(session)
  if (settlement === null) return
  try {
    if (settlement.status === 'failed') {
      // 并行两格的失败记录由续体自己落；`failurePolicy` 在并行模式下不生效，也不注入任何消息。
      await writeReviewRecord(session.id, {
        ...settlement.base,
        durationMs: settlement.durationMs,
        status: 'failed',
        failureReason: settlement.failureReason,
      })
      return
    }
    const { outcome } = settlement
    // `continue` 不产生干预上下文，但仍要落完成态记录。
    if (outcome.verdict !== 'continue') {
      const anchorStep = ctx.sessionProjections.stateOf(session, 'navigatorSteps')?.anchorStep ?? null
      const body = outcome.verdict === 'adjust'
        ? composeAdjustNotice(triggerStep, outcome.recommendation)
        : composeStopSuggestion(triggerStep, outcome.reason, outcome.recommendation)
      agent.inject(noticeMessage(isExpired(anchorStep, triggerStep) ? withExpiryNote(body) : body))
    }
    await writeReviewRecord(session.id, {
      ...settlement.base,
      durationMs: settlement.durationMs,
      status: 'completed',
      verdict: outcome,
      ...settlement.usage === undefined ? {} : { usage: settlement.usage },
    })
  } catch {
    // 续体不打断主会话：失败记录已由本续体在上一段落盘，这里只兜收尾路径（注入建议、落完成态）上的异常。
  }
}

/**
 * 待投递期间的过期改写：真实用户消息到达时，把待处理队列里属于本插件、还没带标注的建议补上标注。
 * 遍历 `nextStep` 与 `nextTurn` 两半（`steer` 落「下一步」、`followup` 落「下一轮」），用
 * `agent.inbox.replace` 改写；必须在建议被 claim 之前完成，claim 之后正文已随消息进入请求。
 *
 * 改写**保留消息 id**：这是「同一条建议换正文」，不是换一条消息——记录与送达面按 id 认「该条建议」，
 * 换 id 会让「SDK 读到的那条消息的 id 等于我们追加时使用的 id」这条判据落空。
 * @param agent - 刚发生插入事件的 agent。
 */
function annotatePendingSuggestions(agent: Agent): void {
  for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
    if (message.source.kind !== 'plugin' || message.source.plugin !== name) continue
    const text = textOf(message.content)
    if (text.includes(EXPIRY_NOTE)) continue
    const rewritten = noticeMessage(withExpiryNote(text))
    agent.inbox.replace(message.id, freezeMessage({ ...rewritten, id: message.id }))
  }
}

/**
 * 并行建议的过期判据（产生时那一落点）：锚点已经走到触发点。
 * 「从触发点算起、到建议送达为止，主会话收到过真实用户消息」在这一刻只能这样读——锚点 ≥ 触发步骤
 * 就意味着那条消息落在触发点上或之后（相等是「正好落在触发点上」）。待投递期间到达的消息这一刻
 * 还没落盘、锚点未动，那个窗口由 `annotatePendingSuggestions` 认领。
 * @param anchorStep - 投影折叠出的锚点；还没有真实用户消息时为 null。
 * @param triggerStep - 这次复核的触发步骤。
 * @returns 产生时就该带过期标注时为 true。
 */
function isExpired(anchorStep: number | null, triggerStep: number): boolean {
  return anchorStep !== null && anchorStep >= triggerStep
}

/**
 * 真实用户消息的判别式（规格「什么算真实用户消息」）：`role === 'user' && source.kind === 'user'`。
 * 工具结果、插件写入的说明与建议、批准都不算；遇到不认识的来源一律按「不是」处理。
 * @param message - 一条插入事件、本步被 claim 的消息，或待处理队列里的消息。
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
  /**
   * 融合进复核超时的上游信号：等待模式传本步的取消信号；并行模式传 `undefined`——复核已脱离本步，
   * 它不该被步骤 / 轮次的推进掐断（见 `settleParallelReview`）。
   */
  readonly upstream: AbortSignal | undefined
  /** 这次复核的触发步骤，记录里按它归位（也是键的判别值）。 */
  readonly triggerStep: number
}

/** 一条记录里与收场状态无关的部分（完成态与失败、取消态共用）。 */
interface ReviewRecordBase {
  readonly triggerStep: number
  readonly config: Required<Config>
  /** 触发点那一刻快照里每条消息的 id，按原顺序。 */
  readonly messageIds: readonly string[]
}

/**
 * 一次复核的结算：只做分类，落盘由调用点决定（设计文档「失败处理」的「失败结算的落点」）。
 *
 * 取消（任务结束 / 任务取消 / 插件释放）没有结算——`reviewOnce` 返回 null，那些记录归 10、11。
 */
type ReviewSettlement =
  | {
    /** 解析成功的收场。 */
    readonly status: 'completed'
    /** 解析成功的结论。 */
    readonly outcome: ReviewOutcome
    /** 记录里与结论无关的部分。 */
    readonly base: ReviewRecordBase
    /** 复核耗时。 */
    readonly durationMs: number
    /** 流里出现 usage 块时的用量；没有该块时整个字段缺省。 */
    readonly usage?: TokenUsage
  }
  | {
    /** 超时 / 输出无法解析 / 拿不到路由 / 传输层抛错。 */
    readonly status: 'failed'
    /** 记进记录 `failureReason` 的那一条。 */
    readonly failureReason: string
    /** 记录里与失败原因无关的部分。 */
    readonly base: ReviewRecordBase
    /** 复核耗时。 */
    readonly durationMs: number
  }

/** 输出过不了严格解析时记进失败原因的那一条。 */
const OUTPUT_UNPARSEABLE = '复核输出无法解析'

/** 「拿不到路由」的防御分支记进失败原因的那一条。 */
const NO_ROUTE = '拿不到会话路由'

/** 等待模式 `failurePolicy: stop` 追加的停止说明里写的失败原因（规格四格表）。 */
const REVIEW_FAILED = '复核失败'

/**
 * 发起一次复核请求，并把这次复核的收场**分类**成结算数据。请求形态、模型配置继承与失败分类的机制见
 * 设计文档「辅助请求的消息构成」「模型配置继承粒度」「失败处理」。
 *
 * **这里不落盘**：完成 / 失败都只交回结算数据，由调用点在读完未处理的消息、判完作废之后再落一条记录
 * （见设计文档「失败处理」的「失败结算的落点」）。取消（非超时的中止）返回 null，不为它落记录。
 * @param attempt - 本次复核的全部输入。
 * @returns 完成 / 失败的结算；取消时为 null。
 */
async function reviewOnce(attempt: ReviewAttempt): Promise<ReviewSettlement | null> {
  const { ctx, config, session, upstream, triggerStep } = attempt
  const startedAt = Date.now()
  const snapshot = session.deriveMessages()
  const base: ReviewRecordBase = { triggerStep, config, messageIds: snapshot.map(message => message.id) }
  const failed = (failureReason: string): ReviewSettlement => ({
    status: 'failed',
    failureReason,
    base,
    durationMs: Date.now() - startedAt,
  })

  // 「拿不到路由」（会话还没有路由信息）是防御分支：等待模式的触发点必然已写入 request/header。
  const route = session.requestHeader()?.config
  if (route === undefined) return failed(NO_ROUTE)

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

  if (thrown !== undefined) return failed(thrown instanceof Error ? thrown.message : String(thrown))
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    // 超时才算失败；其余中止（任务结束 / 任务取消 / 插件释放）的记录归 10、11，本票不为它落失败记录，
    // 否则它们写下的取消记录会被同键的迟到失败写入覆盖。
    if (timeoutOf(timeout.signal, REVIEW_TIMEOUT_CODE) !== undefined) return failed(finish.failure.message)
    return null
  }
  if (finish.kind === 'error') return failed(finish.failure.message)
  const outcome = parseReviewOutcome(textOf(assembler.blocks()))
  if (outcome === null) return failed(OUTPUT_UNPARSEABLE)
  // 完成态不保证有 usage：流里没有 usage 块时整个字段缺省（口径见设计文档「复核记录的存放位置」）。
  return {
    status: 'completed',
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
