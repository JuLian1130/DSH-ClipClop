/**
 * 票 04 的集成层其余不变式（第 4–8 条）：日志可重建、工具配对、`fork` 一致、重载与降级两方向、
 * 资格强制作。
 *
 * 第 1–3 条（退化反例）在 `replay-envelope-piai.spec.ts` 与 `replay-envelope-messages.spec.ts`，观察面是
 * **真实适配器 config 上的 `onReplayDegrade`**；本文件的观察面是**日志与模型可见历史**，所以它建在 02 的
 * 真实会话夹具上（真 agent loop + 真 JSONL 落盘 + 真重挂载），不重复第 1–3 条的用例。
 *
 * 两处口径决定本文件怎么读：
 *
 * - **步号**与 03 一致：`agent/pre-step` 在该步**之前**发出，第 N 次 pre-step 时已有 N-1 条已记录的
 *   `assistant/message`。节流按日志里的 `step/start` 条数（`persist.ts` 的 `sessionStepNumber`），所以
 *   跨 turn 累计步数决定触发点，逐 turn `lc.step()` 驱动即可。
 * - **`targets` 与模型可见历史覆盖两个不同的环节**（第 8 条）：前者是写入侧资格过滤**之后**的产物，只能
 *   证明「无资格的步骤没被写进去」；「服务端按 replay 信封强制」只有模型可见历史那一侧看得到。两侧都断。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isReasoningPrunable } from '../src/replay.ts'
import type { PersistentLifecycle, ScriptedStep } from './support/session-harness.ts'
import {
  cleanupRoots,
  lifecycle,
  persistedPrunes,
  reasoningTexts,
  recordedAssistants,
  remount,
  restore,
} from './support/session-harness.ts'

afterEach(cleanupRoots)

/**
 * 本文件用的节流参数：`M = 2`、`K = 0`（保持 `M ≥ K + 2` 这条不变式）。
 *
 * 取值只为把「一条真实的已裁消息」造出来；`M`/`K` 的数字由 07 的实测收紧，本票不改默认值。
 */
const CONFIG = { everySteps: 2, keepRecentSteps: 0 }

