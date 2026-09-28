/**
 * 票 08 的 **A2-DSH 两臂装置**：走来源①（真实路由 + 真实凭据）的两臂对照，回答「裁剪后**被提供方计费的
 * 输入是否真的下降」。
 *
 * 与 07 的 `two-arm.ts` **不是同一个装置**，也不复用它：07 的两臂挂脚本化适配器、`usage` 由请求内容派生，
 * 用来断「空转反例下两臂 usage 逐项相等」；换成真实路由会破坏 07 自己的判据。本装置的两臂各发一次**真实**
 * 请求，读的是**提供方计费**，因此它不能断「逐项相等」——真实端点各自独立采样。
 *
 * **对照基线**（票面 :16 写死）：不用「同一会话裁剪前 vs 裁剪后」——裁剪在步数到 `M` 时落盘，后一次请求
 * 必然多出该步新产生的消息，会让正确实现读出「未降」。这里取**同一份已落盘历史的反事实对照**：两臂各自
 * `resume` **同一个已落盘会话**的一份独立副本，唯一被操纵的量是该步骤的推理块是否被裁（一臂挂本插件投影、
 * 另一臂不挂；降级方向本就重建出未裁剪历史），然后各发**一次**请求。
 *
 * **观察面**：按 `assistant/message` 的 `usage` 读，且 `TokenUsage` 三次计数**互斥**，所以被计费的输入是
 * 三者之和（`inputTokens + cacheReadTokens + cacheWriteTokens`），不得只看 `inputTokens` 单值。
 *
 * 端点与凭据由使用者提供（票面 :25）：`PROBE_BASE_URL` + `DEEPSEEK_API_KEY`。装置**不设默认端点**——官方
 * `api.deepseek.com` 已不再支持 chat-completions 思考回放。缺任一项时本装置不产出任何结论。
 *
 * @module
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as pruner from '../../src/index.ts'
import { persistReasoningPrune } from '../../src/index.ts'
import { visibleReasoning } from './gate-readings.ts'
import { persistedPrunes } from './session-harness.ts'

/** 目标端点根地址；无默认值（票面 :25）。 */
const BASE_URL = process.env['PROBE_BASE_URL']
/** 目标模型 id。 */
const MODEL = 'deepseek/deepseek-v4.1-flash'
/** 本装置在真实路由上的 route 名。 */
const ROUTE = 'gate-a-real'

/**
 * 路由声明。`api` 必须是 `openai-completions`：裁剪资格按步骤的 replay 信封逐条判定
 * （`操作性定义 · 裁剪资格`），声明别的传输则两臂都无资格、装置空转。
 */
const PROVIDER = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  api: 'openai-completions',
  baseURL: BASE_URL ?? '',
  models: [{ id: MODEL, name: MODEL }],
}

/** 一次两臂对照的读数。 */
export interface ArmReading {
  /** 该臂是否挂了裁剪投影。 */
  readonly pruned: boolean
  /**
   * 该臂模型可见历史里的推理文本，按出现顺序，**逐块一项**。
   *
   * 「裁剪确实发生在模型可见历史里」只能由它断——只断落盘的 `targets` 会把「裁了但没生效」读成成功。
   */
  readonly reasoningTexts: readonly string[]
  /** 这一次请求的三次计数。 */
  readonly usage: { readonly inputTokens: number, readonly cacheReadTokens: number, readonly cacheWriteTokens: number }
  /** 被提供方计费的输入 = 三次计数之和（三者互斥，见模块头）。 */
  readonly billedInput: number
}

/** 一次两臂对照的全部观察量。 */
export interface GateAObservation {
  /** 裁剪臂落盘事件里的 `targets`；用来确认裁剪真的落盘了。 */
  readonly carrierTargets: readonly SessionSeq[]
  /**
   * 种子那一步的推理文本，**逐块一项**（即该被裁掉的那些块）。
   *
   * 「裁剪确实发生在模型可见历史里」比的是**这些块**是否还在：两臂在 resume 之后各自还要跑一个新 turn，
   * 而那个 turn 自己也会产生推理块，所以不能断「裁剪臂可见推理为空」。
   */
  readonly seedReasoningTexts: readonly string[]
  /** 不挂插件那一臂（基线：未裁剪）。 */
  readonly control: ArmReading
  /** 挂插件那一臂（裁剪版）。 */
  readonly pruned: ArmReading
}

/**
 * 挂一整条真实链路。
 * @param root - 该臂的落盘根；调用方保证两臂各拿一份内容相同的副本。
 * @param withPlugin - 是否装载本插件（唯一的自变量）。
 * @returns 该臂的 context 与 loop 驱动。
 */
async function mount(root: string, withPlugin: boolean): Promise<{ ctx: Context, harness: AgentLoopTestHarness }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // 必须注册至少一个工具：实测该端点在请求**不带** `tools` 数组时根本不把 `reasoning_content` 计入
  // `prompt_tokens`（同一份推理：不带 tools 时 97→97，带 tools 时 355→460）。DSH 的 agent loop 请求恒带
  // 工具声明，不带不是真实工作负载，那样两臂的差恒为零。
  ctx.tools.register({
    name: 'noop',
    description: 'Does nothing; exists so the request carries a tools array.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
  })
  await ctx.plugin(PiAi, { providers: { [ROUTE]: PROVIDER } })
  // 本插件 inject 了 `commands`：不挂它插件不激活（那时裁剪臂读到的就是未裁剪版，判据空转）。
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  if (withPlugin) await ctx.plugin(pruner, {})
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness }
}

