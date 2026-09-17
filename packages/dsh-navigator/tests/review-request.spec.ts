/**
 * 票据 03：到点发起复核（等待模式）。
 *
 * 全部用例挂在集成夹具（真实 agent loop + 被测插件 + 脚本化适配器）上，观察面只取外部行为：
 * 适配器收到的请求、触发点那一刻的主会话快照、会话里落盘的消息与 `turn/end` 原因。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningEffortId, type Message } from '@deepseek-ai/dsh-llm'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as navigator from '../src/index.ts'
import { BUILTIN_PROMPT, FIXED_INSTRUCTIONS } from '../src/review-prompt.ts'
import { CONTINUE_VERDICT } from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import {
  isReviewRequest,
  mountNavigatorLoop,
} from './support/loop-fixture.ts'

/** 每个用例一套独立 context：投影与事件监听都是全局的，串用会互相干扰。 */
afterEach(disposeTrackedContexts)

/** 一条主请求的脚本回复。 */
const OK = { text: '收到' }

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

/** 主会话当前对模型可见的助手消息 id，按顺序。 */
function assistantIds(agent: Agent): string[] {
  return agent.session.deriveMessages()
    .filter(message => message.role === 'assistant')
    .map(message => message.id)
}

/** 主会话当前对模型可见的本插件写入的消息。 */
function pluginMessages(agent: Agent): Message[] {
  return agent.session.deriveMessages().filter(
    message => message.source.kind === 'plugin' && message.source.plugin === navigator.name,
  )
}

/**
 * 跑一次到点的复核，取回末尾那条 user 消息的正文。
 * @param prompt - 配置的复核提示词；缺省不配置（走内置提示词）。
 * @returns 复核请求末条消息的正文。
 */
async function reviewInstructionText(prompt?: string): Promise<string> {
  const fixture = await mountNavigatorLoop({
    config: { triggerEverySteps: 1, ...prompt === undefined ? {} : { prompt } },
    script: [OK, { text: CONTINUE_VERDICT }],
  })
  await fixture.send('第一步')
  await fixture.send('第二步')
  const review = fixture.reviews()[0]
  expect(review).toBeDefined()
  return textOf(review?.request.messages.at(-1))
}

describe('复核请求的内容与形态', () => {
  it('请求内容 = 触发点的快照原顺序 + 末尾一条 user 消息，没有截断，且记下后不再变化', async () => {
    // 先取快照再断请求：适配器收到复核请求时，在同一次同步回调里读一次主会话
    // `deriveMessages()`，当场拷下 id 列表。禁止在请求录完之后再抓一次快照来比对——
    // 同源同时刻的两次读取必然逐条对齐，那样的断言任何实现都会绿。
    const frozenAtRequest: string[] = []
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 2 },
      script: [OK, OK, { text: CONTINUE_VERDICT }],
      observeRequest: (request) => {
        if (isReviewRequest(request)) frozenAtRequest.push(...request.messages.map(message => message.id))
      },
    })
    await fixture.send('第一步')
    await fixture.send('第二步')
    await fixture.send('第三步')

    const review = fixture.reviews()[0]
    expect(review).toBeDefined()
    const snapshotIds = review?.snapshotIds ?? []

    // 快照覆盖触发点那一刻对模型可见的全部消息、无遗漏无重复：id 序列与快照逐一相等，不看条数。
    expect(review?.request.messages.slice(0, -1).map(message => message.id)).toEqual([...snapshotIds])
    // 末尾恰好一条 user 消息。
    expect(review?.request.messages).toHaveLength(snapshotIds.length + 1)
    expect(review?.request.messages.at(-1)?.role).toBe('user')
    // 便宜的不变量：请求被记下之后，无论插件随后如何处理这次结论，消息序列都不再变化。
    expect(review?.request.messages.map(message => message.id)).toEqual(frozenAtRequest)
  })

  it('末尾那条 user 消息 = 可替换的复核提示词 + 固定段，固定段在最后且两种情况逐字相同', async () => {
    const builtin = await reviewInstructionText()
    const replaced = await reviewInstructionText('只看目标与阻塞')

    expect(builtin.startsWith(BUILTIN_PROMPT)).toBe(true)
    expect(replaced.startsWith('只看目标与阻塞')).toBe(true)
    expect(builtin.endsWith(FIXED_INSTRUCTIONS)).toBe(true)
    expect(replaced.endsWith(FIXED_INSTRUCTIONS)).toBe(true)
    expect(builtin.slice(-FIXED_INSTRUCTIONS.length)).toBe(replaced.slice(-FIXED_INSTRUCTIONS.length))
  })

  it('继承服务商、模型与推理强度，温度 0、上限用 maxOutputTokens，且不设 system、不传 tools', async () => {
    const effort = ReasoningEffortId('high')
    const fixture = await mountNavigatorLoop({
      // 4096 是 maxOutputTokens 的默认值，配一个非默认值才能把「上限来自配置」与
      // 「上限来自适配器/路由默认」区分开。
      config: { triggerEverySteps: 1, maxOutputTokens: 1234 },
      script: [OK, { text: CONTINUE_VERDICT }],
      agentOptions: { reasoningEffort: effort },
      reasoning: { efforts: [{ id: effort, name: 'High' }] },
    })
    await fixture.send('第一步')
    await fixture.send('第二步')

    const main = fixture.calls()[0]?.request
    const review = fixture.reviews()[0]?.request
    expect(review).toBeDefined()
    expect(review?.provider).toBe(main?.provider)
    expect(review?.model).toBe(main?.model)
    expect(review?.reasoningEffort).toBe(main?.reasoningEffort)
    expect(review?.reasoningEffort).toBe(effort)
    expect(review?.temperature).toBe(0)
    expect(review?.maxTokens).toBe(1234)
    // 「没有设置 system」只指请求选项的字段未设置：消息数组里仍保留主会话自己的 system 消息。
    expect(review !== undefined && 'system' in review).toBe(false)
    expect(review?.messages[0]?.role).toBe('system')
    expect(review !== undefined && 'tools' in review).toBe(false)
  })
})

