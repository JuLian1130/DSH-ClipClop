/**
 * 票 09：激活点 ⑤ —— 裁剪拒收后的还原与停用。
 *
 * 票据判据逐条落在这里（编号照票面 `- [ ]`）。四条口径先写死，否则用例会自己骗自己：
 *
 * - **失败必须是真实的**：`failWhen` 让适配器真的抛 `LlmError`，运行期把它归一化成
 *   `agent/request-error` 的 `payload.failure`；伪造一条事件绕不过 `assistant/attempt` 与终局 `throw`。
 * - **拒收必须落在「已有裁剪事件」的会话上**：第三把锁要求本会话已存在裁剪事件，所以每个现场都先驱动
 *   turn 1 走满 6 步（`toolsThrough = 5`），在其中第 4 步（`M = 4` 的整数倍）真的落一条裁剪。
 * - **反例必须与正面同形**：三条反例各自只差一个条件（码 / 三词 / 已有裁剪），其余构造逐字相同，否则
 *   「零写入」在「本插件根本不写」时也成立。
 * - **「信号已中止」也必须是真实的**：`failWhen` 在返回失败前调 `agent.cancel()`，于是瀑布跑到本插件时
 *   `signal.aborted` 已经是真——不是把信号伪造成常量。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import {
  CARRIER_EVENT_TYPE,
  isPruningSuspended,
  MANUAL_COMMAND_NAME,
  persistReasoningPrune,
  pruneAtRequestError,
  pruneTargetsAtCommand,
  pruneTargetsAtStep,
  readPrunedSteps,
} from '../src/index.ts'
import { replayEnvelopeAlignsWithContent } from '../src/replay.ts'
import { reasoningPrunerProjection } from '../src/projection.ts'
import type { FakeSession, LifecycleOptions, PersistentLifecycle } from './support/session-harness.ts'
import {
  cleanupRoots,
  lifecycle,
  persistedPrunes,
  persistedSuspensions,
  rawLogText,
  reasoningTexts,
  recordedAssistants,
  registerTool,
  remount,
  restore,
  surfaceReading,
  toolCallScript,
} from './support/session-harness.ts'
import {
  assistantEvent,
  assistantMessage,
  carrierEvent,
  piAiReplayState,
  projectionContext,
} from './support/fixtures.ts'

afterEach(cleanupRoots)

/** 保留窗口 `K`：turn 1 走 6 步，窗口之外只剩第 1 步，于是第一批恰好一个目标。 */
const K = 2
/** 节流 `M`：第 4 步触发一次裁剪；之后第 8、12 步是 ② 的后续触发点。 */
const M = 4
/** turn 1 的步数（`toolsThrough = 5` ⇒ 前 5 次调用发起工具调用、第 6 次收尾）。 */
const FIRST_TURN_STEPS = 6

/** 三词同时命中的拒收正文（大小写不敏感）。 */
const REJECTION_MESSAGE =
  'Error 400: reasoning_content must be passed back for every assistant message while thinking mode is enabled.'
/** 第一把锁里的兜底码（网关正文不含 `400`/`invalid request` 字样时的那一档）。 */
const FALLBACK_REJECTION_CODE = 'PI_AI_ERROR'
/** 溢出救援的码：与「请求被拒」那一支不相交。 */
const OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** 每个现场一个唯一会话身份（同一落盘根里 `id` 只能用一次）。 */
let sessionCounter = 0

/** 一次构造的现场。 */
interface Driven {
  readonly lc: PersistentLifecycle
  readonly agent: Agent
  readonly session: Session
  readonly id: string
}

/** 一次「在某条 turn 文本上构造一次失败」的声明。 */
interface ArmedFailure {
  /** 请求里出现这条文本的那一次调用失败；只命中一次。 */
  readonly text: string
  readonly message: string
  readonly code: string
}

