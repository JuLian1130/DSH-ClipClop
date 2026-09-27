/**
 * 票 07 的**两臂对照器**：同一任务、同一脚本序列、同一路由与配置，**只有「挂裁剪投影 / 不挂」这一个自变
 * 量不同**。
 *
 * 观察面写死：两臂各起一条独立的 agent loop 与独立会话（各自一个落盘根、一个 context），因此两臂之间没有
 * 共享状态。**这不是选择而是规格的明说**（`闸门 D`「没有可比的基线设施」）：仓内没有评测装置，`fork` 只
 * 复制一段包含式前缀，`llm-replay` 假定轨迹完全一致（脚本耗尽会大声失败），所以对照只能从同一任务出发现跑。
 *
 * `loop-fixture` 是形状模板而非可复用装置（它挂的是 navigator 本身，没有「不挂」的一端），所以本文件照它
 * 的形状新建一份属于本包的对照器。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { LifecycleOptions, PersistentLifecycle, ScriptedStep } from './session-harness.ts'
import { cleanupRoots, lifecycle, persistedPrunes } from './session-harness.ts'
import { proxySignals } from './gate-readings.ts'

/** 一臂的现场。 */
export interface Arm {
  readonly lc: PersistentLifecycle
  readonly agent: Agent
  readonly session: Session
}

/** 一次两臂对照的现场。 */
export interface Compared {
  /** 不挂裁剪的那一臂（基线）。 */
  readonly control: Arm
  /** 挂裁剪投影的那一臂。 */
  readonly pruned: Arm
  /** 两臂各自的驱动步数（逐 turn），用于断言两臂驱动**逐条相同**。 */
  readonly turnSteps: readonly number[]
}

/** {@link twoArms} 的可选项。 */
export interface TwoArmOptions {
  /**
   * 逐 turn 的步数。两臂用**同一份**序列，脚本由它派生（每个 turn 的最后一步纯文本收尾，于是该 turn 有界）。
   *
   * 用步数而不是一份现成脚本：turn 必须有界，而「每一步都发起工具调用」的脚本永远收不了尾——那种写法在
   * 夹具里表现为 turn 永不结束（实测：挂起后 worker 崩溃）。逐 turn 的收尾形状照 03 的 `scriptOfTurns`。
   */
  readonly turnSteps: readonly number[]
  /** 逐 turn 的驱动文本（每条真实用户消息一次）；两臂逐条相同。 */
  readonly turns: readonly string[]
  /** 推理文本的前缀，用来在断言里认出「哪一步被裁」。 */
  readonly reasoningPrefix?: string
  /**
   * 裁剪臂的插件配置。控制臂**不挂**插件，所以「裁不掉任何东西」的空转反例由这里的配置承担
   * （`keepRecentSteps` ≥ 会话全部步数时每次到点都是空批量、零写入）。
   */
  readonly prunedConfig?: LifecycleOptions['config']
  /** 裁剪臂的「全部历史步骤资格不成立」开关；空转反例的另一条构造。 */
  readonly prunedIneligible?: boolean
  /** 是否挂真的 compaction-basic（闸门 B-2 要）。 */
  readonly compaction?: Record<string, unknown>
  /** 是否挂 tool-result pruner。 */
  readonly toolResultPruner?: boolean
  /** 两臂失败入口（闸门 B-2 用）；两臂同款，按请求内容命中。 */
  readonly failWhen?: LifecycleOptions['failWhen']
  /** 裁剪臂的逐 `agent/pre-step` 观察面。 */
  readonly onPreStep?: LifecycleOptions['onPreStep']
  /**
   * 两臂同款的**反应式驱动**（按模型可见历史决定回复）。闸门 D 的 `K` 背书要求这条驱动面；固定脚本下两臂
   * 信号恒等，`K` 搜索只会返回「没有 `K` 触发恶化」。
   */
  readonly decide?: LifecycleOptions['decide']
}

/**
 * 由逐 turn 的步数派生脚本：每个 turn 的最后一步纯文本收尾、其余发起工具调用。
 *
 * 这一步的形状照 03 的 `scriptOfTurns`（同一份脚本两臂共用是闸门 D 第 2 条的前提）。
 * @param turnSteps - 逐 turn 的步数。
 * @param reasoningPrefix - 推理文本前缀。
 * @returns 逐步脚本。
 */
export function scriptOfTurns(turnSteps: readonly number[], reasoningPrefix = 'r'): ScriptedStep[] {
  const toolCalls: boolean[] = []
  for (const steps of turnSteps) {
    for (let index = 0; index < steps; index += 1) toolCalls.push(index < steps - 1)
  }
  return toolCalls.map((tool, index) => ({
    reasoning: `${reasoningPrefix}${index}`,
    text: `t${index}`,
    calls: tool ? [{ name: 'noop', arguments: `{"i":${index}}` }] : [],
  }))
}

