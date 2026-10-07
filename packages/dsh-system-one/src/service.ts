import type { Context, Disposable } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SystemOneProvider } from './provider.ts'
import type { AskRequest, AskResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  /**
   * 插件面只有注册与提问。`providers()` **不在这里**：它是给设置页列候选项的只读投影，只走
   * `@Remote` 那条远程路径。它一旦出现在插件面上，业务插件就能「拿列表挑一个」，把「用哪个条目」
   * 变回隐式默认——而这件事只由调用方自己的配置回答。
   */
  interface Context {
    systemOne: Pick<SystemOneService, 'register' | 'ask'>
  }
}

/**
 * 决策模型的注册表：`register()` 收条目，`ask()` 按条目 id 把题面交给它。
 *
 * 服务里**没有**「当前 provider」这类全局状态。用哪一个由调用方（业务插件）在自己的配置里选，
 * 每次 `ask` 都点名 `target`——所以同一条目被谁用过、配错了该看哪个插件的设置，都有唯一答案。
 */
export class SystemOneService extends TypertRemoteService {
  private readonly entries = new Map<string, SystemOneProvider>()

  constructor(ctx: Context) {
    super(ctx, 'systemOne')
  }

  /**
   * 注册一个 provider 条目。
   *
   * 注册的生命周期跟着**调用方**所在的 fiber：`this.ctx` 是 cordis 的追踪上下文，解析到调用点，
   * 所以 provider 插件卸载时这条注册自动释放，服务本身不必追踪谁注册了什么。
   * @param id - 条目 id，`ask()` 的 `target` 用它指名。
   * @param provider - 该条目的实现。
   * @returns 释放这条注册的 disposer。
   * @throws 同一个 id 已注册时抛错：两个条目同名会让 `ask` 指向不确定的实现，不能静默覆盖。
   */
  register(id: string, provider: SystemOneProvider): Disposable {
    if (this.entries.has(id)) throw new Error(`system-one: provider "${id}" is already registered`)
    return this.ctx.effect(function* (this: SystemOneService) {
      this.entries.set(id, provider)
      yield () => {
        this.entries.delete(id)
      }
    }.bind(this), `systemOne.register(${id})`)
  }

  /**
   * 已注册的条目 id，按注册顺序。
   *
   * 这是给设置页列候选项用的只读投影，**不是选择机制**：消费者不按它挑 provider，用哪个由自己的
   * 配置决定。插件面据此把它挡在 `Context['systemOne']` 之外，只留远程这一条路径。
   * @returns 条目 id 的副本。
   */
  @Remote
  providers(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * 把一批题交给 `target` 指名的条目。
   * @param request - 条目 id、状态与题面。
   * @returns provider 的答案，外加服务侧测得的耗时。
   * @throws `target` 没有对应注册时抛错，消息里点名该 id 与当前已注册的 id。
   */
  async ask(request: AskRequest): Promise<AskResult> {
    const provider = this.entries.get(request.target)
    if (provider === undefined) {
      const ids = this.providers()
      const known = ids.length === 0 ? 'none' : ids.join(', ')
      throw new Error(`system-one: no provider registered as "${request.target}" (registered: ${known})`)
    }
    // provider 只该看到 `ProviderRequest`。解构出去而不是列一张字段表：`AskRequest` 以后加字段时，
    // 服务这里不会把它静默丢掉。
    const { target: _target, ...providerRequest } = request
    const started = Date.now()
    const response = await provider.evaluate(providerRequest)
    return { ...response, latencyMs: Date.now() - started }
  }
}
