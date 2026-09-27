/**
 * 票 07 · 闸门 B：缓存净收益（判据 + 测量协议）。
 *
 * 本票不产出实现代码的判据，产出的是**测量判据与读数**：`M` 的取值由 B 背书、`K` 的取值由 D 背书、
 * ① 是否要做自持重试由 B-2 背书。三条口径先写死，否则用例会自己骗自己：
 *
 * - **token 体积的真源是 `assistant/message` 的 `usage`**，逐次记录三次计数；「全价输入」是三者和，
 *   不是 `inputTokens` 单值（三次计数互斥）。`tokenMeter` 的读数一律不用——它按**原始表面事件**定价、
 *   不读投影，裁剪不会让它下降，拿它当省钱的证据是错的。
 * - **`h` 是外部声明的价格比**，来源写在 `gate-readings.ts` 的 {@link H_SOURCE}；token 数里读不出价格。
 * - **「裁剪确实发生在模型可见历史里」每次都要断**（该请求的输入里推理块不在）。只断 `targets` 有值证明
 *   不了裁剪生效——信封退化时整条消息会静默跌落 provider-neutral 重建，那时 B 读到的 `R` 是名义上的。
 *
 * `M` 的实测结论写在票面「实现期登记」里；本文件把它的两项读数（`n` 随 `M` 增大而下降、`tail` 同时增大）
 * 固化成用例。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { H, H_SOURCE, netBenefit, reasoningTokens, tokenReadings } from './support/gate-readings.ts'
import { disposeCompared, twoArms } from './support/two-arm.ts'
import { cleanupRoots, persistedPrunes } from './support/session-harness.ts'
import { overflowScenario } from './support/overflow-scenario.ts'

/** 本文件用的场景规模：4 步/turn × 2 turn = 8 步，于是边界推进与其后的请求都造得出来。 */
const TURN_STEPS = [4, 4]
const TURNS = ['first turn', 'second turn']

/**
 * 本文件自行声明的后续请求数（`闸门 B` 判据：该请求数由实验场景自行声明，不由规格假定）。
 *
 * 取一条比 8 步场景更长、但仍在同一量级的工作负载：判定「净收益为正」就是 `n` 小于它。
 */
const LATER_REQUESTS = 40

afterEach(cleanupRoots)

describe('票 07 · 闸门 B · token 体积的读数面', () => {
  it('逐次请求从 assistant/message 的 usage 读出三次计数，且被裁推理该次请求真的少掉 token', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    await compared.control.lc.dispose()
    const controlBefore = tokenReadings(compared.control.session)
    const prunedBefore = tokenReadings(compared.pruned.session)

    // 读数面存在且逐条可读：真源是每条 assistant/message 上的 usage。
    expect(controlBefore.length).toBeGreaterThanOrEqual(6)
    expect(prunedBefore.length).toBe(controlBefore.length)

    // 「全价输入」是三者和——三次计数互斥，`inputTokens` 是未缓存输入、cached input 另计。
    for (const reading of controlBefore) {
      expect(reading.billedInput).toBe(reading.inputTokens + reading.cacheReadTokens + reading.cacheWriteTokens)
    }

    // 两臂的请求逐条对应（同一脚本、同一路由、同一个驱动序列）。
    const controlCalls = compared.control.lc.calls
    const prunedCalls = compared.pruned.lc.calls
    expect(prunedCalls.length).toBe(controlCalls.length)

    // **裁剪确实发生在模型可见历史里**：某个下标之后，裁剪臂的请求里推理块比控制臂少。
    const removedAt = controlCalls.findIndex((call, index) =>
      call.reasoning.length > (prunedCalls[index]?.reasoning.length ?? 0))
    expect(removedAt).toBeGreaterThanOrEqual(0)

    // **被裁推理让后续请求少掉多少 token**：同下标处两臂请求体积之差，要有具体数字。
    const controlAt = controlCalls[removedAt]!
    const savedTokens = controlAt.requestTokens - prunedCalls[removedAt]!.requestTokens
    expect(savedTokens).toBeGreaterThan(0)
    expect(prunedCalls[removedAt]!.reasoning).not.toEqual(controlAt.reasoning)

    // 裁剪确实落盘了（与上面的模型可见历史一起断——只断任一侧都是空转）。
    expect(persistedPrunes(compared.pruned.session).length).toBeGreaterThan(0)

    await compared.pruned.lc.dispose()
  }, 60000)

  it('实验场景的最低构成：稳定前缀 + 一次边界推进 + 推进后至少 3 次请求', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    const readings = tokenReadings(compared.pruned.session)
    const boundary = readings.findIndex((reading, index) =>
      index > 0 && reading.cacheReadTokens > 0 && reading.inputTokens > (readings[index - 1]!.inputTokens))

    // 一次边界推进：缓存命中的稳定前缀之后，重算的尾部落进未缓存输入。
    expect(boundary).toBeGreaterThanOrEqual(0)
    // 推进后至少 3 次请求（含推进那一次之后的两条）。
    expect(readings.length - boundary).toBeGreaterThanOrEqual(3)

    await disposeCompared(compared)
  }, 60000)
})