/**
 * 起两臂并**逐条相同地**驱动它们。
 *
 * 控制臂走 `withPlugin: false`：它是「把一份已裁历史喂给一段录制轨迹」在仓内不成立时的直接替代——同一任务
 * 从头发起，端挂裁剪投影、另一端不挂。
 * @param options - 见 {@link TwoArmOptions}。
 * @returns 两臂现场。
 */
export async function twoArms(options: TwoArmOptions): Promise<Compared> {
  const script = scriptOfTurns(options.turnSteps, options.reasoningPrefix)
  const shared: LifecycleOptions = {
    ...options.compaction === undefined ? {} : { compaction: options.compaction },
    ...options.toolResultPruner === true ? { toolResultPruner: true } : {},
    ...options.failWhen === undefined ? {} : { failWhen: options.failWhen },
    ...options.decide === undefined ? {} : { decide: options.decide },
    ...options.onPreStep === undefined ? {} : { onPreStep: options.onPreStep },
  }
  const control = await lifecycle(script, { ...shared, withPlugin: false })
  registerTools(control.ctx)
  const pruned = await lifecycle(script, {
    ...shared,
    ...options.prunedConfig === undefined ? {} : { config: options.prunedConfig },
    ...options.prunedIneligible === true ? { ineligible: true } : {},
  })
  registerTools(pruned.ctx)
  const controlArm = await driveArm(control, options.turns, 'arm-control')
  const prunedArm = await driveArm(pruned, options.turns, 'arm-pruned')
  return { control: controlArm, pruned: prunedArm, turnSteps: [...options.turnSteps] }
}

/**
 * 建会话并把给定的每个 turn 依次驱动到收尾。
 * @param lc - 该臂的生命周期。
 * @param turns - 逐 turn 的驱动文本。
 * @param id - 会话身份；两臂用不同 id，避免落到同一个落盘根的同一身份上。
 * @returns 该臂现场。
 */
async function driveArm(lc: PersistentLifecycle, turns: readonly string[], id: string): Promise<Arm> {
  const { agent, session } = await lc.createSession(id)
  for (const text of turns) await lc.step(agent, text)
  return { lc, agent, session }
}

/** 脚本用到的两条工具，让工具调用能派发（两臂都要，否则工具调用失败本身就会污染信号）。 */
function registerTools(ctx: Context): void {
  for (const name of ['noop', 'read']) {
    ctx.tools.register({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({}),
    })
  }
}

/** 释放一次对照里的两臂（落盘根统一由 `cleanupRoots` 删）。 */
export async function disposeCompared(compared: Compared): Promise<void> {
  await compared.control.lc.dispose()
  await compared.pruned.lc.dispose()
  await cleanupRoots()
}

/** {@link kSweep} 的一档结果。 */
export interface KSweepShelf {
  /** 这一档的保留窗口 `K`。 */
  readonly k: number
  /** 同步长下两臂的信号差（裁剪臂 − 控制臂）；正数即恶化。 */
  readonly stepsDelta: number
  readonly repeatedProbesDelta: number
  /** 裁剪臂在该档是否真的裁掉了东西（`K` 过大时空批量 ⇒ 这一档什么都没测）。 */
  readonly pruned: boolean
}

/**
 * **从大到小逐档扫 `K`**：`K` 是「保留最近几个步骤不裁」，所以恶化发生在 **小 `K`** 一侧——`K` 越小裁得
 * 越狠、模型越可能回头重查。因此下限是「从小到大扫，**首个不再出现恶化**的 `K`」，等价于「出现恶化的最大
 * `K` 再加一」；出现恶化的那个 `K` 本身不得写回。
 *
 * 驱动面是**反应式**的（`decide` 按模型可见历史决定回复）：被裁历史让本次改为回头重查。固定脚本驱动不出
 * 这个反应（两臂输出逐条相同、信号恒等），那正是「不得据固定脚本回填 `K`」的原因。
 *
 * `K` 必须保持 03 的不变式 `M ≥ K + 2`——首次触发的批量非空。`M` 因此随档取 `K + 2`。
 * @param options - 同步长、档位、驱动文本与反应式驱动。
 * @returns 逐档结果。
 */
export async function kSweep(options: {
  readonly turnSteps: readonly number[]
  readonly turns: readonly string[]
  readonly ks: readonly number[]
  readonly decide: NonNullable<LifecycleOptions['decide']>
}): Promise<KSweepShelf[]> {
  const shelves: KSweepShelf[] = []
  for (const k of options.ks) {
    const compared = await twoArms({
      turnSteps: options.turnSteps,
      turns: options.turns,
      // `M = K + 2` 是这条不变式的下界；再小首次触发的批量就是空的。
      prunedConfig: { everySteps: k + 2, keepRecentSteps: k },
      decide: options.decide,
    })
    const control = proxySignals(compared.control.session.snapshotEvents())
    const pruned = proxySignals(compared.pruned.session.snapshotEvents())
    shelves.push({
      k,
      stepsDelta: pruned.steps - control.steps,
      repeatedProbesDelta: pruned.repeatedProbes - control.repeatedProbes,
      pruned: persistedPrunes(compared.pruned.session).length > 0,
    })
    await disposeCompared(compared)
  }
  return shelves
}