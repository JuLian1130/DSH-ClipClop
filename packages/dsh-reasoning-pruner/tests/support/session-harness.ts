/**
 * 票 02 的集成夹具：一条**真实**会话（真 agent loop + 真会话存储 + 真 JSONL 落盘后端）与「重挂载」。
 *
 * 03、04、05、06、07 复用本文件，所以它建在 `tests/support/` 下而不是某个 spec 里。三样能力：
 *
 * - **可裁消息**：`ScriptedReasoningAdapter` 每一步产出一条**由 `openai-completions` 传输产生**的
 *   assistant 消息——含推理块、文本块、可选工具调用，并按「块数相等 + 逐位同类型」给出 replay 信封。
 *   这是裁剪资格与裁剪算子的真实输入（票 01 用的 `text-adapter.ts` 三者皆无，造不出可裁候选）。
 * - **耐久落盘**：挂真的 `JsonlSessionPersistence`，会话走 agent loop 的 `createStoredSession`，所以每次
 *   `session/event` 都被路由进写句柄；`dispose()` 排空并关闭句柄，换成第二个 context 就得到一次**真的
 *   重挂载**（投影注册真的再跑一次）。
 * - **冷读**：`coldRead` 走 `sessionPersistence.open(..., 'read').read()`，即未装载插件也走的那条
 *   `validateStoredEvents` + 关系折叠的读路径。
 *
 * 校准（不是验收判据）：比较「运行期折叠」与「重载全量折叠」时两边都要带上同一个系统提示词上下文——一个
 * 从未跑过请求的空会话不派生 `system/message`。因此运行期至少推进一个 turn 再比较。
 *
 * @module
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, LlmAdapter, LlmError, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { estimateContent, ROLE_OVERHEAD } from '@deepseek-ai/dsh-token-meter/estimate'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as plugin from '../../src/index.ts'
import { CARRIER_EVENT_TYPE } from '../../src/types.ts'
import type { Config } from '../../src/types.ts'

/** 脚本每一步的产出；`calls` 为空时该步以纯文本收尾。 */
export interface ScriptedStep {
  /** 推理块文本；缺省表示这一步不产出推理块。 */
  readonly reasoning?: string
  /** 文本块文本。 */
  readonly text: string
  /** 要发起的工具调用；非空时该步的 turn 不结束。 */
  readonly calls?: readonly { readonly name: string, readonly arguments: string }[]
  /**
   * 该步 replay 信封声明的传输。缺省 `openai-completions`（唯一有裁剪资格的传输）；给别的值就造出一条
   * **信封无资格**的历史步骤——那是「无资格不写入」唯一能正面构造的输入。
   */
  readonly api?: string
  /**
   * 这一步声明的缓存场景。token 数**不**由脚本给出，由请求内容派生（见 {@link ScriptedReasoningAdapter}）：
   *
   * - `hit`：与前一次请求逐字节相同的前缀命中缓存，其后变更的后缀计未缓存输入。
   * - `cold`：什么都没命中，整条请求计未缓存输入。
   * - `write`：相同前缀命中缓存，变更的后缀被写入缓存（计 `cacheWriteTokens`）。
   *
   * 缺省 `hit`。三种场景互斥——它们是同一件事的三种声明，不是回退链。
   */
  readonly cache?: CacheScenario
}

/** 脚本声明的缓存场景；见 {@link ScriptedStep.cache}。 */
export type CacheScenario = 'hit' | 'cold' | 'write'

/**
 * 一次**按模型可见历史**作出的回复决定（见 {@link ScriptedReasoningAdapter} 的 `decide`）。
 *
 * `probe` 为真表示这次要回头重查（再读一次同一个目标），于是该步发一次工具调用；为假则该步纯文本收尾。
 * 它是「模型对被裁历史作出反应」的唯一入口，也是 `K` 下限唯一可被背书的驱动面。
 *
 * **实现必须自己把「一直重查」收住**（例如按调用下标设上限）：`probe` 恒真时该 turn 永不收尾，夹具会挂
 * 起直到 worker 崩溃——这不是判据失败，而是驱动没写完。收到第二个参数 `call` 正是为了这个。
 */
export interface ReactiveDecision {
  /** 本次是否回头重查。 */
  readonly probe: boolean
  /** 重查目标的参数（原始 JSON 字符串）；缺省按步号生成，于是同一目标会被反复读。 */
  readonly arguments?: string
}

/** 信封里 `api` 的缺省值，也就是唯一有裁剪资格的传输。 */
const API = 'openai-completions'

/**
 * 让某一次模型调用真的以这个失败收场。
 *
 * `code` 走 `LlmError`（`HarnessError` 的子类）的 `code` 自有属性，因此运行期把它归一化成
 * `finish: { kind: 'error', failure }`、`failure.code` 就是这个字符串；换成普通 `Error` 会被归一化成
 * `UNKNOWN`，造不出 `CONTEXT_WINDOW_EXCEEDED` 这类判据要的码。
 */
export interface LlmFailure {
  /** 失败正文。 */
  readonly message: string
  /** 提供方中立码（如 `CONTEXT_WINDOW_EXCEEDED`）。 */
  readonly code: string
}

