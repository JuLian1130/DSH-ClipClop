/**
 * 票 06 第 14–16 条与第 11、13、14 条的命令面：④ 手动入口的四条结局、服务端强制、不劫持 `/compact`、
 * 「不写会话日志之外的东西」，以及开关**不参与** ①/② 的语义边界。
 *
 * 计数口径写死：命令只能经 `ctx.commands.execute()` 派发，而它在 handler 之前与结算时**无条件**各追加一条
 * `command/run` / `command/done`。所以「本插件自产的事件」= 承载事件，框架那一对先剔除（框架自己的同款
 * 过滤在 `command-compact` 的用例里）。**事件数**与**事件类型集合**都按这个口径。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CARRIER_EVENT_TYPE, MANUAL_COMMAND_NAME } from '../src/index.ts'
import {
  cleanupRoots, lifecycle, persistedPrunes, reasoningTexts, recordedAssistants, registerTool, toolCallScript,
  type PersistentLifecycle,
} from './support/session-harness.ts'

afterEach(async () => { await cleanupRoots() })

/** 框架为每次派发无条件追加的一对事件；统计本插件自产的事件时先剔除。 */
const FRAMEWORK_COMMAND_EVENTS = new Set(['command/run', 'command/done'])

/** 驱动一个恰好 `steps` 步的 turn。 */
async function drive(lc: PersistentLifecycle, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** 派发一次本插件的命令。 */
async function run(lc: PersistentLifecycle, agent: Agent) {
  return lc.ctx.commands.execute(agent, `/${MANUAL_COMMAND_NAME}`, [], new AbortController().signal)
}

/** 订阅会话事件，按事件类型收集（承载事件与框架命令事件都在内，用例自己剔除）。 */
function collectEventTypes(lc: PersistentLifecycle): Set<string> {
  const types = new Set<string>()
  lc.ctx.on('session/event', (_session: Session, event) => { types.add(event.type) })
  return types
}

/** 本插件自产的事件数。 */
function carrierCount(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === CARRIER_EVENT_TYPE).length
}

describe('票 06 第 14 条：命令的四种结局各断言一次', () => {
  it('① 成功：落盘一条承载事件，且模型可见历史里那些推理块确实不在了', async () => {
    const lc = await lifecycle(toolCallScript(3), { toolsThrough: 2, config: { everySteps: 50, keepRecentSteps: 2 } })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent, session } = await lc.createSession('command-success')
      await drive(lc, agent, 'go')
      const before = recordedAssistants(session)
      expect(before).toHaveLength(3)
      expect(reasoningTexts(session)).toHaveLength(3)
      expect(persistedPrunes(session)).toHaveLength(0)

      const execution = await run(lc, agent)

      expect(execution?.result.kind).toBe('success')
      const prunes = persistedPrunes(session)
      expect(prunes).toHaveLength(1)
      // 手动入口不设保留窗口：整段可裁历史一次推进，`targets` 是那些 seq 逐项。
      expect(prunes[0]!.targets).toEqual(before.map(assistant => assistant.seq))
      // 两侧都断：只断落盘时，「裁了但没生效」全绿。
      expect(reasoningTexts(session)).toHaveLength(0)
    } finally {
      await lc.dispose()
    }
  })

  it('② 无可裁历史：零写入（事件数不变）', async () => {
    const lc = await lifecycle(toolCallScript(1), { toolsThrough: 0 })
    try {
      const { agent, session } = await lc.createSession('command-nothing')
      await run(lc, agent)
      expect(carrierCount(session)).toBe(0)
    } finally {
      await lc.dispose()
    }
  })

  it('③ 资格不成立（全部历史步骤都不是 openai-completions）：零写入', async () => {
    const lc = await lifecycle(toolCallScript(2), { toolsThrough: 1, ineligible: true })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent, session } = await lc.createSession('command-ineligible')
      await drive(lc, agent, 'go')
      expect(recordedAssistants(session).length).toBeGreaterThan(0)
      await run(lc, agent)
      expect(carrierCount(session)).toBe(0)
    } finally {
      await lc.dispose()
    }
  })

  it('④ 开关关闭：零写入', async () => {
    const lc = await lifecycle(toolCallScript(2), { toolsThrough: 1, config: { manualPrune: false } })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent, session } = await lc.createSession('command-disabled')
      await drive(lc, agent, 'go')
      expect(recordedAssistants(session).length).toBeGreaterThan(0)
      const execution = await run(lc, agent)
      // 入口不可用是用户自己的选择：命令仍在，但不做任何事，也不落任何事件。
      expect(execution?.result.kind).toBe('error')
      expect(carrierCount(session)).toBe(0)
    } finally {
      await lc.dispose()
    }
  })
})