describe('什么时候复核', () => {
  it('到点才发：判据是已完成步数达到触发点，节奏按「触发点 + 间隔」推进，不补打', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 2 },
      script: [OK, OK, { text: CONTINUE_VERDICT }, OK, OK, { text: CONTINUE_VERDICT }],
    })

    await fixture.send('1')
    // 完成步数到 triggerEverySteps - 1：适配器上还没有复核请求。
    expect(fixture.reviews()).toHaveLength(0)
    await fixture.send('2')
    expect(fixture.reviews()).toHaveLength(0)
    // 再完成一步后的那次 pre-step（触发点 2）恰好出现一条。
    await fixture.send('3')
    expect(fixture.reviews()).toHaveLength(1)
    // 区间内不补打：第 3 步落在触发点 2 与 4 之间。
    await fixture.send('4')
    expect(fixture.reviews()).toHaveLength(1)
    // 触发点 4：恰好加一。
    await fixture.send('5')
    expect(fixture.reviews()).toHaveLength(2)
  })

  it('首次观察落在间隔整数倍处时不立刻补打：触发点由推导式给出，不是「步数是间隔的整数倍」', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 2 },
      mountEagerly: false,
      script: [OK, OK, OK, OK, { text: CONTINUE_VERDICT }],
    })
    // 会话先跑两步，插件再被观察：此时已完成 2 步，正好是间隔的整数倍。
    await fixture.send('第一步')
    await fixture.send('第二步')
    await fixture.mountPlugin()

    // 推导式取三项最大值（当前步数落在的间隔倍数 2）再加一个间隔，触发点是 4：不立刻补打。
    await fixture.send('第三步')
    expect(fixture.reviews()).toHaveLength(0)
    await fixture.send('第四步')
    expect(fixture.reviews()).toHaveLength(0)
    await fixture.send('第五步')
    expect(fixture.reviews()).toHaveLength(1)
  })

  it('复核自己的请求不计数：没有它产生的助手消息，下一次触发点仍按主会话成功步数推进', async () => {
    const triggerPoints: number[] = []
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 2 },
      script: [OK, OK, { text: CONTINUE_VERDICT }, OK, OK, { text: CONTINUE_VERDICT }],
      observeRequest: (request, agent) => {
        if (isReviewRequest(request)) triggerPoints.push(assistantIds(agent).length)
      },
    })

    for (const text of ['1', '2', '3', '4', '5']) await fixture.send(text)

    expect(fixture.reviews()).toHaveLength(2)
    // 两次复核都发生在主会话成功提交 2 / 4 条助手消息之后——复核请求没有推快节奏。
    expect(triggerPoints).toEqual([2, 4])
    // 五次发送各一条助手消息，会话里没有多出复核请求产生的助手消息。
    expect(assistantIds(fixture.agent)).toHaveLength(5)
  })
})

