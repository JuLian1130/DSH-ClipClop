/**
 * 票 07 的**读数层**：三张测量闸门（B / B-2 / D）共用的观察面。
 *
 * 它只读**已耐久记录的现成面**，不新建计量：token 体积来自 `assistant/message` 的 `usage`，五个质量代理
 * 信号来自 `step/end` 折叠、`tool/result`、`turn/end`、`assistant/attempt`、`tool/call`。所有读数都是
 * 纯函数取一条已取好的事件数组，因此「哪一次请求算进来」这类口径由调用方决定，读数层不替它猜。
 *
 * @module
 */

import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

/**
 * 一次请求的 token 体积：真源是 `assistant/message` 上的 `usage`。
 *
 * 三次计数**互斥**（`inputTokens` 是未缓存输入，cached input 另计），所以「全价输入」是三者之和，
 * 不能写成 `inputTokens` 单值。缺省按 0 读（`cacheReadTokens` 只在非零时出现）。
 */
export interface TokenReading {
  /** 该次请求在日志里的 `assistant/message` seq；用来把读数与「哪一次请求」对上。 */
  readonly seq: number
  /** 未缓存输入。 */
  readonly inputTokens: number
  /** 缓存命中输入。 */
  readonly cacheReadTokens: number
  /** 缓存写入输入。 */
  readonly cacheWriteTokens: number
  /** 计费输入 = 三者之和（`TokenUsage` 明写 billed input 是三者和）。 */
  readonly billedInput: number
}

/**
 * 由 `usage` 派生一次 token 读数。
 * @param usage - 该事件的 `usage`；缺席时三次计数全按 0 读。
 * @returns 三次计数与计费输入。
 */
export function tokenReading(usage: { readonly inputTokens?: number, readonly cacheReadTokens?: number, readonly cacheWriteTokens?: number } | undefined): Omit<TokenReading, 'seq'> {
  const inputTokens = usage?.inputTokens ?? 0
  const cacheReadTokens = usage?.cacheReadTokens ?? 0
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0
  return { inputTokens, cacheReadTokens, cacheWriteTokens, billedInput: inputTokens + cacheReadTokens + cacheWriteTokens }
}

/**
 * 逐条 `assistant/message` 的请求读数，按 seq 升序。
 *
 * **不看 `interrupted`**：被取消的步骤也真的发过请求、也真的计费，token 体积这一项要把它们算进来（与步骤
 * 数那条口径的差别正在这里，见 {@link ProxySignals.steps}）。
 * @param session - 会话。
 * @returns 每条 assistant 消息的 seq 与三次计数。
 */
export function tokenReadings(session: Session): TokenReading[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    .map(event => ({ seq: event.seq, ...tokenReading(event.data.usage) }))
}

/** 五个质量代理信号。全部是可比较的数或枚举值，不接受「无明显变化」。 */
export interface ProxySignals {
  /**
   * 步骤数。
   *
   * 两条口径**不等价**，本字段用的是**数 `assistant/message`**（不含 `interrupted: true`）这一条：
   * `sessionStats.steps` 由 `step/end` 折叠，会算进被取消的步骤、不算 `max-tokens` 的空内容宿主消息，
   * 而该投影只在 web-app bundle 里挂载、本仓的集成夹具不含它。选这一条就不必为一个读数再挂一个投影。
   */
  readonly steps: number
  /** 失败工具调用数：`tool/result` 中 `isError === true` 且**不是**两个取消码的条数。 */
  readonly failedToolCalls: number
  /** 异常收尾：各个 `turn/end` 的 `reason.kind`，按发生顺序。 */
  readonly turnEnds: readonly string[]
  /** 失败请求尝试数：`assistant/attempt` 的条数。 */
  readonly failedAttempts: number
  /** 重复探查次数：同一目标被再次读取或再次搜索的次数（见 {@link repeatedProbes}）。 */
  readonly repeatedProbes: number
}

/** 两个取消码：未派发就被中止、以及已派发后被取消。两者都会合成一条 `isError` 结果，但都是正常取消。 */
const CANCEL_CODES = new Set<string>([TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH])

