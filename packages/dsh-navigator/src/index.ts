/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * 等待模式的「到点发起一次复核」：监听 `agent/pre-step`，到触发点时取主会话快照、按主会话继承的
 * 路由发一次辅助请求；结论为 `continue` 或复核失败时都不触碰会话。输出的严格解析、记录、建议注入、
 * 停止说明、并行模式与失败表其余格由后续票据实现。
 *
 * 主会话取自 pre-step 载荷的 `agent.session`，不经 `ctx.sessions.get`；`ctx.sessions.get` 的函数
 * 检查仍保留，它只服务激活门禁。取法、理由与那条检查为何不删，见设计文档「范围与约束」。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import { composeReviewInstruction } from './review-prompt.ts'
import { advanceTriggerStep, deriveNextTriggerStep } from './trigger.ts'
import type { Config } from './types.ts'

export * from './types.ts'

/** Cordis 插件名。08 的过期改写按 `source.plugin` 过滤本插件消息时复用这个值。 */
export const name = 'dsh-navigator'

/**
 * 三个必需服务。任一缺失时 Cordis 让插件停在 PENDING 而不是带着缺能力运行——`inject` 没列的服务
 * 在取用时直接抛错，所以「服务缺失时不激活」由框架兑现，缺哪个服务由 DSH 启动审计报告。
 *
 * 监听 `agent/pre-step` 不需要额外服务——机制、源码依据与先例见设计文档「范围与约束」。
 */
export const inject = ['llm', 'sessions', 'sessionProjections']

/** 复核超时的取消代码，写进 `deadline` 的 `TimeoutReason`。 */
const REVIEW_TIMEOUT_CODE = 'NAVIGATOR_REVIEW_TIMEOUT'

/**
 * 注册计数投影、检查本版要调用的 API 形状，并在触发点发起等待模式复核。
 * @param ctx - 插件的 context；`inject` 的三个服务此时都已就绪。
 * @param config - 解析后的配置（六个字段都已落值）。
 * @throws 当 `ctx.llm.stream` 或 `ctx.sessions.get` 不存在或不是函数时，错误信息点名缺的那个。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  if (typeof ctx.llm.stream !== 'function') {
    throw new Error('dsh-navigator requires ctx.llm.stream to be a function')
  }
  if (typeof ctx.sessions.get !== 'function') {
    throw new Error('dsh-navigator requires ctx.sessions.get to be a function')
  }
  ctx.sessionProjections.register(navigatorStepsProjection)

  /** 每个主会话的下一次触发点（已完成步数）。按 `Session` 弱引用持有，重新观察时重新推导。 */
  const triggerSteps = new WeakMap<Session, number>()

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const { session } = agent
    const observed = ctx.sessionProjections.stateOf(session, 'navigatorSteps')
    let triggerStep = triggerSteps.get(session)
    if (triggerStep === undefined) {
      // 第一次取得主会话：能力缺失在这里直接报错，当前 turn 以 error 收尾。检查必须落在第一次
      // pre-step——loop 自己对这些方法的调用都在 pre-step 之后，拖到第一个触发点就轮不到插件点名。
      assertSessionMethods(session)
      // 首次观察还没有复核记录（04 才有），三项里只有锚点与当前步数。
      triggerStep = deriveNextTriggerStep({
        lastReviewStep: null,
        anchorStep: observed?.anchorStep ?? null,
        currentSteps: observed?.steps ?? 0,
        everySteps: config.triggerEverySteps,
      })
      triggerSteps.set(session, triggerStep)
    }
    if ((observed?.steps ?? 0) < triggerStep) return next()
    // 到点。节奏只按「触发点 + 间隔」推进：不重新计时、不顺延、也不补打。
    triggerSteps.set(session, advanceTriggerStep(triggerStep, config.triggerEverySteps))
    await reviewOnce(ctx, config, session, signal)
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

/**
 * 发起一次复核请求。
 *
 * 请求形态按设计文档的「辅助请求的消息构成」「模型配置继承粒度」：触发点取一次的主会话快照
 * **原样**加末尾一条 user 消息；继承主会话的服务商、模型与推理强度，温度固定 0，上限用
 * `maxOutputTokens`；不设 `system`、不传 `tools`。超时用 `deadline(reviewTimeoutMs)`，不重试。
 *
 * 本票不读复核的输出，也不按结论分支：`continue`、`adjust`/`stop` 与复核失败（超时、输出无法
 * 解析、传输层抛错、拿不到路由）在这一步都只等于「不触碰会话」——三类结论的干预归 06、记录归 04。
 * @param ctx - 提供 `ctx.llm` 的 context。
 * @param config - 触发那一刻的配置。
 * @param session - 主会话：快照与路由的来源。
 * @param upstream - 本步的取消信号，与复核超时融合。
 */
async function reviewOnce(
  ctx: Context,
  config: Required<Config>,
  session: Session,
  upstream: AbortSignal,
): Promise<void> {
  // 「拿不到路由」（会话还没有路由信息）是防御分支：等待模式的触发点必然已写入 request/header。
  const route = session.requestHeader()?.config
  if (route === undefined) return

  const instruction = createUserMessage({
    content: [{ type: 'text', text: composeReviewInstruction(config.prompt) }],
    source: { kind: 'plugin', plugin: name },
  })

  const timeout = deadline(upstream, config.reviewTimeoutMs, REVIEW_TIMEOUT_CODE)
  try {
    for await (const _chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      temperature: 0,
      maxTokens: config.maxOutputTokens,
      messages: [...session.deriveMessages(), instruction],
      signal: timeout.signal,
    })) {
      // 消费整条流就是「等这次复核收场」；内容本票不读，超时由 `deadline` 中止 signal 收场。
    }
  } catch {
    // 传输层抛错（中间件、嵌套调用）按复核失败处理，不打断主会话。
  } finally {
    timeout[Symbol.dispose]()
  }
}