/** 每一步都发起一次工具调用、且推理文本逐索引不同的脚本；`toolsThrough` 决定一个 turn 走几步。 */
const SCRIPT: ScriptedStep[] = Array.from({ length: 12 }, (_unused, index) => ({
  reasoning: `thinking ${index}`,
  text: `text ${index}`,
  calls: [{ name: 'noop', arguments: '{"index":' + String(index) + '}' }],
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

/** 驱动一个恰好 `steps` 步的 turn（脚本每步都带工具调用，收尾交给适配器）。 */
async function drive(steps: number): Promise<{ lc: PersistentLifecycle, session: Session }> {
  const lc = await lifecycle(SCRIPT, { config: CONFIG, toolsThrough: steps - 1 })
  registerTool(lc.ctx, 'noop')
  const { agent, session } = await lc.createSession('gate-c')
  await lc.step(agent, 'go')
  return { lc, session }
}

/** 日志里的 `assistant/message`，按 seq 升序。 */
interface LoggedAssistant {
  readonly seq: number
  readonly event: SessionEvent<'assistant/message'>
  readonly types: readonly string[]
}

/** 从一段事件里取出全部 `assistant/message`。 */
function loggedAssistants(events: readonly SessionEvent[]): LoggedAssistant[] {
  return events
    .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    .map(event => ({
      seq: event.seq,
      event,
      types: event.data.message.content.map(block => block.type),
    }))
}

/** 从一段事件里取出全部 `tool/result`（message 的 callId 与错误标志）。 */
function loggedResults(events: readonly SessionEvent[]): { id: string, isError: boolean }[] {
  return events
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => ({ id: String(event.data.message.toolCallId), isError: event.data.message.isError === true }))
}

/** 模型可见历史里的工具结果（与 {@link loggedResults} 同形状，供逐项对照）。 */
function visibleResults(session: Session): { id: string, isError: boolean }[] {
  return session.deriveMessages().flatMap(message => message.role === 'tool'
    ? [{ id: String(message.toolCallId), isError: message.isError === true }]
    : [])
}

/** 模型可见历史里每条 assistant 消息的内容块类型序列。 */
function visibleBlockTypes(session: Session): string[][] {
  return session.deriveMessages().flatMap(message =>
    message.role === 'assistant' ? [message.content.map(block => block.type)] : [])
}

/** 取出模型可见历史里第 `index` 条 assistant 消息的内容（越界即测试自身出错）。 */
function visibleAssistantContent(session: Session, index: number): readonly ContentBlock[] {
  const message = session.deriveMessages().filter(candidate => candidate.role === 'assistant')[index]
  if (message === undefined) throw new Error(`no assistant message at index ${String(index)}`)
  return message.content
}

describe('票 04 · 第 4 条：裁剪后的日志仍能独立重建每个请求', () => {
  it('顺序、role、其余内容块、工具调用 id 与工具结果配对在裁剪后齐全不变', async () => {
    const { lc, session } = await drive(6)

    // 判据非空：确实发生了裁剪，否则「不变」在未裁剪的历史上也成立。
    const prunedSeqs = new Set(persistedPrunes(session).flatMap(entry => entry.targets))
    expect(prunedSeqs.size).toBeGreaterThan(0)

    // `coldRead` 读的是**已落盘**的日志，而写缓冲只在后端自己的 teardown 里排空；要在 `dispose()` 之前读
    // 同一份日志，必须显式过一次 `session/flush`。
    await lc.ctx.sessions.flush(session)
    const log = await lc.coldRead('gate-c')
    const logged = loggedAssistants(log.events)

    // 顺序与 role：日志里的每一条 assistant/message 按序对应模型可见历史里的同序 assistant 消息——逐项比，
    // 不是只比条数（只比条数时「顺序被打乱」也全绿）。被裁消息在可见侧恰好少掉 reasoning 一个块，其余
    // 内容块逐位相同；没被裁的消息两边完全一致。
    expect(visibleBlockTypes(session)).toHaveLength(logged.length)
    logged.forEach((entry, index) => {
      const visibleTypes = visibleAssistantContent(session, index).map(block => block.type)
      expect(visibleTypes).toEqual(prunedSeqs.has(entry.seq)
        ? entry.types.filter(type => type !== 'reasoning')
        : entry.types)
    })

    // 被裁消息在日志里仍保留推理块（裁剪不销毁原件，见第 4 条的日志侧）。
    for (const entry of logged) {
      if (prunedSeqs.has(entry.seq)) expect(entry.types).toContain('reasoning')
    }

    // 工具调用 id 与工具结果配对。
    const callIds = logged.flatMap(entry => entry.event.data.message.content.flatMap(block =>
      block.type === 'tool-call' ? [String(block.id)] : []))
    expect(callIds.length).toBeGreaterThan(0)
    expect(loggedResults(log.events).map(entry => entry.id)).toEqual(callIds)

    await lc.dispose()
  })
})

describe('票 04 · 第 5 条：裁剪不影响工具调用配对校验', () => {
  it('带工具调用的被裁消息：id、name、arguments、结果与错误标志全部不变', async () => {
    const { lc, session } = await drive(4)

    const prunedSeqs = new Set(persistedPrunes(session).flatMap(entry => entry.targets))
    expect(prunedSeqs.size).toBeGreaterThan(0)

    // `coldRead` 读的是**已落盘**的日志，而写缓冲只在后端自己的 teardown 里排空；要在 `dispose()` 之前读
    // 同一份日志，必须显式过一次 `session/flush`。
    await lc.ctx.sessions.flush(session)
    const log = await lc.coldRead('gate-c')
    const logged = loggedAssistants(log.events)
    // 必须用**带工具调用**的被裁消息：纯文本消息时这条判据测不到配对。
    const prunedWithCalls = logged.filter(entry => prunedSeqs.has(entry.seq)
      && entry.types.includes('tool-call'))
    expect(prunedWithCalls.length).toBeGreaterThan(0)

    const callsOf = (content: readonly ContentBlock[]) => content.flatMap(block => block.type === 'tool-call'
      ? [{ id: String(block.id), name: block.name, arguments: block.arguments }]
      : [])

    for (const entry of prunedWithCalls) {
      const index = logged.findIndex(candidate => candidate.seq === entry.seq)
      // id / name / arguments 逐项相等，顺序由数组顺序保证。
      expect(callsOf(visibleAssistantContent(session, index)))
        .toEqual(callsOf(entry.event.data.message.content))
    }

    // 工具结果与错误标志：裁剪只改 assistant 消息，结果帧与模型可见历史完全一致。
    expect(loggedResults(log.events).length).toBeGreaterThan(0)
    expect(visibleResults(session)).toEqual(loggedResults(log.events))

    await lc.dispose()
  })
})

describe('票 04 · 第 6 条：fork 后的子会话与父会话在裁剪点一致', () => {
  it('fork 点落在裁剪点之后：子会话在裁剪点仍是裁剪版', async () => {
    // fork 只复制前缀（闸门 D 记录了这条限制），所以构造时让 fork 点落在裁剪点**之后**：先驱动到裁剪发生
    // 再多走几步，然后在最后一条事件处 fork（`boundary` 是包含式 seq）。
    const { lc, session } = await drive(5)

    const prunedSeqs = new Set(persistedPrunes(session).flatMap(entry => entry.targets))
    expect(prunedSeqs.size).toBeGreaterThan(0)
    const boundary = session.snapshotEvents().at(-1)!.seq
    // fork 点确实在裁剪点之后。
    expect(boundary).toBeGreaterThan(Math.max(...prunedSeqs))

    const child = lc.ctx.sessions.fork(session, boundary, SessionId('gate-c-child'))

    // 子会话的模型可见历史在裁剪点与父会话一致（含被裁步骤仍是裁剪版）。
    expect(visibleBlockTypes(child)).toEqual(visibleBlockTypes(session))
    expect(reasoningTexts(child)).toEqual(reasoningTexts(session))
    // 判据非空：父会话确实裁掉了推理，否则「一致」在未裁剪的历史上也成立。
    const recorded = recordedAssistants(session)
    for (const target of prunedSeqs) {
      expect(reasoningTexts(child)).not.toContain(recorded.find(entry => entry.seq === target)!.reasoning)
    }

    await lc.dispose()
  })
})

describe('票 04 · 第 7 条：重载与降级必须可判断（两个方向）', () => {
  it('① 装载本插件的读者重载后得到与运行期一致的裁剪版历史', async () => {
    // 判据对象是「在真实会话（真实适配器驱动的落盘历史）上这两个方向仍成立」；02 已在它自己的夹具上断过
    // 一次，本用例的端口不同（这里的裁剪由 ② 的触发真实产生，不是测试直接 append 决策）。
    const { lc, session } = await drive(2)
    expect(persistedPrunes(session).length).toBeGreaterThan(0)
    const runtime = session.deriveMessages()
    expect(reasoningTexts(session)).toEqual(['thinking 1'])

    // `coldRead` 读的是**已落盘**的日志，而写缓冲只在后端自己的 teardown 里排空；要在 `dispose()` 之前读
    // 同一份日志，必须显式过一次 `session/flush`。
    await lc.ctx.sessions.flush(session)
    const log = await lc.coldRead('gate-c')
    await lc.dispose()

    const remounted = await remount(lc.root, SCRIPT, { config: CONFIG, toolsThrough: 1 })
    registerTool(remounted.ctx, 'noop')
    expect(restore(remounted, 'gate-c', log).deriveMessages()).toEqual(runtime)
    await remounted.dispose()
  })

  it('② 未装载插件的读者不拒绝整段会话，只重建出未裁剪历史', async () => {
    const { lc, session } = await drive(2)
    expect(persistedPrunes(session).length).toBeGreaterThan(0)
    const runtime = visibleBlockTypes(session)

    // `coldRead` 读的是**已落盘**的日志，而写缓冲只在后端自己的 teardown 里排空；要在 `dispose()` 之前读
    // 同一份日志，必须显式过一次 `session/flush`。
    await lc.ctx.sessions.flush(session)
    const log = await lc.coldRead('gate-c')
    await lc.dispose()

    // 未装载插件的读者：同一份落盘日志，`withPlugin: false` 的 context 里没有本插件的投影。
    const bare = await remount(lc.root, SCRIPT, { withPlugin: false, config: CONFIG, toolsThrough: 1 })
    const restored = restore(bare, 'gate-c', log)

    // ① 会话没有被拒绝：事件读得出来、模型可见历史建得出来、**结构与裁剪版一致**（同样的消息、同样的存活
    // 块类型序列），只有推理块回来了——这正是「降级方向是多花 token，不是对话损坏」。
    expect(log.events.length).toBeGreaterThan(0)
    const withoutReasoning = (types: string[][]) => types.map(blocks => blocks.filter(type => type !== 'reasoning'))
    expect(withoutReasoning(visibleBlockTypes(restored))).toEqual(withoutReasoning(runtime))
    // 判据非空：裁剪版那条消息确实少了推理块、降级版那条确实把它带回来了（否则上面那条在「两边都没推理」
    // 时空转）。
    expect(runtime[0]).not.toContain('reasoning')
    expect(visibleBlockTypes(restored)[0]).toContain('reasoning')
    // ② 得到的是**未裁剪**历史（推理块仍在）：降级方向是「多花 token」，不是对话损坏。
    expect(reasoningTexts(restored)).toEqual(['thinking 0', 'thinking 1'])
    await bare.dispose()
  })
})

describe('票 04 · 第 8 条：裁剪只作用于资格成立的历史步骤', () => {
  it('中途换模型的会话：有资格的步骤被裁、无资格的原样保留（两侧都断）', async () => {
    // 构造：同一个会话里逐步骤混用传输。`ScriptedReasoningAdapter` 的信封 `api` 由 `stepApi` 逐次覆盖，
    // 所以第 1 步是 `openai-completions`（有资格），第 2 步起换成别的传输（无资格）——`ineligible` 是全有
    // 或全无，造不出这种会话。
    const lc = await lifecycle(SCRIPT, {
      config: CONFIG,
      // 一个 turn 恰好 3 步：前 2 次模型调用发起工具调用，第 3 次纯文本收尾（否则全带工具调用的 turn 不会
      // 结束，`whenIdle()` 永不 resolve）。
      toolsThrough: 2,
      stepApi: ['openai-completions', 'anthropic-messages'],
    })
    registerTool(lc.ctx, 'noop')
    const { agent, session } = await lc.createSession('mixed-transport')
    for (const text of ['go', 'more', 'even more']) await lc.step(agent, text)

    const events = session.snapshotEvents()
    const assistants = events.filter(
      (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
    )
    // 判据非空：会话里确实两种资格都存在，且确实发生了一次裁剪。
    const eligible = assistants.filter(event => event.data.message.source.kind === 'model'
      && isReasoningPrunable(event.data.message))
    const ineligible = assistants.filter(event => event.data.message.source.kind === 'model'
      && !isReasoningPrunable(event.data.message))
    expect(eligible.length).toBeGreaterThan(0)
    expect(ineligible.length).toBeGreaterThan(0)
    const targets = persistedPrunes(session).flatMap(entry => entry.targets)
    expect(targets).toContain(eligible[0]!.seq)

    // 写入侧（`targets`）：只含资格成立的 seq——它只能证明「无资格的步骤没被写进去」。
    const eligibleSeqs = eligible.map(event => Number(event.seq))
    expect(targets.every(seq => eligibleSeqs.includes(Number(seq)))).toBe(true)

    // 应用路径（模型可见历史）：资格强制作真生效，无资格步骤的推理块原样保留。
    const visible = reasoningTexts(session)
    const recorded = recordedAssistants(session)
    for (const event of ineligible) {
      const reasoning = recorded.find(entry => entry.seq === event.seq)!.reasoning
      expect(visible).toContain(reasoning)
    }
    // 两侧覆盖不同的环节：被声明的目标在可见历史里确实被裁了。
    for (const seq of targets) {
      expect(visible).not.toContain(recorded.find(entry => entry.seq === seq)!.reasoning)
    }

    await lc.dispose()
  })
})
