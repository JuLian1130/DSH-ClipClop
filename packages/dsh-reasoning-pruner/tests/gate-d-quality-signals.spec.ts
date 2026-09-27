/**
 * 票 07 · 闸门 D：任务质量不下降（同场景对照）。
 *
 * 本闸门存在的理由只有一个：整份规格的立足点是一句从未被检验的话——「历史步骤的推理对后续内容不重要」。
 * 而**质量下降在这个功能里长得像成功**：裁掉推理省下的 token 是真的，模型因此回头重查、多试一条路所多花的
 * 步骤也是真的；只要多出的步骤比省下的便宜，成本账面仍然显示「改善」。
 *
 * 三条口径先写死：
 *
 * - **五个代理信号从现成耐久面读出**，全部是可比较的数或枚举值，不接受「无明显变化」。步骤数用的是
 *   **数 `assistant/message`**（不含 `interrupted: true`）这条口径——两条口径不等价，记录里写死用的哪一条。
 * - **`K` 只能由「模型会对被裁历史作出反应」的驱动背书**：固定脚本下两臂输出逐条相同、五个信号恒等，
 *   `K` 搜索只会返回「没有 `K` 触发恶化」，那等于把「测不出来」记成「没有恶化」。
 * - **任务是否达成只能人工判定**：`turn/end.completed` **不是**任务达成信号（它会在还有工具调用时因工具主动
 *   收尾而出现，也会因「模型没发起工具调用」而在一句话回答上出现）。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { H, proxySignals, repeatedProbes, tokenReadings } from './support/gate-readings.ts'
import { disposeCompared, kSweep, twoArms } from './support/two-arm.ts'
import { callInfo, cleanupRoots, persistedPrunes } from './support/session-harness.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

afterEach(cleanupRoots)

/** 空转反例与 `K` 扫描共用的场景规模。 */
const TURN_STEPS = [4, 4]
const TURNS = ['first turn', 'second turn']

/**
 * 反应式驱动：**被裁掉的推理步数达到 3 步**时，模型改为回头重查（再读一次同一目标）。
 *
 * 判据写成「丢了多少」而不是「某一步在不在」：`K` 只决定保留窗口大小，任何 `K` 下最老的步骤都会被裁掉，
 * 于是「某一步在不在」在每一档都给出同一个答案、扫不出下限。每档之间的差别正是**被裁掉多少**。
 *
 * `call` 上界是必需的：`probe` 恒真时该 turn 永不收尾，夹具会挂起（实测过 worker 崩溃）。
 */
function reactive(request: { readonly messages: readonly { readonly content: readonly unknown[] }[] }, call: number): { readonly probe: boolean } {
  if (call > 40) return { probe: false }
  const history = request.messages.map(message => JSON.stringify(message.content)).join('')
  const missing = SCRIPT_REASONING.filter(text => !history.includes(`"${text}"`)).length
  return { probe: missing >= 3 }
}

/** 场景的全部推理文本，用来在反应式驱动里数「丢了几步」。 */
const SCRIPT_REASONING = Array.from({ length: 12 }, (_unused, index) => `r${index}`)

/** `K` 扫描用的场景规模：12 步，于是 `K = 10` 仍有 1 条可裁（不是「什么都没裁」的空档）。 */
const SWEEP_TURN_STEPS = [4, 4, 4]
const SWEEP_TURNS = ['first turn', 'second turn', 'third turn']