describe('票 07 · 闸门 B · 净收益算式代入实测值', () => {
  it('把实测 tail / R 与外部声明的 h 代入 n，并与场景声明的后续请求数比大小', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    const control = compared.control.lc.calls
    const pruned = compared.pruned.lc.calls
    const controlReadings = tokenReadings(compared.control.session)
    const prunedReadings = tokenReadings(compared.pruned.session)

    // 边界推进那一次：两臂输入读数开始分叉的那个下标。
    const boundaryCall = control.findIndex((call, index) =>
      call.reasoning.length > (pruned[index]?.reasoning.length ?? 0))
    expect(boundaryCall).toBeGreaterThanOrEqual(0)

    // `tail` 实测：推进后那次请求里**重算且无法命中缓存**的输入（未缓存输入 + 缓存写入）。
    const boundaryReading = prunedReadings[boundaryCall]!
    const tail = boundaryReading.inputTokens + boundaryReading.cacheWriteTokens
    // `R` 实测：这次推进被移除的推理 token 量（同下标两臂请求体积之差）。
    const r = control[boundaryCall]!.requestTokens - pruned[boundaryCall]!.requestTokens
    expect(tail).toBeGreaterThan(0)
    expect(r).toBeGreaterThan(0)

    const benefit = netBenefit({ tail, r, h: H, laterRequests: LATER_REQUESTS })

    // 判据非空：`n` 是一个算出来的数、后续请求数是一个声明的数，大小关系明确写成净收益为正/为负。
    expect(benefit.n).toBeCloseTo(((1 - H) * tail) / (H * r), 5)
    // 明确写出结论的方向，而不是「typeof 是 boolean」这种恒真断言。
    expect(benefit.positive).toBe(false)
    // `h` 是外部输入，必须写明来源（这条在记录里出现一次，三张闸门共用同一份 h）。
    expect(H_SOURCE).toContain('cost')
    // 本例的读数：h=0.02 量级下 n 远大于该请求形状此后还会出现的次数 ⇒ 净收益为负。
    // 这不是「收益可观」这类措辞，而是一个明确的大小关系。
    expect(benefit.n).toBeGreaterThan(LATER_REQUESTS)

    await disposeCompared(compared)
  }, 60000)

  it('不提供定价时的等价 token 判据：新增未缓存输入 < 后续请求数 × 被裁推理', async () => {
    // 用**记录所引用的那一档**（`M = 3` / `K = 1`）：登记章把这条判据的读数写成 `55 < 40 × 5`，用例必须
    // 真的产在那组配置上，否则票据记录与它所指的用例各自漂移（`M = 2` 档的读数是 `25 < 200`）。
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 3, keepRecentSteps: 1 },
    })
    const control = compared.control.lc.calls
    const pruned = compared.pruned.lc.calls
    const boundaryCall = control.findIndex((call, index) =>
      call.reasoning.length > (pruned[index]?.reasoning.length ?? 0))
    expect(boundaryCall).toBeGreaterThanOrEqual(0)

    const prunedReading = tokenReadings(compared.pruned.session)[boundaryCall]!
    // 「边界推进新增的未缓存输入」就是**边界尾**：该次请求里无法命中前缀缓存、因此按全价计费的那部分。
    // 不写成「与上一次请求的未缓存输入之差」——裁剪会同时把上一次的分母改小，那种写法有时会给出负数。
    const addedUncached = prunedReading.inputTokens + prunedReading.cacheWriteTokens
    const r = control[boundaryCall]!.requestTokens - pruned[boundaryCall]!.requestTokens
    const tokenCriterionPositive = addedUncached < LATER_REQUESTS * r

    // 这条是同一算式在 h = 0.5 附近的特例，不是一般结论——记录里必须写明用的是哪一条。
    // 明确写出结论：本场景下这条 token 判据给出**为正**（`55 < 40 × 5`）。
    expect(tokenCriterionPositive).toBe(true)
    // 代价与收益两侧就是记录里引用的那两个数（`tail = 55`、`R = 5`）：钉住它们，「记录与用例同源」才有
    // 东西挡它漂移——只断方向时换成另一档配置也照绿。
    expect(addedUncached).toBe(55)
    expect(r).toBe(5)
    // 与 h = 0.5 的特例口径对齐：`n = tail / R`，所以「n 小于后续请求数」与这条 token 判据**恒等**
    // （这正是规格说它是「同一算式在 `h = 0.5` 附近的特例」的含义）。
    expect(netBenefit({ tail: addedUncached, r, h: 0.5, laterRequests: LATER_REQUESTS }).positive).toBe(tokenCriterionPositive)
    // 而本例外部声明的 h = 0.02 把代价抬了约 49 倍，给出**不同**结论——这正是「两条判据不得混用」的证据。
    expect(netBenefit({ tail: addedUncached, r, h: H, laterRequests: LATER_REQUESTS }).positive).not.toBe(tokenCriterionPositive)

    await disposeCompared(compared)
  }, 60000)
})

