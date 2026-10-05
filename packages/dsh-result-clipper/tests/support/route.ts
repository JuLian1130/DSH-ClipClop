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

/** 一段脚本化答复：文本（可带用量）、抛错、以带稳定错误码的终止错误块收场，或挂到请求的 signal 中止。 */
export type FakeReply =
  | { readonly text: string; readonly usage?: TokenUsage }
  | { readonly error: string }
  /** 走 DSH 的终止错误块（真实现的适配器选择与 setup 失败就是这条路），`code` 是稳定机器码。 */
  | { readonly failure: { readonly code: string; readonly message?: string } }
  | { readonly hang: true }

/**
 * 档位表不含 `off` 的 route 拒收「关闭推理」时的那种收场：DSH 的终止错误块带稳定机器码（票 09 的重试只认它）。
 * 码写字面量而不是从实现里引常量——测试与实现共用同一个字面量就等于断言自己。
 */
export const UNSUPPORTED_EFFORT_REPLY: FakeReply = { failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } }

/** 一次假 route 的答复。 */
export class FakeRoute {
  /** 收到的请求，按顺序。 */
  readonly requests: GenerateOptions[] = []

  /**
   * 档位表：设过的键（`provider/model`）才算"该 route 声明了这些档位"，`null` 表示该模型不提供推理档位；
   * 没设过 = 没命中这个方法以外的信息（实现按"该模型不提供档位"处理，与 DSH 里 `reasoning === undefined` 同义）。
   */
  readonly reasonings = new Map<string, readonly { readonly id: string }[] | null>()

  /** `resolveModelInfo` 的调用记录，按顺序（缓存用例数它）。 */
  readonly resolveCalls: string[] = []

  /** 这些 route（`provider/model`）的档位表读取失败。 */
  readonly resolveFailures = new Set<string>()

  #script: readonly FakeReply[]

  /**
   * @param script - 按请求顺序的答复；用完重复最后一段，空数组等价于单段空文本。
   */
  constructor(script: readonly FakeReply[] = []) {
    this.#script = script.length > 0 ? script : [{ text: '' }]
  }

  /**
   * 供 `src/efforts.ts` 读档位表：把 `reasonings` 里的读数翻成 `resolveModelInfo` 的形状。
   * @param provider - provider id。
   * @param model - model id。
   * @returns 模型信息；该模型不声明档位时为 `{}`。
   */
  async resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: readonly { id: string }[] } }> {
    const key = `${provider}/${model}`
    this.resolveCalls.push(key)
    if (this.resolveFailures.has(key)) throw new Error(`fake route cannot resolve ${key}`)
    const efforts = this.reasonings.get(key)
    return efforts == null ? {} : { reasoning: { efforts } }
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
    if ('failure' in reply) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: reply.failure.code, message: reply.failure.message ?? reply.failure.code },
        },
      }
      return
    }
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
