/**
 * 集成夹具（票据 03 交付，04–11 复用）：真实 agent loop + 把被测插件挂进去 + 可脚本化、可挂住
 * 不放行的适配器，并在适配器收到请求的同一次同步回调里拍下主会话快照。
 *
 * 适配器复用 01 的 `scripted-adapter.ts`（不新造第二份）；context 记账/释放复用 02b 拆出的
 * `mounted-contexts.ts`（原先的 `cordis-fixture.ts`）；前置服务与真实 loop 由 testkit 的
 * `mountAgentLoopTestDependencies` / `mountAgentLoopTestHarness` 装配。投影注册由插件自己在
 * `apply` 里完成，夹具不重复注册。
 *
 * `storageDomain` 由本夹具提供，两档二选一（04 追加）：缺省用共享桩，只让 `apply` 跑完；给了
 * `storageRoot` 就挂真实存储栈（`storage` 服务 + json 后端 + `storage-domain`，后端根落在 `root`），
 * 只有它做得到「看原始文档 / 塞坏记录 / 让记录跨 `update` 与重挂载存活」。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as navigator from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { ScriptedAdapter, userMessage, type ScriptedResponse } from './scripted-adapter.ts'
import { trackContext } from './mounted-contexts.ts'
import { createStubServices } from './stub-services.mjs'

/** 一次被观察到的模型请求：请求本身，加上收到它那一刻的主会话快照消息 id。 */
export interface ObservedCall {
  /** 送进适配器的请求对象。 */
  readonly request: GenerateOptions
  /** 触发点那一刻主会话对模型可见的全部消息 id，按原顺序。 */
  readonly snapshotIds: readonly string[]
  /** 收到请求那一刻本会话已完成的步数（投影读数）——触发点用例拿它当已知的触发点。 */
  readonly steps: number
}

/** 集成夹具的句柄。 */
export interface NavigatorLoop {
  readonly ctx: Context
  readonly agent: Agent
  /** 全部模型请求，按调用顺序，各带请求那一刻的主会话快照。 */
  calls(): readonly ObservedCall[]
  /** 其中本插件的复核请求（末条消息是本插件注入的 plugin 消息）。 */
  reviews(): readonly ObservedCall[]
  /** 本会话落盘的事件，按顺序（实时 `session/event` 流，不含构造期的 seed）。 */
  events(): readonly SessionEvent[]
  /** 本会话已落盘的 `turn/end` 原因，按顺序。 */
  turnEndReasons(): readonly TurnEndReason[]
  /** 送一条真实用户消息，并等本轮收尾。 */
  send(text: string): Promise<void>
  /**
   * 把插件挂进这个 loop，配置取夹具选项里的 `config`。缺省在 `mountNavigatorLoop` 返回前就已挂好；
   * 需要「会话先跑几步、插件再被观察」的用例把 `mountEagerly` 置 false，在自己想要的时刻调用它。
   */
  mountPlugin(): Promise<void>
  /** 当前插件实例的 fiber；读到记录域是否真的重开、以及断言「插件仍激活」都用它。 */
  pluginFiber(): Fiber | undefined
  /**
   * 重挂载插件：丢弃前一个实例（连带关闭它持有的记录域），再挂一个新的。第 1 条的读回就在这一步
   * 之后进行——只有重挂载才真的再跑一次域 open。
   */
  remountPlugin(): Promise<void>
  /**
   * 按 Cordis 原生的配置更新路径改配置（`update` 内部重跑 `apply`，先关域再重新 open）。
   * 返回前等这次重启 settle，否则用例会在 `apply` 还没跑完时去读记录。
   */
  updateConfig(config: Config): Promise<void>
}

/** 夹具挂载参数。 */
export interface NavigatorLoopOptions {
  /** 插件配置；缺省即 `Config` 的全部默认值。 */
  readonly config?: Config
  /** 是否在返回前就挂插件；缺省 true。 */
  readonly mountEagerly?: boolean
  /** 适配器脚本，按调用顺序——主请求与复核请求混排时按顺序写。 */
  readonly script?: readonly ScriptedResponse[]
  /** 造主会话时在 `{ provider: 'mock', model: 'mock' }` 之上追加的选项；改 provider 时适配器按最终 provider 注册。 */
  readonly agentOptions?: AgentOptions
  /** 适配器声明的推理强度档位；继承推理强度的用例需要它。 */
  readonly reasoning?: LlmModelReasoningInfo
  /** 每次请求被记下时同步调用的额外观察钩子（夹具自己的快照观察也在同一次回调里）。 */
  readonly observeRequest?: (request: GenerateOptions, agent: Agent) => void
  /**
   * 记录域的存储形态：给了它就挂真实存储栈并把 JSON 后端根落在它下面（同一条 loop 上二选一），
   * 缺省用共享桩。第 1、4、5、7、8、9 条要给这个值。
   */
  readonly storageRoot?: string
}

