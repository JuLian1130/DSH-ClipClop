/**
 * 决策模型接入层的插件入口：把注册表挂到 `ctx.systemOne`，并把配置里的条目注册进去。
 *
 * 一个包、一个装载行。第三方 provider 用这里导出的 `SystemOneProvider` 实现自己的条目，在
 * `inject: ['systemOne']` 之后调 `ctx.systemOne.register(id, provider)` 注册进来。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { buildEntries } from './entries.ts'
import { SystemOneService } from './service.ts'

export const name = 'dsh-system-one'

/**
 * 挂服务，然后按 `entries` 建条目并注册。
 *
 * 服务**直接实例化**而不是 `ctx.plugin(SystemOneService)`：后者的 apply 不在同一 tick 里跑完，
 * 紧接着的 `register` 会撞上「服务还不存在」。`Service` 在构造函数里就把自己 provide 到传入的 ctx，
 * 生命周期跟着本插件的 fiber。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置；`entries` 是装载期读一次的 volatile 引用。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  const service = new SystemOneService(ctx)
  for (const [id, provider] of buildEntries(ctx, config.entries.get())) service.register(id, provider)
}

export * from './config.ts'
export { SystemOneProvider, type ProviderRequest } from './provider.ts'
export { SystemOneService } from './service.ts'
export type {
  Answer,
  AskRequest,
  AskResult,
  BooleanAnswer,
  ChoiceAnswer,
  JsonArray,
  JsonObject,
  JsonValue,
  Level,
  ProviderResponse,
  Question,
  ScoreAnswer,
  Usage,
  Warning,
} from './types.ts'
