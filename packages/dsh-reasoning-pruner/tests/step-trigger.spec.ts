/**
 * 票 03：激活点② —— 按步数节流批量推进。
 *
 * 本票的判据是**触发节奏**（不是「有没有裁剪」），所以每条断言都成对：到点必须落盘、未到点必须零写入。
 * 参数取小值（`M = 6`、`K = 2`）只是为了构造；`M`/`K` 的数字由 07 的实测收紧，本票只保证「有默认值、
 * 可装载、可覆盖」这一层。
 *
 * 两处口径必须写清楚，否则用例会自己骗自己：
 *
 * - **步号**：`agent/pre-step` 在提出该步**之前**发出，第 N 次 pre-step 时已有 N-1 条已记录的
 *   `assistant/message`；最后一步的 assistant 消息要等该步的模型调用落定才出现。
 * - **取样点**：本插件以 `{ prepend: true }` 注册，`onPreStep` 观察面注册得比它晚（它 `unshift`、后面的
 *   按 `push` 追加），所以观察到的是「本步骤的决策已落盘、该步骤的 assistant 消息尚未出现」那一刻。
 *
 * `targets` 一律**逐项**断言：只断「有落盘」时，一个落错集合甚至落空集合的实现也全绿。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { persistReasoningPrune, pruneAtStepBoundary, pruneTargetsAtStep } from '../src/persist.ts'
import type { PersistentLifecycle, ScriptedStep } from './support/session-harness.ts'
import {
  cleanupRoots,
  fakeSession,
  lifecycle,
  persistedPrunes,
  reasoningTexts,
  recordedAssistants,
  remount,
  restore,
} from './support/session-harness.ts'
import type { FakeSession } from './support/session-harness.ts'

afterEach(cleanupRoots)

/** 本票用例用的步进间隔与保留窗口：`M = 6`、`K = 2`（保持 `M ≥ K + 2` 这条不变式）。 */
const M = 6
const K = 2
const CONFIG = { everySteps: M, keepRecentSteps: K }

/** 第 `index` 步的推理文本；逐项断言靠它认出「哪一步被保留」。 */
function reasoningOf(index: number): string {
  return `thinking ${index}`
}

/**
 * 一个**每一步都发起工具调用**的 turn 脚本；收尾交给适配器的 `toolsThrough`（见 {@link drive}）。
 *
 * 段数取得比用例驱动的最长 turn 还多，所以每一步的推理文本都不同，逐项断言才能靠文本认出是哪一步。
 */
const DRIVE_REPEAT_STEPS = 16
const SCRIPT: ScriptedStep[] = Array.from({ length: DRIVE_REPEAT_STEPS }, (_unused, index) => ({
  reasoning: reasoningOf(index),
  text: `text ${index}`,
  calls: [{ name: 'noop', arguments: '{}' }],
}))

/** 一条只有名字的工具，让脚本里的工具调用能派发。 */
function registerTool(ctx: Context, name: string): void {
  ctx.tools.register({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
  })
}

/** 每次 pre-step 之后取样到的一行：步号 + 那一刻已落盘的裁剪决策数与本步骤已记录的 assistant 消息数。 */
interface PreStepSample {
  readonly step: number
  readonly prunes: number
  readonly assistants: number
}

/** 一次驱动过一个 turn 的现场。 */
interface Driven {
  readonly lc: PersistentLifecycle
  readonly session: Session
  readonly samples: PreStepSample[]
}

/**
 * 等驱动收场；`whenIdle()` 万一不 resolve（未知的循环时序）就用 `cancel()` 收敛，绝不让用例挂住。
 * @param agent - 被驱动的 agent。
 */
async function settle(agent: Agent): Promise<void> {
  let settled = false
  const idle = agent.whenIdle().then(() => { settled = true })
  await Promise.race([idle, new Promise<void>(resolve => setTimeout(resolve, 3_000))])
  if (!settled) {
    agent.cancel({ kind: 'hook', reason: 'drive: forcing the driver back to idle' })
    await agent.whenIdle()
  }
}

