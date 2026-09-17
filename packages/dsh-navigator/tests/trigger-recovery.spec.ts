/**
 * 票据 05：触发与恢复。
 *
 * 观察面按票面写死：「下一次触发点」不读任何内部计数，落成「某次复核请求在已完成步数恰为 N 的那一刻
 * 被收到」——夹具的 `ObservedCall.steps` 就是请求到达那一刻的已完成步数。负向断言一律用
 * `expectNoReviewAt`：同一次观察里同时证明该会话确实走到了第 N 步（有一条主会话请求 `steps === N`），
 * 否则插件抛错、turn 以 error 收尾、驱动器少跑一步都会让「没出现复核」恒真。
 *
 * 步进用 02c 的多步驱动 `drive`：一条真实用户消息之后跑出几十步，其间不再出现真实用户消息；只有
 * 需要「某一步来一条真实用户消息」时才让那一步以纯文本收尾（会话转空闲），再送下一条消息。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import { FIXED_INSTRUCTIONS } from '../src/review-prompt.ts'
import { readReviewRecords } from '../src/index.ts'
import {
  CONTINUE_VERDICT,
  SCRIPTED_TOOL_NAME,
  type ScriptedResponse,
} from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import {
  isReviewRequest,
  mountNavigatorLoop,
  type NavigatorLoop,
} from './support/loop-fixture.ts'

/** 每个用例一套独立 context；磁盘根也逐用例回收。 */
const roots: string[] = []

afterEach(async () => {
  await disposeTrackedContexts()
  await Promise.all(roots.splice(0).map(
    root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
})

/**
 * 造一份脚本化的长程运行：每一步一条主请求，默认发 tool-call 撑住 turn；`turnEnds` 里的步改发纯文本
 * 收尾（会话转空闲，随后才能再送一条真实用户消息）。复核请求与主请求共用同一个适配器请求序列，
 * 位置按「触发点 T 的复核在下一步的 pre-step 发出」排布，所以 `triggers` 要写**期望的**触发点集合。
 * @param options - 总步数、收尾的步与触发点集合。
 * @returns 按请求顺序排好的脚本。
 */
function scriptedRun(options: {
  readonly steps: number
  readonly turnEnds?: readonly number[]
  readonly triggers: readonly number[]
}): ScriptedResponse[] {
  const ends = new Set(options.turnEnds ?? [])
  const triggers = new Set(options.triggers)
  const script: ScriptedResponse[] = []
  for (let step = 1; step <= options.steps; step += 1) {
    if (triggers.has(step - 1)) script.push({ text: CONTINUE_VERDICT })
    script.push(ends.has(step) ? { text: '这一步收尾' } : { toolCall: SCRIPTED_TOOL_NAME })
  }
  return script
}

/** 主会话的复核请求落在哪些已完成步数上，按顺序。 */
function reviewSteps(fixture: NavigatorLoop): number[] {
  return fixture.main.reviews().map(call => call.steps)
}

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

/**
 * 断「第 N 步那一刻没有出现复核」，并证明这个会话确实走到了第 N 步。
 * @param fixture - 夹具句柄。
 * @param step - 观察点的已完成步数。
 */
function expectNoReviewAt(fixture: NavigatorLoop, step: number): void {
  const calls = fixture.main.calls()
  expect(calls.some(call => !isReviewRequest(call.request) && call.steps === step)).toBe(true)
  expect(calls.some(call => isReviewRequest(call.request) && call.steps === step)).toBe(false)
}

describe('重载：不立刻补打、也不会永久不再触发', () => {
  it('① 在间隔整数倍处重载：第 100 步那一刻不出现复核，第 150 步那一刻恰好出现一次', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 220, triggers: [50, 150] }),
    })
    // 一条真实用户消息推到第 50 步：触发点 50 的复核在 steps === 50 被收到。
    await fixture.main.drive(51, '出发')
    expect(reviewSteps(fixture)).toEqual([50])

    // 跑到「已完成 100 步、正要进第 101 步」那一刻重载（重载本身不产生请求）。
    await fixture.main.drive(49)
    expect(fixture.main.steps()).toBe(100)
    await fixture.remountPlugin()

    // 重载后按推导式重新推导：max(记录 50、锚点 0、网格 floor(100/50)*50 = 100) + 50 = 150。
    await fixture.main.drive(51)
    expectNoReviewAt(fixture, 100)
    expect(reviewSteps(fixture)).toEqual([50, 150])
  })

  it('② 在 150 重载后不会永久不再触发：往后跑满一个间隔，第 200 步那一刻出现复核', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 260, triggers: [50, 100, 200] }),
    })
    await fixture.main.drive(150, '出发')
    expect(fixture.main.steps()).toBe(150)
    // 第 150 步的复核要到第 151 步的 pre-step 才发，所以这一刻重载时它还没发。
    expect(reviewSteps(fixture)).toEqual([50, 100])
    await fixture.remountPlugin()

    // 重载后推导式：max(记录 100、锚点 0、网格 floor(150/50)*50 = 150) + 50 = 200。
    await fixture.main.drive(51)
    expect(fixture.main.calls().some(call => !isReviewRequest(call.request) && call.steps === 200)).toBe(true)
    expect(reviewSteps(fixture)).toEqual([50, 100, 200])
  })
})

