/**
 * 票 02：落盘通路与投影消费。
 *
 * 八组断言，全部建在**真实会话**上（真 agent loop + 真 JSONL 落盘后端 + 真的重挂载）：
 *
 * 1. 运行期增量折叠与重载全量折叠得到逐字节相同的**模型可见历史**（观察面写死为 `deriveMessages()`）。
 * 2. 裁剪是持久的，且裁剪决策本身可重载；原始推理全文仍可从会话日志读取。
 * 3. 未装载插件的读者**不得拒绝整段会话**，只能重建出未裁剪历史——本票的存亡点。
 * 4. 投影不吞掉宿主自己产出的事件；该事件的日志副作用（落一条 `request/header`）也在观察面里。
 * 5. 校验失败当场大声、不留坏日志、会话不卡住。
 * 6. 投影推进 `contentGeneration` 而 `replaceGeneration` 不动（激活点①强度判据的前提）。
 * 7. payload 不含会话内容（读未经 schema 解析的原始落盘文本）。
 * 8. 裁剪资格不成立时不写入。
 *
 * 事件日志的读取只发生在用例侧：`ownEvents()` / `snapshotEvents()` 带 `@deprecated`，Agent Note 明写
 * 生产源码不得调用、只放行仓库测试文件；插件的生产源码一个都不读。
 *
 * 生命周期一律显式 `dispose()`（重挂载要等前一个 context 把写句柄排空关闭），所以本文件不设兜底
 * 释放——多一个「可能已经被释放过」的隐式路径只会让失败点变模糊。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { CARRIER_EVENT_TYPE, persistReasoningPrune } from '../src/index.ts'
import type { ScriptedStep } from './support/session-harness.ts'
import {
  cleanupRoots,
  lifecycle,
  rawLogText,
  reasoningTexts,
  remount,
  restore,
} from './support/session-harness.ts'

afterEach(cleanupRoots)

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

/** 每步都发起工具调用，因此一个 turn 走几步就是几步。 */
function toolStep(reasoning: string, text: string): ScriptedStep {
  return { reasoning, text, calls: [{ name: 'noop', arguments: '{}' }] }
}

/** 脚本：前两步带工具调用，第三步纯文本收尾 → 三条已记录的 `assistant/message`。 */
const SCRIPT: ScriptedStep[] = [
  toolStep('thinking one', 'first'),
  toolStep('thinking two', 'second'),
  { reasoning: 'thinking three', text: 'third' },
]

/** 宿主自己写的真实 payload 形状（照 `web-search-deepseek` 的 `recordRequest` 三字段）。 */
const HOST_PAYLOAD = {
  endpoint: 'https://api.deepseek.com/anthropic/messages',
  apiVersion: '2023-06-01',
  body: {
    model: 'deepseek-v4-flash',
    max_tokens: 1024,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'search: dsh' }] as const }] as const,
    tools: [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 5 }] as const,
  },
}

/** 一条日志里 `assistant/message` 事件的 seq，按出现顺序。 */
function assistantSeqs(session: Session): number[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'assistant/message')
    .map(event => event.seq)
}

/** 推完 {@link SCRIPT} 的会话。 */
async function drivenSession(id: string, text = 'go') {
  const lc = await lifecycle(SCRIPT)
  registerTool(lc.ctx, 'noop')
  const created = await lc.createSession(id)
  await lc.step(created.agent, text)
  return { lc, ...created }
}

