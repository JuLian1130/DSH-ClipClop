/**
 * 集成夹具：**真实** agent loop + 真 token 计量器 + 脚本化 route + 被测插件。
 *
 * 为什么需要它：本票的一条判据是「替换后的落盘内容被 token 计量器读到」，而计量器读的是**会话表面**
 * （`tool/result` 事件的落盘投影），不是 `tools/post-execute` 的返回值——只测接缝看不到这一面。夹具因此
 * 把结果真的驱动进一条真会话。
 *
 * 脚本化 route 同时服务主会话（先发一次 `bash` 工具调用、之后纯文本收尾）与本插件的摘要请求（按
 * `<<<TOOL_RESULT>>>` 标记辨认），所以两条请求走的是同一个适配器注册。适配器声明 `off` 档位，因为
 * 摘要请求默认要 `reasoningEffort: 'off'`，未声明的档位会在路由校验里被拒。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as plugin from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { FakeSpill } from './spill.ts'

/** 本夹具注册的工具名；脚本里的工具调用写它。 */
const TOOL = 'bash'

/** 摘要请求的判别标记：插件把工具正文放进这对分隔标记之间。 */
const SUMMARY_MARKER = '<<<TOOL_RESULT>>>'

/** 脚本化 route：主会话先发一次工具调用、之后纯文本收尾；摘要请求回一段固定 JSON。 */
class ScriptedAdapter extends LlmAdapter {
  /** 收到的全部请求，按顺序。 */
  readonly requests: GenerateOptions[] = []

  #mainCalls = 0

  /** @param summary - 摘要请求回的说明正文。 */
  constructor(private readonly summary: string) {
    super()
  }

  /**
   * 报告本 route 的能力：只有 `off` 一个推理档位。
   * @param provider - provider 路由。
   * @param model - 模型 id。
   * @returns 该 route 的模型信息。
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] },
    })
  }

  /**
   * 记下请求并按它是不是摘要请求答复。
   * @param options - 实现发来的请求。
   * @returns 逐步产出的流块。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (requestText(options).includes(SUMMARY_MARKER)) {
      yield* text({ type: 'text', text: JSON.stringify({ action: 'summarize', summary: this.summary }) }, 0)
      return
    }
    this.#mainCalls += 1
    // 第 1 次主请求发工具调用把 turn 撑过一步；之后纯文本收尾。
    if (this.#mainCalls === 1) {
      const id = ToolCallId('scripted-bash')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // 助手消息带一个推理块：它是推理裁剪器的裁剪对象，「摘要与它互不影响」用两次运行的助手消息对比来验。
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'reasoning-kept' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reasoning-kept' } }
    yield* text({ type: 'text', text: 'done' }, 1)
  }
}

/**
 * 按 `text` 块在给定下标发出一段流。
 * @param block - 要发出的文本块。
 * @param index - 该块在本次回复里的下标。
 * @returns 流块序列。
 */
async function* text(block: Extract<ContentBlock, { type: 'text' }>, index: number): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text: block.text }
  yield { type: 'block-end', index, block }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * 一条请求的全部文本输入。
 * @param options - 请求。
 * @returns 文本块拼接结果。
 */
function requestText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('')
}

/** 一条装好的真实链路。 */
export interface LoopFixture {
  readonly ctx: Context
  readonly agent: Agent
  /** 脚本化 route 收到的请求。 */
  readonly requests: readonly GenerateOptions[]
  /** 摘要改写的替换值来自哪个假 spill 入口。 */
  readonly spill: FakeSpill
  dispose(): Promise<void>
}

/**
 * 装一条真实 agent loop 并跑完一个 turn。
 * @param config - 被测插件的配置。
 * @param body - `bash` 工具返回的正文。
 * @param summary - 摘要请求回的说明正文。
 * @returns 夹具；turn 已收尾。
 */
export async function runLoop(
  config: Schemastery.TypeS<typeof Config>,
  body: string,
  summary: string,
): Promise<LoopFixture> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const adapter = new ScriptedAdapter(summary)
  ctx.llm.registerAdapter(['mock'], adapter)
  const spill = new FakeSpill()
  ctx.provide('spillStore', spill as never)
  await ctx.plugin(plugin, config)
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.tools.register(defineContentToolFixture({
    name: TOOL, description: TOOL, parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: body }] },
  }))
  const agent = await harness.create(SessionId('result-clipper-session'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return {
    ctx,
    agent,
    get requests() { return adapter.requests },
    spill,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