describe('票 07 · 闸门 B · 批量推进是主要杠杆', () => {
  it('大 M 的 n 更小，但 tail 同时增大（两项同时成立）', async () => {
    const shelves: { readonly m: number, readonly tail: number, readonly r: number, readonly prunes: number }[] = []
    for (const m of [3, 8]) {
      const compared = await twoArms({
        turnSteps: TURN_STEPS,
        turns: TURNS,
        // 两档都必须满足 03 的不变式 `M ≥ K + 2`（这里 `K = 1`，所以 `M` 至少 3）：`M = K + 1` 时首次触发
        // 的批量恰好为空、写入侧零落盘，那一档的读数从**第二次**触发起算，与另一档不同起点、不可比。
        prunedConfig: { everySteps: m, keepRecentSteps: 1 },
      })
      const control = compared.control.lc.calls
      const pruned = compared.pruned.lc.calls
      const boundaryCall = control.findIndex((call, index) =>
        call.reasoning.length > (pruned[index]?.reasoning.length ?? 0))
      expect(boundaryCall).toBeGreaterThanOrEqual(0)
      const reading = tokenReadings(compared.pruned.session)[boundaryCall]!
      shelves.push({
        m,
        tail: reading.inputTokens + reading.cacheWriteTokens,
        r: control[boundaryCall]!.requestTokens - pruned[boundaryCall]!.requestTokens,
        prunes: persistedPrunes(compared.pruned.session).length,
      })
      await disposeCompared(compared)
    }
    const small = shelves.find(shelf => shelf.m === 3)!
    const large = shelves.find(shelf => shelf.m === 8)!
    const nSmall = netBenefit({ tail: small.tail, r: small.r, h: H, laterRequests: LATER_REQUESTS }).n
    const nLarge = netBenefit({ tail: large.tail, r: large.r, h: H, laterRequests: LATER_REQUESTS }).n

    // 大 M 摊薄：更少的边界推进次数。
    expect(large.prunes).toBeLessThan(small.prunes)
    // 判据非空的两项**同时**成立：`n` 随 M 增大而下降 **且** `tail` 同时增大。
    // 只断 n 下降时，「tail 不计入批量自身」的实现也全绿——所以两项都断。
    expect(nLarge).toBeLessThan(nSmall)
    expect(large.tail).toBeGreaterThan(small.tail)
    // 两档的四个读数逐值钉住：记录里 `M` 的背书结论（回填 03）引用的就是它们，只断方向时
    // 它们可以同向漂移而全绿，票面数字会与实测静默分叉（`M = 3` 档的 `55` / `5` 已在上面
    // 那条 token 判据用例里钉住，这里补齐 `M = 8` 档）。
    expect([small.tail, small.r, large.tail, large.r]).toEqual([55, 5, 175, 30])
    expect(nSmall).toBeCloseTo(539, 5)
    // 记录里写的 `286` 是四舍五入值（与 `M = 3` 档的 `539` 同一形态）。
    expect(nLarge).toBeCloseTo(285.83, 2)
  }, 120000)

  it('tail 从最老的那一个被新裁步骤起算、包含这批步骤自身', async () => {
    // 隔离「批量自身算不计进 tail」的唯一办法是**比较两档的增量**：批量更大时，若 tail 只从上一个边界起算、
    // 不把这批步骤自身算进去，`tail` 的增量就会**小于**该批自身的推理量。逐档量出两者再比。
    const shelves: { readonly m: number, readonly tail: number, readonly batch: number, readonly steps: number }[] = []
    for (const m of [4, 8]) {
      const compared = await twoArms({
        turnSteps: TURN_STEPS,
        turns: TURNS,
        // 满足 03 的不变式 `M ≥ K + 2`（`K = 1`）。
        prunedConfig: { everySteps: m, keepRecentSteps: 1 },
      })
      const control = compared.control.lc.calls
      const pruned = compared.pruned.lc.calls
      const boundaryCall = control.findIndex((call, index) =>
        call.reasoning.length > (pruned[index]?.reasoning.length ?? 0))
      expect(boundaryCall).toBeGreaterThanOrEqual(0)
      const reading = tokenReadings(compared.pruned.session)[boundaryCall]!
      // 该批自身的推理量：同一下标上控制臂请求里有、裁剪臂请求里没有的那些推理文本。
      const removed = control[boundaryCall]!.reasoning.filter(text => !pruned[boundaryCall]!.reasoning.includes(text))
      expect(removed.length).toBeGreaterThan(0)
      shelves.push({
        m,
        tail: reading.inputTokens + reading.cacheWriteTokens,
        batch: reasoningTokens(removed),
        steps: removed.length,
      })
      await disposeCompared(compared)
    }
    const small = shelves.find(shelf => shelf.m === 4)!
    const large = shelves.find(shelf => shelf.m === 8)!

    // 大档的批量确实更大（否则下面的增量比较没有意义）。
    expect(large.steps).toBeGreaterThan(small.steps)
    expect(large.batch).toBeGreaterThan(small.batch)
    // **判据**：`tail` 的增量至少覆盖这批步骤自身的推理量。若实现把批量自身排除在 `tail` 之外，增量会小于
    // 该批自身的推理量，这条当场失败——这正是「tail 不计入批量自身也全绿」那个漏洞的封堵点。
    expect(large.tail - small.tail).toBeGreaterThanOrEqual(large.batch - small.batch)
    // 并且 tail 恒大于单批自身的推理量（它是边界尾的全部，不只是被裁的那几步）。
    expect(small.tail).toBeGreaterThan(small.batch)
    expect(large.tail).toBeGreaterThan(large.batch)
  }, 120000)
})