describe('票 02 · 第 1–3 条：重载一致、耐久、插件缺席降级', () => {
  it('第 1 条：运行期增量折叠与重载全量折叠得到逐字节相同的模型可见历史', async () => {
    const { lc, session } = await drivenSession('reload-parity')

    const seqs = assistantSeqs(session)
    expect(seqs).toHaveLength(3)
    expect(reasoningTexts(session)).toEqual(['thinking one', 'thinking two', 'thinking three'])

    // 裁掉前两条（第三条留在保留窗口里；K 的取值不在本票）。
    persistReasoningPrune(session, [SessionSeq(seqs[0]!), SessionSeq(seqs[1]!)])
    const runtimeHistory = session.deriveMessages()
    expect(reasoningTexts(session)).toEqual(['thinking three'])
    // 观察面写死为模型可见历史：辅助读者（`session-query` 与迁移代际校验用的硬编码首方投影表）会得到
    // 未裁剪历史，这是设计的能力边界，本用例**不**对它写判据。
    await lc.dispose()

    // 真的重挂载：新 context、新插件 fiber、投影注册真的再跑一次。
    const reloaded = await remount(lc.root, SCRIPT)
    const cold = await reloaded.coldRead('reload-parity')
    const restored = restore(reloaded, 'reload-parity', cold)
    // 投影只在**装载它的进程**里注册，所以派生必须在 `dispose()` 之前读——这条本身就是「重挂载真的又跑
    // 了一次投影注册」的反向见证（卸载后 `deriveMessages()` 会抛「projection was removed」）。
    const reloadedHistory = restored.deriveMessages()
    await reloaded.dispose()

    expect(JSON.stringify(reloadedHistory)).toBe(JSON.stringify(runtimeHistory))
  })

  it('第 2 条：裁剪持久，且原始推理全文仍可从会话日志读取（裁剪不销毁原件）', async () => {
    const { lc, session } = await drivenSession('durable')
    const seqs = assistantSeqs(session)
    persistReasoningPrune(session, [SessionSeq(seqs[0]!), SessionSeq(seqs[1]!)])
    await lc.dispose()

    const reloaded = await remount(lc.root, SCRIPT)
    const cold = await reloaded.coldRead('durable')
    const restored = restore(reloaded, 'durable', cold)
    // ① 模型可见历史是裁剪版：推理块不在。
    expect(reasoningTexts(restored)).toEqual(['thinking three'])
    await reloaded.dispose()

    // ② 原始推理全文与文本都仍在日志里：直接读那些 assistant/message 的 message.content（不是
    // deriveMessages）。只断「推理仍在」会让「实现顺手把文本也改了」全绿。
    const loggedContent = cold.events
      .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
      .map(event => event.data.message.content)
    expect(loggedContent).toEqual([
      [
        { type: 'reasoning', text: 'thinking one' },
        { type: 'text', text: 'first' },
        { type: 'tool-call', id: expect.any(String), name: 'noop', arguments: '{}' },
      ],
      [
        { type: 'reasoning', text: 'thinking two' },
        { type: 'text', text: 'second' },
        { type: 'tool-call', id: expect.any(String), name: 'noop', arguments: '{}' },
      ],
      [{ type: 'reasoning', text: 'thinking three' }, { type: 'text', text: 'third' }],
    ])
  })

  it('第 3 条（本票存亡点）：未装载插件时不拒绝整段会话，只重建出未裁剪历史', async () => {
    const { lc, session } = await drivenSession('absent-plugin')
    const seqs = assistantSeqs(session)
    persistReasoningPrune(session, [SessionSeq(seqs[0]!), SessionSeq(seqs[1]!)])
    await lc.dispose()

    // 承载类型必须是**已知类型**（`packages/core/session/src/known-event-types.ts:80`）：未知类型会被
    // `validateStoredEvents` 拒绝，连带整段会话读不出来——「写入静默成功、重载全损」。这条断言与下面的
    // 读回用例成对：它只证明「不是未知类型」，证不了「已知类型里挑得对」。
    expect(KNOWN_SESSION_EVENT_TYPES.has(CARRIER_EVENT_TYPE)).toBe(true)

    // 未装载插件的读者。
    const bare = await remount(lc.root, SCRIPT, { withPlugin: false })

    // ① 会话读得出来：不抛 `SessionFormatUnsupportedError`。
    const cold = await bare.coldRead('absent-plugin')
    expect(cold.events.some(event => event.type === CARRIER_EVENT_TYPE)).toBe(true)

    // ② 得到的历史是未裁剪版（推理块仍在）：降级方向是「多花 token」，不是对话损坏。
    const restored = restore(bare, 'absent-plugin', cold)
    expect(reasoningTexts(restored)).toEqual(['thinking one', 'thinking two', 'thinking three'])
    await bare.dispose()
  })
})