/** `drive` 的可选项。 */
interface DriveOptions {
  readonly everySteps?: number
  readonly keepRecentSteps?: number
  readonly withPlugin?: boolean
  readonly root?: string
  /** 是否驱动 turn 1（默认驱动；`false` 用来构造「本会话没有裁剪事件」的反例）。 */
  readonly firstTurn?: boolean
  /**
   * 构造「拒收时信号已中止」：在 `prepend` 缝上注册一个跑在本插件**之前**的监听器，等拒收真的到达时
   * 把本 turn 取消掉。**不能在 `failWhen` 里取消**——那会让 stream 之后的 `signal.throwIfAborted()` 先抛，
   * 瀑布根本不跑（实测），构造不出「处理器看到已中止的信号」这个状态。
   */
  readonly abortOnRejection?: boolean
}

/**
 * 建一个现场并（默认）驱动 turn 1：6 步、第 4 步落一条裁剪。
 * @param armed - 逐 turn 文本的失败声明。
 * @param options - 覆盖 `M`/`K`/是否挂插件/是否复用落盘根/是否驱动 turn 1。
 * @returns 现场。
 */
async function drive(armed: readonly ArmedFailure[] = [], options: DriveOptions = {}): Promise<Driven> {
  const pending = new Map(armed.map(entry => [entry.text, entry]))
  let agent: Agent | undefined
  const failWhen: LifecycleOptions['failWhen'] = (request) => {
    for (const [text, failure] of pending) {
      const hit = request.messages.some(message =>
        message.content.some(block => block.type === 'text' && block.text === text))
      if (!hit) continue
      // 只命中一次：重试那一次必须能成功，否则「重试成功」不可观察。
      pending.delete(text)
      return { message: failure.message, code: failure.code }
    }
    return undefined
  }
  const config = {
    everySteps: options.everySteps ?? M,
    keepRecentSteps: options.keepRecentSteps ?? K,
  }
  const lifecycleOptions: LifecycleOptions = {
    config,
    toolsThrough: FIRST_TURN_STEPS - 1,
    failWhen,
    // `prepend` 在插件装载之后被调，所以这里 `{prepend: true}` 注册的监听器排在插件之前（后注册的
    // `unshift` 到队首）。只在需要构造「处理器看到已中止的信号」时用。
    ...options.abortOnRejection === true
      ? {
        prepend: (ctx: Context) => {
          ctx.on('agent/request-error', (payload, next) => {
            if (armed.some(entry => entry.code === payload.failure.code)) payload.agent.cancel({ kind: 'user' })
            return next()
          }, { prepend: true })
        },
      }
      : {},
    ...options.withPlugin === undefined ? {} : { withPlugin: options.withPlugin },
  }
  const lc = options.root === undefined
    ? await lifecycle(toolCallScript(40), lifecycleOptions)
    : await remount(options.root, toolCallScript(40), lifecycleOptions)
  registerTool(lc.ctx, 'noop')
  const id = `rejection-${sessionCounter}`
  sessionCounter += 1
  const created = await lc.createSession(id)
  agent = created.agent
  if (options.firstTurn !== false) await lc.step(created.agent, 'first turn')
  return { lc, agent: created.agent, session: created.session, id }
}

/** 日志里承载类型的事件条数（裁剪决策与停用决策都算）。 */
function carrierCount(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === CARRIER_EVENT_TYPE).length
}

/** 某次请求的模型可见推理文本（按调用下标）。 */
function requestReasoning(lc: PersistentLifecycle, index: number): readonly string[] {
  return lc.calls[index]?.reasoning ?? []
}

/** 模型可见历史里那条 assistant 消息（按 msg id 认）。 */
function visibleAssistant(session: Session, id: string): AssistantMessage | undefined {
  return session.deriveMessages().find((message): message is AssistantMessage =>
    message.role === 'assistant' && message.id === id)
}

/** 日志里那条已记录的 assistant 消息。 */
function recordedAssistant(session: Session, seq: number): AssistantMessage {
  const event = session.snapshotEvents().find(candidate => candidate.seq === seq)
  if (event?.type !== 'assistant/message') throw new Error(`fixture: seq ${seq} is not an assistant/message`)
  return event.data.message
}

/** 某条已记录 assistant 消息上的推理块文本。 */
function reasoningOf(message: AssistantMessage): string[] {
  return message.content.filter(block => block.type === 'reasoning').map(block => block.text)
}