describe('票 07 · 闸门 D · 空转反例必须先跑', () => {
  it('裁不掉任何东西时两臂的五个信号与每次 usage 逐项完全相等（K 过大）', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      // `K` ≥ 会话全部步数 ⇒ 每次到点都是空批量、写入侧零落盘。
      prunedConfig: { everySteps: 2, keepRecentSteps: 50 },
    })
    // 先断这一臂真的什么都没裁（否则「相等」可能是两臂都裁了）。
    expect(persistedPrunes(compared.pruned.session)).toEqual([])
    expect(proxySignals(compared.pruned.session.snapshotEvents()))
      .toEqual(proxySignals(compared.control.session.snapshotEvents()))
    expect(compared.pruned.lc.calls.map(callInfo)).toEqual(compared.control.lc.calls.map(callInfo))
    // usage 那一半（票面第 10 条要求「五个代理信号**与每次请求的 usage** 逐项完全相等」）：`callInfo` 刻意
    // 不含 usage，所以它必须**单独**断。缺了这条，两臂派生的 `cacheReadTokens` 即使不同也全绿——而
    // 「写死的 token 数会让这条反例恒真」正是第 9 条要防的。
    expect(tokenReadings(compared.pruned.session)).toEqual(tokenReadings(compared.control.session))
    await disposeCompared(compared)
  }, 120000)

  it('资格全不成立时同样逐项相等（全部历史步骤无裁剪资格）', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
      prunedIneligible: true,
    })
    expect(persistedPrunes(compared.pruned.session)).toEqual([])
    expect(proxySignals(compared.pruned.session.snapshotEvents()))
      .toEqual(proxySignals(compared.control.session.snapshotEvents()))
    expect(compared.pruned.lc.calls.map(callInfo)).toEqual(compared.control.lc.calls.map(callInfo))
    // usage 那一半同样要断（与上一条构造一致）：`callInfo` 刻意不含 usage，缺了这条，这条构造下两臂
    // 派生的 `cacheReadTokens` 即使不同也全绿。
    expect(tokenReadings(compared.pruned.session)).toEqual(tokenReadings(compared.control.session))
    await disposeCompared(compared)
  }, 120000)
})

describe('票 07 · 闸门 D · 五个代理信号', () => {
  it('五个信号都读得出可比较的数或枚举值', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 1 },
    })
    const signals = proxySignals(compared.pruned.session.snapshotEvents())
    // ① 步骤数：数 `assistant/message`（不含 interrupted），两条口径不等价、记录里写死这一条。
    expect(signals.steps).toBe(8)
    // ② 失败工具调用数：排除两个取消码之后仍是数。
    expect(signals.failedToolCalls).toBe(0)
    // ③ 异常收尾：`turn/end` 的 reason.kind，七个变体的取值集合。
    expect(signals.turnEnds).toEqual(['completed', 'completed'])
    // ④ 失败请求尝试数：`assistant/attempt` 的条数。本场景没有失败的尝试，所以是 0——**不是**「typeof 是
    // number」这种任何取值都过的写法；具体的非零读数由下面那条最小事件用例钉住。
    expect(signals.failedAttempts).toBe(0)
    // ⑤ 重复探查：固定脚本下每一步的目标都不同，所以没有重复。
    expect(signals.repeatedProbes).toBe(0)
    await disposeCompared(compared)
  }, 120000)

  it('失败请求尝试数读的是 `assistant/attempt` 的条数', () => {
    // 五个信号里 ④ 是唯一从 `assistant/attempt` 读出的量：只断「是 number」的话，读错事件、或恒读 0
    // （真实会话里 `assistant/attempt` 确实为 0）都全绿。这里正面给出非零读数。
    const events = [
      event('assistant/attempt', { turn: 1, step: 1 }),
      event('assistant/attempt', { turn: 1, step: 1 }),
      event('assistant/message', { turn: 1, step: 1, message: {}, stream: [] }),
    ]
    expect(proxySignals(events).failedAttempts).toBe(2)
    // 它不数别的类型的条数。
    expect(proxySignals([events[2]!]).failedAttempts).toBe(0)
  })

  it('失败工具调用数排除两个取消码（正常取消不算质量下降）', () => {
    const events = [
      event('tool/result', { turn: 1, step: 1, message: { role: 'tool', isError: true }, error: { name: 'x', code: 'ABORTED_BEFORE_DISPATCH' } }),
      event('tool/result', { turn: 1, step: 1, message: { role: 'tool', isError: true }, error: { name: 'x', code: 'ABORTED' } }),
      event('tool/result', { turn: 1, step: 1, message: { role: 'tool', isError: true }, error: { name: 'x', code: 'ENOENT' } }),
      event('tool/result', { turn: 1, step: 1, message: { role: 'tool', isError: true } }),
      event('tool/result', { turn: 1, step: 1, message: { role: 'tool' } }),
    ]
    // 两次真失败：ENOENT，以及那条无 code 的 `isError`。两个取消码与那条成功结果都不算。
    expect(proxySignals(events).failedToolCalls).toBe(2)
    // 单独钉住两个取消码：只加它们时计数为 0（把它们算成失败正是「一次正常取消被读成质量下降」）。
    expect(proxySignals(events.slice(0, 2)).failedToolCalls).toBe(0)
    // 而没有取消码的 `isError` 必须被算进来。
    expect(proxySignals([events[2]!]).failedToolCalls).toBe(1)
  })

  it('步骤数不含 `interrupted: true` 的那些消息', () => {
    const events = [
      event('assistant/message', { turn: 1, step: 1, message: {}, stream: [] }),
      event('assistant/message', { turn: 1, step: 2, message: {}, stream: [], interrupted: true }),
    ]
    expect(proxySignals(events).steps).toBe(1)
  })
})

