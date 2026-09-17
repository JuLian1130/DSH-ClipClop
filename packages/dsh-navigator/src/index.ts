/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * 等待模式的「到点发起一次复核」：监听 `agent/pre-step`，到触发点时取主会话快照、按主会话继承的
 * 路由发一次辅助请求，并把收场结算成一条记录（装配输出、严格解析取结论、收用量与耗时，按终止原因
 * 分完成 / 失败）；结论为 `continue` 或复核失败时都不触碰会话。建议注入、停止说明、并行模式与失败表
 * 其余格由后续票据实现。
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import { openReviewStore, readReviewRecords, type ReviewWriter } from './records.ts'
import { composeReviewInstruction } from './review-prompt.ts'
import { advanceTriggerStep, deriveNextTriggerStep, resetTriggerStepAtUserMessage } from './trigger.ts'
import type { Config } from './types.ts'
import { parseReviewOutcome } from './verdict.ts'

export * from './types.ts'
export * from './records.ts'
export * from './replay.ts'

/** Cordis 插件名。08 的过期改写按 `source.plugin` 过滤本插件消息时复用这个值。 */
export const name = 'dsh-navigator'

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

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
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
    await reviewOnce({ ctx, config, session, upstream: signal, triggerStep, writeReviewRecord })
    return next()
  })
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
 * 三种状态按规格的记录表逐格取值；一次复核最多落一条记录。
 * @param attempt - 本次复核的全部输入。
 */
async function reviewOnce(attempt: ReviewAttempt): Promise<void> {
  const { ctx, config, session, upstream, triggerStep, writeReviewRecord } = attempt
  const startedAt = Date.now()
  const snapshot = session.deriveMessages()
  const base = { triggerStep, config, messageIds: snapshot.map(message => message.id) }
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
    return
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
    return
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    // 超时才算失败；其余中止（任务结束 / 任务取消 / 插件释放）的记录归 10、11，本票不为它落失败记录，
    // 否则它们写下的取消记录会被同键的迟到失败写入覆盖。
    if (timeoutOf(timeout.signal, REVIEW_TIMEOUT_CODE) !== undefined) await fail(finish.failure.message)
    return
  }
  if (finish.kind === 'error') {
    await fail(finish.failure.message)
    return
  }
  const outcome = parseReviewOutcome(textOf(assembler.blocks()))
  if (outcome === null) {
    await fail(OUTPUT_UNPARSEABLE)
    return
  }
  // 完成态不保证有 usage：流里没有 usage 块时整个字段缺省（口径见设计文档「复核记录的存放位置」）。
  await writeReviewRecord(session.id, {
    ...base,
    durationMs: Date.now() - startedAt,
    status: 'completed',
    verdict: outcome,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  })
}

/**
 * 把装配好的内容块里的正文拼起来。
 * @param blocks - `BlockAssembler.blocks()` 的结果。
 * @returns 全部文本块的正文，按块顺序。
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}