describe('新的自主执行区间：真实用户消息带来的运行期重置', () => {
  it('③ 第 50 步触发过、第 70 步来消息、第 80 步重载：下一次触发点是 120，不是记录项算出的 100', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 220, turnEnds: [70], triggers: [50, 120] }),
    })
    // 跑到第 70 步；那一步收尾让会话空闲，好在这里再送一条真实用户消息。
    await fixture.main.drive(70, '出发')
    expect(fixture.main.steps()).toBe(70)
    expect(reviewSteps(fixture)).toEqual([50])
    await fixture.main.drive(10, '转弯')
    // 锚点是那条消息记入会话日志时的已完成步数（此刻已提交 70 条助手消息）。
    expect(fixture.ctx.sessionProjections.stateOf(fixture.main.session, 'navigatorSteps')?.anchorStep).toBe(70)
    expect(fixture.main.steps()).toBe(80)
    await fixture.remountPlugin()

    // 推导式：max(记录 50、锚点 70、floor(80/50)*50 = 50) + 50 = 120。锚点项若没接上会算出 100。
    await fixture.main.drive(21)
    expectNoReviewAt(fixture, 100)
    await fixture.main.drive(20)
    expect(reviewSteps(fixture)).toEqual([50, 120])
  })

  it('不重载：第 70 步的真实用户消息把内存触发点提升到 120，第 100 步不出现复核、第 120 步出现一次', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 220, turnEnds: [70], triggers: [50, 120] }),
    })
    await fixture.main.drive(70, '出发')
    await fixture.main.drive(50, '转弯')

    // 运行期重置：内存触发点被提升到「锚点 70 + 间隔 50」= 120。不实现重置时内存值是 100，
    // 第 100 步那一刻会多打一次。200 不属于本条。
    await fixture.main.drive(21)
    expectNoReviewAt(fixture, 100)
    await fixture.main.drive(20)
    expect(reviewSteps(fixture)).toEqual([50, 120])
  })

  it('在 120 重载：推导式第三项网格 100 胜出，下一次触发点是 150', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 220, turnEnds: [70], triggers: [50, 150] }),
    })
    await fixture.main.drive(70, '出发')
    // 第 70 步的真实用户消息之后跑到「已完成 120 步、正要进第 121 步」这一刻。
    await fixture.main.drive(50, '转弯')
    expect(fixture.main.steps()).toBe(120)
    // 第 120 步的复核要到第 121 步的 pre-step 才发，所以这一刻重载时它还没发，记录项仍是 50。
    expect(reviewSteps(fixture)).toEqual([50])
    await fixture.remountPlugin()

    // 推导式：max(记录 50、锚点 70、网格 floor(120/50)*50 = 100) + 50 = 150，网格项胜出。
    await fixture.main.drive(31)
    expectNoReviewAt(fixture, 120)
    expect(reviewSteps(fixture)).toEqual([50, 150])
  })
})

