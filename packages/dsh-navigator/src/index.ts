/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * 等待模式的「到点发起一次复核」：监听 `agent/pre-step`，到触发点时取主会话快照、按主会话继承的
 * 路由发一次辅助请求，并把收场**只做分类**（装配输出、严格解析取结论、收用量与耗时，按终止原因分完成 /
 * 失败），结算数据交回调用点。**写入落在应用点**：完成态与失败都在读完未处理的消息之后再落盘；那道
 * 未处理消息的检查只挂在会产生干预动作的那一支（失败态即等待 × `failurePolicy: stop`，完成态按
 * `verdict` 过滤），不产生干预动作的格不做（落点、逐格分工与理由见设计文档「失败处理」的「失败结算的
 * 落点」）。复核的结论由监听器按 `verdict` 分派：`adjust` 把复核建议追加进本步的
 * `decision.messages`，`stop` 先追加停止说明再取消当前 turn；`continue` 不触碰会话。
 *
 * **并行模式**（08）：到点后复核脱离本步在续体里跑，主会话照常走下一步；收场时把结论用 `agent.inject`
 * 排进待处理队列——`adjust` 与 `stop` 都只注入建议（`stop` 不取消 turn，由主会话自己决定停不停），
 * `continue` 不注入。到点时若已有复核在跑就跳过这一次，节奏仍按「触发点 + 间隔」推进。并行复核不融合
 * 本步的取消信号：步骤 / 轮次推进时 `phase.abort` 会被重建，融合会让复核被主会话的步结束掐断；复核
 * 自己的超时仍由 `reviewOnce` 的 `deadline` 保证。过期标注两个落点见
 * `settleParallelReview` 与 `annotatePendingSuggestions`。
 *
 * **终态取消**（10）：任务结束或任务取消时一律取消在途复核。等待模式按本步 pre-step 的 `signal.aborted`
 * 判取消（原因取闭集里的 `task-cancelled`），与结算交回的是 `null` / 完成 / 失败无关——闸门在 signal
 * 中止时只兜底放行，放行后适配器照脚本收场，只认 `settlement === null` 会把这一格落成完成态。并行模式
 * 在续体里让 `agent.whenIdle()` 与复核收场赛跑：复核收场晚于静止时按 `signal.aborted` 分「任务取消 /
 * 任务结束」，复核先收场但信号已经中止（G10 实测的时序）同样落取消记录；晚到的结算一律不注入、也不再写
 * 第二条记录。`{ kind: 'disposed' }` 是 Agent 实例释放这一条路径，不经过这里的终态分流（插件释放那条
 * 路径见下）。判据用的 `signal` 还必须跨 turn 边界的 `phase.abort` 替换仍成立，所以按会话记住最近一次
 * pre-step 的信号（见 `phaseSignals`）。
 *
 * **等待期作废**（07）：等待复核期间到达的真实用户消息让本次复核作废——不注入、不追加停止说明、
 * 不停止，也不调用 `agent.cancel`（默认清空待处理队列，会把用户刚发的话丢掉）；作废只落那条取消
 * 记录（原因 `invalidated`），完成态不落盘。两条判定信号与 verdict 过滤为何只加在其中一支，见设计
 * 文档「注入与停止机制」。这条只适用等待模式：并行在途复核遇到真实用户消息不作废，处置是过期标注。
 *
 * **插件释放**（11）：本实例的纤维释放（卸载、重挂载、`internal/update` 重启）时，在途复核一律取消
 * ——释放回调在域关闭**之前**按登记里那份记录基底落一条原因 `plugin-disposed` 的取消记录，晚到的结算
 * 不再落盘、也不再应用结论；正在等待的那一步按失败表那一格收场（`continue` 原样放行，`stop` 追加写
 * 取消原因的停止说明后停止本 turn）。释放信号来自插件自己的 fiber——卸载 navigator 不中止 agent，
 * pre-step 载荷的 `signal` 因此不会 abort（机制见设计文档「注入与停止机制」「复核记录的存放位置」）。
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
import type { Agent, AgentCancelCause, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import { openReviewStore, readReviewRecords, type ReviewCancelReason, type ReviewWriter } from './records.ts'
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
 * 本票这一格的取消原因取值：取 04 导出的闭集里的 `plugin-disposed`，`satisfies` 把它钉在闭集上，
 * 释放回调与等待步的停止说明共用这一个常量（不各写一份字面量）。
 */
const PLUGIN_DISPOSED = 'plugin-disposed' satisfies ReviewCancelReason

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
   * 每个主会话当前在途的复核，按会话 id 取键。它同时是在途守卫——到点时表里已有条目就跳过这一次
   * （等待模式下 `await` 掩盖了这个需要，并行模式下复核脱离本步，没有它「同时最多一个在途复核」不
   * 成立）；登记随复核收场注销，所以这张表同时是**释放路径的枚举面**：插件纤维释放时按键遍历，
   * 把每一条在途复核取消掉（值里的记录基底就是为这一处随登记一起可达的——`WeakMap` 遍历不了）。
   */
  const inFlightReviews = new Map<SessionId, InFlightReview>()
  /**
   * 释放回调（11）：把每一条在途复核按登记里的记录基底落成一条「取消 / `plugin-disposed`」。
   *
   * **注册必须晚于 `openReviewStore`**，写入必须**同步入队**——两件事合起来才满足设计文档
   * 「复核记录的存放位置」的「读写入口与 writer 的关闭次序」不变式②（机制与源码依据见该节）。
   * 写入失败按「无法落盘」处理，绝不打断卸载。
   * @returns 全部写入 settle 之后兑现。
   */
  const releaseInFlightReviews = (): Promise<void> => {
    const writes: Promise<void>[] = []
    for (const [sessionId, review] of inFlightReviews) {
      // 标记先置：本步的 handler 与并行的续体都按它跳过落盘与结论，基底有没有补上快照不影响这件事。
      review.released = true
      // 基底只差快照的消息 id 时（释放落在 `await next()` 期间）照落一条 `messageIds` 缺省的取消记录——
      // 记录表允许它缺省（「取到快照之前就结束则没有」）。
      writes.push(
        cancelReview(writeReviewRecord, sessionId, review.base, review.startedAt, PLUGIN_DISPOSED).catch(() => {}),
      )
    }
    inFlightReviews.clear()
    return Promise.all(writes).then(() => undefined)
  }
  ctx.effect(() => () => releaseInFlightReviews(), 'dsh-navigator.releaseInFlightReviews')

  /**
   * 每个主会话最近一次 pre-step 的取消信号（当前 turn 的控制器）。终态判据要一份跨 turn 边界仍成立的
   * 信号面：`turn()` 末尾换掉 `phase.abort` 时旧 controller 不被 abort，只取触发步捕获的那份会把跨
   * turn 的「任务取消」误记成「任务结束」（机制见设计文档「注入与停止机制」）。所以每个步边界都把它
   * 刷新成当前控制器；`phase.abort` 替换与下一个步边界之间的同步交接窗口不经过 pre-step，这一段按设计
   * 文档允许的「只覆盖同一次驱动」边界写明，不另立信号面。
   */
  const phaseSignals = new WeakMap<Session, AbortSignal>()

  // 唯一的 `agent/inbox/inserted` 监听器（08 的并行建议过期改写在这里追加，不另注册一份）。
  // 判别式只认真实用户消息，不放宽成「任何插入事件都作废」；只有**在途**复核会被置位——消息在
  // 触发点那次复核发起之前入队时，这里没有可作废的对象，那一格由应用点检查未处理的消息
  // （本步被 claim 的批次 ∪ `nextStep` / `nextTurn` 队列）认领。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isRealUserMessage(message)) return
    const review = inFlightReviews.get(agent.session.id)
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
    // 终态判据的信号面：每个步边界都刷新成当前 turn 的控制器（理由见 `phaseSignals`）。
    phaseSignals.set(session, signal)
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
    if (inFlightReviews.has(session.id)) return next()
    // 在途登记要早于 `next()`：claim 早于 waterfall 派发，登记晚了这一段到达的消息就只剩应用点的
    // 队列那一半认领。收场之后注销。触发步骤与配置快照在登记这一刻冻结（释放因此能在 `next()` 期间
    // 就落一条 `messageIds` 缺省的取消记录），快照的消息 id 之后由 `reviewPoint` 填进同一份基底。
    const review: InFlightReview = {
      invalidated: false,
      released: false,
      base: { triggerStep, config },
      startedAt: Date.now(),
    }
    inFlightReviews.set(session.id, review)
    if (config.mode === 'parallel') {
      // 记录基底与计时起点在触发点冻结：完成 / 失败 / 取消三条写入路径共用它；并行这一支没有可回去的
      // 应用点，终态取消要在复核收场之前落记录，所以在这里取（见 `ReviewPoint`）。
      // 并行：复核脱离本步，先发起再取回决策，主会话照常走下一步。续体自己收异常，绝不打断主会话。
      const point = reviewPoint(session, review)
      void settleParallelReview({
        ctx,
        session,
        agent,
        writeReviewRecord,
        inFlightReviews,
        phaseSignals,
        review,
        point,
      })
      return next()
    }
    let decision: PreStepDecision
    let settlement: ReviewSettlement | null
    let point: ReviewPoint
    try {
      // 先取回内层决策，再按结论追加通知：waterfall 的内层默认返回「本步被 claim 的消息 +
      // runtime-context 消息」，自造 `{ kind: 'enter', messages }` 会静默丢掉后者。
      decision = await next()
      // 快照在触发点冻结；落在 `next()` 之后，与 03 起取快照的时刻一致——内层 handler 若在这一步追加
      // 了会话内容，快照仍照规格「等于那一刻主会话对模型可见的完整上下文」。
      point = reviewPoint(session, review)
      settlement = await reviewOnce({ ctx, session, upstream: signal, point })
    } finally {
      inFlightReviews.delete(session.id)
    }
    // 尚未被任何一步处理的消息（本步被 claim 的批次 ∪ `nextStep` / `nextTurn` 队列）：凡会产生干预动作
    // 的支路都先查它（规格「等待模式下注入建议、追加停止说明或停止 turn 之前——包括失败策略触发的
    // 停止」）。判定到干预之间不隔 await，所以此刻队列里剩下的就是 `cancel` 会清掉的全部。
    const unprocessed = [...messages, ...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    // 插件释放（11）：释放回调已经在域关闭之前按登记里的基底落过取消记录，晚到的这次结算不再落盘、
    // 也不再应用结论。正在等待的这一步只取失败表那一格的干预动作——`continue` 原样放行，`stop`
    // 追加停止说明后停止本 turn，说明正文写的是取消原因而不是「复核失败」。**停止前那道检查照跑**：
    // 命中就作废、不追加说明、不停止，释放回调落下的那条取消记录就是这一格的记录（不再写第二条）。
    if (review.released) {
      if (config.failurePolicy === 'stop' && !review.invalidated && !unprocessed.some(isRealUserMessage)) {
        stopWithNotice(agent, triggerStep, PLUGIN_DISPOSED)
      }
      return decision
    }
    // 任务取消（用户停止或进程退出）：本步 pre-step 的 signal 被中止就是终态取消；判据只看 signal，
    // 与结算交回的是 null / 完成 / 失败无关。也不调用 `agent.cancel`——它默认清空待处理队列，会把
    // 用户刚发的话一起丢掉（终态取消同理）。
    if (signal.aborted) {
      await cancelTerminalReview(writeReviewRecord, session.id, point.base, point.startedAt, signal)
      return decision
    }
    if (settlement === null) return decision
    // 完成态按 `verdict` 过滤、失败态只在 `failurePolicy: stop` 上跑；`review.invalidated` 两条路径都
    // 照读。取舍见设计文档「注入与停止机制」与「失败处理」的「失败结算的落点」。
    const intervenes = settlement.status === 'completed'
      ? settlement.outcome.verdict !== 'continue'
      : config.failurePolicy === 'stop'
    const invalidated = review.invalidated || (intervenes && unprocessed.some(isRealUserMessage))
    // 写入挪到作废判定之后：作废 / 取消时只落那条取消记录——先落完成态或失败态再同键覆盖正是 04 要避免的。
    if (invalidated) {
      await cancelReview(writeReviewRecord, session.id, point.base, point.startedAt, 'invalidated')
      return decision
    }
    if (settlement.status === 'failed') {
      // 失败 × `stop`：干预动作紧跟判定、中间不隔 await——一旦留出间隙，落在间隙里的消息就会被停止动作的
      // `cancel` 清掉。说明正文写「复核失败」（规格四格表）。
      if (config.failurePolicy === 'stop') stopWithNotice(agent, triggerStep, REVIEW_FAILED)
      await writeReviewRecord(session.id, {
        ...point.base,
        durationMs: Date.now() - point.startedAt,
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
      ...point.base,
      durationMs: Date.now() - point.startedAt,
      status: 'completed',
      verdict: settlement.outcome,
      ...settlement.usage === undefined ? {} : { usage: settlement.usage },
    })
    return decision
  })
}

