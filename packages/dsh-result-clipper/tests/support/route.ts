/**
 * 假 route：本票需要观察「摘要请求长什么样」与「摘要路径怎么失败」，而这两件事都在 `ctx.llm.stream`
 * 的入参上，所以用一个只记录请求、按脚本回话的 `llm` 服务替身（规格「测试决定 · 请求内容」的假 route）。
 *
 * `hang` 那一段不自己计时：它等请求的 `signal`（实现给出的 20s 超时就是这个 signal）被中止后抛错，
 * 因此「实现没把 signal 传进请求」会让用例挂住而不是绿。
 *
 * @module
 */

import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** 一段脚本化答复：文本（可带用量）、抛错，或挂到请求的 signal 中止。 */
export type FakeReply =
  | { readonly text: string; readonly usage?: TokenUsage }
  | { readonly error: string }
  | { readonly hang: true }

/** 一次假 route 的答复。 */
export class FakeRoute {
  /** 收到的请求，按顺序。 */
  readonly requests: GenerateOptions[] = []

  #script: readonly FakeReply[]

  /**
   * @param script - 按请求顺序的答复；用完重复最后一段，空数组等价于单段空文本。
   */
  constructor(script: readonly FakeReply[] = []) {
    this.#script = script.length > 0 ? script : [{ text: '' }]
  }

  /**
   * 记下请求并按脚本答复。
   * @param options - 实现发来的请求。
   * @returns 逐步产出的流块。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.#script[Math.min(this.requests.length, this.#script.length - 1)]
    this.requests.push(options)
    if (reply === undefined) throw new Error('fake route has no reply')
    if ('hang' in reply) {
      await new Promise<never>((_resolve, reject) => {
        const fail = (): void => { reject(new Error('fake route request aborted')) }
        if (options.signal?.aborted === true) {
          fail()
          return
        }
        options.signal?.addEventListener('abort', fail, { once: true })
      })
      return
    }
    if ('error' in reply) throw new Error(reply.error)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    // 用量块照 DSH 的流协议排在终止块之前（适配器在 finish 前报告 usage）；没给就整块不发，
    // 「底层没报告用量」这条路径因此与「报告了 0」在夹具里是可分开的。
    if (reply.usage !== undefined) yield { type: 'usage', usage: reply.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * 一条摘要请求的模型可见输入（全部消息的文本拼起来），用来断言「请求含工具正文」。
 * @param options - 假 route 记下的请求。
 * @returns 全部文本块与消息正文拼接的结果。
 */
export function requestText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('')
}