/**
 * 驱动一个**恰好 `steps` 次 pre-step** 的 turn，并逐 pre-step 取样。
 *
 * 驱动交给适配器一劳永逸地决定收尾点（`toolsThrough = steps - 1`）：第 N 次 pre-step 正好在第 N 次模型
 * 请求之前，第 `steps` 次请求被适配器改成纯文本，于是该 turn 在第 `steps` 步结束。这样不需要
 * steer/followup 接力，也就不依赖循环时序；`whenIdle()` 自然收敛。
 * @param options - 落盘根、步数与插件配置。
 * @returns 生命周期、会话与逐 pre-step 取样。
 */
async function drive(options: {
  readonly root?: string
  readonly config?: Partial<typeof CONFIG>
  readonly steps: number
  readonly id?: string
  /** 把已落盘的同名会话装回来再驱动（重载后续跑的用例用）。 */
  readonly resume?: boolean
  /** 让每一步的信封都无裁剪资格（见 {@link LifecycleOptions.ineligible}）。 */
  readonly ineligible?: boolean
  readonly prepend?: (ctx: Context) => void
}): Promise<Driven> {
  const samples: PreStepSample[] = []
  const lc = await lifecycle(SCRIPT, {
    ...options.root === undefined ? {} : { root: options.root },
    config: options.config ?? CONFIG,
    ...options.ineligible === undefined ? {} : { ineligible: options.ineligible },
    ...options.prepend === undefined ? {} : { prepend: options.prepend },
    toolsThrough: options.steps - 1,
    onPreStep: ({ step, session }) => {
      samples.push({ step, prunes: persistedPrunes(session).length, assistants: recordedAssistants(session).length })
    },
  })
  registerTool(lc.ctx, 'noop')
  const { agent, session } = await lc.createSession(options.id ?? 'trigger', { resume: options.resume })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await settle(agent)
  return { lc, session, samples }
}

