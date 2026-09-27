/**
 * 票 04 第 1–3 条的 pi-ai 侧驱动：以**真实 `PiAiAdapter`** 为内核。
 *
 * 退化信号只在真实适配器内部产生（手写假适配器没有 `onReplayDegrade` 这条钩子），而它发生在
 * `toPiContext` 里、**早于** `streamSimple`：所以驱动照常消费一次真实 `stream`，把生成器取完并吞掉
 * 必然的失败（没有 wire），只留两个观察面——`degradeCalls` 与 {@link PiAiReplayDriver.wireAssistant}。
 *
 * 手搓 `piProvider`：适配器只做 `models.setProvider(profile.piProvider)`，不需要
 * `buildProvider`/settings/credentials/catalog。pi-ai 的运行期类型（`Provider`/`Model`）是传递依赖，
 * 从本包解析不到，因此结构形状一律用 `as never` 收口。
 *
 * @module
 */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** 驱动发请求用的路由，同时也是手搓 provider 与 model 的身份。 */
const ROUTE = 'piai-driver'
/** 唯一的模型 id。 */
const MODEL_ID = 'piai-driver-model'

/** `onReplayDegrade` 的一次调用，字段就是适配器 config 上那个回调的入参。 */
export interface ReplayDegradeCall {
  readonly provider: string
  readonly model: string
  readonly reason: string
}

/** 线上一块内容；签名字段是否存在就是本票第 1–3 条的后果判据。 */
export interface WireBlock {
  readonly type: string
  readonly [field: string]: unknown
}

/** 线上一条 assistant 消息。 */
export interface WireAssistantMessage {
  readonly role: string
  readonly content: readonly WireBlock[]
}

/** 传给 `streamSimple` 的 context 里与本票有关的那一半。 */
interface WireContext {
  readonly messages: readonly WireAssistantMessage[]
}

/**
 * 一次请求的驱动：真实 `PiAiAdapter` + 手搓 profile，跑完把两个观察面留在实例上。
 */
export class PiAiReplayDriver {
  /** `onReplayDegrade` 的调用记录，按发生顺序。 */
  readonly degradeCalls: ReplayDegradeCall[] = []

  private readonly adapter: PiAiAdapter
  private captured: WireContext | undefined

  constructor() {
    const model = {
      id: MODEL_ID,
      name: MODEL_ID,
      provider: ROUTE,
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }
    const provider = {
      id: ROUTE,
      name: ROUTE,
      // 少了它 pi-ai 会在 `applyAuth` 里报 "Provider is not configured"：本路径不碰凭据，只要它能解析出
      // 一份（空）auth 就能走到 `streamSimple`。
      auth: { apiKey: { name: 'P', resolve: async () => ({ auth: {} }) } },
      getModels: () => [model],
      stream: () => { throw new Error('unused') },
      streamSimple: (_model: unknown, context: unknown) => {
        this.captured = context as WireContext
        throw new Error('no wire')
      },
    }
    const profile: ResolvedPiAiProviderProfile = {
      provider: ROUTE,
      displayName: 'P',
      streamIdleTimeoutMs: 1000,
      maxRequestImageBytes: 1,
      requestImagePixelBudget: 1,
      requestImageMaxBytes: 1,
      retryPolicy: {} as never,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
      piProvider: provider as never,
    }
    this.adapter = new PiAiAdapter({
      profiles: () => new Map([[ROUTE, profile]]),
      resolveApiKey: async () => 'driver-key',
      // pi-ai 为空注入补默认的凭据存储与鉴权上下文；本驱动只走到那份空 auth 的解析。
      auth: {} as never,
      onReplayDegrade: call => this.degradeCalls.push(call),
    })
  }

  /**
   * 驱动一次真实请求。
   * @param messages - 该请求的完整历史。
   */
  async run(messages: readonly RequestMessage[]): Promise<void> {
    const options: GenerateOptions = { provider: ROUTE, model: MODEL_ID, messages: [...messages] }
    try {
      for await (const _chunk of this.adapter.stream(options)) {
        // 线上形状在首个 chunk 之前就已固定：取完只为让适配器正常收尾。
      }
    } catch {
      // 没有 wire，收尾必失败；两个观察面都已在失败之前落定。
    }
  }

  /**
   * 线上第 `index` 条 assistant 消息。
   * @param index - assistant 消息在线上历史里的序号。
   * @returns 那条消息；`run` 之前或序号越界时为 undefined。
   */
  wireAssistant(index: number): WireAssistantMessage | undefined {
    return this.captured?.messages.filter(message => message.role === 'assistant')[index]
  }
}