describe('票 07 · 闸门 D · 重复探查归实验侧自建', () => {
  it('抓得到「中间夹着别的调用」的再次读取，且参数键序不影响配对', () => {
    // 两次同目标 `read` **必须隔着别的调用**（这里隔着 `read B` 与 `noop`）：挨着放时「只数连续重复」
    // 的实现也给同样的读法，这条断言对它就不可失败，而 `K` 的下限正是建立在这个统计器上。
    const calls = [
      call('read', '{"path":"A","z":1}'),
      call('read', '{"path":"B"}'),
      call('noop', '{"x":1}'),
      call('read', '{"z":1,"path":"A"}'),
    ]
    const statistic = repeatedProbes(calls)
    // 规范化后 A 被读了两次（键序不同、隔着一读一 noop）⇒ 1 次重复；B 一次、noop 不是探查类工具。
    // 连续重复器在这里给 0——这正是本条判据要能分辨的那件事。
    expect(statistic.total).toBe(1)
    expect(statistic.perTarget.filter(entry => entry.repeats > 0)).toHaveLength(1)
    expect(statistic.perTarget.find(entry => entry.repeats > 0)!.count).toBe(2)
  })

  it('模型产出的非法 JSON 参数仍可配对（退回原文，不抛）', () => {
    // `tool/call.arguments` 是模型产出的原始字符串、可以不是合法 JSON（先例 `repeat-tool-reminder` 的
    // `sortJsonValue` 注释把这条写成既有输入路径）。同一个非法串被再次探查时仍要配成一对。
    const calls = [call('read', '{"path": A'), call('noop', '{}'), call('read', '{"path": A')]
    expect(repeatedProbes(calls).total).toBe(1)
  })

  it('统计器只读日志、不写入任何会话事件', async () => {
    const compared = await twoArms({ turnSteps: TURN_STEPS, turns: TURNS, prunedConfig: { everySteps: 2, keepRecentSteps: 1 } })
    const before = compared.pruned.session.snapshotEvents().length
    repeatedProbes(compared.pruned.session.snapshotEvents()
      .filter((entry): entry is SessionEvent<'tool/call'> => entry.type === 'tool/call'))
    // 先例的产出是**模型可见的提醒消息**（接进来会改变被测历史、污染对照）；本统计器必须是纯读。
    expect(compared.pruned.session.snapshotEvents().length).toBe(before)
    await disposeCompared(compared)
  }, 120000)
})