describe('票 07 · 闸门 B · 摘要遮蔽分支的适用边界', () => {
  it('先裁再摘要更便宜当且仅当 h > 1 − r；r ≈ 0.35 时要求 h > 0.65', async () => {
    // 摘要输入 S、推理占比 r：不裁剪的成本 ≈ h × S（前缀热），裁剪后 ≈ (1 − r) × S。
    const r = 0.35
    const cheaper = (h: number): boolean => h > 1 - r

    // r ≈ 0.35 时要求 h > 0.65。
    expect(cheaper(0.66)).toBe(true)
    expect(cheaper(0.65)).toBe(false)
    // 而缓存折扣通常是 0.1 量级：本例外部声明的 h = 0.02 ⇒ 先裁再摘要**更贵**。
    expect(cheaper(H)).toBe(false)
    // 「排除推理能省摘要 token」不等于省钱——这两句不能互相替换。
    expect(1 - r).toBeCloseTo(0.65, 5)

    // 用**实测**的 r 复核这条边界：从一次真实的摘要调用读它的推理占比。
    const scenario = await overflowScenario({ mountToolResultPruner: true, largeToolResults: true })
    expect(scenario.summaryReasoningShare).toBeGreaterThan(0)
    expect(scenario.summaryReasoningShare).toBeLessThan(1)
    // 该场景下先裁再摘要**更贵**：实测 r 很小（推理只占摘要输入的一小部分），所以要求 `h > 1 − r` 里那个
    // 门槛接近 1，而外部声明的 `h = 0.02` 远低于它。
    expect(H > 1 - scenario.summaryReasoningShare).toBe(false)
    await scenario.dispose()
  }, 120000)
})