/**
 * 驱动 `count` 个 turn，文本逐条不同。
 *
 * 后续 turn 都是**一步**：适配器的 `toolsThrough` 按全局调用计数，turn 1 用满之后新 turn 只会走一个步骤。
 * 于是「到 `M` 的整数倍」需要驱动到第 `M` 个 turn——这是「新建会话照常落盘」唯一不靠猜测的写法。
 * @param lc - 生命周期。
 * @param agent - 目标会话的 agent。
 * @param prefix - 各 turn 文本的前缀（同一条会话内不得重复）。
 * @param count - turn 数。
 */
async function driveTurns(lc: PersistentLifecycle, agent: Agent, prefix: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await lc.step(agent, `${prefix} ${index + 1}`)
}

/** 落盘字节里本插件承载事件的那些行（`session-log-deepseek` 原样上传的就是这些 `data`）。 */
function carrierLines(raw: string): string[] {
  return raw.split('\n').filter(line => line.includes('clipclop'))
}

describe('票 09 · 第 1 条：三把锁，且三个反例各零写入', () => {
  it('三把锁全中时落一条停用事件；只差一个条件的三个反例一条都不落', async () => {
    // 正面：码属拒收支、正文三词全中、本会话已有裁剪事件 ⇒ 落**一条**。
    const positive = await drive([{ text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' }])
    expect(persistedPrunes(positive.session)).toHaveLength(1)
    const carriersBefore = carrierCount(positive.session)
    await positive.lc.step(positive.agent, 'second turn')
    expect(persistedSuspensions(positive.session)).toHaveLength(1)
    expect(carrierCount(positive.session)).toBe(carriersBefore + 1)
    await positive.lc.dispose()

    // 反例①：只命中码（正文没有三词）。
    const codeOnly = await drive([{ text: 'second turn', message: 'Error 400: bad request body.', code: 'INVALID_REQUEST' }])
    const codeOnlyBefore = carrierCount(codeOnly.session)
    await codeOnly.lc.step(codeOnly.agent, 'second turn')
    expect(carrierCount(codeOnly.session)).toBe(codeOnlyBefore)
    expect(persistedSuspensions(codeOnly.session)).toEqual([])
    // 判据非空：本会话确有裁剪事件、窗口外也确有候选，所以「零写入」不是因为没有候选。
    expect(persistedPrunes(codeOnly.session)).toHaveLength(1)
    expect(pruneTargetsAtCommand(codeOnly.session).length).toBeGreaterThan(0)
    await codeOnly.lc.dispose()

    // 反例②：只命中文本（码不属于「请求被拒」这一支）。
    const textOnly = await drive([{ text: 'second turn', message: REJECTION_MESSAGE, code: 'SERVER' }])
    const textOnlyBefore = carrierCount(textOnly.session)
    await textOnly.lc.step(textOnly.agent, 'second turn')
    expect(carrierCount(textOnly.session)).toBe(textOnlyBefore)
    expect(persistedSuspensions(textOnly.session)).toEqual([])
    await textOnly.lc.dispose()

    // 反例③：文本与码都命中，但本会话**没有**裁剪事件（`M` 大到 turn 1 不触发）。
    const noPrune = await drive(
      [{ text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' }],
      { everySteps: 500 },
    )
    expect(persistedPrunes(noPrune.session)).toEqual([])
    const noPruneBefore = carrierCount(noPrune.session)
    await noPrune.lc.step(noPrune.agent, 'second turn')
    expect(carrierCount(noPrune.session)).toBe(noPruneBefore)
    expect(persistedSuspensions(noPrune.session)).toEqual([])
    // 判据非空：候选其实存在（窗口外还有步骤），第三把锁是唯一拦住它的条件。
    expect(pruneTargetsAtCommand(noPrune.session).length).toBeGreaterThan(0)
    await noPrune.lc.dispose()
  })

  it('放宽到 PI_AI_ERROR：网关正文不含 400/invalid request 字样时同样触发', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: FALLBACK_REJECTION_CODE },
    ])
    await lc.step(agent, 'second turn')
    expect(persistedSuspensions(session)).toHaveLength(1)
    expect(persistedSuspensions(session)[0]!.envelope['errorCode']).toBe(FALLBACK_REJECTION_CODE)
    await lc.dispose()
  })
})

describe('票 09 · 第 2 条：还原与停用是同一条事件，不得出现中间态', () => {
  it('只追加一次 append：一条事件同时带 restore 与停用事实，重载后形状与条数一致', async () => {
    const { lc, agent, session, id } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    const prunedSeqs = persistedPrunes(session).flatMap(entry => entry.targets)
    const before = carrierCount(session)
    await lc.step(agent, 'second turn')

    // 判据非空：被还原的就是此前真的裁过的那些 seq。
    expect(prunedSeqs.length).toBeGreaterThan(0)
    expect(carrierCount(session)).toBe(before + 1)
    const suspensions = persistedSuspensions(session)
    expect(suspensions).toHaveLength(1)
    expect([...suspensions[0]!.restore].sort((a, b) => a - b)).toEqual([...prunedSeqs].sort((a, b) => a - b))

    // 重载后读日志：仍是一条，且同一个停用判定成立（没有「只还原未停用」的中间态）。
    // `restore` 走 `sessions.prepare`，不能对**同一生命周期里已存在**的会话再用一次，所以换一次重挂载。
    await lc.ctx.sessions.flush(session)
    const root = lc.root
    await lc.dispose()
    const plan = await remount(root, toolCallScript(40), {
      config: { everySteps: M, keepRecentSteps: K },
      toolsThrough: FIRST_TURN_STEPS - 1,
    })
    const reloaded = restore(plan, id, await plan.coldRead(id))
    expect(persistedSuspensions(reloaded)).toHaveLength(1)
    expect(isPruningSuspended(reloaded)).toBe(true)
    await plan.dispose()
  })
})

describe('票 09 · 第 3 条：还原只覆盖仍是当前表面节点的目标', () => {
  it('被裁步骤的推理块回到下一次请求里，内容与信封与原文逐位一致', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    const target = persistedPrunes(session)[0]!.targets[0]!
    const original = recordedAssistant(session, target)
    const restoredReasoning = reasoningOf(original)
    expect(restoredReasoning.length).toBeGreaterThan(0)
    // 裁剪版在先：turn 1 之后的模型可见历史里没有这条推理。
    expect(reasoningTexts(session)).not.toContain(restoredReasoning[0])

    const callsBefore = lc.calls.length
    await lc.step(agent, 'second turn')

    // 失败那一次请求带的是**裁剪版**（三把锁的前提），重试那一次才带回还原后的历史。
    expect(requestReasoning(lc, callsBefore)).not.toContain(restoredReasoning[0])
    expect(requestReasoning(lc, callsBefore + 1)).toContain(restoredReasoning[0])
    // 还原拿到的是原文：内容与信封逐位一致 ⇒ 存活块签名保留。
    const visible = visibleAssistant(session, original.id)
    // 同一性而不只是深比较：设计文档「验证状态 · 未验证」把「还原拿到的是原文对象」记为插件侧新引入的契约，
    // 并点名要本插件自己的测试钉住它（本仓既有的投影测试只做深比较）。
    expect(visible).toBe(original)
    expect(visible).toEqual(original)
    expect(replayEnvelopeAlignsWithContent(visible!)).toBe(true)
    // 还原列表只列当前表面节点上的 seq。
    const nodes = new Set<number>(session.surface.nodes)
    expect(persistedSuspensions(session)[0]!.restore.every(seq => nodes.has(seq))).toBe(true)
    await lc.dispose()
  })
})

