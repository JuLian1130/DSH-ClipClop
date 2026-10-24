/**
 * 决策模型接入层的插件入口：把注册表挂到 `ctx.systemOne`，并把配置里的条目注册进去。
 *
 * 一个包、一个装载行。第三方 provider 用这里导出的 `SystemOneProvider` 实现自己的条目，在
 * `inject: ['systemOne']` 之后调 `ctx.systemOne.register(id, provider)` 注册进来。
 *
 * `entries` 是 volatile 配置：设置页写回后，loader 把新值提交进本插件运行中的 fiber，并只向本 fiber 派发
 * `loader/volatile-update`。监听器据此重读配置、整批替换自己那批注册——增删改条目都不需要重载插件。
 * @module
 */
import type { Context, Disposable } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Config } from './config.ts'
import { buildEntries } from './entries.ts'
import { SystemOneService } from './service.ts'

export const name = 'dsh-system-one'

/**
 * 挂服务，按 `entries` 建条目并注册，之后跟着 volatile 更新整批替换。
 *
 * 服务**直接实例化**而不是 `ctx.plugin(SystemOneService)`：后者的 apply 不在同一 tick 里跑完，
 * 紧接着的 `register` 会撞上「服务还不存在」。`Service` 在构造函数里就把自己 provide 到传入的 ctx，
 * 生命周期跟着本插件的 fiber。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置；`entries` 是 volatile 引用，每次更新后重读。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  const service = new SystemOneService(ctx)
  /** 本插件自己那批注册：替换时整批换掉，`ask` 要么看到旧的、要么看到新的。 */
  let registered = new Map<string, Disposable>()

  /**
   * 按当前配置重建并替换自己那批注册。
   *
   * 新一批 provider 全部建好（`buildEntries` 在这里校验重复 id）并确认 id 没被其它插件占用之后才动旧
   * 注册：中途抛错时旧注册原样留着，不会留下半新半旧的注册表。
   * @throws 配置非法（如 id 重复），或某个 id 已被其它插件注册。
   */
  const reload = (): void => {
    const entries = buildEntries(ctx, config.entries.get())
    // 预检赶在 dispose 之前：自己的 id 会被换掉，不算冲突；别人的 id 现在让不出来。
    const foreign = new Set(service.providers().filter((id) => !registered.has(id)))
    for (const [id] of entries) {
      if (foreign.has(id)) throw new Error(`system-one: provider "${id}" is already registered by another plugin`)
    }
    for (const dispose of registered.values()) dispose()
    const next = new Map<string, Disposable>()
    for (const [id, provider] of entries) next.set(id, service.register(id, provider))
    registered = next
  }

  ctx.effect(function* () {
    yield () => {
      for (const dispose of registered.values()) dispose()
      registered.clear()
    }
    yield ctx.on('loader/volatile-update', () => {
      try {
        reload()
      } catch (error) {
        // 新值已经提交进 fiber，撤不回来；旧注册表继续服务，错误写进日志让人能定位。
        ctx.logger.error('system-one: entries update could not be applied, keeping the previous registrations')
        ctx.logger.error(error)
      }
    })
    reload()
  }, 'systemOne.entries')
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
