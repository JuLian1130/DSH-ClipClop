/**
 * dsh-navigator 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，由 profile 的
 * `cordis.patch.yml` 按 DSH 原生插件写法装载，不实现自己的配置文件加载器。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 显式引入服务包，让本文件的 `ctx.llm` / `ctx.sessions` 类型不依赖 projection.ts 的偶然 import 链；
// 删掉这两行今天也能通过编译，保留是为了入口的类型自足（DSH 自身的插件入口也这么写）。
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection } from './projection.ts'
import type { Config } from './types.ts'

export * from './types.ts'

/** Cordis 插件名。08 的过期改写按 `source.plugin` 过滤本插件消息时复用这个值。 */
export const name = 'dsh-navigator'

/**
 * 三个必需服务。任一缺失时 Cordis 让插件停在 PENDING 而不是带着缺能力运行——`inject` 没列的服务
 * 在取用时直接抛错，所以「服务缺失时不激活」由框架兑现，缺哪个服务由 DSH 启动审计报告。
 */
export const inject = ['llm', 'sessions', 'sessionProjections']

/**
 * 注册计数投影，并检查本版要调用的两个 API 的形状。
 * @param ctx - 插件的 context；`inject` 的三个服务此时都已就绪。
 * @param config - 解析后的配置（六个字段都已落值）；配置生效于行为的各条由后续票据断言。
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
}