describe('票 02 · 第 4 条：宿主自己产出的事件安全穿过', () => {
  it('模型可见历史零影响、事件确实进了日志、且那笔不可避免的代价如实记账', async () => {
    const { lc, agent, session } = await drivenSession('host-event')

    const messagesBefore = session.deriveMessages()
    const generationBefore = session.surface.contentGeneration
    const replaceBefore = session.surface.replaceGeneration

    // 宿主自己的事件：不是我们写的（payload 顶层没有 clipclop 键）。
    const hostSeq = session.append(CARRIER_EVENT_TYPE, HOST_PAYLOAD).seq

    // 零影响 + 不报错。
    expect(session.deriveMessages()).toEqual(messagesBefore)
    // 记账：投影命中无条件推进 contentGeneration，replaceGeneration 不动。
    expect(session.surface.contentGeneration).toBe(generationBefore + 1)
    expect(session.surface.replaceGeneration).toBe(replaceBefore)

    // 该事件之后确实下一步请求落了 `request/header`（header 未变时 reason 是 'series'；同一次还改了
    // header 则是 'change' + startsSeries: true——两个分支都算）。
    await lc.step(agent, 'after host event')
    const headers = session.snapshotEvents().filter(
      (event): event is SessionEvent<'request/header'> =>
        event.type === 'request/header'
        && event.seq > hostSeq
        && (event.data.reason === 'series' || event.data.startsSeries === true),
    )
    expect(headers.length).toBeGreaterThan(0)
    await lc.dispose()

    // 判据非空：必须确认宿主事件真实落盘了——否则「零影响」在「事件根本没写进去」时也成立。
    const reloaded = await remount(lc.root, SCRIPT)
    const cold = await reloaded.coldRead('host-event')
    await reloaded.dispose()
    const stored = cold.events.find(event => event.type === CARRIER_EVENT_TYPE)
    expect(stored).toBeDefined()
    expect(stored?.data).toEqual(HOST_PAYLOAD)
  })
})

describe('票 02 · 第 5 条：校验失败当场大声、不留坏日志', () => {
  it('append 本身抛出、日志没有多出这条事件、后续请求仍能发出', async () => {
    const { lc, agent, session } = await drivenSession('bad-payload')

    const before = session.ownEvents().length
    const generationBefore = session.surface.contentGeneration

    // 非法 payload：外层多一个顶层键（形状要求单个命名空间键）。
    expect(() =>
      session.append(CARRIER_EVENT_TYPE, {
        clipclop: { targets: [SessionSeq(0)] },
        extra: 'not allowed',
      } as never),
    ).toThrow(/exactly the one clipclop key/)

    // 日志没有多出这条事件（我们的校验属**提交前**：`planSurfaceEvent` 由 `surfaceManager.validateNext`
    // 调用、在 `log.push` 之前，所以不必为「留下坏日志」写恢复逻辑）。
    expect(session.ownEvents().length).toBe(before)
    expect(assistantSeqs(session)).toHaveLength(3)
    // 表面没有被半份改动污染。
    expect(session.surface.contentGeneration).toBe(generationBefore)

    // 后续请求仍能正常发出（会话没有卡在坏状态）。
    await lc.step(agent, 'still alive')
    expect(assistantSeqs(session)).toHaveLength(4)
    await lc.dispose()
  })
})

