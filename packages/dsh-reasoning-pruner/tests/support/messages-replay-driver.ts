/**
 * Messages 侧驱动：以**真实** `DeepSeekAdapter` 为内核，走一遍完整请求路径。
 *
 * 退化信号与请求体都产生在 `fetch` **之前**（`request()` 先 `serialize()`，串行化时才读信封），所以端点
 * 用不可达地址即可——本文件把 `globalThis.fetch` 在驱动期间换成只记录请求体的桩，调用结束（含抛错）即
 * 还原。断言只读返回的观察量，不关心桩响应的成败。
 *
 * @module
 */

import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Message } from '@deepseek-ai/dsh-llm'

/** 驱动使用的模型 id：消息 `source.model`、信封 `response.model` 与请求 `model` 必须三者一致。 */
export const MESSAGES_MODEL = 'deepseek-flash'

/** 断言所需的 Messages 请求体片段（线上 reasoning 块叫 `thinking`，签名挂在它上面）。 */
export interface MessagesWireBody {
  messages: readonly {
    role: string
    content: readonly { type: string; text?: string; thinking?: string; signature?: string }[]
  }[]
}

/** 一次驱动得到的两项观察量。 */
export interface MessagesDriveObservation {
  /** `onReplayDegrade` 收到的 reason，按发生顺序。 */
  degradeReasons: readonly string[]
  /** `fetch` 收到的请求体，已解析。 */
  body: MessagesWireBody
}

/**
 * 用一条历史驱动一次 Messages 请求。
 * @param messages - 模型可见历史。
 * @returns 退化 reason 列表与请求体。
 */
export async function driveMessagesRequest(
  messages: readonly Message[],
): Promise<MessagesDriveObservation> {
  const degradeReasons: string[] = []
  let body: MessagesWireBody | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as MessagesWireBody
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  try {
    const connection = resolveAdapterOptions({
      baseURL: 'http://127.0.0.1:1/v1',
      models: [{ id: MESSAGES_MODEL }],
    })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: {} }),
      // 匿名 id 是品牌字符串；本驱动只需要一个稳定值，不为它引依赖或碰磁盘。
      resolveUserId: (() => 'dsh-reasoning-pruner-test') as DeepSeekAdapterOptions['resolveUserId'],
      prepareExtensions: async () => ({ fields: {}, accept: () => Promise.resolve() }),
      onReplayDegrade: ({ reason }) => { degradeReasons.push(reason) },
    })
    try {
      for await (const _chunk of adapter.stream({ provider: 'deepseek', model: MESSAGES_MODEL, messages: [...messages] })) {
        // 桩响应在退化信号之后失败，能否收到 chunk 与断言无关。
      }
    } catch (_stubbedTransportFailure) {
      // 见上：吞掉桩响应引起的传输错误。
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  if (body === undefined) throw new Error('messages-replay-driver: adapter never reached fetch')
  return { degradeReasons, body }
}