describe('观察范围：只观察用户发起的顶层会话', () => {
  it('子会话不触发复核、也不影响主会话；带 parentSession 的 fork 会话照常触发并计数', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 2 },
      // 全 tool-call 脚本：只关心复核请求有没有被收到，不关心中间要不要收尾。
      script: [{ toolCall: SCRIPTED_TOOL_NAME }],
    })
    // 主会话先跑到它自己的触发点：名下有复核，子会话的负向断言才不是靠总数空转。
    await fixture.main.drive(3, '主会话')
    expect(reviewSteps(fixture)).toEqual([2])

    // 子会话（origin: 'subagent'）自己的步数从 0 起，跑满一个间隔后名下不该出现复核请求。
    const sub = await fixture.createSubSession('probe-sub')
    await sub.drive(4, '子会话')
    expect(sub.steps()).toBe(4)
    expect(sub.calls()).toHaveLength(4)
    expect(sub.reviews()).toEqual([])

    // 主会话的计数与触发点不受子会话影响。
    expect(fixture.main.steps()).toBe(3)
    expect(reviewSteps(fixture)).toEqual([2])

    // fork 出来的会话带 parentSession、不带 origin：算顶层，照常触发并计数。
    const fork = await fixture.createForkSession('probe-fork')
    await fork.drive(4, 'fork 会话')
    expect(fork.steps()).toBe(4)
    expect(fork.reviews().map(call => call.steps)).toEqual([2])
  })
})

describe('中途更新配置', () => {
  it('之后的复核请求末条消息用新 prompt，触发步骤按重载公式重新推导', async () => {
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: 50 },
      script: scriptedRun({ steps: 140, triggers: [50, 100] }),
    })
    await fixture.main.drive(51, '出发')
    expect(reviewSteps(fixture)).toEqual([50])

    // 在步边界改配置：`update` 重跑 `apply`，触发点按推导式重新推导
    // （max(记录 50、锚点 0、网格 floor(51/50)*50 = 50) + 50 = 100）。
    await fixture.updateConfig({ triggerEverySteps: 50, prompt: '只看目标与阻塞' })
    await fixture.main.drive(51)

    expect(reviewSteps(fixture)).toEqual([50, 100])
    const last = fixture.main.reviews().at(-1)
    expect(textOf(last?.request.messages.at(-1))).toBe(`只看目标与阻塞\n\n${FIXED_INSTRUCTIONS}`)
  })
})

describe('记录项真的接线：重载推导的第一项来自读回入口的列表末条', () => {
  it('第 105 步的复核已落盘、重载并改间隔 20：第 120 步不出现复核、第 125 步恰好出现一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-trigger-'))
    roots.push(root)
    const fixture = await mountNavigatorLoop({
      storageRoot: root,
      config: { triggerEverySteps: 50 },
      // 第 5 步用纯文本收尾：会话空闲后才能在「第 5 步」再送一条真实用户消息（此后锚点不再移动）。
      script: scriptedRun({ steps: 160, turnEnds: [5], triggers: [55, 105, 125] }),
    })
    await fixture.main.drive(5, '先跑五步')
    await fixture.main.drive(101, '转弯')
    expect(fixture.main.steps()).toBe(106)
    expect(reviewSteps(fixture)).toEqual([55, 105])

    // 在第二次复核落盘之后、进下一步之前先重载、再改间隔（两个动作都落在同一步边界上、都不产生复核
    // 请求）。重载沿用夹具配置（间隔 50），所以决定性的那次 apply 是随后的配置重启——它带间隔 20，
    // 且和重载一样清空内存触发点并重开记录域，下一次观察因此按推导式读回记录项。
    await fixture.remountPlugin()
    // 重载的可观察贡献：重开记录域之后记录仍读得回来，末条的触发步骤确实是 105（不是 55，否则推导
    // 退化成与无记录项同值的 120）。缺省桩每次 open() 新建一张表，这条会红——正是票面要求挂
    // storageRoot 的那个理由。
    expect(readReviewRecords(fixture.main.session.id).map(record => record.triggerStep)).toEqual([55, 105])
    await fixture.updateConfig({ triggerEverySteps: 20 })

    // 有记录项：max(105、锚点 5、网格 floor(106/20)*20 = 100) + 20 = 125；把记录项留 null 时是 120。
    await fixture.main.drive(15)
    expectNoReviewAt(fixture, 120)
    await fixture.main.drive(5)
    expect(reviewSteps(fixture)).toEqual([55, 105, 125])
  })
})