/** 一次模型调用的观察量：模型调用下标、用途，以及请求侧输入的规模。 */
export interface LlmCall {
  /** 本适配器实例的第几次调用（从 0 起）。 */
  readonly call: number
  /** 请求用途；`'compaction'` 即摘要调用自身。 */
  readonly purpose: string | undefined
  /** 请求的消息条数。 */
  readonly messages: number
  /** 请求全部消息的文本长度之和。 */
  readonly chars: number
  /** 本适配器为该次调用报告的未缓存输入 token 数；调用失败时为 `undefined`。 */
  readonly inputTokens: number | undefined
  /** 本适配器为该次调用报告的缓存命中 token 数；调用失败时为 `undefined`。 */
  readonly cacheReadTokens: number | undefined
  /** 本适配器为该次调用报告的缓存写入 token 数；调用失败时为 `undefined`。 */
  readonly cacheWriteTokens: number | undefined
  /**
   * 该次请求的模型可见输入里的推理块文本，按出现顺序。
   *
   * 「裁剪确实发生在模型可见历史里」只能用这个面断——`targets` 有值只证明落盘了，裁了但没生效
   * （信封退化时整条消息跌落重建）在这里才看得见。
   */
  readonly reasoning: readonly string[]
  /**
   * 该次请求逐消息的规范化内容（`JSON.stringify(message.content)`）。
   *
   * 用例靠它**自己**按派生规则从该次请求算出应有的三次计数——`usage` 必须可被独立复算，否则
   * 「由请求内容派生」这条只能靠读适配器的源码相信。
   */
  readonly content: readonly string[]
  /**
   * 该次请求全部消息的估价 token 数（DSH 固定密度估价器）。
   *
   * 摘要分支的「推理占比 `r`」只能在摘要调用自身这一次请求上量：它是推理 token 与这一次请求总量之比，
   * 而摘要调用不经 agent loop、不落 `assistant/message`，所以它的体积只能在请求侧读。
   */
  readonly requestTokens: number
}

/**
 * 两臂逐调用应逐项相等的字段。
 *
 * 空转反例（「两臂之间除裁剪外没有别的差异」）要比的就是这些：请求的消息条数、文本量、推理块与估价
 * token 数，加上调用下标与用途。**不**包含 `usage`——那是本票新补的派生读数，两臂的差异正是它要量的东西。
 * @param call - 一次调用的观察行。
 * @returns 该调用的比较面。
 */
export function callInfo(call: LlmCall): {
  readonly call: number
  readonly purpose: string | undefined
  readonly messages: number
  readonly chars: number
  readonly reasoning: readonly string[]
  readonly requestTokens: number
} {
  const { call: index, purpose, messages, chars, reasoning, requestTokens } = call
  return { call: index, purpose, messages, chars, reasoning, requestTokens }
}

/**
 * 表面在两个 generation 上的读数。
 *
 * `replaceGeneration` 只数 `replace`（摘要落盘会推进它），`contentGeneration` 还数插件投影变更
 * （本插件的裁剪推进它）——「裁剪不算进展」这条判据的全部依据就是这个差值。
 */
export interface SurfaceReading {
  /** 已提交的 positional replacement 数。 */
  readonly replaceGeneration: number
  /** 已提交的 replacement 与插件自有 message 变更之和。 */
  readonly contentGeneration: number
  /** 已落盘的裁剪决策条数（承载事件里顶层带 `clipclop` 的那些）。 */
  readonly prunes: number
  /** 那一刻模型可见历史里的推理块文本，按出现顺序。 */
  readonly reasoning: readonly string[]
}

/**
 * 取一次表面读数。
 * @param session - 会话。
 * @returns 两个 generation、裁剪决策条数与模型可见的推理文本。
 */
export function surfaceReading(session: Session): SurfaceReading {
  return {
    replaceGeneration: session.surface.replaceGeneration,
    contentGeneration: session.surface.contentGeneration,
    prunes: persistedPrunes(session).length,
    reasoning: reasoningTexts(session),
  }
}

/** 本文件创建过的落盘根；`cleanupRoots` 统一删除。 */
const createdRoots: string[] = []

/**
 * 每一步产出推理块、文本块与可选工具调用的脚本化适配器。
 *
 * `finish` 的 `replayState` 按**实际发出的块**逐位给条目（文本块的 `textSignature`、推理块的
 * `thinkingSignature`、工具调用块的 `thoughtSignature`），所以消息天然满足「信封与内容逐位对齐」。
 * 脚本用完后重复最后一段，调用次数由用例自己控制。
 */
export class ScriptedReasoningAdapter extends LlmAdapter {
  private call = 0

  /**
   * 已经失败过的失败身份（`message` + `code`），每个身份只失败一次——重试不再失败，否则「重试成功与否」
   * 无法观察。
   *
   * 按身份而不是按「总共一次」：同一次运行里可以有**两个**不同的失败（合同里的情形是摘要失败 + 溢出失败，
   * 它们共同造出「tool-result pruner 落了 replace、摘要没成、compaction-basic 仍重试」那条分支）。
   * 单个条件的 `failWhen` 行为不变——它第二次仍返回同一个身份，因此依旧只失败一次。
   */
  private readonly failed = new Set<string>()