describe('票 07 · 闸门 D · K 由本闸门背书', () => {
  it('从小到大逐档扫 K：首个不再出现恶化的 K 才是下限', async () => {
    // 驱动面必须是**反应式**的：固定脚本下两臂信号恒等，扫出来的「没有恶化」是测不出来而不是没恶化。
    const shelves = await kSweep({
      turnSteps: SWEEP_TURN_STEPS,
      turns: SWEEP_TURNS,
      ks: [0, 1, 2, 3, 4, 6, 8, 9, 10, 11],
      decide: reactive,
    })
    // 每一档都必须真的裁掉了东西，否则这一档什么都没测——`K` 大到窗口覆盖全部步数时就是这种空档，
    // 它返回的「没有恶化」是**测不出来**，不得据此回填 `K`。
    for (const shelf of shelves) expect(shelf.pruned).toBe(true)

    // 恶化出现在**小 K** 一侧（裁得越狠、模型越回头重查）。
    const worst = shelves.find(shelf => shelf.k === 0)!
    expect(worst.stepsDelta).toBeGreaterThan(0)
    expect(worst.repeatedProbesDelta).toBeGreaterThan(0)

    // 首个不再出现恶化的 K 才是下限（等价于「出现恶化的最大 K 再加一」）；出现恶化的那个 K 本身不得写回。
    const firstClean = shelves.find(shelf => shelf.stepsDelta <= 0 && shelf.repeatedProbesDelta <= 0)!
    expect(firstClean.k).toBe(10)
    // 下限是**紧**的：`K = 9`（它的前一个整数值）仍在恶化，所以下限不是 9 也不是更低。
    expect(shelves.find(shelf => shelf.k === 9)!.repeatedProbesDelta).toBeGreaterThan(0)
    expect(shelves.find(shelf => shelf.k === 8)!.stepsDelta).toBeGreaterThan(0)
    // 该档同时**真的裁了东西**——这两条一起排除「拿一个没测到东西的档当安全档」。
    expect(firstClean.pruned).toBe(true)
  }, 300000)

  it('固定脚本驱动的两臂五个信号恒等——这正是它不能背书 K 的原因', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    // 真的裁了，但固定脚本下模型输出逐条相同 ⇒ 五个信号逐项相等。
    expect(persistedPrunes(compared.pruned.session).length).toBeGreaterThan(0)
    expect(proxySignals(compared.pruned.session.snapshotEvents()))
      .toEqual(proxySignals(compared.control.session.snapshotEvents()))
    await disposeCompared(compared)
  }, 120000)
})