/**
 * 一条请求是不是本插件的复核请求：末条消息是插件注入的 user 消息。
 * @param request - 适配器收到的请求。
 * @returns 是本插件的复核请求时为 true。
 */
export function isReviewRequest(request: GenerateOptions): boolean {
  const last = request.messages.at(-1)
  return last?.source.kind === 'plugin' && last.source.plugin === navigator.name
}

/**
 * 挂真实存储栈：`storage` 服务 + json 后端（记录落在 `root` 下）+ `storage-domain`（路由 `json`）。
 * @param ctx - 夹具的根 context。
 * @param root - JSON 后端根：同一个根下重挂载插件，记录就该还在。
 */
async function mountStorageStack(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root },
  )
  await ctx.plugin(
    {
      name: storageDomainName,
      inject: storageDomainInject,
      apply: storageDomainApply,
      Config: storageDomainConfig,
    },
    { backend: 'json' },
  )
}

/**
 * 挂一套集成夹具：真实 loop + 被测插件 + 观察型适配器。
 * @param options - 配置、脚本与观察钩子。
 * @returns 驱动主会话、读请求与快照的句柄。
 */
export async function mountNavigatorLoop(options: NavigatorLoopOptions = {}): Promise<NavigatorLoop> {
  const ctx = trackContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  if (options.storageRoot === undefined) {
    // 桩只服务「记录字段」与「记录不进会话」两条；要看原始文档或让记录跨重挂载存活的用例给 root。
    const { services } = createStubServices(['llm', 'sessions', 'sessionProjections'])
    ctx.provide('storageDomain', services.storageDomain)
  } else {
    await mountStorageStack(ctx, options.storageRoot)
  }
  const harness = await mountAgentLoopTestHarness(ctx)
  // 路由可被用例改成非默认值：断言「继承路由」时，默认值与被硬编码的值不可区分。
  const route = { provider: 'mock', model: 'mock', ...options.agentOptions }
  const agent = await harness.create(SessionId('navigator-review'), route)
  // 会话事件按真实实例过滤：用例可能把 `agent.session` 换成替身（票据第 9 条）。
  const session = agent.session

  const calls: ObservedCall[] = []
  const adapter = new ScriptedAdapter(options.script, {
    ...options.reasoning === undefined ? {} : { reasoning: options.reasoning },
    onRequest: (request) => {
      calls.push({
        request,
        snapshotIds: agent.session.deriveMessages().map(message => message.id),
        steps: ctx.sessionProjections.stateOf(agent.session, 'navigatorSteps')?.steps ?? 0,
      })
      options.observeRequest?.(request, agent)
    },
  })
  ctx.llm.registerAdapter([route.provider], adapter)

  const events: SessionEvent[] = []
  ctx.on('session/event', (subject, event) => {
    if (subject === session) events.push(event)
  })

  /** 当前插件实例的 fiber；`remountPlugin` / `updateConfig` 与「插件仍激活」的断言都用它。 */
  let pluginFiber: Fiber | undefined
  /** 取当前插件 fiber，插件还没挂时硬失败——静默返回 undefined 会让用例空转。 */
  const requireFiber = (): Fiber => {
    if (pluginFiber === undefined) {
      throw new Error('mountNavigatorLoop: the plugin is not mounted')
    }
    return pluginFiber
  }
  const mountPlugin = async (): Promise<void> => {
    pluginFiber = await ctx.plugin(navigator, options.config ?? {})
  }
  if (options.mountEagerly !== false) await mountPlugin()

  return {
    ctx,
    agent,
    calls: () => calls,
    reviews: () => calls.filter(call => isReviewRequest(call.request)),
    events: () => events,
    turnEndReasons: () => events.flatMap(
      event => event.type === 'turn/end' ? [event.data.reason] : [],
    ),
    mountPlugin,
    pluginFiber: () => pluginFiber,
    async remountPlugin() {
      await requireFiber().dispose()
      pluginFiber = undefined
      await mountPlugin()
    },
    async updateConfig(config) {
      const fiber = requireFiber()
      fiber.update(config)
      await fiber.await()
    },
    async send(text) {
      agent.followup(userMessage(text))
      await agent.whenIdle()
    },
  }
}