  /** 上一次请求逐消息的规范化字节串；本次的 `cacheReadTokens` 按它与本次的公共前缀判定。 */
  private previousRequest: readonly string[] | undefined

  /** 每一次模型调用前记录的一行（见 {@link LlmCall}）；`purpose` 与输入规模都出自这一次请求。 */
  readonly calls: LlmCall[] = []

  /**
   * @param script - 逐步脚本；最后一段在脚本用完后重复。
   * @param toolsThrough - 前多少次模型调用发起工具调用；之后一律纯文本收尾，让 turn 有界。
   * @param stepApi - 按模型调用下标逐次覆盖信封声明的传输；最后一个元素在数组用完后重复。用来在**同一个
   *   会话**里混用有资格与无资格的传输——`ineligible` 只能把每一步都改成无资格，造不出「中途换模型」。
   * @param failWhen - 该次调用的请求满足它时，本次调用以 {@link LlmFailure} 失败（**每个失败身份只失败一次**：
   *   命中的那一次记下来，重试不再失败）。这是「真实失败路径」的唯一入口：适配器向外抛 `LlmError`，运行期把它
   *   归一化成 `agent/request-error` 的 `payload.failure`。用「请求里出现某段文本」这种与调用下标无关的
   *   条件，才不会把「重试是不是真的重发」的判据建在猜测的下标上。
   * @param decide - **按模型可见历史决定本次回复**的驱动（闸门 D 的 `K` 背书要求这条驱动面）。
   *   给定时它取代按调用下标取脚本的那条路：`decision` 为真表示「被裁历史让这次回复改为回头重查」，
   *   该步就发一次工具调用（其参数由 `probe` 给出或按步号生成）；为假则该步纯文本收尾。
   *
   *   这与 {@link ScriptedStep} 的固定脚本**不是**同一个东西，两者也不等价：固定脚本下两臂的模型输出与
   *   工具调用序列逐条相同、五个代理信号恒等，`K` 搜索只会返回「没有 `K` 触发恶化」——那等于把「测不出来」
   *   记成「没有恶化」。所以 `K` 的下限只能由这条驱动面背书。
   */
  constructor(
    private readonly script: readonly ScriptedStep[],
    private readonly toolsThrough?: number,
    private readonly stepApi?: readonly string[],
    private readonly failWhen?: (request: GenerateOptions) => LlmFailure | undefined,
    private readonly decide?: (request: GenerateOptions, call: number) => ReactiveDecision,
  ) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = this.call
    this.call += 1
    // 这一次调用的观察行先占位、`usage` 发完再补齐：调用失败时两个 token 读数保持 `undefined`（那一次
    // 没有 usage 可读），用例靠 `purpose === 'compaction'` 认摘要调用。
    const observation: {
      -readonly [K in keyof LlmCall]: LlmCall[K]
    } = {
      call,
      purpose: options.purpose,
      messages: options.messages.length,
      chars: options.messages.reduce((total, message) => total + textLengthOf(message.content), 0),
      inputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoning: options.messages.flatMap(message => message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)),
      content: options.messages.map(message => JSON.stringify(message.content)),
      requestTokens: options.messages.reduce((total, message) => total + estimateContent(message.content) + ROLE_OVERHEAD, 0),
    }
    this.calls.push(observation)
    const failure = this.failWhen?.(options)
    if (failure !== undefined) {
      const identity = `${failure.code}\u0000${failure.message}`
      if (!this.failed.has(identity)) {
        this.failed.add(identity)
        throw new LlmError(failure.message, failure.code)
      }
    }

    let step = this.script[Math.min(call, this.script.length - 1)]
    // 反应式驱动（见构造函数的 `decide`）：它取代按调用下标回放的那条路，所以只走它自己的决定。
    if (this.decide !== undefined) {
      const decision = this.decide(options, call)
      step = {
        ...step,
        calls: decision.probe
          ? [{ name: 'read', arguments: decision.arguments ?? '{"path":"same"}' }]
          : [],
      }
    }
    const api = this.stepApi?.[Math.min(call, this.stepApi.length - 1)]
    if (api !== undefined) step = { ...step, api }
    // 有界 turn：第 `toolsThrough` 次模型调用之后不再发起工具调用，于是该 turn 在
    // `toolsThrough + 1` 步收尾。这是「驱动到恰好第 N 步」唯一不依赖时序的写法——`agent/pre-step`
    // 正好在第 N 次请求之前发出，而该请求就是收尾那一次。
    if (this.toolsThrough !== undefined && this.call > this.toolsThrough) {
      step = { ...step, calls: [] }
    }

    const blocks: ContentBlock[] = []
    if (step.reasoning !== undefined) blocks.push({ type: 'reasoning', text: step.reasoning })
    blocks.push({ type: 'text', text: step.text })
    for (const [index, invoked] of (step.calls ?? []).entries()) {
      blocks.push({
        type: 'tool-call',
        id: ToolCallId(`${invoked.name}-${call}-${index}`),
        name: invoked.name,
        arguments: invoked.arguments,
      })
    }

    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield block.type === 'reasoning'
        ? { type: 'reasoning-delta', index, text: block.text }
        : { type: 'text-delta', index, text: block.type === 'text' ? block.text : '' }
      yield { type: 'block-end', index, block }
    }
    const usage = this.deriveUsage(options, step.cache)
    observation.inputTokens = usage.inputTokens
    observation.cacheReadTokens = usage.cacheReadTokens
    observation.cacheWriteTokens = usage.cacheWriteTokens
    yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: blocks.some(block => block.type === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' },
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: step.api ?? API,
          provider: options.provider,
          model: options.model,
          stopReason: 'stop',
        },
        blocks: blocks.map(block => block.type === 'reasoning'
          ? { type: 'reasoning', thinkingSignature: `sig-think-${block.text}` }
          : block.type === 'text'
            ? { type: 'text', textSignature: 'sig-text' }
            : { type: 'tool-call', thoughtSignature: 'sig-tool' }),
      },
    }
  }

  /**
   * 由**请求内容**派生的 `usage`（本票补的第三样能力）。
   *
   * 规则写死：本次请求与上一次请求**逐消息同字节**的前缀计 `cacheReadTokens`，其后变更的尾部计
   * `inputTokens`；`cacheWriteTokens` 只在声明 `write` 场景的那一步等于该尾部。token 数由 DSH 自己的
   * 固定密度估价器（`@deepseek-ai/dsh-token-meter/estimate`）算出，**脚本不写死任何 token 数**——写死的数
   * 会让「裁了推理 ⇒ 后续请求的输入变小」这条读数恒真，也会让两臂对照的空转反例失去意义。
   *
   * 按**消息内容**而非整条消息比较前缀：消息身份与来源不参与模型可见输入，让它们参与前缀判定会造出
   * 「内容没变但前缀不命中」的假命中失败。裁剪改的正是内容，所以裁掉推理的请求在这里必然读到一个更短
   * 的未缓存尾部。
   * @param options - 该次调用的请求。
   * @param scenario - 该步脚本声明的缓存场景（缺省 `hit`）。
   * @returns 该次调用报告的用量。
   */
  private deriveUsage(options: GenerateOptions, scenario: CacheScenario = 'hit'): TokenUsage {
    const request = options.messages.map(message => JSON.stringify(message.content))
    const previous = this.previousRequest
    this.previousRequest = request
    let cached = 0
    if (scenario !== 'cold' && previous !== undefined) {
      while (cached < request.length && cached < previous.length && request[cached] === previous[cached]) {
        cached += 1
      }
    }
    const price = (from: number): number =>
      options.messages.slice(from).reduce((total, message) => total + estimateContent(message.content) + ROLE_OVERHEAD, 0)
    const inputTokens = price(cached)
    return {
      inputTokens,
      outputTokens: 10,
      cacheReadTokens: price(0) - inputTokens,
      cacheWriteTokens: scenario === 'write' ? inputTokens : 0,
      reasoningTokens: 5,
    }
  }
}