describe('票 07 · 闸门 D · 反例：「步骤更多但总花费更低」', () => {
  it('恶化的每一档都把「质量」与「花费」两半同时读出来，并如实给出是否为成本吸收', async () => {
    // 逐档把两半都读出来：这一档的结论必须**同时**给出「质量」与「花费」两个读数，不得只报花费那一半。
    // 花费 = 按外部声明的 `h` 定价（见 `sumCost`）；计费 token 另列，只作为记录里那一栏的读数。
    const shelves: { readonly k: number, readonly qualityWorse: boolean, readonly costLower: boolean }[] = []
    // 逐档的原始读数：记录里点名了 `K = 0` 与 `K = 10` 两档的具体数字，那两档必须在用例里被钉住——
    // 否则记录里的数字没有任何东西挡它漂移（这正是上一版登记写错 2846/26896/2836 却全绿的原因）。
    // `billed` 是**计费输入 token**（三者和，记录里引用的就是它），`cost` 是按 `h` 定价后的**花费**：
    // 两者在裁剪把缓存命中推成未缓存输入时会给出相反方向，所以必须分开钉、不得互相代替。
    const readings = new Map<number, { readonly steps: number, readonly probes: number, readonly billed: number, readonly cost: number }[]>()
    // 扫**实测为恶化的每一档**：这条 latch 是「质量下降被成本吸收」的唯一防线，档位集合必须等于
    // 「实测恶化的档」而不是记录里随手列的几个。`K = 9` 由上面那条用例断为恶化档，因此它必须在这里
    // 也被读到——把 `1/2/3/9` 排除在外时，那四档出现吸收也会全绿。
    for (const k of [0, 1, 2, 3, 4, 6, 8, 9, 10]) {
      const compared = await twoArms({
        turnSteps: SWEEP_TURN_STEPS,
        turns: SWEEP_TURNS,
        // `M = K + 2` 保持 03 的不变式：首次触发的批量非空。
        prunedConfig: { everySteps: k + 2, keepRecentSteps: k },
        decide: reactive,
      })
      const controlSignals = proxySignals(compared.control.session.snapshotEvents())
      const prunedSignals = proxySignals(compared.pruned.session.snapshotEvents())
      const controlTokens = sumCost(compared.control.session)
      const prunedTokens = sumCost(compared.pruned.session)
      // 两半都必须可读——这是「不得只报告花费那一半」的落点。
      expect(controlTokens).toBeGreaterThan(0)
      expect(prunedTokens).toBeGreaterThan(0)
      readings.set(k, [
        { steps: controlSignals.steps, probes: controlSignals.repeatedProbes, billed: sumBilled(compared.control.session), cost: controlTokens },
        { steps: prunedSignals.steps, probes: prunedSignals.repeatedProbes, billed: sumBilled(compared.pruned.session), cost: prunedTokens },
      ])
      shelves.push({
        k,
        qualityWorse: prunedSignals.steps > controlSignals.steps
          || prunedSignals.repeatedProbes > controlSignals.repeatedProbes,
        costLower: prunedTokens < controlTokens,
      })
      await disposeCompared(compared)
    }

    // `K = 0`（恶化最重）与 `K = 10`（首个不再恶化）两档的具体读数：质量、重复探查、计费 token 三项。
    // 这三组数字就是记录里引用的那几项，钉住它们才有「记录与实测一致」可言。
    expect(readings.get(0)!.map(entry => ({ steps: entry.steps, probes: entry.probes, billed: entry.billed }))).toEqual([
      { steps: 13, probes: 9, billed: 2878 },
      { steps: 44, probes: 40, billed: 26990 },
    ])
    expect(readings.get(10)!.map(entry => ({ steps: entry.steps, probes: entry.probes, billed: entry.billed }))).toEqual([
      { steps: 13, probes: 9, billed: 2878 },
      { steps: 13, probes: 9, billed: 2868 },
    ])
    // **花费方向与计费 token 方向相反**（这正是本条不得用三者和当花费的理由）：`K = 10` 档计费 token
    // 更低（2868 < 2878），按 `h = 0.02` 定价却**更贵**——裁剪把 315 token 从缓存命中推成未缓存输入，
    // 三者和看不见这一步。记录里 `K = 10` 那一句不得写成「更省钱」。
    const cleanTokens = readings.get(10)!
    expect(cleanTokens[1]!.billed).toBeLessThan(cleanTokens[0]!.billed)
    expect(cleanTokens[1]!.cost).toBeGreaterThan(cleanTokens[0]!.cost)

    // `K = 0` 是恶化的那一档：质量确实更差。
    expect(shelves.find(shelf => shelf.k === 0)!.qualityWorse).toBe(true)
    // **实测结论（如实记）**：本场景下没有任何一档出现「步骤更多但总花费更低」——恶化的每一档花费也更高，
    // 所以「质量下降被成本吸收」这条反例在本构造下不成立。记录照实写，不硬凑。
    // 这里管的是**花费**（按 `h` 定价），不是计费 token：两者在 `K = 10` 档方向相反（见上一条断言）。
    expect(shelves.filter(shelf => shelf.qualityWorse).every(shelf => !shelf.costLower)).toBe(true)
    // 而在**不**恶化的那一档上计费 token 确实更低——但花费更高（两条走向相反），这正是判据必须两半都读、
    // 且必须写清用的是哪一种币种的理由。
    const clean = shelves.find(shelf => shelf.k === 10)!
    expect(clean.qualityWorse).toBe(false)
    expect(clean.costLower).toBe(false)
  }, 300000)
})