describe('票 09 · 第 4 条：停用覆盖 ①②④，且只按会话生效', () => {
  it('①②④ 三个入口都不再增加裁剪事件；新建会话照常；fork 出的子会话继承停用', async () => {
    // turn 2 的第一条请求被拒收 ⇒ 落一条还原 + 停用；重试成功。turn 3 上再构造一次溢出失败（①）。
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
      { text: 'third turn', message: 'context window exceeded', code: OVERFLOW_CODE },
    ])
    await lc.step(agent, 'second turn')
    expect(persistedSuspensions(session)).toHaveLength(1)
    const afterSuspension = carrierCount(session)

    // ②（第 8 步是 `M` 的整数倍）与 ①（同一步上的溢出失败）都在 turn 3 上：两条都不得落盘。
    await lc.step(agent, 'third turn')
    expect(carrierCount(session)).toBe(afterSuspension)
    // 判据非空：这一步真到了 ② 的触发点，窗口外也确实有候选。
    expect(pruneTargetsAtStep(session, { everySteps: M, keepRecentSteps: K }).length).toBeGreaterThan(0)

    // ④：手动命令同样不得落盘。
    await lc.ctx.commands.execute(agent, `/${MANUAL_COMMAND_NAME}`, [], new AbortController().signal)
    expect(carrierCount(session)).toBe(afterSuspension)
    // 判据非空：④ 的候选非空（不设保留窗口）。
    expect(pruneTargetsAtCommand(session).length).toBeGreaterThan(0)

    // 新建的会话不受影响：同一个生命周期里另开一条，驱动到第 4 步（`M` 的整数倍）照常落一条裁剪。
    const fresh = await lc.createSession(`fresh-${sessionCounter}`)
    sessionCounter += 1
    await driveTurns(lc, fresh.agent, 'fresh', M)
    expect(persistedPrunes(fresh.session)).toHaveLength(1)

    // fork 出的子会话继承日志前缀 ⇒ 也继承停用。`fork` 给回的是 Session（host 侧不另配 agent），而判据的
    // 对象正是「三入口共用的那一条从日志重建的停用判定」，所以直接打入口：候选非空时一条都不落。
    const boundary = session.snapshotEvents().at(-1)!.seq
    const child = lc.ctx.sessions.fork(session, boundary, SessionId(`rejection-child-${sessionCounter}`))
    sessionCounter += 1
    expect(isPruningSuspended(child)).toBe(true)
    expect(pruneTargetsAtStep(child, { everySteps: M, keepRecentSteps: K }).length).toBeGreaterThan(0)
    const childCarriers = carrierCount(child)
    expect(pruneAtRequestError(child, new AbortController().signal, { everySteps: M, keepRecentSteps: K }))
      .toBeUndefined()
    expect(carrierCount(child)).toBe(childCarriers)
    await lc.dispose()
  })
})