/**
 * `steps` 步的脚本：每一步都发起一次工具调用，收尾交给适配器的 `toolsThrough = steps - 1`，于是这个 turn
 * 恰好走 `steps` 个步骤、留下 `steps` 条可裁的 assistant 消息。
 * @param steps - 步数。
 * @returns 逐步脚本。
 */
export function toolCallScript(steps: number): ScriptedStep[] {
  return Array.from({ length: steps }, (_unused, index) => ({
    reasoning: `r${index}`,
    text: `t${index}`,
    calls: [{ name: 'noop', arguments: '{}' }],
  }))
}

/**
 * 注册 {@link toolCallScript} 用到的那条工具，让脚本里的工具调用能派发。
 * @param ctx - 夹具的根 context。
 * @param name - 工具名（脚本里写的是 `noop`）。
 */
export function registerTool(ctx: Context, name: string): void {
  ctx.tools.register({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
  })
}

/** 一条消息内容里可读文本的长度之和（文本块与推理块各算自己的 `text`）。 */
function textLengthOf(content: readonly ContentBlock[]): number {
  return content.reduce((total, block) => {
    if (block.type === 'text' || block.type === 'reasoning') return total + block.text.length
    if (block.type === 'tool-call') return total + block.arguments.length
    return total
  }, 0)
}

/** 落盘后的一条已读日志。 */
export interface ColdLog {
  /** 读路径校验过的事件（未装载插件时正是这条路径决定「整段读不出来」）。 */
  readonly events: readonly SessionEvent[]
  /** 存下来的头。 */
  readonly header: SessionHeader
  /** 读路径给出的取值所有权状态。 */
  readonly eventState: 'detached' | 'shared-frozen'
}