/** 在途复核的登记：作废标记、释放标记，加上释放路径落取消记录要用的记录基底。 */
interface InFlightReview {
  /** 插入事件监听器置位（真实用户消息在复核在途时到达），等待模式的应用点在收场之后读它。 */
  invalidated: boolean
  /** 释放回调置位：释放路径已经落过取消记录，晚到的结算不再落盘、也不再应用结论。 */
  released: boolean
  /**
   * 触发点冻结的记录基底与计时起点，完成 / 失败 / 取消三条写入路径共用；触发步骤与配置快照在登记时
   * 就有，快照的消息 id 要等 `next()` 之后由 `reviewPoint` 填进同一个对象。
   */
  readonly base: ReviewRecordBase
  /** 计时起点：登记的这一刻（即触发点）。 */
  readonly startedAt: number
}

/** 并行复核续体的全部输入。 */
interface ParallelAttempt {
  readonly ctx: Context
  readonly session: Session
  /** 本步的 agent：建议用 `agent.inject` 排进待处理队列，终态察觉用 `agent.whenIdle()`。 */
  readonly agent: Agent
  /** 落一条记录：本实例的 writer。 */
  readonly writeReviewRecord: ReviewWriter
  /** 在途登记表：复核一收场就注销，下一次到点才不再跳过。 */
  readonly inFlightReviews: Map<SessionId, InFlightReview>
  /** 这次复核自己的在途登记：注销时按身份核对，晚到的收场不删新一代的登记。 */
  readonly review: InFlightReview
  /** 每个会话最近一次 pre-step 的取消信号：终态原因按它分「任务结束 / 任务取消」。 */
  readonly phaseSignals: WeakMap<Session, AbortSignal>
  /** 触发点冻结的记录基底与计时起点：终态取消在复核还没收场时就要用它落记录。 */
  readonly point: ReviewPoint
}

