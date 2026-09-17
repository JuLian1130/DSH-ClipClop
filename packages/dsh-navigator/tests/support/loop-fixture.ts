/**
 * 集成夹具（票据 03 交付，02c 补驱动 / 归属 / 会话构造，04–11 复用）：真实 agent loop + 把被测插件挂
 * 进去 + 可脚本化、可挂住不放行的适配器，并在适配器收到请求的同一次同步回调里拍下**发起它的那条会话**
 * 的快照。
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
 * 02c 追加的四样能力：
 * - **多步驱动**：`main.drive(steps, text?)` 先用一条真实用户消息唤醒会话，再推进 `steps` 步，其间不再
 *   出现真实用户消息。脚本每步发一个 tool-call（`SCRIPTED_STEP`）turn 就不会提前收尾；最后一步用纯文本
 *   收尾也一样算这 `steps` 步里的最后一步。驱动结束后该会话的请求数与计数口径的已完成步数都增加了
 *   `steps`。
 * - **步边界暂停**：`drive` 停在「已完成 N 步、正要进第 N+1 步」这个 `agent/pre-step` **之前**——闸门是
 *   夹具自己的 pre-step 监听器（**注册早于插件**，在 `next()` 之前 await 一个可释放的 Promise），所以
 *   暂停点上该会话的请求数恰为 N；用例重载 / 改配置后再次 `drive`，就从第 N+1 步续跑。脚本用纯文本
 *   收尾、turn 先结束而没有下一个步边界时，`drive` 按「会话转入空闲」返回。
 * - **请求归属**：`ObservedCall.session` 是发起这条请求的会话。loop 自建的请求带 `sessionId`（主会话、
 *   子会话、fork 会话都有），插件自建的复核请求**不带**；后者按 pre-step 边界归属到那一刻正在起
 *   pre-step 的会话——夹具监听器先于插件跑，复核请求因此与那一步的主请求落进同一次归属。
 * - **会话构造**：`createSubSession`（`meta.origin: 'subagent'`）与 `createForkSession`
 *   （`meta.parentSession`，按 `Sessions.fork` 同款同时带 `seed` 与 `inheritedEventCount`）都走
 *   `ctx.agents.create()`，不新造第二条 loop。
 *
 * **驱动读数与投影注册时序**（02c 第 5 条，夹具约定、不是验收判据）：需要从第 1 步起计数的用例必须
 * **挂载早于第 1 步**；「先跑几步再挂」的用例第一次观察读到的投影状态是从日志折出的历史，其步数与
 * 「当时那一步」可能差一格，期望值按实测运行读数写。步边界闸门不读投影——它按会话事件里的
 * `assistant/message`（不带 `interrupted`）自己数，所以暂停点的请求数不受挂载时序影响。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
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
import {
  ScriptedAdapter,
  SCRIPTED_TOOL_NAME,
  userMessage,
  type ScriptedResponse,
} from './scripted-adapter.ts'
import { trackContext } from './mounted-contexts.ts'
import { createStubServices } from './stub-services.mjs'

/** 一次被观察到的模型请求：请求本身，加上发起它的会话与收到它那一刻该会话的快照。 */
export interface ObservedCall {
  /** 送进适配器的请求对象。 */
  readonly request: GenerateOptions
  /** 发起这条请求的会话：loop 自建的请求按 `request.sessionId` 归属，插件的复核请求按 pre-step 边界归属。 */
  readonly session: Session
  /** 收到请求那一刻该会话对模型可见的全部消息 id，按原顺序。 */
  readonly snapshotIds: readonly string[]
  /** 收到请求那一刻该会话已完成的步数（投影读数）——触发点用例拿它当已知的触发点。 */
  readonly steps: number
}

/** 一条会话的观察与驱动句柄：主会话、子会话、fork 会话共用它。 */
export interface NavigatorSession {
  readonly agent: Agent
  readonly session: Session
  /** 该会话名下的模型请求，按调用顺序。 */
  calls(): readonly ObservedCall[]
  /** 该会话名下的复核请求（末条消息是本插件注入的 plugin 消息）。 */
  reviews(): readonly ObservedCall[]
  /** 该会话落盘的事件，按顺序（实时 `session/event` 流，不含构造期的 seed）。 */
  events(): readonly SessionEvent[]
  /** 该会话已落盘的 `turn/end` 原因，按顺序。 */
  turnEndReasons(): readonly TurnEndReason[]
  /** 该会话按计数口径数出的已完成步数（不带 `interrupted` 的 `assistant/message` 条数）。 */
  steps(): number
  /**
   * 从当前步边界再推进 `steps` 步，然后停在下一个步边界并交回控制权；`text` 给出时先送一条真实
   * 用户消息。期间不再出现别的真实用户消息。
   */
  drive(steps: number, text?: string): Promise<void>
  /** 送一条真实用户消息，并等该会话本轮的 turn 收尾。 */
  send(text: string): Promise<void>
}