describe('结论与失败', () => {
  it('continue 不进入主模型上下文：该步收尾后只多出该步自己的助手消息', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1 },
      script: [OK, { text: CONTINUE_VERDICT }, OK],
    })
    await fixture.send('第一步')
    const before = assistantIds(fixture.agent)
    await fixture.send('第二步')

    expect(fixture.reviews()).toHaveLength(1)
    const after = assistantIds(fixture.agent)
    expect(after).toHaveLength(before.length + 1)
    expect(pluginMessages(fixture.agent)).toEqual([])
  })

  it('超时用 reviewTimeoutMs、不重试，主会话不因此被打断', async () => {
    const deadlineMs: Array<number | undefined> = []
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1, reviewTimeoutMs: 50 },
      // 请求顺序：主请求、复核请求（挂住不放行）、超时放行后的主请求。
      script: [OK, { hang: true }, OK],
      observeRequest: (request) => {
        const { signal } = request
        if (!isReviewRequest(request) || signal === undefined) return
        // 「超时用 reviewTimeoutMs」要钉到值上：超时信号带的是配置的那个毫秒数。
        signal.addEventListener('abort', () => { deadlineMs.push(timeoutOf(signal)?.timeoutMs) })
      },
    })
    await fixture.send('第一步')
    await fixture.send('第二步')

    // 只收到一次复核请求：超时不重试。
    expect(fixture.reviews()).toHaveLength(1)
    expect(deadlineMs).toEqual([50])
    // 这一步原样放行：两个回合都正常收尾。
    expect(fixture.turnEndReasons()).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    expect(assistantIds(fixture.agent)).toHaveLength(2)
    expect(pluginMessages(fixture.agent)).toEqual([])
  })

  // 三个输入在本票里的动作完全相同（放行、不留内容、不抛错）——结论为 `continue` 时也是这个动作。
  // 因此这条用例钉的是「任何输入都不产生有害动作」：实现若在复核失败时抛错或写入消息就会红。
  // 「输出无法解析」的严格判定与失败记录的写法归 04/09，本票不解析输出。
  it.each([
    { name: '复核请求报错', response: { error: 'boom' } },
    { name: '超时', response: { hang: true } },
    { name: '输出无法解析', response: { text: '这段不是 JSON' } },
  ] as const)('默认失败格（等待 × continue）：$name 时这一步原样放行、不留内容、不抛错', async ({ response }) => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1, reviewTimeoutMs: 50 },
      script: [OK, response, OK],
    })
    await fixture.send('第一步')
    await fixture.send('第二步')

    expect(fixture.reviews()).toHaveLength(1)
    // 放行：触发复核的那一步照常收尾。
    expect(fixture.turnEndReasons()).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    // 不留内容：对话里没有本插件写入的任何消息。
    expect(pluginMessages(fixture.agent)).toEqual([])
    expect(assistantIds(fixture.agent)).toHaveLength(2)
  })

  it('复核请求在传输层抛错时也按默认失败格放行，不打断主会话', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 1 },
      script: [OK],
    })
    // DSH 的 `llm/stream` 中间件失败保持抛出（见设计文档引用的 `LlmRuntime.adapterStream` 注释），
    // 与适配器返回的错误不同：它不会变成终态 chunk，所以请求到不了适配器，只能在这里数。
    let attempts = 0
    fixture.ctx.on('llm/stream', (options, next) => {
      if (!isReviewRequest(options)) return next()
      attempts += 1
      throw new Error('中间件失败了')
    })
    await fixture.send('第一步')
    await fixture.send('第二步')

    expect(attempts).toBe(1)
    expect(fixture.turnEndReasons()).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    expect(pluginMessages(fixture.agent)).toEqual([])
    expect(assistantIds(fixture.agent)).toHaveLength(2)
  })
})

describe('会话级能力缺失', () => {
  /**
   * 造一个替身：同一份真实会话，只遮蔽掉缺的那个方法。
   * @param session - 真实主会话。
   * @param missing - 要遮蔽掉的会话级方法名；不传就只换身份、不遮蔽。
   * @returns 遮蔽了该方法的替身。
   */
  function sessionStandIn(
    session: Session,
    missing?: 'deriveMessages' | 'requestHeader',
  ): Session {
    return new Proxy(session, {
      get(target, property) {
        if (property === missing) return undefined
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  it.each(['deriveMessages', 'requestHeader'] as const)(
    '%s 缺失时第一次 pre-step 就抛出，turn 以 error 收尾且错误链点出方法名',
    async (missing) => {
      const fixture = await mountNavigatorLoop({ script: [OK] })
      const real = fixture.agent.session
      // 真实 loop 下 `ctx.sessions.get` 返回的就是 `agent.session` 本身。两条读法不拆成不同的
      // 实例，就没有判据：在被测的那一份上遮蔽时，插件即使走被否决的 `ctx.sessions.get` 路径
      // 也照样报错，用例永远绿。所以 `ctx.sessions.get` 换成返回另一个替身的桩，缺失方法只遮蔽
      // 在 pre-step 载荷会取到的那一份（`agent.session`）上。
      fixture.ctx.sessions.get = () => sessionStandIn(real)
      ;(fixture.agent as { session: Session }).session = sessionStandIn(real, missing)

      await fixture.send('触发第一步')

      // 能力检查落在第一次 pre-step：这一步根本没打开，也没有走到模型请求。若检查被拖到第一个
      // 触发点，会是 loop 自己在 step 打开之后撞上被遮蔽的方法——那时 `step/start` 已经落盘。
      expect(fixture.events().some(event => event.type === 'step/start')).toBe(false)
      expect(fixture.calls()).toHaveLength(0)
      const reason = fixture.turnEndReasons().at(-1)
      expect(reason?.kind).toBe('error')
      const message = reason?.kind === 'error' ? reason.error.message : ''
      expect(message).toContain(missing)
      // 错误点名本插件，而不是 loop 自己摊平出来的调用栈文案。
      expect(message).toContain(navigator.name)
    },
  )
})