describe('票 09 · 第 5 条：同一步重试恰好一次；中止仍落盘但不重试', () => {
  it('一次拒收只换来一次重试', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    const callsBefore = lc.calls.length
    await lc.step(agent, 'second turn')
    // 本步恰好两次模型调用：失败那次 + 重试那次。断「恰好」，不是只断「重试了」。
    expect(lc.calls.length - callsBefore).toBe(2)
    expect(persistedSuspensions(session)).toHaveLength(1)
    await lc.dispose()
  })

  it('拒收时信号已中止：事件仍然落盘，但没有重试', async () => {
    const { lc, agent, session } = await drive(
      [{ text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' }],
      { abortOnRejection: true },
    )
    const callsBefore = lc.calls.length
    await lc.step(agent, 'second turn')
    // 落盘照旧（不落的话下一次请求还会再撞一次）。
    expect(persistedSuspensions(session)).toHaveLength(1)
    // 没有重试：本步只有失败那一次模型调用。
    expect(lc.calls.length - callsBefore).toBe(1)
    await lc.dispose()
  })
})

describe('票 09 · 第 6 条：空壳消息不具裁剪资格', () => {
  /** 一条只有推理块的 assistant 消息（连同逐位对齐的信封）。 */
  function shellMessage(): AssistantMessage {
    return assistantMessage({
      content: [{ type: 'reasoning', text: 'only thinking' }],
      replayState: piAiReplayState('openai-completions', [{ type: 'reasoning', thinkingSignature: 'sig-think' }]),
    })
  }

  /** 一条普通可裁消息（文本 + 推理）。 */
  function normalMessage(): AssistantMessage {
    return assistantMessage({
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'thinking' },
      ],
      replayState: piAiReplayState('openai-completions', [
        { type: 'text', textSignature: 'sig-text' },
        { type: 'reasoning', thinkingSignature: 'sig-think' },
      ]),
    })
  }

  it('投影不裁它：整条消息（含推理块）仍留在模型可见历史里', () => {
    const payload = { clipclop: { targets: [SessionSeq(0)] } }
    const shellEvents: SessionEvent[] = [assistantEvent(0, shellMessage()), carrierEvent(1, payload)]
    const normalEvents: SessionEvent[] = [assistantEvent(0, normalMessage()), carrierEvent(1, payload)]

    // 判据非空：同一条 payload 打在普通消息上确实产出裁剪版。
    const prunedNormal = foldSurface(normalEvents, [reasoningPrunerProjection])
    expect(prunedNormal.projectedMessages.size).toBe(1)
    expect(prunedNormal.projectedMessages.get(SessionSeq(0))!.content).toHaveLength(1)

    // 空壳消息：零替换，节点仍在，整条消息逐字不变。
    const untouched = foldSurface(shellEvents, [reasoningPrunerProjection])
    expect(untouched.projectedMessages.size).toBe(0)
    expect(untouched.nodes).toEqual([SessionSeq(0)])
    expect(reasoningPrunerProjection.project(
      shellEvents[1] as SessionEvent<typeof CARRIER_EVENT_TYPE>,
      projectionContext(shellEvents, [SessionSeq(0)]),
    ).size).toBe(0)
  })

  it('写入侧也不为它落事件，而同一次调用换普通消息会落', () => {
    // 真适配器**总是**带一个文本块，造不出「只有推理块」的历史步骤，所以这里用最小的会话面。
    for (const [label, message] of [['空壳', shellMessage()], ['普通', normalMessage()]] as const) {
      const events: SessionEvent[] = [
        { type: 'step/start', seq: SessionSeq(0), time: 0, data: { turn: 1, step: 1 } } as SessionEvent,
        assistantEvent(1, message),
      ]
      let next = 2
      const session: FakeSession = {
        events,
        surface: { nodes: [SessionSeq(1)], replaceGeneration: 0, contentGeneration: 0 },
        snapshotEvents: (from = 0, toExclusive = events.length) => events.slice(from, toExclusive),
        ownEvents: () => events,
        inheritedEventCount: SessionLogOffset(0),
        append: (type: string, data: unknown) => {
          const event = { type, seq: SessionSeq(next), time: 0, data } as SessionEvent
          next += 1
          events.push(event)
          return event
        },
      }
      const written = persistReasoningPrune(session as unknown as Session, [SessionSeq(1)])
      if (label === '空壳') {
        expect(written).toBeUndefined()
        expect(events).toHaveLength(2)
      } else {
        expect(written).toBeDefined()
        expect(events).toHaveLength(3)
      }
    }
  })
})