/** 集成夹具的句柄。 */
export interface NavigatorLoop {
  readonly ctx: Context
  readonly agent: Agent
  /** 主会话的句柄；`send` / `events` / `turnEndReasons` 是它对应方法的别名。 */
  readonly main: NavigatorSession
  /** 全部会话的模型请求，按调用顺序，各带发起它的会话与那一刻的快照。 */
  calls(): readonly ObservedCall[]
  /** 其中本插件的复核请求，跨全部会话。 */
  reviews(): readonly ObservedCall[]
  /** 主会话落盘的事件，按顺序（实时 `session/event` 流，不含构造期的 seed）。 */
  events(): readonly SessionEvent[]
  /** 主会话已落盘的 `turn/end` 原因，按顺序。 */
  turnEndReasons(): readonly TurnEndReason[]
  /** 送一条真实用户消息给主会话，并等本轮收尾。 */
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
  /** 造一条子会话（`origin: 'subagent'`），与主会话共用同一条 loop 与适配器。 */
  createSubSession(sessionId: string): Promise<NavigatorSession>
  /**
   * 造一条 fork 会话（`parentSession` 指向主会话、不带 `origin`）。
   * @param sessionId - 新会话 id。
   * @param seed - 要继承的父会话前缀；缺省空数组，与 `inheritedEventCount: 0` 一起构成合法 fork 头部。
   *   需要继承历史的用例传一段**平衡的已完成 turn 前缀**（主会话的实时事件账本见 `main.events()`）。
   */
  createForkSession(sessionId: string, seed?: readonly SessionEvent[]): Promise<NavigatorSession>
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
  /**
   * 每次请求被记下时同步调用的额外观察钩子（夹具自己的快照观察也在同一次回调里）；第二个参数是
   * 发起这条请求的会话的 agent，与 `ObservedCall.session` 同源。
   */
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

/** 一条会话的步边界闸门状态。 */
interface Boundary {
  /** 本次 `drive` 要停下的已完成步数；到点后清空。 */
  target: number | undefined
  /** 已经停在边界上、等下一次 `drive` 放行。 */
  blocked: boolean
  /** 放行被挡住的那次 pre-step。 */
  release: (() => void) | undefined
  /** 通知当前 `drive`「已经到边界」。 */
  reached: (() => void) | undefined
}

/**
 * 挂一套集成夹具：真实 loop + 被测插件 + 观察型适配器。
 * @param options - 配置、脚本与观察钩子。
 * @returns 驱动会话、读请求与快照的句柄。
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

  // 步进工具：这一步要能成功收尾又**不**结束 turn，所以工具体不调 `concludeTurn()`。
  // `parameters` 走 raw 形状（`register` 不校验它）；`output.schema` 用注解式 `{}`（`assertSupportedJsonSchema` 接受）。
  ctx.tools.register({
    name: SCRIPTED_TOOL_NAME,
    description: '脚本化夹具的步进工具：让当前步骤正常收尾，turn 继续。',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: () => Promise.resolve({}),
  })

  const calls: ObservedCall[] = []
  /**
   * 逐会话的事件账本。在**任何 append 之前**挂上，所以它从 seq 0 起完整；主会话的账本同时充当
   * fork 的 `seed` 来源（`snapshotEvents()` 已被标记禁止新调用）。
   */
  const eventsBySession = new Map<Session, SessionEvent[]>()
  const eventsOf = (session: Session): SessionEvent[] => {
    const known = eventsBySession.get(session)
    if (known !== undefined) return known
    const fresh: SessionEvent[] = []
    eventsBySession.set(session, fresh)
    return fresh
  }
  // 会话事件按真实实例过滤：用例可能把 `agent.session` 换成替身（票据第 9 条）。
  const mainSession = agent.session
  const mainEvents = eventsOf(mainSession)
  ctx.on('session/event', (subject, event) => { eventsOf(subject).push(event) })

  /** 计数口径（与插件投影同一判据）：不带 `interrupted` 的 `assistant/message` 条数。 */
  const completedSteps = (session: Session): number => eventsOf(session).filter(
    event => event.type === 'assistant/message' && event.data.interrupted !== true,
  ).length

  /** 已知会话：loop 自建的请求按 `request.sessionId` 归到它名下。 */
  const knownSessions = new Map<string, { agent: Agent; session: Session }>()
  knownSessions.set(mainSession.id, { agent, session: mainSession })
  /** 没有 `sessionId` 的请求（插件的复核请求）归到最近一次起 pre-step 的会话。 */
  let preStepOwner: { agent: Agent; session: Session } = { agent, session: mainSession }

