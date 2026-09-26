/**
 * 票 01 第 5 条的另一半：注册投影后，「不是我们写的」承载类型事件**安全穿过**，但**不是零副作用**。
 *
 * 投影拦截早于该类型的所有其它折叠分支，所以宿主自己的事件也必须走投影；而 `applySurfacePlan` 的
 * `project` 分支**无条件**推进 `contentGeneration`（与投影返回什么无关）。承载体是宿主自己也在用的
 * 类型，所以每产生一条该类型事件，下一步请求就会落一条 `request/header`（header 未变时
 * `reason: 'series'`，同一次还改了 header 则是 `reason: 'change'` + `startsSeries: true`）并重置工具
 * 基线。这条用例**逐条断死**这份代价，免得它无声扩大；反例面是「只断消息历史不变」时一个把工具集合也
 * 搞坏、或每次折叠多推一次计数的实现全绿。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 显式引入服务包：`ctx.tools` / `ctx.llm` 的类型来自它们的模块增强。
import type {} from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { CARRIER_EVENT_TYPE } from '../src/index.ts'
import { userMessage } from './support/fixtures.ts'
import { TextAdapter } from './support/text-adapter.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** 宿主自己写的真实 payload 形状（照 `web-search-deepseek` 的 `recordRequest`，三处逐字段一致）。 */
const HOST_PAYLOAD = {
  endpoint: 'https://api.deepseek.com/anthropic/messages',
  apiVersion: '2023-06-01',
  body: {
    model: 'deepseek-v4-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'search: dsh' }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  },
} as const

/**
 * 注册一个用不到的工具。第二步再注册第二个会改变 request header，从而在工具基线上留下一条
 * `updates`——没有它，「该事件之后 updates 清空」是恒真的空转判据。
 * @param ctx - 夹具的根 context。
 * @param name - 工具名。
 */
function registerTool(ctx: Context, name: string): void {
  ctx.tools.register({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
  })
}

/** 推进一个 turn（一条真实用户消息 + 等它收尾）。 */
async function step(agent: Agent, text: string): Promise<void> {
  agent.followup(userMessage(text))
  await agent.whenIdle()
}

describe('宿主事件安全穿过投影，但它推进 contentGeneration 的代价逐条成立', () => {
  it('模型可见历史零变化；contentGeneration 恰好加一；下一步请求落 series 头并重置工具基线', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['mock'], new TextAdapter())
    await ctx.plugin(plugin, { everySteps: 50, keepRecentSteps: 10 })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('host-event-passthrough'), { provider: 'mock', model: 'mock' })
    const session: Session = agent.session

    registerTool(ctx, 'alpha')
    await step(agent, 'step one')

    // 注册 beta **并**先落一条宿主事件：下一步请求因此带 `startsSeries`（内容代次变了），工具加法与其
    // 请求头在同一次落盘、基线就地重置成 [alpha, beta]——工具基线先结算，下面「tools 与事件前相等」
    // 才是有效判据（否则事件前的 tools 还是旧基线 [alpha]）。
    registerTool(ctx, 'beta')
    session.append(CARRIER_EVENT_TYPE, HOST_PAYLOAD)
    await step(agent, 'step two')

    // 事件前：工具基线带着一条 update（下面「updates 清空」才有意义）。
    const before = session.toolHistory()
    expect(before.tools.map(tool => tool.name)).toEqual(['alpha', 'beta'])
    expect(before.updates.length).toBeGreaterThan(0)

    const generationBefore = session.surface.contentGeneration
    const replaceBefore = session.surface.replaceGeneration
    const messagesBefore = session.deriveMessages()

    // 被观察的事件：宿主自己的形状，投影返回空 Map、不抛错。
    const hostSeq = session.append(CARRIER_EVENT_TYPE, HOST_PAYLOAD).seq

    // 它不是表面类型：节点与消息历史零变化，但投影命中推进了 contentGeneration。
    expect(session.deriveMessages()).toEqual(messagesBefore)
    expect(session.surface.contentGeneration).toBe(generationBefore + 1)
    expect(session.surface.replaceGeneration).toBe(replaceBefore)

    await step(agent, 'step three')

    // 该事件之后确有 request/header 带 `startsSeries`（header 未变时就是 `reason: 'series'`）。
    const headers = session.snapshotEvents().filter(
      (event): event is SessionEvent<'request/header'> =>
        event.type === 'request/header'
        && event.seq > hostSeq
        && (event.data.reason === 'series' || event.data.startsSeries === true),
    )
    expect(headers.length).toBeGreaterThan(0)

    // 工具集合没被搞坏，updates 被清空。
    const after = session.toolHistory()
    expect(after.tools).toEqual(before.tools)
    expect(after.updates).toEqual([])
  })
})
