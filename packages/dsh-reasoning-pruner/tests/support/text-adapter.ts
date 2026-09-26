/**
 * 最小脚本化适配器：每次请求回一段固定文本并正常收尾。
 *
 * testkit 不导出 mock adapter，本文件只为「真实 agent loop 能跑起来、步与请求边界可观察」这一件事存在；
 * 它不产出 reasoning 块、也不带 replay 信封——票 01 的 loop 级用例只观察承载类型事件对折叠计数的副作用，
 * 不构造可裁候选消息（那需要闸门 D 的实验装置，见规格）。
 *
 * @module
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 固定文本回复的适配器。 */
export class TextAdapter extends LlmAdapter {
  /** 收到的请求，按调用顺序。 */
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
