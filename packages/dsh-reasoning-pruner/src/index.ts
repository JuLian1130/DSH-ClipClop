/**
 * dsh-reasoning-pruner 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生
 * 插件写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本插件当前交付 01（基座）、02（落盘通路与投影消费）、03（激活点②：按步数节流批量推进）与 05（激活
 * 点①：溢出救援）。装载后的动作是三件：为承载类型注册消息投影，在 `agent/pre-step` 上按**会话级步数**
 * （日志里的 `step/start` 条数，不是载荷 `step`——后者每 turn 从 1 重数）的 `M` 的整数倍推进一次裁剪
 * 边界，以及在 `agent/request-error` 上对 `CONTEXT_WINDOW_EXCEEDED` 做一次溢出救援。④（命令与开关）在
 * 后续票据里追加。
 *
 * 注册投影有一条不可避免的代价，记在这里以免被当成缺陷：投影命中就推进 `contentGeneration`
 * （与投影返回什么无关），而承载类型是宿主自己也在写的类型，所以**宿主每产生一条该类型事件**，下一步
 * 请求都会落一条 `request/header`（`reason: 'series'` 或 `change` + `startsSeries`）并重置工具基线。
 * 机制、量级与观察面见设计文档「注意投影拦截的副作用」。
 *
 * **裁剪不降低 `tokenMeter.measure()` 的读数**：计量器按原始表面事件定价、不读投影，表现是「省了钱、
 * 界面上的上下文占比不动」。② 的节奏因此只能由本插件自己的步数口径决定，见 `pruneAtStepBoundary`。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
// 显式引入服务包，让本文件的 `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链。
import type {} from '@deepseek-ai/dsh-session'
import { pruneAtRequestError, pruneAtStepBoundary } from './persist.ts'
import { reasoningPrunerProjection } from './projection.ts'
import type { Config } from './types.ts'

export * from './types.ts'
export * from './replay.ts'
export * from './projection.ts'
export * from './persist.ts'

export const name = 'dsh-reasoning-pruner'

/**
 * 消息投影注册与步进触发所需的唯一服务。后续票据只**追加**自己需要的服务，不改本票已定的这一项。
 */
export const inject = ['sessions']

/**
 * 校验配置、注册裁剪投影，并把 ② 挂到 `agent/pre-step` 上。
 *
 * `prepend` 是这条判据的全部内容：裁剪必须在 compaction-basic 自己测量/选区**之前**落盘，否则被裁的
 * 区间可能已经被摘要遮蔽。`{ prepend: true }` 走 `unshift`（`vendor/cordis/src/events.ts:255`）。
 *
 * 三处挂点都复用同一套选区与写入（`persist.ts`），配置边界在这里重复一次（与 `Config` schema 同一套）：
 * schema 只在装载路径上生效，绕过 loader 直接调用 `apply` 的路径同样必须大声失败，不做静默回退。
 * @param ctx - 插件的 context；`sessions` 已就绪。
 * @param config - 解析后的配置。
 * @throws 配置越界时，错误信息点名越界的字段与取值。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  assertConfig(config)
  ctx.sessions.registerMessageProjection(reasoningPrunerProjection)
  // 这一步就是 ② 的全部行为。**不对称地对待失败**：写入侧的校验是提交前的，坏 payload 会让 `append`
  // 当场抛，所以失败是响亮且不留坏记录的；这里**不**把它降级成日志——静默吞掉会让「重复声明同一批」这类
  // 不变量破坏变成一行 warn（02 第 5 条与 03 第 6 条的判据都建在「它必须响亮」上）。
  // 载荷 `step` 不参与判据：它每 turn 从 1 重数，节流用的是日志派生的会话级步号（见 `pruneAtStepBoundary`）。
  ctx.on('agent/pre-step', ({ agent, signal }, next): Promise<PreStepDecision> => {
    pruneAtStepBoundary(agent.session, signal, config)
    return next()
  }, { prepend: true })
  // ①：溢出救援。同样 `prepend`——裁剪必须在 compaction-basic 测量/选区之前落盘，否则被裁区间可能已被
  // 它的摘要遮蔽。这里**只落盘、不返回 `{kind:'retry'}`**（委托 `next()`）：裁剪只推进
  // `contentGeneration`，compaction-basic 的重试凭证是 `replaceGeneration`，所以它看不到我们的裁剪、
  // 也不会因此重试；自持重试需要自带一个有界计数，首版不做（见设计文档「激活点 ①：溢出救援」）。
  ctx.on('agent/request-error', ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) pruneAtRequestError(agent.session, signal, config)
    return next()
  }, { prepend: true })
}

/**
 * `Config` schema 边界的运行期副本（直接调用 `apply` 时用）。
 * @param config - 待校验的配置。
 * @throws 字段不是整数或越界时。
 */
function assertConfig(config: Required<Config>): void {
  if (!Number.isSafeInteger(config.everySteps) || config.everySteps < 1) {
    throw new Error(`dsh-reasoning-pruner: everySteps must be an integer >= 1, got ${String(config.everySteps)}`)
  }
  if (!Number.isSafeInteger(config.keepRecentSteps) || config.keepRecentSteps < 0) {
    throw new Error(`dsh-reasoning-pruner: keepRecentSteps must be an integer >= 0, got ${String(config.keepRecentSteps)}`)
  }
}
