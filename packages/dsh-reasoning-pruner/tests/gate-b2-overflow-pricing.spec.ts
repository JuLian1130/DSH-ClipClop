/**
 * 票 07 · 闸门 B-2：激活点①（溢出救援）。
 *
 * ① 的判据是**救回**，不是稳态收益，而且必须按**搭车**语义构造。机制前提写死：裁剪自己**不会触发重试**
 * ——compaction-basic 的重试凭证是 `replaceGeneration`，而投影式裁剪只推进 `contentGeneration`。所以 ① 只能
 * 搭 compaction-basic 自己的车（tool-result pruner 落了 replace，或摘要成功提交）。
 *
 * 三条口径先写死，否则用例会自己骗自己：
 *
 * - **判据非空**：重试请求确实带着裁剪版历史（被裁步骤的推理块不在该请求的模型可见输入里）、该请求的输入
 *   确实小于同场景不裁剪时、且该 turn 以 `completed` 收尾。只断「裁剪落盘了」对 ① 这个兜底功能是空转。
 * - **摘要成功时不可判**：摘要会把整段区间遮蔽掉，重试请求带的是**摘要产物**，两臂都「推理块不在」（05 已把
 *   这条口径写实）。所以可分辨的那条分支是**摘要失败 + tool-result pruner 落了 replace**——重试请求直接带
 *   替换后的表面。
 * - **不得写成「裁剪使 compaction-basic 判定为进展」**：本票不要求 `replaceGeneration` 因裁剪而前进，也不
 *   得断言「裁剪导致 `{kind:'retry'}`」。反例要正面构造。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { H, reasoningTokens, visibleReasoning } from './support/gate-readings.ts'
import { overflowScenario, reasoningShare, retryPair, summaryUsage } from './support/overflow-scenario.ts'
import { cleanupRoots, persistedPrunes, recordedAssistants } from './support/session-harness.ts'

afterEach(cleanupRoots)

/**
 * 救援分支的构造：工具返回越阈值的大结果（tool-result pruner 因此真的落 replace）+ 摘要调用失败
 * （整段区间没有被摘要遮蔽，重试请求直接带替换后的表面）。
 */
const RESCUE = { mountToolResultPruner: true, largeToolResults: true, summaryFails: true } as const

describe('票 07 · 闸门 B-2 · ① 的判据是「救回」，按搭车语义构造', () => {
  it('重试请求带着裁剪版历史、输入更小、且该 turn 完成（三项逐项断）', async () => {
    const pruned = await overflowScenario({ ...RESCUE, keepRecentSteps: 2 })
    const untouched = await overflowScenario({ ...RESCUE, withPlugin: false, keepRecentSteps: 50 })

    // 臂的区分先立住：一臂真的裁了、另一臂一条都没写。
    expect(persistedPrunes(pruned.session)).toHaveLength(1)
    expect(persistedPrunes(untouched.session)).toEqual([])

    // ① 重试请求**确实带上了裁剪版历史**：该请求的模型可见输入里，被裁步骤的推理块不在。
    const prunedPair = retryPair(pruned)
    const untouchedPair = retryPair(untouched)
    expect(prunedPair.retry.reasoning).not.toContain('thinking 0')
    expect(prunedPair.retry.reasoning).not.toContain('thinking 1')
    // 保留窗口里的仍在——否则「什么都没带」也满足上面那条。
    expect(prunedPair.retry.reasoning).toContain('thinking 2')
    // 而对照臂同一次重试请求带着全部四步推理：这就是「裁剪版的差别」。
    expect(untouchedPair.retry.reasoning).toEqual(['thinking 0', 'thinking 1', 'thinking 2', 'thinking 3'])

    // ② 该请求的输入**确实小于**同场景不裁剪时。
    expect(prunedPair.retry.requestTokens).toBeLessThan(untouchedPair.retry.requestTokens)

    // ③ **重试成功**：该 turn 以 `completed` 收尾（`completed` 不是任务达成信号，只表示这一 turn 正常收尾）。
    expect(pruned.turnEnds.at(-1)).toBe('completed')
    expect(untouched.turnEnds.at(-1)).toBe('completed')
    // 重试确实发生在摘要之后：数组顺序即时间顺序。
    expect(prunedPair.summary.purpose).toBe('compaction')

    await pruned.dispose()
    await untouched.dispose()
  }, 300000)

  it('裁剪自己不会触发重试：整条 failure 处理里 replaceGeneration 的进展只来自同侪', async () => {
    const pruned = await overflowScenario({ ...RESCUE, keepRecentSteps: 2 })
    // 裁剪推进的是 `contentGeneration`；`replaceGeneration` 的进展来自 tool-result pruner 的 replace。
    // 这条把「裁剪导致重试」这个说法正面排除：裁剪落盘时 `replaceGeneration` 一点没动。
    const atListener = pruned.observed[0]!.atListener
    expect(atListener.prunes).toBe(1)
    // 观察点（本插件已跑完、compaction-basic 还没跑）上 replaceGeneration 相对失败前没有进展。
    expect(atListener.replaceGeneration).toBe(pruned.beforeFailure.replaceGeneration)
    expect(atListener.contentGeneration).toBe(pruned.beforeFailure.contentGeneration + 1)
    await pruned.dispose()
  }, 300000)
})

