/**
 * 测试用的脚本化 LLM 适配器与消息工厂。
 *
 * testkit 不导出 mock adapter（见设计文档的「测试决策」），所以本仓库自备：每次请求按顺序返回
 * 脚本里的一段文本，并记下收到的 `GenerateOptions`，供断言复核请求的构成。
 *
 * @module
 */

import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'

/** 一次脚本化回复：返回一段文本，或者让这次请求以错误收场。 */
export type ScriptedResponse =
  | { readonly text: string }
  | { readonly error: string }

/** 一段合法的复核结论，作为脚本的默认回复。 */
export const CONTINUE_VERDICT = '{"verdict":"continue","reason":"看起来正常","recommendation":"无"}'

/** 脚本化适配器：用完脚本后重复最后一段。 */
export class ScriptedAdapter extends LlmAdapter {
  /** 按调用顺序记下的请求。 */
  readonly requests: GenerateOptions[] = []

  readonly #script: readonly ScriptedResponse[]

  /**
   * @param script - 每次请求的回复；空数组等价于单条默认回复。
   */
  constructor(script: readonly ScriptedResponse[] = [{ text: CONTINUE_VERDICT }]) {
    super()
    this.#script = script.length > 0 ? script : [{ text: CONTINUE_VERDICT }]
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length
    this.requests.push(options)
    const response = this.#script[Math.min(index, this.#script.length - 1)]
    if (response === undefined || 'error' in response) {
      throw new Error(response?.error ?? 'scripted adapter has no response')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response.text } }
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