describe('票 06 第 11 条：置灰只影响界面，服务端仍按裁剪资格强制', () => {
  it('界面允许但资格不成立时：那条步骤的推理块仍在，落盘 payload 的 targets 不含它', async () => {
    // 界面允许 = 开关为开（当前路由判为可受益）；服务端的资格逐步骤读 replay 信封，不看界面。
    const lc = await lifecycle(toolCallScript(2), {
      toolsThrough: 1,
      stepApi: ['openai-completions', 'anthropic-messages'],
      config: { manualPrune: true },
    })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent, session } = await lc.createSession('command-enforcement')
      await drive(lc, agent, 'go')
      const recorded = recordedAssistants(session)
      expect(recorded).toHaveLength(2)
      const [eligible, ineligible] = recorded

      await run(lc, agent)

      const prunes = persistedPrunes(session)
      expect(prunes).toHaveLength(1)
      expect(prunes[0]!.targets).toEqual([eligible!.seq])
      expect(prunes[0]!.targets).not.toContain(ineligible!.seq)
      // 资格不成立的那条步骤原样保留（模型可见历史里它的推理块还在）。
      expect(reasoningTexts(session)).toEqual([ineligible!.reasoning])
    } finally {
      await lc.dispose()
    }
  })
})

describe('票 06 第 16 条：命令不写会话日志之外的东西', () => {
  it('成功场景新增的成员恰是承载类型，没有第二种新类型也没有类型消失；不新建子会话', async () => {
    const lc = await lifecycle(toolCallScript(2), { toolsThrough: 1, config: { manualPrune: true } })
    try {
      registerTool(lc.ctx, 'noop')
      // 一个**活的**订阅，命令前后各取一次快照——命令只在会话日志里多写承载事件那一条。
      const types = collectEventTypes(lc)
      const { agent, session } = await lc.createSession('command-log-success')
      await drive(lc, agent, 'go')
      const before = new Set(types)
      const agentsBefore = lc.ctx.agents.list().map(candidate => String(candidate.session.id))
      await run(lc, agent)
      const after = new Set(types)

      expect([...after].filter(type => !before.has(type) && !FRAMEWORK_COMMAND_EVENTS.has(type)))
        .toEqual([CARRIER_EVENT_TYPE])
      expect([...before].filter(type => !after.has(type) && !FRAMEWORK_COMMAND_EVENTS.has(type))).toEqual([])
      expect(lc.ctx.agents.list().map(candidate => String(candidate.session.id))).toEqual(agentsBefore)
      expect(session.id).toBe(SessionId('command-log-success'))
    } finally {
      await lc.dispose()
    }
  })

  it('②③④ 场景下事件类型集合完全相等', async () => {
    const lc = await lifecycle(toolCallScript(2), { toolsThrough: 1, ineligible: true })
    try {
      registerTool(lc.ctx, 'noop')
      const types = collectEventTypes(lc)
      const { agent } = await lc.createSession('command-log-nothing')
      await drive(lc, agent, 'go')
      const before = new Set(types)
      await run(lc, agent)
      const own = (set: ReadonlySet<string>) => [...set].filter(type => !FRAMEWORK_COMMAND_EVENTS.has(type)).sort()
      expect(own(types)).toEqual(own(before))
    } finally {
      await lc.dispose()
    }
  })
})

describe('票 06 第 15 条：命令不劫持 /compact', () => {
  it('本插件的命令名与内建 /compact 不同名，且 /compact 仍走 compaction-basic 的 compactNow 路径', async () => {
    const lc = await lifecycle(toolCallScript(2), { toolsThrough: 1, compaction: { maxOverflowRetries: 0 } })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent } = await lc.createSession('command-compact')
      await drive(lc, agent, 'go')
      await lc.ctx.plugin(CommandCompact)

      // 命令表里两条命令各归各的：本插件的名字与 `compact` 不同，`compact` 仍是内建那个 definitionId。
      const names = lc.ctx.commands.list(agent).map(descriptor => descriptor.name)
      expect(names).toContain(MANUAL_COMMAND_NAME)
      expect(MANUAL_COMMAND_NAME).not.toBe('compact')
      expect(lc.ctx.commands.find(agent, 'compact')?.definitionId)
        .toBe('@deepseek-ai/dsh-command-compact')

      // 真派发一次 `/compact`：它必须走到 compaction-basic 的 `compactNow`（本插件没有换掉那条路径）。
      const engine = lc.ctx.compaction as unknown as { compactNow: (...args: never[]) => Promise<unknown> }
      const original = engine.compactNow
      let reached = 0
      engine.compactNow = async (...args: never[]) => {
        reached += 1
        return original.apply(engine, args)
      }
      try {
        await lc.ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
      } finally {
        engine.compactNow = original
      }
      expect(reached).toBe(1)
    } finally {
      await lc.dispose()
    }
  })
})

describe('票 06 第 13 条：开关的语义边界——它不参与 ①/②', () => {
  it('开关为 false 时走到 M 步仍照常落盘一次；开关为 true 时逐项相同', async () => {
    /** 走到第 M 步并取回该次推进的 targets。 */
    const atStep = async (manualPrune: boolean) => {
      const lc = await lifecycle(toolCallScript(6), {
        toolsThrough: 5,
        config: { everySteps: 6, keepRecentSteps: 2, manualPrune },
      })
      try {
        registerTool(lc.ctx, 'noop')
        const { agent, session } = await lc.createSession(manualPrune ? 'boundary-on' : 'boundary-off')
        await drive(lc, agent, 'go')
        const prunes = persistedPrunes(session)
        expect(prunes).toHaveLength(1)
        return prunes[0]!.targets
      } finally {
        await lc.dispose()
      }
    }

    expect(await atStep(false)).toEqual(await atStep(true))
  })
})