describe('票 09 · 第 7、8 条：重载一致与持久化门禁', () => {
  it('插件缺席时承载事件是惰性的：同一份日志重建出未裁剪历史，且不被拒绝', async () => {
    const { lc, session, id } = await drive([])
    // 判据非空：装载插件时这一步的推理**不在**模型可见历史里。
    const pruned = persistedPrunes(session).flatMap(entry => entry.targets)
    expect(pruned.length).toBeGreaterThan(0)
    const hidden = reasoningOf(recordedAssistant(session, pruned[0]!))
    expect(reasoningTexts(session)).not.toContain(hidden[0])

    await lc.ctx.sessions.flush(session)
    const root = lc.root
    await lc.dispose()

    // 未装载本插件的读者：冷读不拒绝整段日志，投影缺席 ⇒ 重建出**未裁剪**历史。
    const plan = await remount(root, toolCallScript(40), {
      config: { everySteps: M, keepRecentSteps: K },
      toolsThrough: FIRST_TURN_STEPS - 1,
      withPlugin: false,
    })
    const cold = await plan.coldRead(id)
    expect(cold.events.length).toBeGreaterThan(0)
    expect(reasoningTexts(restore(plan, id, cold))).toContain(hidden[0])
    await plan.dispose()
  })

  it('含停用事件的会话：装载插件时重载得到逐字节相同的历史，插件缺席时也不被拒绝', async () => {
    const { lc, agent, session, id } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    await lc.step(agent, 'second turn')
    const runtime = session.deriveMessages()
    // 持久化门禁：落盘用的是**已知承载类型**，不是插件自建类型（自建类型不在生成集合里，冷读会拒收）。
    const carriers = session.snapshotEvents().filter(event => event.type === CARRIER_EVENT_TYPE)
    expect(carriers.length).toBeGreaterThan(0)

    await lc.ctx.sessions.flush(session)
    const root = lc.root
    await lc.dispose()

    // 装载插件的重载：新 context、投影真的再注册一次，得到逐字节相同的模型可见历史。
    const reloadPlan = await remount(root, toolCallScript(40), {
      config: { everySteps: M, keepRecentSteps: K },
      toolsThrough: FIRST_TURN_STEPS - 1,
    })
    const reloaded = restore(reloadPlan, id, await reloadPlan.coldRead(id))
    expect(JSON.stringify(reloaded.deriveMessages())).toBe(JSON.stringify(runtime))
    // 重载后仍是已停用。
    expect(isPruningSuspended(reloaded)).toBe(true)
    await reloadPlan.dispose()

    // 未装载本插件的读者：冷读不拒绝含停用事件的日志（持久化门禁），且这些事件惰性穿过。
    const plan = await remount(root, toolCallScript(40), {
      config: { everySteps: M, keepRecentSteps: K },
      toolsThrough: FIRST_TURN_STEPS - 1,
      withPlugin: false,
    })
    const cold = await plan.coldRead(id)
    expect(cold.events.length).toBeGreaterThan(0)
    const withoutPlugin = restore(plan, id, cold)
    expect(JSON.stringify(withoutPlugin.deriveMessages())).toBe(JSON.stringify(runtime))
    await plan.dispose()
  })
})

