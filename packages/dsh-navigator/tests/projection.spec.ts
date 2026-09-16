import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { navigatorStepsProjection, type NavigatorStepsState } from '../src/projection.ts'
import { ScriptedAdapter, navigatorMessage, userMessage, type ScriptedResponse } from './support/scripted-adapter.ts'
import { disposeTrackedContexts, trackContext } from './support/cordis-fixture.ts'

/** 每个用例一个独立 context：投影注册是全局的，串用会让计数互相干扰。 */
afterEach(disposeTrackedContexts)

/**
 * 挂一个真实的 agent loop + 脚本化适配器。
 * @param script - 适配器的脚本回复。
 * @returns 驱动 agent 与读取投影所需的句柄。
 */
async function mount(script?: readonly ScriptedResponse[]) {
  const ctx = trackContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('navigator-projection'), { provider: 'mock', model: 'mock' })
  return {
    adapter,
    agent,
    register: () => ctx.sessionProjections.register(navigatorStepsProjection),
    state: (): NavigatorStepsState => {
      const state = ctx.sessionProjections.stateOf(agent.session, 'navigatorSteps')
      if (state === undefined) throw new Error('navigatorSteps 投影没有注册')
      return state
    },
  }
}

describe('navigatorSteps 投影', () => {
  it('每次成功提交的助手消息计一步，锚点跟着真实用户消息走', async () => {
    const { agent, register, state } = await mount()
    register()

    agent.followup(userMessage('go'))
    await agent.whenIdle()
    expect(state()).toEqual({ steps: 1, anchorStep: 0 })

    // 插件注入的建议是 source.kind === 'plugin'：不移动锚点；随后的真实用户消息把它推到当时的步数。
    agent.inject(navigatorMessage('建议：来自第 1 步', '第 1 步 建议'))
    agent.steer(userMessage('换方向'))
    await agent.whenIdle()
    expect(state()).toEqual({ steps: 2, anchorStep: 1 })
  })

  it('失败的请求不计数（落盘为 assistant/attempt）', async () => {
    const { agent, register, state } = await mount([{ error: 'boom' }])
    register()

    agent.followup(userMessage('go'))
    await agent.whenIdle().catch(() => undefined)
    expect(state()).toEqual({ steps: 0, anchorStep: 0 })
  })

  it('事件写完之后才注册，也能折出整段历史（与 G7 探针同一条件）', async () => {
    const { agent, register, state } = await mount()

    agent.followup(userMessage('go'))
    await agent.whenIdle()
    register()

    expect(state()).toEqual({ steps: 1, anchorStep: 0 })
  })

  it('带 interrupted 的助手消息不计数，无关事件返回同一个状态引用', () => {
    const before: NavigatorStepsState = { steps: 3, anchorStep: 1 }
    const interrupted = { type: 'assistant/message', data: { interrupted: true } } as unknown as SessionEvent
    const committed = { type: 'assistant/message', data: {} } as unknown as SessionEvent
    const unrelated = { type: 'turn/end', data: {} } as unknown as SessionEvent

    expect(navigatorStepsProjection.apply(before, interrupted)).toBe(before)
    expect(navigatorStepsProjection.apply(before, unrelated)).toBe(before)
    expect(navigatorStepsProjection.apply(before, committed)).toEqual({ steps: 4, anchorStep: 1 })
  })
})