/** 一个生命周期（一个 context + 一个落盘根）上的能力。 */
export interface PersistentLifecycle {
  readonly ctx: Context
  /** 该生命周期的落盘根；`remount` 用它换取一次真的重挂载。 */
  readonly root: string
  /** 建一条真实会话；`id` 是它在落盘根里的身份，也是重挂载时的入口。 */
  /**
   * 建一条会话；`id` 是它在落盘根里的身份。同一落盘根里 `id` 只能用一次。
   *
   * `resume` 为真时走 `ctx.agents.resume`，把**已落盘的同名会话装回来**再驱动（
   * `agentLoop.create` 对已有同 id 的工件会抛 `SessionAlreadyExistsError`，不是恢复入口）。
   */
  createSession(id: string, options?: { readonly resume?: boolean }): Promise<{ agent: Agent, session: Session }>
  /** 推进一个 turn（一条真实用户消息 + 等它收尾）。 */
  step(agent: Agent, text: string): Promise<void>
  /** 冷读落盘的日志；未装载插件时也走这条路径。 */
  coldRead(id: string): Promise<ColdLog>
  /** 每一次模型调用前记录的一行，按调用顺序（见 {@link LlmCall}）；摘要调用靠 `purpose` 辨认。 */
  readonly calls: readonly LlmCall[]
  /** 本插件那一行的 fiber（`withPlugin: false` 时为 `undefined`）；06 的「宿主半仍 ACTIVE」读它。 */
  readonly pluginFiber: Fiber | undefined
  /** 排空写句柄并释放整个 context；**不删落盘根**（重挂载与读原始落盘文本都还要用它）。 */
  dispose(): Promise<void>
}

/** {@link lifecycle} 的可选项。 */
export interface LifecycleOptions {
  /** 关闭本插件，用来构造「未装载插件的读者」。 */
  readonly withPlugin?: boolean
  /**
   * 前多少次模型调用发起工具调用；之后一律纯文本收尾，于是该 turn 在 `toolsThrough + 1` 步结束。
   *
   * 「驱动到恰好第 N 步」的判据就是这个：第 N 次 `agent/pre-step` 正好在第 N 次请求之前，而第 N 次请求
   * 就是收尾那一次。不设时脚本的 `calls` 说了算（与 02 的夹具一致）。
   */
  readonly toolsThrough?: number
  /** 复用已有落盘根（重挂载时给）。 */
  readonly root?: string
  /**
   * 传给本插件的配置；缺省走 `Config` 的默认值。取的是 **schema 的输入类型**（profile patch 里写的形状）：
   * `volatile` 字段读入普通值、读出稳定引用，两者不是同一个类型。
   */
  readonly config?: Schemastery.TypeS<typeof Config>
  /**
   * 在插件装载**之后**、驱动之前被调一次。
   *
   * 位置是有意的：`ctx.on` 的 `{prepend: true}` 走 `unshift`，**后注册的排在队首**，所以在这里注册的
   * `{prepend: true}` 监听器会跑在本插件之前。用于「只挂一个观察面」的场景（例如给 `ctx.tokenMeter`
   * 打桩）。
   */
  readonly prepend?: (ctx: Context) => void
  /**
   * 在插件装载**之前**、驱动之前被调一次（异步等待其完成）。
   *
   * 这里注册的同侪与观察面都排在 compaction-basic **之前**（后者由 {@link LifecycleOptions.compaction}
   * 在本回调之后装载），而本插件以 `{prepend: true}` 注册、恒在 hooks 队首（`unshift` 先插先跑）。
   *
   * **这里注册的 `{prepend: true}` 观察面并不在本插件之前**——两者都 `unshift`，「先注册的先跑」在内侧，
   * 但本插件后注册，所以它排在最前。要观察「本插件跑完、compaction-basic 还没跑」那一刻用
   * {@link LifecycleOptions.onRequestError}（它在插件之后、compaction-basic 之前以 `push` 注册）。
   */
  readonly beforePlugin?: (ctx: Context) => void | Promise<void>
  /**
   * 让每一步的信封都声明一个**没有裁剪资格**的传输（`api !== 'openai-completions'`）。
   *
   * 这是「到点但无可裁步骤 ⇒ 零写入」唯一能正面构造的输入：触发节奏照旧，只是写入侧的资格闸门把每一批
   * 都拦成空集。
   */
  readonly ineligible?: boolean
  /**
   * 按模型调用下标逐次覆盖信封声明的传输（见 {@link ScriptedReasoningAdapter} 的 `stepApi`）。
   *
   * 「中途换模型只裁有资格的那些步骤」唯一能正面构造的输入：`ineligible` 是全有或全无。
   */
  readonly stepApi?: readonly string[]
  /**
   * 让**第一次**满足它的模型调用以指定失败收场（见 {@link ScriptedReasoningAdapter} 的 `failWhen`）。
   *
   * 这是构造一次**真实** `CONTEXT_WINDOW_EXCEEDED` 失败的入口：适配器真的抛错，运行期把它归一化成
   * `agent/request-error` 的 `payload.failure`，所以失败码、`assistant/attempt`、终局 `throw` 都由真实
   * 代码路径产生；伪造一条 `agent/request-error` 事件绕不过这条路径。
   */
  readonly failWhen?: (request: GenerateOptions) => LlmFailure | undefined
  /**
   * 按模型可见历史决定本次回复（闸门 D 的 `K` 背书要的驱动面）；见 {@link ScriptedReasoningAdapter} 的
   * `decide`。给定时它会取代按调用下标回放脚本的那条路。
   */
  readonly decide?: (request: GenerateOptions, call: number) => ReactiveDecision
  /**
   * 挂真的 `@deepseek-ai/dsh-compaction-basic`，用这份配置（`auto: true` 由夹具补上）。
   *
   * 本插件以 `prepend` 注册，而它在本插件**之前**装载，所以「裁剪先落盘、它的测量与选区在后」这条顺序
   * 就是真实的同侪形态。第 6 条用 `{ maxOverflowRetries: 0 }` 构造「它不重试」的稀疏分支。
   */
  readonly compaction?: Record<string, unknown>
  /** 挂真的 `@deepseek-ai/dsh-compaction-tool-result-pruner`（构造「pruner 没落 replace」的分支用）。 */
  readonly toolResultPruner?: boolean
  /**
   * 逐 `agent/request-error` 的观察面，注册在本插件**之后**、compaction-basic **之前**（普通 `push`；
   * 见 {@link LifecycleOptions.compaction} 的装载位置）。
   *
   * 于是它先于同侪拿到 `atListener`（那一刻本插件已跑完、同侪还没跑），再在 `next()` resolve 后拿到
   * **链的最终动作** `action`。注意 `action` 是链的返回值，不是本插件自己的返回值——本插件是链上最外层，
   * 它 `return next()` 时两者恒等，所以「本插件有没有自己改成 retry」无法从 `action` 上分辨。
   */
  readonly onRequestError?: (payload: {
    readonly agent: Agent
    readonly failure: { readonly code: string }
    /** 观察者被调到时**立刻**取到的表面读数：即「本插件已跑完、compaction-basic 还没跑」那一刻。 */
    readonly atListener: SurfaceReading
    /** 整条链跑完之后（`next()` resolve 时）取到的链的最终动作。 */
    readonly action: unknown
  }) => void
  /**
   * 每个 `agent/pre-step` 载荷的观察面，在**本插件的监听器跑完之后**被调一次。
   *
   * 这是「恰好在第 N 步落盘」唯一可判断的取样点：本插件以 `prepend` 注册，所以本回调注册得比它晚、在
   * 它之后跑；而它又比后续（非 prepend）的同侪早，因此观察到的正是「本步骤的裁剪决策已落盘、批次事件尚未
   * 出现」那一刻。给的是载荷本身，用例自己决定记什么。
   */
  readonly onPreStep?: (payload: { step: number, turn: number, session: Session }) => void
}