/** 一条最小事件，用来单独测信号口径。 */
function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 0, data } as unknown as SessionEvent
}

/** 一条最小 `tool/call`。 */
function call(name: string, rawArguments: string): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c', name, arguments: rawArguments } } as unknown as SessionEvent<'tool/call'>
}

/**
 * 该会话的**花费**读数，按本票外部声明的 `h` 定价。
 *
 * 计价式与闸门 B-2 同源：`未缓存输入 + h × 缓存命中 + 缓存写入`（`h` 是缓存命中单价 / 未缓存输入单价）。
 * **不得**用三次计数之和当花费：裁剪把 token 从 `inputTokens` 搬进 `cacheReadTokens` 时三者和一格不变，
 * 于是「裁剪更省钱」这条结论会被装置预先定死——实测 `K = 10` 档正是这种形态（见下方断言）。
 * @param session - 会话。
 * @returns 全部 `assistant/message` 按 `h` 定价的花费。
 */
function sumCost(session: Session): number {
  return tokenReadings(session).reduce((total, reading) =>
    total + reading.inputTokens + H * reading.cacheReadTokens + reading.cacheWriteTokens, 0)
}

/**
 * 该会话的**计费输入 token**（三次计数之和）。
 *
 * 它是记录里引用的那一栏，**不是**花费：裁剪把 token 从缓存命中搬进未缓存输入时这个和不变，
 * 所以「更省钱」这类结论只能由 {@link sumCost} 给出。
 * @param session - 会话。
 * @returns 全部 `assistant/message` 的计费输入 token 之和。
 */
function sumBilled(session: Session): number {
  return tokenReadings(session).reduce((total, reading) => total + reading.billedInput, 0)
}

describe('票 07 · 闸门 D · 判据的读法（不能证明什么）', () => {
  it('没有任何「任务成功」信号可用，`turn/end.completed` 不是任务达成', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    const signals = proxySignals(compared.pruned.session.snapshotEvents())

    // `completed` 在**两个方向**上都不成立，本票不把它当成功信号：
    // ① 模型没发起工具调用时就收尾（与任务是否达成无关）；② 工具自己主动收尾时也会出现（此时仍有工具调用）。
    // 所以这里只把它读成枚举值，任务是否达成是**人工判定**的字段。
    expect(signals.turnEnds).toEqual(['completed', 'completed'])
    // 而「模型没发起工具调用」这一支在同一个场景里的确是最后一步的形状——`completed` 与「有没有工具调用」
    // 无关这件事因此在本场景里也是可观察的：收尾那一步的脚本 `calls` 为空，但同一条会话里仍有工具调用。
    const events = compared.pruned.session.snapshotEvents()
    expect(events.some(entry => entry.type === 'tool/call')).toBe(true)
    await disposeCompared(compared)
  }, 120000)

  it('代理信号只支持「没有恶化」，不支持「没有损害」', async () => {
    const compared = await twoArms({
      turnSteps: TURN_STEPS,
      turns: TURNS,
      prunedConfig: { everySteps: 2, keepRecentSteps: 0 },
    })
    // 五个信号是**必要条件**的读数、不是充分条件的证明：本票的结论里必须出现这句边界，
    // 且不得出现「已证明质量不下降」这类措辞（记录写在票面「实现期登记」）。
    const signals = proxySignals(compared.control.session.snapshotEvents())
    // 「没有恶化」的判据形式就是「五个信号的差 ≤ 0」；它成立时也只能说没有观测到恶化。
    expect(signals.steps).toBeGreaterThan(0)
    expect(signals.turnEnds.length).toBeGreaterThan(0)
    await disposeCompared(compared)
  }, 120000)
})