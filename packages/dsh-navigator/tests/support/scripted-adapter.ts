/**
 * 测试用的脚本化 LLM 适配器与消息工厂。
 *
 * testkit 不导出 mock adapter（见设计文档的「测试决策」），所以本仓库自备：每次请求按顺序返回
 * 脚本里的一段文本，并记下收到的 `GenerateOptions`，供断言复核请求的构成。脚本用完一段后重复
 * 最后一段；一段也可以把这次请求**挂住不放行**，直到它的 `signal` 被中止（超时与闸门用例用）。
 *
 * @module
 */

import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** 一次脚本化回复：返回一段文本、让这次请求以错误收场，或把这次请求挂住不放行。 */
export type ScriptedResponse =
  | { readonly text: string }
  | { readonly error: string }
  | { readonly hang: true }

/** 收到请求时同步调用的观察钩子；在触发点那一刻读主会话快照用。 */
export type RequestObserver = (options: GenerateOptions) => void

/** 脚本之外的适配器行为。 */
export interface ScriptedAdapterHooks {
  /**
   * 每次请求被记下时**同步**调用。等待模式的 pre-step 被 `await`，此刻主会话走不到下一步，
   * 在这里读 `deriveMessages()` 拿到的就是触发点那一刻的快照。
   */
  readonly onRequest?: RequestObserver
  /** 声明的推理强度档位。继承推理强度的用例需要它——路由校验会拒绝未声明的档位。 */
  readonly reasoning?: LlmModelReasoningInfo
}

/** 一段合法的复核结论，作为脚本的默认回复。 */
export const CONTINUE_VERDICT = '{"verdict":"continue","reason":"看起来正常","recommendation":"无"}'

/** 每次正常回复附带的用量：真实适配器都会给一个 `usage` 块，完成态记录的「用量 有值」靠它。 */
export const SCRIPTED_USAGE: TokenUsage = { inputTokens: 11, outputTokens: 7 }

/** 脚本化适配器：用完脚本后重复最后一段。 */
export class ScriptedAdapter extends LlmAdapter {
  /** 按调用顺序记下的请求。 */
  readonly requests: GenerateOptions[] = []

  readonly #script: readonly ScriptedResponse[]
  readonly #hooks: ScriptedAdapterHooks

  /**
   * @param script - 每次请求的回复；空数组等价于单条默认回复。
   * @param hooks - 观察钩子与声明的模型元数据。
   */
  constructor(
    script: readonly ScriptedResponse[] = [{ text: CONTINUE_VERDICT }],
    hooks: ScriptedAdapterHooks = {},
  ) {
    super()
    this.#script = script.length > 0 ? script : [{ text: CONTINUE_VERDICT }]
    this.#hooks = hooks
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.#hooks.reasoning === undefined ? {} : { reasoning: this.#hooks.reasoning },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length
    this.requests.push(options)
    // 观察与请求登记在同一次同步回调里，见 `ScriptedAdapterHooks.onRequest`。
    this.#hooks.onRequest?.(options)
    const response = this.#script[Math.min(index, this.#script.length - 1)]
    if (response === undefined) throw new Error('scripted adapter has no response')
    if ('hang' in response) {
      // 挂住不放行，直到请求的 signal 被中止（复核超时或本步取消）。
      await new Promise<never>((_resolve, reject) => {
        const fail = (): void => { reject(new Error('scripted adapter request aborted')) }
        if (options.signal?.aborted === true) {
          fail()
          return
        }
        options.signal?.addEventListener('abort', fail, { once: true })
      })
      // 上面那个 Promise 只 reject，类型上是 `never`；这个 return 只为把控制流收在这里。
      return
    }
    if ('error' in response) throw new Error(response.error)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response.text } }
    yield { type: 'usage', usage: SCRIPTED_USAGE }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * 造一条真实用户消息。
 * @param text - 正文。
 * @returns 判别式为 `source.kind === 'user'` 的用户消息。
 */
export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * 造一条本插件注入的说明或建议消息（`form: 'notice'`，必须带 summary）。
 * @param text - 正文。
 * @param summary - 折叠行上的一行说明。
 * @returns `source.kind === 'plugin'` 的用户消息。
 */
export function navigatorMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-navigator', form: 'notice', summary },
  })
}