describe('票 02 · 第 6 条：contentGeneration 推进、replaceGeneration 不动', () => {
  it('一次成功裁剪让两个计数反向变化', async () => {
    const { lc, session } = await drivenSession('generations')

    const seqs = assistantSeqs(session)
    const contentBefore = session.surface.contentGeneration
    const replaceBefore = session.surface.replaceGeneration

    persistReasoningPrune(session, [SessionSeq(seqs[0]!)])

    // 只断 contentGeneration 会让「实现误用了 replace」全绿，所以两个方向都要断。
    expect(session.surface.contentGeneration).toBe(contentBefore + 1)
    expect(session.surface.replaceGeneration).toBe(replaceBefore)
    await lc.dispose()
  })
})

describe('票 02 · 第 7 条：payload 不含会话内容', () => {
  it('标记串不出现在原始落盘文本里，而会话正文本身确实落了盘', async () => {
    const marker = 'UNIQUE-MARKER-7f3c1a'
    const lc = await lifecycle([toolStep('thinking marked', `see ${marker}`), { text: 'done' }])
    registerTool(lc.ctx, 'noop')
    const { agent, session } = await lc.createSession('no-content')
    await lc.step(agent, `please ${marker}`)

    const seqs = assistantSeqs(session)
    persistReasoningPrune(session, [SessionSeq(seqs[0]!)])
    // 落盘发生在请求前的 durability checkpoint 上，所以再推一个 turn 之后才读盘。
    await lc.step(agent, 'next')
    await lc.dispose()

    // 观察面写死：**未经 schema 解析的原始落盘文本**，不是 `deriveMessages()` 的返回值。
    const raw = await rawLogText(lc.root)
    // 判据非空：会话内容确实在日志里，否则下面的断言是空转。
    expect(raw).toContain(marker)
    const carrierLines = raw.split('\n').filter(line => line.includes(CARRIER_EVENT_TYPE))
    expect(carrierLines.length).toBeGreaterThan(0)
    for (const line of carrierLines) expect(line).not.toContain(marker)
  })
})

describe('票 02 · 第 8 条：裁剪资格不成立时不写入', () => {
  it('全部候选都无资格时不落任何事件，而不是落一条空记录', async () => {
    const { lc, session } = await drivenSession('no-eligible')

    const before = session.ownEvents().length
    const contentBefore = session.surface.contentGeneration

    // 无资格的历史步骤：本适配器造出的步骤都是 `openai-completions`，所以拿几条**非 assistant/message**
    // 的 seq 当候选——资格判定对它们给不出可裁结论，与「信封不是 pi-ai」落在同一个分支的同一侧。信封那
    // 一侧的全部反例由 `qualification.spec.ts` 正面构造，本票断的是「这个结论有没有转成一次落盘」。
    const nonAssistant = session.snapshotEvents()
      .filter(event => event.type !== 'assistant/message')
      .map(event => event.seq)
    expect(nonAssistant.length).toBeGreaterThan(0)
    expect(persistReasoningPrune(session, nonAssistant)).toBeUndefined()

    // 事件数不变，且**不是**「落了一条 targets 为空的事件」。
    expect(session.ownEvents().length).toBe(before)
    expect(session.ownEvents().some(event => event.type === CARRIER_EVENT_TYPE)).toBe(false)
    // 表面也没动：空记录会污染日志并让闸门 C 的降级判据难以判断。
    expect(session.surface.contentGeneration).toBe(contentBefore)
    await lc.dispose()
  })

  it('混合候选里只有资格成立的进 targets', async () => {
    const { lc, session } = await drivenSession('mixed-eligible')
    const seqs = assistantSeqs(session)
    const userSeq = session.snapshotEvents().find(event => event.type === 'user/message')!.seq

    // 资格判定落在写入侧，所以候选里混进无资格的步骤既不会进 payload，也不会让 append 抛出。
    const eventSeq = persistReasoningPrune(session, [SessionSeq(userSeq), SessionSeq(seqs[1]!)])
    expect(eventSeq).toBeDefined()
    const logged = session.snapshotEvents().find(event => event.seq === eventSeq)
    expect(logged?.data).toEqual({ clipclop: { targets: [seqs[1]!] } })
    await lc.dispose()
  })
})