describe('票 07 · 闸门 B-2 · 不得写成「裁剪使 compaction 判定为进展」', () => {
  it('反例：compaction-basic 不决定重试时，请求仍然失败、裁剪不产出任何 replace', async () => {
    // `maxOverflowRetries: 0` ⇒ 它在选区之前就 `return next()`，整个 failure 处理里没有任何 replace。
    const scenario = await overflowScenario({ compaction: { maxOverflowRetries: 0 }, keepRecentSteps: 2 })

    // ① 请求仍然失败。
    expect(scenario.turnEnds.at(-1)).toBe('error')
    // ② 裁剪本身没有产出任何 `replace`（`replaceGeneration` 不变）。
    expect(scenario.session.surface.replaceGeneration).toBe(0)
    // 而它自己的裁剪确实落盘了（否则上面那条在一个「什么都没做」的实现上也成立）。
    expect(persistedPrunes(scenario.session)).toHaveLength(1)
    // ③ 落盘的裁剪只对**后续**步骤生效：被裁推理不在模型可见历史上，而日志里的原件仍在。
    expect(visibleReasoning(scenario.session)).not.toContain('thinking 0')
    expect(recordedAssistants(scenario.session).map(entry => entry.reasoning)).toContain('thinking 0')
    await scenario.dispose()
  }, 300000)

  it('首版不自持重试：本票只记录结论，不改实现', async () => {
    // 本票不要求 `replaceGeneration` 因裁剪前进，也不得断言「裁剪导致 {kind:'retry'}`。
    const pruned = await overflowScenario({ ...RESCUE, keepRecentSteps: 2 })
    const action = pruned.observed[0]!.action as { readonly kind?: string } | undefined
    // 链的最终动作是 retry，但那是 **compaction-basic 自己**的决定（它的 replace 落了）。
    expect(action?.kind).toBe('retry')
    // 这条记录的结论（是否要做自持重试）写在票面「实现期登记」里；本票不改实现。
    await pruned.dispose()
  }, 300000)
})

