/**
 * 决策模型接入层的插件入口：把注册表挂到 `ctx.systemOne`。
 *
 * 一个包、一个装载行。第三方 provider 用这里导出的 `SystemOneProvider` 实现自己的条目，在
 * `inject: ['systemOne']` 之后调 `ctx.systemOne.register(id, provider)` 注册进来。
 * @module @dsh-clipclop/dsh-system-one
 */
import type { Context } from '@deepseek-ai/cordis'
import { SystemOneService } from './service.ts'

export const name = 'dsh-system-one'

export function apply(ctx: Context): void {
  ctx.plugin(SystemOneService)
}

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