/** 并行终态察觉的赛跑结果：复核收场（可能带结算）或整个 agent 静止。 */
type ParallelRace =
  | { readonly kind: 'settled'; readonly settlement: ReviewSettlement | null }
  | { readonly kind: 'idle' }

/**
 * 并行模式的复核续体：脱离本步跑完复核，收场后把结论作为建议注入待处理队列。
 *
 * 三处机制要点：
 * - **不融合本步的取消信号**（`upstream: undefined`）：步骤 / 轮次推进时 `phase.abort` 会被重建，
 *   融合会让复核被主会话的步结束掐断；复核自己的超时仍由 `reviewOnce` 里的 `deadline` 保证。
 * - **终态察觉**：`agent.whenIdle()` 与复核收场赛跑。`whenIdle()` 兑现即整个 agent 静止——任务正常
 *   收尾，或取消后收敛到静止；此时按 `phaseSignals` 里那份 signal 的 `aborted` / `reason` 分「任务
 *   结束」与「任务取消」。不能按「谁先到」分原因：任务取消总是先 abort signal，而复核请求什么时刻
 *   收场由传输层决定（G10 实测：abort 后 0ms 结算时复核先到、30ms 时 `whenIdle()` 先到）。复核先收场
 *   但 signal 已经中止的那一序同样是「在途被取消」，也按取消处置。终态取消之后本函数已经返回，晚到的
 *   结算不注入、也不再写第二条记录。
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
  const { ctx, session, agent, writeReviewRecord, inFlightReviews, phaseSignals, review, point } = attempt
  /**
   * 注销在途登记——只在它仍指向**这次**复核时。任务结束 / 任务取消那次复核可能还挂在自己的超时上，
   * 它晚到的收场绝不能删掉此后新一代复核的登记：删掉守卫就失效，同一会话会跑出两个复核。
   */
  const releaseInFlight = (): void => {
    if (inFlightReviews.get(session.id) === review) inFlightReviews.delete(session.id)
  }
  // 复核收场承诺：结算交回这一次 race；一收场就注销在途登记（不等下面的建议注入与落记录）。
  const reviewOutcome = reviewOnce({ ctx, session, upstream: undefined, point }).then(
    (settlement): ParallelRace => ({ kind: 'settled', settlement }),
    (): ParallelRace => ({ kind: 'settled', settlement: null }),
  ).finally(releaseInFlight)
  try {
    const winner = await Promise.race([
      reviewOutcome,
      agent.whenIdle().then((): ParallelRace => ({ kind: 'idle' })),
    ])
    // 插件释放（11）：释放回调已经在域关闭之前落过取消记录，晚到的这次结算不再落盘、也不注入建议
    // （放在下面各分支之前——释放与 `whenIdle()` 谁先兑现不做约定，晚到的那一序同样不许再写一条）。
    if (review.released) return
    const signal = phaseSignals.get(session)
    const aborted = signal?.aborted === true
    if (winner.kind === 'settled' && aborted) {
      // 复核先收场、取消信号也已经中止（G10 实测：abort 后 0ms 结算是复核先到）：这次复核同样是在途
      // 被取消，按终态落取消记录，不注入、也不落完成 / 失败记录。
      await cancelTerminalReview(writeReviewRecord, session.id, point.base, point.startedAt, signal)
      return
    }
    if (winner.kind === 'idle') {
      // 终态：复核还在途就等到了整个 agent 静止。先注销在途登记（这次复核已经作废，不该继续挡住后续
      // 触发），再按信号落「任务取消 / 任务结束」。
      releaseInFlight()
      await cancelTerminalReview(writeReviewRecord, session.id, point.base, point.startedAt, signal)
      return
    }
    const { settlement } = winner
    if (settlement === null) return
    if (settlement.status === 'failed') {
      // 并行两格的失败记录由续体自己落；`failurePolicy` 在并行模式下不生效，也不注入任何消息。
      await writeReviewRecord(session.id, {
        ...point.base,
        durationMs: Date.now() - point.startedAt,
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
        ? composeAdjustNotice(point.base.triggerStep, outcome.recommendation)
        : composeStopSuggestion(point.base.triggerStep, outcome.reason, outcome.recommendation)
      agent.inject(noticeMessage(isExpired(anchorStep, point.base.triggerStep) ? withExpiryNote(body) : body))
    }
    await writeReviewRecord(session.id, {
      ...point.base,
      durationMs: Date.now() - point.startedAt,
      status: 'completed',
      verdict: outcome,
      ...settlement.usage === undefined ? {} : { usage: settlement.usage },
    })
  } catch {
    // 续体不打断主会话：收尾路径（落取消 / 失败记录、注入建议、落完成态）上的异常一律吞掉；写入失败
    // 本身的处置归 04 的 writer 契约。
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
  readonly session: Session
  /**
   * 融合进复核超时的上游信号：等待模式传本步的取消信号；并行模式传 `undefined`——复核已脱离本步，
   * 它不该被步骤 / 轮次的推进掐断（见 `settleParallelReview`）。
   */
  readonly upstream: AbortSignal | undefined
  /** 触发点冻结的记录基底与计时起点（也是键的判别值）。 */
  readonly point: ReviewPoint
}

/** 一条记录里与收场状态无关的部分（完成、失败、取消三态共用）。 */
interface ReviewRecordBase {
  readonly triggerStep: number
  readonly config: Required<Config>
  /** 触发点那一刻快照里每条消息的 id，按原顺序；取到快照之前就结束则整个字段缺省。 */
  messageIds?: readonly string[]
}

/** 一次复核在触发点冻结的部分：记录基底与快照、计时起点；完成、失败、取消三条写入路径共用。 */
interface ReviewPoint {
  /** 记录里与收场状态无关的部分（登记那一刻建好，取快照时补上消息 id）。 */
  readonly base: ReviewRecordBase
  /** 触发点那一刻的模型可见消息快照，复核请求按它原样发送；落在 `next()` 之后取。 */
  readonly snapshot: readonly Message[]
  /** 计时起点：登记那一刻（即触发点）；记录的耗时按「写入那一刻 − 它」算。 */
  readonly startedAt: number
}

/**
 * 在触发点取一次复核的快照，并把消息 id 填进这次复核登记里那份记录基底（规格「快照在触发点取一次」）。
 *
 * 基底在登记那一刻就建好、由 `reviewPoint` 补上快照那一半，三条写入路径因此共用同一个对象：释放路径
 * 在 `next()` 期间就要落记录，那时快照还没取到，记的是一条 `messageIds` 缺省的取消记录。
 * @param session - 主会话。
 * @param review - 这次复核的登记。
 * @returns 记录基底、快照与计时起点。
 */
function reviewPoint(session: Session, review: InFlightReview): ReviewPoint {
  const snapshot = session.deriveMessages()
  review.base.messageIds = snapshot.map(message => message.id)
  return { base: review.base, snapshot, startedAt: review.startedAt }
}

/**
 * 取消的唯一入口：经 04 的写入入口落一条状态为「取消」的记录。07 的作废路径、10 的终态路径与 11 的
 * 释放路径共用这一次写入（各自的触发点不同）；取消态不带结论与失败原因（规格「记录与诊断」的取消列）。
 * @param writeReviewRecord - 本实例的 writer（04 的写入入口）。
 * @param sessionId - 记录归属的会话。
 * @param base - 触发点冻结的记录基底。
 * @param startedAt - 计时起点。
 * @param cancelReason - 取消原因，取 04 导出的闭集取值。
 */
async function cancelReview(
  writeReviewRecord: ReviewWriter,
  sessionId: SessionId,
  base: ReviewRecordBase,
  startedAt: number,
  cancelReason: ReviewCancelReason,
): Promise<void> {
  await writeReviewRecord(sessionId, {
    ...base,
    durationMs: Date.now() - startedAt,
    status: 'cancelled',
    cancelReason,
  })
}

/**
 * 终态取消：按本步 pre-step 的取消信号落一条取消记录——已中止就是「任务取消」，否则是「任务结束」。
 * `{ kind: 'disposed' }` 是 Agent 实例释放这一条路径，不在这里落记录（插件重载 / 卸载那条释放路径
 * 由本实例的释放回调收口，见 `releaseInFlightReviews`）。三个终态触发点（等待模式的 signal 中止、
 * 并行续体的复核先收场与 `whenIdle()` 先兑现两臂）共用这一条判据。
 * @param writeReviewRecord - 本实例的 writer（04 的写入入口）。
 * @param sessionId - 记录归属的会话。
 * @param base - 触发点冻结的记录基底。
 * @param startedAt - 计时起点。
 * @param signal - 该会话最近一次 pre-step 的取消信号。
 */
async function cancelTerminalReview(
  writeReviewRecord: ReviewWriter,
  sessionId: SessionId,
  base: ReviewRecordBase,
  startedAt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted !== true) {
    await cancelReview(writeReviewRecord, sessionId, base, startedAt, 'task-ended')
    return
  }
  if (isDisposed(signal.reason)) return
  await cancelReview(writeReviewRecord, sessionId, base, startedAt, 'task-cancelled')
}

/**
 * `signal.reason` 是不是 Agent 实例释放（`{ kind: 'disposed' }`）。那条 abort 不由插件释放触发——
 * 卸载 navigator 自己的 fiber 不中止 agent，pre-step 载荷的 `signal` 因此不会 abort、也没有
 * `reason.kind === 'disposed'` 可读；插件释放由本实例的释放回调察觉并收口。
 * @param reason - `AbortSignal.reason`。
 * @returns 是 Agent 实例释放时为 true。
 */
function isDisposed(reason: unknown): boolean {
  return (reason as AgentCancelCause | undefined)?.kind === 'disposed'
}

/**
 * 一次复核的结算：只做分类，落盘由调用点决定（设计文档「失败处理」的「失败结算的落点」）。
 *
 * 记录基底与耗时由调用点在触发点冻结、写入时按它取（见 `ReviewPoint`）。取消（非超时的中止）没有
 * 结算——`reviewOnce` 返回 null，终态取消的记录由调用点按 signal / `whenIdle()` 落（归 10、11）。
 */
type ReviewSettlement =
  | {
    /** 解析成功的收场。 */
    readonly status: 'completed'
    /** 解析成功的结论。 */
    readonly outcome: ReviewOutcome
    /** 流里出现 usage 块时的用量；没有该块时整个字段缺省。 */
    readonly usage?: TokenUsage
  }
  | {
    /** 超时 / 输出无法解析 / 拿不到路由 / 传输层抛错。 */
    readonly status: 'failed'
    /** 记进记录 `failureReason` 的那一条。 */
    readonly failureReason: string
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
 * （见设计文档「失败处理」的「失败结算的落点」）。取消（非超时的中止）返回 null，不为它落记录——终态
 * 取消的记录由调用点按 signal / `whenIdle()` 落。
 * @param attempt - 本次复核的全部输入。
 * @returns 完成 / 失败的结算；取消时为 null。
 */
async function reviewOnce(attempt: ReviewAttempt): Promise<ReviewSettlement | null> {
  const { ctx, session, upstream, point } = attempt
  const { config } = point.base
  const failed = (failureReason: string): ReviewSettlement => ({ status: 'failed', failureReason })

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
      messages: [...point.snapshot, instruction],
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
    // 超时才算失败；其余中止（任务结束 / 任务取消 / 插件释放）没有结算，本票不为它落失败记录，
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