describe('票 03 · 第 1、2 条：到点触发、未到点零写入', () => {
  it('恰好压在第 M 步落盘一条承载事件，targets 是该批量应裁的那些步骤（逐项断言）', async () => {
    const { lc, session, samples } = await drive({ steps: M })

    // 步号口径：第 N 次 pre-step 时已有 N-1 条已记录消息。
    expect(samples.map(sample => sample.step)).toEqual([1, 2, 3, 4, 5, 6])
    // 反例（第 2 条）：M-1 步时零写入。
    expect(samples[4]).toEqual({ step: 5, prunes: 0, assistants: 4 })
    // 正面（第 1 条）：第 M 步恰好落一条，且此刻已有 M-1 条已记录 assistant 消息。
    expect(samples[5]).toEqual({ step: 6, prunes: 1, assistants: 5 })

    // 判据非空：targets 的具体集合（数量与 seq 逐项）。5 条已记录步骤里，最近 K=2 条保留，剩下 seq 最小的
    // 3 条进本批。
    const prunes = persistedPrunes(session)
    expect(prunes).toHaveLength(1)
    const recorded = recordedAssistants(session)
    expect(prunes[0]!.targets).toEqual(recorded.slice(0, 3).map(entry => entry.seq))
    // 承载事件确实落在第 M 步那一步里：它排在「本步骤之前最后一条 assistant/message」之后、
    // 「本步骤那条 assistant/message」之前。
    expect(prunes[0]!.seq).toBeGreaterThan(recorded[4]!.seq)
    expect(prunes[0]!.seq).toBeLessThan(recorded[5]!.seq)

    await lc.dispose()
  })

  it('到点但没有一条历史步骤有裁剪资格时零写入（不是落一条空记录）', async () => {
    // 规格 `测试决策`「② 的触发节奏」的同名条目：资格不成立时应当**没有任何事件落盘**，而不是落一条
    // `targets` 为空的事件——后者会污染日志，并让闸门 C 的降级判据难以判断。构造方式是让每一步的信封都
    // 声明无资格的传输（`isReasoningPrunable` 判 false），触发节奏与第 1 条完全一样。
    const { lc, session, samples } = await drive({ steps: M, ineligible: true })

    // 判据非空：到点那一步确实发生了（否则「零写入」在一个根本没驱动的会话上也成立）。
    expect(samples.map(sample => sample.step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(samples[5]!.assistants).toBe(5)
    // 每一条历史步骤都在，且一条都没被裁。
    expect(recordedAssistants(session)).toHaveLength(M)
    expect(reasoningTexts(session)).toHaveLength(M)
    // 零写入：日志里没有我们的承载事件（`persistedPrunes` 只认顶层带 `clipclop` 键的那些）。
    expect(persistedPrunes(session)).toEqual([])

    await lc.dispose()
  })
})

describe('票 03 · 第 3 条：K 被尊重', () => {
  it('targets 不含最近 K 步，且模型可见历史里那 K 步的推理块仍在', async () => {
    const { lc, session } = await drive({ steps: M })

    const recorded = recordedAssistants(session)
    const targets = persistedPrunes(session)[0]!.targets
    const kept = recorded.slice(-K)

    // ① targets 不含最近 K 步的 seq。
    expect(kept).toHaveLength(K)
    for (const entry of kept) expect(targets).not.toContain(entry.seq)
    // 判据非空的反面：被保留的那几步确实是**带推理**的步骤，否则下一条断言是空转。
    expect(kept.map(entry => entry.reasoning)).toEqual([reasoningOf(4), reasoningOf(5)])

    // ② 模型可见历史里那 K 步的推理块仍在。只断 ① 时「投影没生效」也全绿，所以两条必须一起断。写入侧
    // 的资格闸门只保证「被声明的 seq 一定被裁」，是否还有别的步骤留在历史里由保留窗口决定，所以这里断的
    // 是「保留窗口里那些步骤的推理文本仍在」，而不是「全部推理文本恰好等于这两条」。
    const visible = reasoningTexts(session)
    for (const entry of kept) expect(visible).toContain(entry.reasoning)
    // 被裁掉的步骤一条都不该留在可见历史里。
    for (const target of targets) {
      const pruned = recorded.find(entry => entry.seq === target)
      expect(visible).not.toContain(pruned!.reasoning)
    }

    await lc.dispose()
  })
})

describe('票 03 · 第 4 条：节奏不受 token 计量读数影响', () => {
  it('读数恒为常量、且计量服务根本不被访问，仍按 M 的整数倍触发', async () => {
    // 机制：`ctx.tokenMeter.measure()` 按**原始表面事件**定价、不读投影，所以「裁了钱」不会让读数下降；
    // ② 的节奏因此只能由步数决定。这条判据要能挡住「读一个不会下降的读数来决定节奏」的实现，所以观察面
    // 不是「读数有没有变」，而是**计量服务压根没被碰过**：把 `ctx.tokenMeter` 换成一个读到任何属性就抛的
    // Proxy，任何形式的判压读取都会当场炸掉这一轮。
    // 机制：`ctx.tokenMeter.measure()` 按**原始表面事件**定价、不读投影，所以「裁了钱」不会让读数下降；
    // ② 的节奏因此只能由步数决定。这条判据要挡住「读一个不会下降的读数来决定节奏」的实现，所以观察面
    // 不是「读数有没有变」，而是**计量服务压根没被读**：把它的原型换成一个读到任何方法就抛的 Proxy，
    // 任何形式的判压读取都会当场炸掉这一轮。（换原型而不是换 `ctx.tokenMeter`：后者受 Cordis 的
    // 「同一属性只能在一个 fiber 上赋值」约束。）
    const touched: string[] = []
    const prepend = (ctx: Context): void => {
      const meter = ctx.tokenMeter
      Object.setPrototypeOf(meter, new Proxy(Object.getPrototypeOf(meter) as object, {
        get: (_target, property) => {
          touched.push(String(property))
          throw new Error(`tokenMeter.${String(property)} must not be read: ② 的节奏只由步数决定`)
        },
      }))
    }
    // 在**本插件的装载路径**上换掉计量服务；`drive` 传入的 `prepend` 回调正是那个时机（它在
    // `ctx.plugin(plugin, …)` 之前跑，且与它同属夹具 context、同一个 fiber，所以可以赋值）。
    const { lc, session, samples } = await drive({ steps: M, prepend })

    expect(samples[4]!.prunes).toBe(0)
    expect(samples[5]!.prunes).toBe(1)
    // 触发节奏与读数无关：整整一轮里计量服务一次都没被读。
    expect(touched).toEqual([])
    // 而且该批量照旧是那三条——把「读数不变」与「节奏不变」钉在一起。
    expect(persistedPrunes(session)[0]!.targets)
      .toEqual(recordedAssistants(session).slice(0, 3).map(entry => entry.seq))

    await lc.dispose()
  })
})

describe('票 03 · 第 5 条：重载后不倒退、不重复推进同一批', () => {
  it('重载后下一次触发点仍是下一个 M 的整数倍，且第二次 targets 与第一次不相交', async () => {
    // 第一个生命周期：驱动到第 12 步，`M` 的整数倍在第 6 步与第 12 步各中一次。
    const first = await drive({ steps: 2 * M, id: 'reloaded' })
    const firstPrunes = persistedPrunes(first.session)
    const beforeReload = recordedAssistants(first.session)
    // 12 次 pre-step 的 turn 记录 12 条（第 12 步那次的 pre-step 先于它的消息，但收尾发生在该步之内）。
    expect(beforeReload).toHaveLength(2 * M)
    expect(firstPrunes).toHaveLength(2)
    expect(firstPrunes[0]!.targets).toEqual(beforeReload.slice(0, 3).map(entry => entry.seq))
    // 第 12 步的 pre-step 上看到的是 11 条（本步骤的消息还没落），保留最近 2 条 → 裁 3..8。
    expect(firstPrunes[1]!.targets).toEqual(beforeReload.slice(3, 2 * M - 1 - K).map(entry => entry.seq))
    await first.lc.dispose()

    // 真的重挂载：新 context、新插件 fiber、投影注册与 pre-step 监听器都真的再跑一次；同名会话在盘上
    // 存在，所以 `createSession` 走的是装载既有历史的 resume，而不是建一条新的。
    const second = await drive({ steps: M, id: 'reloaded', root: first.lc.root, resume: true })

    // ① 重载后不立刻补打一次：步号在恢复的会话里从 1 重新数，下一次触发点仍是下一个 M 的整数倍。
    expect(second.samples.map(sample => sample.step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(second.samples[4]!.prunes).toBe(2)
    expect(second.samples[5]!.prunes).toBe(3)

    // ② 已裁过的不再裁：第二次 targets 与第一次不相交。重复声明同一 seq 会让 01 的投影校验当场抛错，
    // 所以这条不成立时表现为 append 失败或静默重复。
    const all = recordedAssistants(second.session)
    expect(all.slice(0, beforeReload.length).map(entry => entry.seq))
      .toEqual(beforeReload.map(entry => entry.seq))
    const secondPrunes = persistedPrunes(second.session)
    expect(secondPrunes).toHaveLength(3)
    const later = secondPrunes[2]!.targets
    // 本批是「第一批之后、保留窗口之前」的那一段：起点紧接第一次的最后一条，终点由恢复后被驱动的步数
    // 决定——第 6 步的 pre-step 上看到的是 `beforeReload.length + 5` 条，保留最近 K 条。
    const settled = all.findIndex(entry => entry.seq === firstPrunes[1]!.targets.at(-1))
    expect(settled).toBeGreaterThanOrEqual(0)
    expect(later).toEqual(
      all.slice(settled + 1, beforeReload.length + M - 1 - K).map(entry => entry.seq),
    )
    for (const target of later) {
      expect(firstPrunes[0]!.targets).not.toContain(target)
      expect(firstPrunes[1]!.targets).not.toContain(target)
    }

    await second.lc.dispose()
  })
})

describe('票 03 · 第 6 条：裁剪是单向的', () => {
  it('连续两次推进的 targets 交集为空，且各自非空', async () => {
    const { lc, session } = await drive({ steps: 2 * M })

    const [first, second] = persistedPrunes(session)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // 判据非空：两次都必须真的裁了东西，否则「交集为空」在两次都是空集合时恒真。
    const all = recordedAssistants(session)
    expect(first!.targets).toEqual(all.slice(0, 3).map(entry => entry.seq))
    expect(second!.targets.length).toBeGreaterThanOrEqual(2)
    expect(first!.targets.filter(target => second!.targets.includes(target))).toEqual([])
    // 两批合起来就是「除保留窗口外的全部历史步骤」。两次触发都在 pre-step 上：第 6 步时看到 5 条（保留
    // 最近 2 条 → 裁最早的 3 条），第 12 步时看到 11 条（保留最近 2 条 → 裁 3..8）——第二批的右端是
    // 「那一刻的条数减 K」，不是最终条数减 K，因为最后一步的消息在触发之后才落。
    expect(second!.targets).toEqual(all.slice(3, 9).map(entry => entry.seq))
    expect([...first!.targets, ...second!.targets])
      .toEqual(all.slice(0, 9).map(entry => entry.seq))

    await lc.dispose()
  })
})

describe('票 03 · 第 7 条：本插件的监听器在 compaction-basic 之前跑', () => {
  it('挂真 compaction-basic：它测量那一刻，本批裁剪已经在日志里', async () => {
    // 判据的内容是**顺序**。可观察量选在「本插件唯一的写入点」上：本插件只在自己的 `agent/pre-step`
    // 回调里 `append` 承载事件，所以「某个观察者跑到时日志里有没有那条事件」直接回答「本插件的处理在它
    // 之前还是之后」。
    //
    // 观察面成对，缺一条都会自欺：
    // - **排在本插件之前**的观察者（`{ prepend: true }`，`unshift` 到队首）：到点那一步必须看到 0；
    // - **链尾**的观察者（默认 `push`）：同一个位置必须看到 1，也就是本插件的写入确实排在它之前。
    // - compaction-basic 的测量：到点之后再看，读数必须是 1（它排在本插件之后）。
    //
    // 三条合起来把本插件的处理夹在「prepend 观察者」与「同侪/链尾观察者」之间——也就是票面要的那个
    // 位置。**不**用监听器数组的下标来判：数组顺序反映的是「谁先注册」，在这里对本插件的 `prepend`
    // 不敏感。
    const carriersWhenMeasured: number[] = []
    const prepend = (ctx: Context): void => {
      const meter = ctx.tokenMeter as unknown as { measure: (session: Session) => unknown }
      const original = meter.measure
      meter.measure = (session) => {
        carriersWhenMeasured.push(persistedPrunes(session).length)
        return original.call(ctx.tokenMeter, session)
      }
    }
    const lc = await lifecycle(SCRIPT, { config: CONFIG, toolsThrough: M - 1, prepend })
    registerTool(lc.ctx, 'noop')
    const beforePlugin: number[] = []
    const afterPlugin: number[] = []
    // `unshift` ⇒ 排在先注册的 prepend（也就是本插件）之前。
    lc.ctx.on('agent/pre-step', ({ agent }, next) => {
      beforePlugin.push(persistedPrunes(agent.session).length)
      return next()
    }, { prepend: true })
    // `push` ⇒ 排在数组末尾，也就是本插件与 compaction-basic 之后。
    lc.ctx.on('agent/pre-step', ({ agent }, next) => {
      afterPlugin.push(persistedPrunes(agent.session).length)
      return next()
    })
    // 同侪必须在**驱动之前**挂上：它在构造期注册 `agent/pre-step` 监听器。阈值取得足够高，让压力分支
    // 只做测量、不进入摘要（本票不测摘要）。
    await lc.ctx.plugin(BasicCompactionEngine, {
      auto: true,
      thresholdRatio: 0.9,
      headroomTokens: 0,
      maxTokens: 8192,
    })
    const { agent, session } = await lc.createSession('listener-order')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await settle(agent)

    // 判据非空：到点那一步确实写了。
    expect(persistedPrunes(session)).toHaveLength(1)
    expect(beforePlugin).toHaveLength(M)
    expect(afterPlugin).toHaveLength(M)
    // ① 本插件之前看到 0、链尾看到 1 ⇒ 本插件的处理夹在两者之间，且一定在 compaction-basic 之前。
    expect(beforePlugin[M - 1]).toBe(0)
    expect(afterPlugin[M - 1]).toBe(1)
    // ② 同侪确实测过压，且它测量那一刻本批裁剪已经在日志里。它每测一次，读数都必须是 1——若它排到本插件
    //    之前，最早那些读数会是 0。
    expect(carriersWhenMeasured).toContain(1)
    // 最早几次测量发生在第 M 步之前（那时还没有承载事件，读数为 0 是应有之义）；从第一次看到承载事件起，
    // 之后再测都必须看得到它——这条正是「测量排在本插件之后」的形态；若顺序反过来，第一次出现 1 之后
    // 还会再回到 0。
    const firstSeen = carriersWhenMeasured.indexOf(1)
    expect(firstSeen).toBeGreaterThanOrEqual(0)
    expect(carriersWhenMeasured.slice(firstSeen).every(count => count === 1)).toBe(true)

    await lc.dispose()
  })
})

describe('票 03 · 第 8 条：signal 已中止时不动作', () => {
  it('同一状态、同一参数下，已中止的真信号一个事件都不写', async () => {
    // 一次真实的 6 步驱动：默认 `M = 50` 所以它自己不会触发，我们拿到的是一条**真实会话**与一份真实的
    // 候选状态（5 条已记录、可裁的步骤）。随后用 `agent/pre-step` 载荷里那种 `AbortSignal` 的已中止形态
    // 调一次触发，两条路径只差信号状态。
    const { lc, session } = await drive({ steps: M, config: { everySteps: 50, keepRecentSteps: K } })
    expect(recordedAssistants(session)).toHaveLength(M)
    expect(persistedPrunes(session)).toEqual([])

    const config = { everySteps: M, keepRecentSteps: K }
    const signal = AbortSignal.abort()
    expect(signal.aborted).toBe(true)
    expect(pruneAtStepBoundary(session, M, signal, config)).toBeUndefined()
    // 判据非空：同一状态、同一参数、信号未中止时**会**写——否则上面的 `undefined` 在「函数根本不写」
    // 时也成立。
    expect(pruneAtStepBoundary(session, M, new AbortController().signal, config)).toBeDefined()
    expect(persistedPrunes(session)).toHaveLength(1)

    await lc.dispose()
  })
})

describe('票 03 · 第 9 条：M/K 的保守默认、可装载、可覆盖', () => {
  it('默认配置装载后 M/K 取到保守默认，且默认值满足「首次批量非空」的不变式', async () => {
    // 走**真的装载路径**：`Config` schema 在服务就绪时解析出默认值，`fiber.config` 是装载后的取值。
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = ctx.plugin(plugin, {})
    await fiber
    // 默认值必须**偏大**（少干活、少伤质量），且本次实现选定的具体数字要写出来：07 的实测据此收紧。
    expect(fiber.config).toEqual({ everySteps: 50, keepRecentSteps: 10 })
    // 不变式：第 M 步时已有 M-1 条已记录步骤，减掉保留窗口 K 必须为正，也就是 M ≥ K + 2。
    expect(fiber.config.everySteps).toBeGreaterThanOrEqual(fiber.config.keepRecentSteps + 2)
    await ctx.fiber.dispose()
  })

  it('把 M 调小后同一构造更早触发', async () => {
    // 默认 M = 50 时这一构造（6 步）一次都不会触发；换成 M = 2 后第 2 步就到点。
    const small = await drive({ steps: M, config: { everySteps: 2, keepRecentSteps: K } })
    const writes = small.samples.map(sample => sample.prunes)
    // 默认 M = 50 时这一构造（6 步）一次都不会触发；M = 2 时第 2 步就到点，但**到点不等于落盘**：
    // 那一刻只有 1 条已记录，全在保留窗口 K = 2 里，所以本批为空、不写（写入侧禁止空 targets）。
    // 第一次真正落盘因此在第 4 步。这条同时是「M ≥ K + 2」这条默认值不变式的活证据。
    expect(writes).toEqual([0, 0, 0, 1, 1, 2])
    await small.lc.dispose()
  })
})

describe('票 03 · 触发判据的纯函数面（不依赖真实 loop）', () => {
  /** 造一个「第 `step` 步的 pre-step 已发生」的会话：已记录步骤恰为 `step - 1` 条。 */
  function sessionAtStep(step: number): FakeSession {
    return fakeSession(Array.from({ length: step - 1 }, (_unused, index) => ({
      reasoning: reasoningOf(index),
      text: `text ${index}`,
    })))
  }

  it('到达整数倍时按「已记录步骤减保留窗口」选出该批；未到点不写', () => {
    // 第 5 步（未到点）与第 7 步（不是整数倍）都不写；第 6 步写出最早的 5-2=3 条。
    const early = sessionAtStep(5) as unknown as Session
    expect(pruneAtStepBoundary(early, 5, new AbortController().signal, CONFIG)).toBeUndefined()
    expect(persistedPrunes(early)).toEqual([])

    const offBeat = sessionAtStep(7) as unknown as Session
    expect(pruneAtStepBoundary(offBeat, 7, new AbortController().signal, CONFIG)).toBeUndefined()
    expect(persistedPrunes(offBeat)).toEqual([])

    const onBeat = sessionAtStep(M) as unknown as Session
    const seqs = recordedAssistants(onBeat).map(entry => entry.seq)
    expect(pruneTargetsAtStep(onBeat, M, CONFIG)).toEqual(seqs.slice(0, 3))
    expect(pruneAtStepBoundary(onBeat, M, new AbortController().signal, CONFIG)).toBeDefined()
    expect(persistedPrunes(onBeat)[0]!.targets).toEqual(seqs.slice(0, 3))
  })

  it('已裁过的不再进下一批，且保留窗口之外的步骤都会被推进掉', () => {
    const signal = new AbortController().signal

    // 第 6 步：5 条已记录（本步骤的消息还没落），保留最近 2 条 → 裁那时最早的 3 条。
    const atSix = sessionAtStep(M) as unknown as Session
    pruneAtStepBoundary(atSix, 6, signal, CONFIG)
    const first = recordedAssistants(atSix).slice(0, 3).map(entry => entry.seq)
    expect(persistedPrunes(atSix)[0]!.targets).toEqual(first)
    // 第 7 步不是整数倍：不写，也不推进。
    expect(pruneAtStepBoundary(atSix, 7, signal, CONFIG)).toBeUndefined()
    expect(persistedPrunes(atSix)).toHaveLength(1)

    // 第 12 步：11 条已记录，去掉已裁的 3 条，保留窗口是「未裁过的里面最近 2 条」（第 10、11 条），
    // 剩下第 4..9 条（索引 3..8）进本批。这是**同一条会话**上的第二次推进，所以先把第一批的日志带过去。
    const atTwelve = sessionAtStep(2 * M) as unknown as Session
    expect(persistReasoningPrune(atTwelve, first as SessionSeq[])).toBeDefined()
    pruneAtStepBoundary(atTwelve, 12, signal, CONFIG)
    const all = recordedAssistants(atTwelve)
    const prunes = persistedPrunes(atTwelve)
    expect(prunes).toHaveLength(2)
    expect(prunes[1]!.targets).toEqual(all.slice(3, 9).map(entry => entry.seq))
    expect(prunes[0]!.targets.filter(target => prunes[1]!.targets.includes(target))).toEqual([])
  })

  it('已记录步骤不超过保留窗口时本批为空', () => {
    // `M = K + 1`：第 M 步时只有 K 条已记录，正好全是保留窗口，本批为空（这正是默认值必须满足
    // `M ≥ K + 2` 的原因）。
    const degenerate = sessionAtStep(K + 1) as unknown as Session
    expect(pruneTargetsAtStep(degenerate, K + 1, { everySteps: K + 1, keepRecentSteps: K })).toEqual([])
    // 再多一步：`M ≥ K + 2` 下同一批就非空了。
    const healthy = sessionAtStep(K + 2) as unknown as Session
    expect(pruneTargetsAtStep(healthy, K + 2, { everySteps: K + 2, keepRecentSteps: K })).toHaveLength(1)
  })
})
