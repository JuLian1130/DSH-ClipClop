import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import type { SystemOneProvider } from './provider.ts'
import type { AskRequest, AskResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  /**
   * 插件面只有注册与提问。`providers()` **不在这里**：它一旦出现在插件面上，业务插件最省事的写法
   * 就是「拿列表挑一个」，把「用哪个条目」变回隐式默认——而这件事只由调用方自己的配置回答。
   *
   * 这是**名义**约束、不是边界：`SystemOneService` 本身是导出的，一次转型就能拿到 `providers()`。
   * 它挡的是顺手用法，不是刻意绕过。
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
export class SystemOneService extends Service {
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
   * 已注册的条目 id，按注册顺序。它是给设置页列候选项用的只读投影，**不是选择机制**。
   *
   * 投影到浏览器（`ctx.remote.systemOne.providers()`）要跟客户端半一起落地：typert 的远程面要求随包
   * 交付生成产物，而眼下没有消费它的客户端。在那之前它只有两个用处——`ask()` 报错时说明现状，
   * 以及测试断言注册顺序。
   * @returns 条目 id 的副本。
   */
  providers(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * 把一批题交给 `target` 指名的条目。
   * @param request - 条目 id、状态与题面。
   * @returns provider 的回答，外加服务侧测得的耗时。
   * @throws `target` 没有对应注册时抛错，消息里点名该 id 与当前已注册的 id。
   */
  async ask(request: AskRequest): Promise<AskResult> {
    const provider = this.entries.get(request.target)
    if (provider === undefined) {
      const ids = this.providers()
      const known = ids.length === 0 ? 'none' : ids.join(', ')
      throw new Error(`system-one: no provider registered as "${request.target}" (registered: ${known})`)
    }
    // provider 只该看到 `ProviderRequest`。摘掉 `target` 而不是把 `request` 直接传过去：`Omit` 只是类型，
    // 运行时真正少掉那一项靠的是这次解构。
    const { target: _target, ...providerRequest } = request
    const started = Date.now()
    const response = await provider.evaluate(providerRequest)
    return { ...response, latencyMs: Date.now() - started }
  }
}