/**
 * 五个代理信号，全部读自一条已取好的事件数组。
 *
 * **`turn/end.completed` 不是任务达成**：它既会在模型没发起工具调用时出现，也会在工具主动收尾
 * （`exec.concludeTurn()`）时出现。本读数层只如实给出枚举值，是否达成由人工判定。
 * @param events - 该会话的全部事件（`session.snapshotEvents()`）。
 * @returns 五个信号。
 */
export function proxySignals(events: readonly SessionEvent[]): ProxySignals {
  const assistantMessages = events.filter((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message')
  const toolResults = events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
  const toolCalls = events.filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
  return {
    steps: assistantMessages.filter(event => event.data.interrupted !== true).length,
    failedToolCalls: toolResults.filter(event =>
      event.data.message.isError === true && !CANCEL_CODES.has(event.data.error?.code ?? '')).length,
    turnEnds: events
      .filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
      .map(event => event.data.reason.kind),
    failedAttempts: events.filter(event => event.type === 'assistant/attempt').length,
    repeatedProbes: repeatedProbes(toolCalls).total,
  }
}

/** 一次重复探查：某个规范化后的目标被第 2 次及以后探查的次数。 */
export interface RepeatedProbe {
  /** 该目标的键，形状是 `[工具名, 规范化参数]`。 */
  readonly key: string
  /** 探查总次数。 */
  readonly count: number
  /** 重复次数 = 总次数 − 1。 */
  readonly repeats: number
}

/**
 * 同一目标被**再次**读取或再次搜索的统计。
 *
 * 三处口径与仓内唯一先例（`repeat-tool-reminder`）不同，因为它不可复用：它只数**连续**重复（一有别的调用
 * 打断就归 1）、计数只在内存里（`WeakMap<Agent, Chain>`，从不落盘）、且产出是**模型可见的提醒消息**
 * （接进来会改变被测历史、污染对照）。本统计器只借它的规范化手法（深键排序后 stringify 与
 * `[name, canonical]` 的键形状），不借它的计数与内存态。
 *
 * 只对读取/搜索类工具计数：这两类才表达「回头重查」，「同一目标」对写类工具没有意义。
 * @param toolCalls - 该会话的全部 `tool/call` 事件。
 * @returns 每个被重复探查的目标，按首次出现顺序。
 */
export function repeatedProbes(toolCalls: readonly SessionEvent<'tool/call'>[]): { readonly total: number, readonly perTarget: readonly RepeatedProbe[] } {
  const counts = new Map<string, number>()
  for (const event of toolCalls) {
    if (!PROBE_TOOLS.has(event.data.name)) continue
    const key = probeKey(event.data.name, event.data.arguments)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const perTarget = [...counts].map(([key, count]) => ({ key, count, repeats: count - 1 }))
  return { total: perTarget.reduce((total, entry) => total + entry.repeats, 0), perTarget }
}

/** 表达「回头重查」的工具名；只有这些才进重复探查统计。 */
const PROBE_TOOLS = new Set(['read', 'search', 'grep', 'glob', 'list', 'fetch'])

/**
 * 一次探查的目标键：`[工具名, 规范化参数]`。
 * @param name - 工具名。
 * @param rawArguments - 模型产出的原始 JSON 字符串（未解析）。
 * @returns 规范化后的键；参数不是合法 JSON 时退回原文（仍是逐字节可比的）。
 */
function probeKey(name: string, rawArguments: string): string {
  return JSON.stringify([name, canonicalize(rawArguments)])
}

/**
 * 参数的规范化：解析后深键排序再 stringify。
 *
 * 解析失败时退回原文——不同键序但同语义的两次探查因此能配成一对，这正是「中间夹着别的调用」也抓得到的
 * 原因（连续重复器抓不到这种）。
 * @param rawArguments - 原始 JSON 字符串。
 * @returns 规范化后的字符串。
 */
function canonicalize(rawArguments: string): string {
  try {
    return JSON.stringify(sortJsonValue(JSON.parse(rawArguments)))
  } catch {
    return rawArguments
  }
}

/** 深键排序：对象按键名排序，数组保持顺序。 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  )
}

/** 模型可见历史里的推理块文本，按出现顺序（用于断「裁剪确实发生在模型可见历史里」）。 */
export function visibleReasoning(session: Session): string[] {
  return session.deriveMessages().flatMap(message =>
    message.role === 'assistant'
      ? message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
      : [],
  )
}

/**
 * 一批推理文本的 token 量，按 DSH 自己的固定密度估价器算。
 *
 * 用来把「被裁推理量 `R`」与摘要调用的推理占比 `r` 从**实测的请求内容**里算出来，而不是按 `targets` 反推
 * ——`targets` 只证明落盘了。
 * @param texts - 推理文本。
 * @returns token 数。
 */
export function reasoningTokens(texts: readonly string[]): number {
  return estimateContent(texts.map(text => ({ type: 'reasoning', text }) as ContentBlock))
}

/**
 * 外部声明的价格比 `h`（缓存命中单价 / 未缓存输入单价），三张闸门共用这一个值。
 *
 * **它是价格比，不是 token 比**：按 token 比 `h` 恒接近 1、`n` 退化为 0，所以「`h = cacheReadTokens /
 * 全价输入`」这条读法不成立。取值来源写死为**装入的 pi-ai 目录 cost 的交叉校验**：
 * `@earendil-works/pi-ai` 的 `providers/data/deepseek.json` 里 `deepseek-v4-flash` 是
 * `{input: 0.14, cacheRead: 0.0028}` ⇒ `h = 0.0028 / 0.14 = 0.02`。
 *
 * **仓内没有任何 cost 消费者**（不是「没有数据」）：那份目录带 per-model `cost` 且会进 DSH 的模型对象，只是
 * 无人读取（pi-ai 的目录注释明说 harness 从不读它、`replay.ts` 把它清零），`TokenUsage` 只有计数没有价格。
 * 所以 `h` 只能外部声明，「从 token 数反解 `h`」不可行——token 与价格之间没有映射。
 *
 * 换端点的人改这里一个数即可，三张闸门会一起跟着变（规格：三张闸门共用同一份 `h`，不得各写一个）。
 */
export const H = 0.02

/**
 * `h` 的取值来源，写进实验记录用。
 *
 * 换来源时连同 {@link H} 一起改：记录里 `h` 必须是一个**写明来源的输入**，不是从 token 数推出来的值。
 */
export const H_SOURCE = 'pi-ai 目录 cost 交叉校验：deepseek-v4-flash cost.cacheRead=0.0028 / cost.input=0.14'

/**
 * 净收益算式 `n ≈ (1 − h) × tail / (h × R)` 的代入结果。
 * `h` 是**价格比**（缓存命中单价 / 未缓存输入单价），必须由使用者外部声明——token 数里读不出价格，
 * 仓内也没有任何 cost 消费者。`n` 是回本请求数。
 */
export interface NetBenefit {
  /** 本次边界推进重算、且无法命中缓存的边界尾 token 数。 */
  readonly tail: number
  /** 本次边界推进中被移除的推理 token 总数。 */
  readonly r: number
  /** 外部声明的价格比。 */
  readonly h: number
  /** 回本请求数 `n ≈ (1 − h) × tail / (h × R)`；`R` 为 0 时无定义，取 `Infinity`。 */
  readonly n: number
  /** 实验场景**自行声明**的后续请求数。 */
  readonly laterRequests: number
  /** 净收益是否为正：`n` 小于此后还会出现的请求数。 */
  readonly positive: boolean
}

/**
 * 代入实测 `tail` / `R` 与外部声明的 `h`，与场景自行声明的后续请求数比较。
 *
 * 判据写死为「`n` 是一个算出来的数、后续请求数是一个声明的数，两者大小关系明确写成净收益为正/为负」，
 * 不接受「收益可观」这类措辞。
 * @param input - `tail` / `R` / `h` / 后续请求数。
 * @returns 算式结果与净收益正负。
 */
export function netBenefit(input: { readonly tail: number, readonly r: number, readonly h: number, readonly laterRequests: number }): NetBenefit {
  const { tail, r, h, laterRequests } = input
  const n = r === 0 ? Number.POSITIVE_INFINITY : ((1 - h) * tail) / (h * r)
  return { tail, r, h, n, laterRequests, positive: n < laterRequests }
}