/**
 * 创建独立落盘根并挂载一整条真实链路。
 *
 * `withPlugin` 为 false 时**不装载本插件**，用来构造「未装载插件的读者」。
 * @param script - 适配器的脚本。
 * @param options - 见 {@link LifecycleOptions}。
 * @returns 该生命周期的能力对象。
 */
export async function lifecycle(
  script: readonly ScriptedStep[],
  options: LifecycleOptions = {},
): Promise<PersistentLifecycle> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-reasoning-pruner-'))
  createdRoots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // 计量器是 DSH 的正常装配项（compaction-basic 的 `inject` 里就有它），挂上它之后「未注入的插件不激活」
  // 这条原生语义在夹具里才与真实环境一致；本插件自己不读它（② 的节奏由步数决定）。
  await ctx.plugin(TokenMeter)
  // 06 起本插件的 host 半 inject 了 `commands`（④ 的命令只能在 host 半注册），所以夹具必须挂真的命令表。
  await ctx.plugin(CommandRuntime)
  const adapter = new ScriptedReasoningAdapter(
    options.ineligible === true
      ? script.map(step => ({ ...step, api: 'anthropic-messages' }))
      : script,
    options.toolsThrough,
    options.stepApi,
    options.failWhen,
    options.decide,
  )
  ctx.llm.registerAdapter(['mock'], adapter)
  if (options.beforePlugin !== undefined) await options.beforePlugin(ctx)
  // 顺序有意：`onRequestError` 的观察面先以普通 `push` 注册（此刻队里只有它）、compaction-basic 后装载，
  // 于是它正落在两者之间；本插件以 `prepend`（`unshift`）恒在 hooks 队首。挂载顺序决定位置，
  // `compaction` 必须在 `withPlugin` 之前。
  if (options.onRequestError !== undefined) {
    const observe = options.onRequestError
    ctx.on('agent/request-error', (payload, next) => {
      // 先取一次表面读数：此刻本插件已跑完、compaction-basic 还没跑。`next()` 之后拿到链的最终动作。
      const atListener = surfaceReading(payload.agent.session)
      return next().then(action => {
        observe({ ...payload, atListener, action })
        return action
      })
    })
  }
  if (options.toolResultPruner === true) await ctx.plugin(ToolResultPruner)
  if (options.compaction !== undefined) await ctx.plugin(BasicCompactionEngine, { auto: true, ...options.compaction })
  const pluginFiber = (options.withPlugin ?? true) ? ctx.plugin(plugin, options.config ?? {}) : undefined
  if (pluginFiber !== undefined) await pluginFiber
  options.prepend?.(ctx)
  // 观察面注册在插件**之后**：本插件 prepend，所以本监听器排在它之后跑，取样点即「本步骤的决策已落盘」。
  if (options.onPreStep !== undefined) {
    const observe = options.onPreStep
    ctx.on('agent/pre-step', ({ agent, step, turn }, next) => {
      observe({ step, turn, session: agent.session })
      return next()
    })
  }
  // 后端必须**先于 loop** 挂载：活会话的写缓冲只在后端自己的 teardown effect 里排空（`session/disposed`
  // 只丢路由、不排空），而 Cordis 按挂载顺序的逆序拆卸。后端先挂 ⇒ loop 先退场 ⇒ 后端排空时写句柄
  // 还在。反过来挂会**静默丢盘**：loop 先退场关掉会话，后端再排空时路由已经没了。
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const harness = await mountAgentLoopTestHarness(ctx)
  /** 本生命周期建过的会话，`dispose` 时逐个过 durability checkpoint。 */
  const sessions: Session[] = []

  return {
    ctx,
    root,
    pluginFiber,
    get calls() {
      return adapter.calls
    },
    async createSession(id, sessionOptions) {
      if (sessionOptions?.resume === true) {
        const handle = await ctx.agents.resume({
          resumeSessionId: SessionId(id),
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        sessions.push(handle.agent.session)
        return { agent: handle.agent, session: handle.agent.session }
      }
      const agent = await harness.create(SessionId(id), { provider: 'mock', model: 'mock' })
      sessions.push(agent.session)
      return { agent, session: agent.session }
    },
    async step(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async coldRead(id) {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        const read = await handle.read()
        return { events: read.events, header: handle.header, eventState: read.eventState }
      } finally {
        await handle.close()
      }
    },
    async dispose() {
      // 活会话的写缓冲只在后端自己的 teardown 里排空，而挂载/拆卸顺序由 `Inject` 决定、不由本文件决定；
      // 显式过一次 `session/flush` 让「盘上有这条会话」与拆卸顺序无关，也让重挂载是确定的。
      for (const session of sessions) await ctx.sessions.flush(session)
      await ctx.fiber.dispose()
      // 落盘根不在这里删：重挂载与读原始落盘文本都要用它。删除统一由 {@link cleanupRoots} 负责。
    },
  }
}

/**
 * 删除本文件创建过的全部落盘根。用例在 `afterEach` 里调它，所以 `dispose()` 之后仍可以读盘。
 */
export async function cleanupRoots(): Promise<void> {
  await Promise.all(createdRoots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
}

/**
 * 在已有落盘根上做一次**真的重挂载**：新 context、新插件 fiber、投影注册真的再跑一次。
 *
 * 不复用「同一个已打开的会话再读一次」——那种写法在「投影只在写入进程的内存里生效」的实现下恒真。
 * @param root - 上一次生命周期用的落盘根。
 * @param script - 适配器脚本（重挂载后若还要继续驱动）。
 * @param options - 同 {@link lifecycle}。
 * @returns 该生命周期的能力对象。
 */
export function remount(
  root: string,
  script: readonly ScriptedStep[],
  options: LifecycleOptions = {},
): Promise<PersistentLifecycle> {
  return lifecycle(script, { ...options, root })
}

/**
 * 把一条冷读日志按**模型可见路径**恢复成会话：`SessionStore.prepare` 正是正常重载走的那条路
 * （`Session.fromRestore(..., this.projections)`），用的是插件注册的投影。
 * @param lc - 提供 `sessions` 服务的生命周期。
 * @param id - 已落盘的会话身份。
 * @param log - {@link PersistentLifecycle.coldRead} 的结果。
 * @returns 一个**未进入 store** 的会话；`deriveMessages()` 即模型可见历史。
 */
export function restore(lc: PersistentLifecycle, id: string, log: ColdLog): Session {
  return lc.ctx.sessions.prepare(SessionId(id), {
    seed: [...log.events],
    meta: log.header,
    eventState: log.eventState,
    inheritedEventCount: SessionLogOffset(0),
  })
}

/** 一条消息里的推理块文本，按出现顺序。 */
export function reasoningTexts(session: Session): string[] {
  return session.deriveMessages().flatMap(message =>
    message.role === 'assistant'
      ? message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
      : [],
  )
}

/** 一条已记录的 `assistant/message` 的 seq 与它携带的推理块文本。 */
export interface RecordedAssistant {
  readonly seq: number
  readonly reasoning: string
}

/**
 * 已记录的 `assistant/message`，按 seq 升序，带各自的推理块文本。
 *
 * 读的是**日志里的消息**（不是模型可见历史）——用例要靠它算出「本批应裁哪些 seq」，拿被投影改过的历史
 * 去算就成循环论证了。
 * @param session - 会话。
 * @returns 每条已记录 assistant 消息的 seq 与推理文本（无推理块时为空串）。
 */
export function recordedAssistants(session: Session): RecordedAssistant[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    .map(event => ({
      seq: event.seq,
      reasoning: event.data.message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
        .join(''),
    }))
}

/** 一条已落盘的裁剪决策。 */
export interface PersistedPrune {
  /** 承载事件自己的 seq。 */
  readonly seq: number
  /** 该决策声明要裁剪的历史步骤，按 seq 升序。 */
  readonly targets: readonly number[]
}

/**
 * 本插件已落盘的裁剪决策，按事件 seq 升序。
 *
 * 只认顶层带 `clipclop` 键的事件——宿主自己的同类型事件必须不出现在这里（那正是 02 的判别规则）。
 * @param session - 会话。
 * @returns 每条决策的承载事件 seq 与 `targets`。
 */
export function persistedPrunes(session: Session): PersistedPrune[] {
  return session.snapshotEvents()
    .filter(event => event.type === CARRIER_EVENT_TYPE)
    .map(event => ({ seq: event.seq, data: event.data as unknown }))
    .filter(entry => typeof entry.data === 'object' && entry.data !== null && 'clipclop' in entry.data)
    .map((entry) => {
      const envelope = (entry.data as { clipclop: { targets: number[] } }).clipclop
      return { seq: entry.seq, targets: envelope.targets }
    })
}

/**
 * 只满足触发与选区所需的**最小会话面**（`snapshotEvents` / `ownEvents` / `inheritedEventCount` /
 * `surface` / `append`）。
 *
 * 它让「已裁集合从日志重建」「保留窗口」「会话级步号」这类**线性推进**可以在没有 agent loop 的情况下直接
 * 构造：真夹具里走到第 12 步要真的驱动 12 步，而这几条判据的对象是纯函数。造出来的 assistant 消息带
 * `pi-ai` + `openai-completions` 信封，也就是唯一有裁剪资格的输入。
 */
export interface FakeSession {
  readonly events: SessionEvent[]
  /** 当前表面节点：只含 `surfaceOp: 'append'` 的消息事件（`append()` 写的是 log-only 事件）。 */
  readonly surface: {
    readonly nodes: readonly number[]
    readonly replaceGeneration: number
    readonly contentGeneration: number
  }
  snapshotEvents(from?: number, toExclusive?: number): readonly SessionEvent[]
  ownEvents(): readonly SessionEvent[]
  readonly inheritedEventCount: number
  append(type: string, data: unknown): { readonly seq: number }
}

/**
 * 造一个最小会话：每一步先落一条 `step/start`，再落一条有裁剪资格的 `assistant/message`（与真 loop 的
 * 「第 N 步的 pre-step 时已有 N-1 条 step/start」形状一致）。
 * @param steps - 每步的推理与文本。
 * @returns 最小会话面；需要真 `Session` 时由用例自己断言转换。
 */
export function fakeSession(steps: readonly { readonly reasoning: string, readonly text: string }[]): FakeSession {
  const events: SessionEvent[] = []
  let seq = 0
  for (const [index, step] of steps.entries()) {
    events.push({
      type: 'step/start',
      seq: SessionSeq(seq),
      time: 0,
      data: { turn: 1, step: index + 1 },
    } as SessionEvent)
    seq += 1
    const content: ContentBlock[] = [
      { type: 'reasoning', text: step.reasoning },
      { type: 'text', text: step.text },
    ]
    const message: AssistantMessage = {
      id: MessageId(`assistant-${seq}`),
      role: 'assistant',
      content,
      source: {
        kind: 'model',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'deepseek', model: 'deepseek-v4-flash', stopReason: 'stop' },
          blocks: [{ type: 'reasoning', thinkingSignature: 'sig-think' }, { type: 'text', textSignature: 'sig-text' }],
        },
      },
    }
    events.push({
      type: 'assistant/message',
      seq: SessionSeq(seq),
      time: 0,
      data: { turn: 1, step: index + 1, message, stream: [] },
      surfaceOp: 'append',
    } as SessionEvent)
    seq += 1
  }
  return {
    events,
    get surface() {
      return {
        nodes: events.filter(event => event.surfaceOp === 'append').map(event => event.seq),
        replaceGeneration: 0,
        contentGeneration: 0,
      }
    },
    snapshotEvents(from = 0, toExclusive = events.length) {
      return events.slice(from, toExclusive)
    },
    ownEvents() {
      return events
    },
    inheritedEventCount: SessionLogOffset(0),
    append(type: string, data: unknown) {
      const event = { type, seq: SessionSeq(seq), time: 0, data } as SessionEvent
      events.push(event)
      seq += 1
      return event
    },
  }
}

/**
 * 读**未经 schema 解析的原始落盘文本**（`.jsonl` 每一行都是原样的 envelope）。
 *
 * 这是「payload 不含会话内容」唯一有效的观察面：`deriveMessages()` 只会投影后的消息，看不到原始
 * payload；而 `session-log-deepseek` 正是把这份 `data` 原样上传到远端的消费者。
 * @param root - 落盘根。
 * @returns 根下所有 `.jsonl` 文件的文本，按路径排序拼接。
 */
export async function rawLogText(root: string): Promise<string> {
  const files = (await readdir(root, { recursive: true, encoding: 'utf8' }))
    .filter(name => name.endsWith('.jsonl'))
    .sort()
  const parts: string[] = []
  for (const file of files) parts.push(await readFile(join(root, file), 'utf8'))
  return parts.join('\n')
}
