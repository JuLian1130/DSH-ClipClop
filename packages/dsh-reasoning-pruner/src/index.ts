/**
 * dsh-reasoning-pruner 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生
 * 插件写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本票只交付基座（资格判定、裁剪算子、投影、配置），**不接任何激活点**：装载后唯一的动作是为承载类型
 * 注册消息投影，因此单独 demo 不出用户可见的裁剪行为。触发、落盘与命令入口在后续票据里追加。
 *
 * 注册投影有一条不可避免的代价，记在这里以免被当成缺陷：投影命中就推进 `contentGeneration`
 * （与投影返回什么无关），而承载类型是宿主自己也在写的类型，所以**宿主每产生一条该类型事件**，下一步
 * 请求都会落一条 `request/header`（`reason: 'series'` 或 `change` + `startsSeries`）并重置工具基线。
 * 机制、量级与观察面见设计文档「注意投影拦截的副作用」。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 显式引入服务包，让本文件的 `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链。
import type {} from '@deepseek-ai/dsh-session'
import { reasoningPrunerProjection } from './projection.ts'
import type { Config } from './types.ts'

export * from './types.ts'
export * from './replay.ts'
export * from './projection.ts'

export const name = 'dsh-reasoning-pruner'

/**
 * 消息投影注册所需的唯一服务。后续票据只**追加**自己需要的服务，不改本票已定的这一项。
 */
export const inject = ['sessions']

/**
 * 校验配置并注册裁剪投影。
 *
 * 这里重复一次配置边界（与 `Config` schema 同一套）：schema 只在装载路径上生效，绕过 loader 直接调用
 * `apply` 的路径同样必须大声失败，不做静默回退。
 * @param ctx - 插件的 context；`sessions` 已就绪。
 * @param config - 解析后的配置。
 * @throws 配置越界时，错误信息点名越界的字段与取值。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  assertConfig(config)
  ctx.sessions.registerMessageProjection(reasoningPrunerProjection)
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