  const adapter = new ScriptedAdapter(options.script, {
    ...options.reasoning === undefined ? {} : { reasoning: options.reasoning },
    onRequest: (request) => {
      const owner = (request.sessionId === undefined ? undefined : knownSessions.get(request.sessionId)) ?? preStepOwner
      calls.push({
        request,
        session: owner.session,
        snapshotIds: owner.session.deriveMessages().map(message => message.id),
        steps: ctx.sessionProjections.stateOf(owner.session, 'navigatorSteps')?.steps ?? 0,
      })
      options.observeRequest?.(request, owner.agent)
    },
  })
  ctx.llm.registerAdapter([route.provider], adapter)

  const boundaries = new Map<Session, Boundary>()
  const boundaryOf = (session: Session): Boundary => {
    const known = boundaries.get(session)
    if (known !== undefined) return known
    const fresh: Boundary = { target: undefined, blocked: false, release: undefined, reached: undefined }
    boundaries.set(session, fresh)
    return fresh
  }

  /**
   * 步边界闸门。注册**早于插件**（同一个 waterfall 里注册在前的最外层先跑），且在 `next()` 之前等
   * 放行——所以暂停点上插件的到点判据还没对这一步求值，请求数也还是 N。
   */
  ctx.on('agent/pre-step', async ({ agent: subject, messages, turn, step, signal }, next) => {
    preStepOwner = { agent: subject, session: subject.session }
    const boundary = boundaryOf(subject.session)
    if (boundary.target !== undefined && completedSteps(subject.session) >= boundary.target) {
      boundary.target = undefined
      boundary.blocked = true
      boundary.reached?.()
      boundary.reached = undefined
      await new Promise<void>((resolve) => {
        boundary.release = resolve
        // 取消 / 卸载会让本步的信号中止：一并放行，交给 loop 自己的 throwIfAborted 收场，不永久挂住。
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      boundary.blocked = false
      signal.throwIfAborted()
      // 放行后**重新派发**这一步的 pre-step：暂停期间用例可能重挂载插件（或改配置重启），最初那次
      // 派发捕获的监听器会随旧 fiber 失效，继续往下跑它只会让旧实例在自己的 ctx 上抛错。重新派发按
      // 当前的监听器集合重跑，新实例因此接住第 N+1 步。默认决策 = 这一步已被 claim 的消息——本夹具
      // 没有 runtime context provider，loop 的默认决策就是它。
      return agentEvents(ctx, subject).waterfall(
        'agent/pre-step',
        { messages, turn, step, signal },
        () => Promise.resolve({ kind: 'enter', messages }),
      )
    }
    return next()
  })

  /** 推进一条会话 `steps` 步并停在步边界。 */
  const drive = async (target: Agent, steps: number, text?: string): Promise<void> => {
    const session = target.session
    const boundary = boundaryOf(session)
    boundary.target = completedSteps(session) + steps
    const reached = new Promise<void>((resolve) => { boundary.reached = resolve })
    if (boundary.blocked) {
      // 上一次 drive 正停在这个边界上：放行这一步，往新的目标继续走。
      boundary.blocked = false
      boundary.release?.()
      boundary.release = undefined
    }
    if (text !== undefined) target.followup(userMessage(text))
    // 脚本用纯文本收尾时 turn 先结束、不再有下一个步边界，这时按「会话转入空闲」返回。
    await Promise.race([reached, target.whenIdle()])
    boundary.target = undefined
    boundary.reached = undefined
  }

  /** 一条会话的观察与驱动句柄。 */
  const sessionHandle = (target: Agent): NavigatorSession => {
    const session = target.session
    return {
      agent: target,
      session,
      calls: () => calls.filter(call => call.session === session),
      reviews: () => calls.filter(call => call.session === session && isReviewRequest(call.request)),
      events: () => eventsOf(session),
      turnEndReasons: () => eventsOf(session).flatMap(
        event => event.type === 'turn/end' ? [event.data.reason] : [],
      ),
      steps: () => completedSteps(session),
      drive: (steps, text) => drive(target, steps, text),
      send: async (text) => {
        target.followup(userMessage(text))
        await target.whenIdle()
      },
    }
  }

  const main = sessionHandle(agent)

  /** 造一条新会话（子会话 / fork），登记归属；它与主会话共用同一条 loop 与适配器。 */
  const createSession = async (createOptions: CreateAgentOptions): Promise<NavigatorSession> => {
    const created = (await ctx.agents.create(createOptions)).agent
    knownSessions.set(created.session.id, { agent: created, session: created.session })
    return sessionHandle(created)
  }

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
    main,
    calls: () => calls,
    reviews: () => calls.filter(call => isReviewRequest(call.request)),
    events: () => mainEvents,
    turnEndReasons: () => main.turnEndReasons(),
    send: (text) => main.send(text),
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
    createSubSession: (sessionId) => createSession({
      sessionId: SessionId(sessionId),
      meta: { origin: 'subagent', parentSession: mainSession.id },
      agentOptions: route,
    }),
    createForkSession: (sessionId, seed = []) => createSession({
      sessionId: SessionId(sessionId),
      meta: { parentSession: mainSession.id, isSeeded: true },
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      agentOptions: route,
    }),
  }
}