describe('票 07 · 闸门 B-2 · 反例：摘要照跑时 ① 可能为负', () => {
  it('按闸门 B 的适用范围定价该次摘要调用，记录它相对不裁剪是更贵还是更便宜', async () => {
    const pruned = await overflowScenario({ mountToolResultPruner: true, largeToolResults: true, keepRecentSteps: 2 })
    const untouched = await overflowScenario({
      mountToolResultPruner: true, largeToolResults: true, withPlugin: false, keepRecentSteps: 50,
    })
    const prunedPair = retryPair(pruned)
    const untouchedPair = retryPair(untouched)

    // 摘要调用的两个读数**不在** `assistant/message` 上：摘要走 `ctx.llm.stream()`、不经 agent loop，其 usage
    // 由 `compaction/summary` 事件承载。**读不到时不得记 0**——所以两臂各自先断能读到。
    // 两侧**各用自己的** usage：拿裁剪臂的读数当「不裁剪」基线会把两次请求量成同一侧。
    const prunedUsage = summaryUsage(pruned.session)
    const untouchedUsage = summaryUsage(untouched.session)
    expect(prunedUsage).toBeDefined()
    expect(untouchedUsage).toBeDefined()

    // 用**同一个 h** 定价两臂各自的这次摘要调用：`h × cacheRead + input` 是它实际的计费输入。
    const priced = (usage: { readonly inputTokens?: number, readonly cacheReadTokens?: number }): number =>
      H * (usage.cacheReadTokens ?? 0) + (usage.inputTokens ?? 0)
    const prunedCost = priced(prunedUsage!)
    const untouchedCost = priced(untouchedUsage!)
    // 结论必须明确写成「更贵/更便宜」，不得只写「收益可观」：两个成本都是算出来的数、且来自各自那一臂。
    expect(prunedCost).toBeGreaterThan(0)
    expect(untouchedCost).toBeGreaterThan(0)
    expect(prunedCost).toBeGreaterThan(untouchedCost)

    // 与规格那条边界**各自**断方向：`h > 1 − r` 是「先裁再摘要更便宜」的条件，本场景不成立。
    // 它和上面那条**不是同一个口径**（上面按事件上报的三次计数定价，规格那条用 `h × S` 与 `(1 − r) × S`
    // 这两个近似式），所以只各自断方向，不断两者相等——那会把两个不同的量当恒等式。
    const r = reasoningShare(prunedPair.summary)
    expect(H > 1 - r).toBe(false)

    await pruned.dispose()
    await untouched.dispose()
  }, 300000)

  it('摘要调用自身的读数：裁剪让喂给摘要的输入少掉多少 token', async () => {
    const pruned = await overflowScenario({ mountToolResultPruner: true, largeToolResults: true, keepRecentSteps: 2 })
    const untouched = await overflowScenario({
      mountToolResultPruner: true, largeToolResults: true, withPlugin: false, keepRecentSteps: 50,
    })
    const prunedPair = retryPair(pruned)
    const untouchedPair = retryPair(untouched)

    // 喂给摘要的那份输入因裁剪而变小（被裁推理不在），这是这次摘要调用**自身**的读数。
    expect(prunedPair.summary.requestTokens).toBeLessThan(untouchedPair.summary.requestTokens)
    const removed = untouchedPair.summary.requestTokens - prunedPair.summary.requestTokens
    expect(removed).toBeGreaterThan(0)
    // 省下的**就是**那几步被裁推理——独立复算：取两臂摘要请求的推理文本差集、按估价器定价，与上面的差值对上。
    // （不写成 `expect(pruned).toBe(untouched - removed)`：那只是把 `removed` 的定义代回去，恒真。）
    const removedReasoning = untouchedPair.summary.reasoning.filter(text => !prunedPair.summary.reasoning.includes(text))
    expect(removedReasoning.length).toBeGreaterThan(0)
    expect(reasoningTokens(removedReasoning)).toBe(removed)
    // 逐项记录（票面第 20 条要「记录摘要调用自身的 inputTokens / cacheReadTokens」）。
    expect(summaryUsage(pruned.session)).toBeDefined()

    // 但它**不足以**让 ① 在该请求形状上转为正收益：`removed` 只占原文输入的一个零头（实测 0.31%），
    // 而「先裁再摘要」的代价是那条边界（`h > 1 − r`）在 `h = 0.02` 下不成立（上一条测试已断言「更贵」）。
    expect(removed / untouchedPair.summary.requestTokens).toBeLessThan(0.01)
    await pruned.dispose()
    await untouched.dispose()
  }, 300000)
})