describe('票 09 · 第 9 条：诊断载荷可事后追查，且不含会话文本', () => {
  it('载荷恰含五个字段，且落盘字节里没有错误原文与会话文本', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    await lc.step(agent, 'second turn')
    const suspension = persistedSuspensions(session)[0]!
    expect(Object.keys(suspension.envelope).sort()).toEqual(
      ['errorCode', 'model', 'provider', 'restore', 'wording'].sort(),
    )
    expect(suspension.envelope['provider']).toBe('mock')
    expect(suspension.envelope['model']).toBe('mock')
    expect(suspension.envelope['errorCode']).toBe('INVALID_REQUEST')
    expect(typeof suspension.envelope['wording']).toBe('string')

    // 观察面是**落盘字节**：`session-log-deepseek` 把 `data` 原样上传，所以要在这一层断。
    await lc.ctx.sessions.flush(session)
    const lines = carrierLines(await rawLogText(lc.root))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain(REJECTION_MESSAGE)
      expect(line).not.toContain('first turn')
      expect(line).not.toContain('second turn')
      expect(line).not.toContain('only thinking')
    }
    await lc.dispose()
  })
})

describe('票 09 · 第 10 条：不引入端点记忆', () => {
  it('同一个进程里新会话照常裁剪：停用只按会话生效，没有跨会话/跨进程状态', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    await lc.step(agent, 'second turn')
    expect(isPruningSuspended(session)).toBe(true)
    // 另一条会话在同一个 provider/model 上照常产生裁剪事件——接受度不是按端点记忆的。
    const other = await lc.createSession(`memory-${sessionCounter}`)
    sessionCounter += 1
    await driveTurns(lc, other.agent, 'other', M)
    expect(persistedPrunes(other.session)).toHaveLength(1)
    expect(isPruningSuspended(other.session)).toBe(false)
    await lc.dispose()
  })
})

describe('票 09 · 停用判定的取值来源是日志', () => {
  it('停用事件带的是 restore：已裁集合不因它改变，裁剪决策计数也不增长', async () => {
    const { lc, agent, session } = await drive([
      { text: 'second turn', message: REJECTION_MESSAGE, code: 'INVALID_REQUEST' },
    ])
    const before = [...readPrunedSteps(session)].sort((a, b) => a - b)
    await lc.step(agent, 'second turn')
    expect([...readPrunedSteps(session)].sort((a, b) => a - b)).toEqual(before)
    expect(surfaceReading(session).prunes).toBe(1)
    await lc.dispose()
  })
})