/**
 * 读该臂在 resume 之后**第一次**请求的三次计数。
 *
 * 用第一次请求而不是最后一次：它的历史就是裁剪版/未裁剪版的种子历史，正是本判据要比较的那一次；模型是否
 * 发起工具调用是不确定的，多出一步的请求会带上工具结果，两臂的输入就不再可比（实测过 `.at(-1)` 的读法因
 * 此得出过反向结论）。
 * @param session - 该臂的会话。
 * @param seedMaxSeq - 种子历史的末尾 seq。
 * @returns 三次计数。
 * @throws 该臂没有发出请求，或端点没有回报 `usage` 时——那两种情形都是**未测**，按票面 :18 不得折算成
 *   任一方向的结论；折算成 0 的失败方向是假通过（该臂必然「更小」）。
 */
function firstRequestUsage(session: { snapshotEvents(): readonly SessionEvent[] }, seedMaxSeq: number): {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
} {
  const first = session.snapshotEvents()
    .filter((event): event is SessionEvent<'assistant/message'> =>
      event.type === 'assistant/message' && event.seq > seedMaxSeq)
    .at(0)
  if (first === undefined) throw new Error('gate-a-two-arms: an arm issued no request; the criterion is unmeasured')
  const usage = first.data.usage
  if (usage === undefined) {
    throw new Error('gate-a-two-arms: the endpoint reported no usage; the criterion is unmeasured, not zero')
  }
  // `cacheReadTokens` / `cacheWriteTokens` 只在非零时出现，缺省即 0（`gate-readings.ts` 的同一读法）。
  return {
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * 跑一次 A2-DSH 两臂对照。
 *
 * 步骤：种一条真实会话并落盘 → 对它落一条裁剪决策 → 两臂各自 `resume` 同一份历史、各发一次请求 →
 * 比较两臂的被计费输入。
 * @returns 两臂读数与落盘的 `targets`。
 * @throws `PROBE_BASE_URL` 缺失时（本装置不设默认端点）。
 */
export async function runGateATwoArms(): Promise<GateAObservation> {
  if (BASE_URL === undefined || BASE_URL.length === 0) {
    throw new Error('gate-a-two-arms: PROBE_BASE_URL is required; this device sets no default endpoint')
  }
  const root = await mkdtemp(join(tmpdir(), 'gate-a-two-arms-'))
  const armRoots: string[] = []
  try {
    const seed = await mount(root, false)
    const sessionId = SessionId('gate-a-two-arms')
    const agent = await seed.harness.create(sessionId, { provider: ROUTE, model: MODEL })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Think step by step about why 17 is prime. Do not call any tool. End with the single word PRIME.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const seedReasoningTexts = visibleReasoning(agent.session)
    const assistantSeqs = agent.session.snapshotEvents()
      .filter(event => event.type === 'assistant/message')
      .map(event => event.seq)
    const carrierSeq = persistReasoningPrune(agent.session, assistantSeqs.map(seq => SessionSeq(seq)))
    if (carrierSeq === undefined) {
      throw new Error('gate-a-two-arms: the seed turn recorded no prunable step; nothing to compare')
    }
    const carrierTargets = persistedPrunes(agent.session).at(-1)?.targets.map(seq => SessionSeq(seq)) ?? []
    // 种子历史的末尾 seq：两臂 resume 后的第一个 `assistant/message` 必然大于它。
    const seedMaxSeq = agent.session.snapshotEvents().at(-1)?.seq ?? 0
    await seed.ctx.sessions.flush(agent.session)
    await seed.ctx.fiber.dispose()

    const arms: ArmReading[] = []
    for (const withPlugin of [false, true]) {
      // 每臂一份**独立**的落盘根，内容从种子的落盘复制而来。共用同一个根会让第二臂读到第一臂刚写下的那个
      // 新 turn，两臂的历史就不再只差「该步骤的推理块是否被裁」这一个自变量（实测：共用根时裁剪臂的请求
      // 里多出一条上一臂产生的 assistant 消息，读数反而更大）。
      const armRoot = await mkdtemp(join(tmpdir(), 'gate-a-two-arms-arm-'))
      armRoots.push(armRoot)
      await cp(root, armRoot, { recursive: true })
      const arm = await mount(armRoot, withPlugin)
      const handle = await arm.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: ROUTE, model: MODEL },
      })
      const reasoningTexts = visibleReasoning(handle.agent.session)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Now restate the verdict in one short sentence.' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      const usage = firstRequestUsage(handle.agent.session, seedMaxSeq)
      arms.push({
        pruned: withPlugin,
        reasoningTexts,
        usage,
        billedInput: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      })
      await arm.ctx.fiber.dispose()
    }
    const control = arms.find(arm => !arm.pruned)
    const prunedArm = arms.find(arm => arm.pruned)
    if (control === undefined || prunedArm === undefined) throw new Error('gate-a-two-arms: an arm produced no reading')
    return { carrierTargets, seedReasoningTexts, control, pruned: prunedArm }
  } finally {
    await rm(root, { recursive: true, force: true })
    await Promise.all(armRoots.map(armRoot => rm(armRoot, { recursive: true, force: true })))
  }
}