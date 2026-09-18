/**
 * 真实入口腿（票据 12）用的脚本化模型服务：一个 OpenAI 兼容的 chat-completions SSE 端点，按到达顺序
 * 决定每条请求答复什么，并留下全部请求体供用例读「模型可见上下文」。
 *
 * 不引 `@deepseek-ai/dsh-llm-mock-server`：那个设施的 `successText` 对每条 success 请求是同一个值，
 * 而这两条腿要按请求区分「主会话答复」「带工具调用的多步答复」与「复核结论」。SSE 帧形状取自该发布包
 * 的 success / tool_call 两个分支（`data: {...}\n\n`、终止块带 usage、`data: [DONE]`）。
 *
 * @module
 */

import { createServer } from 'node:http'
import { FIXED_INSTRUCTIONS } from '../../src/review-prompt.ts'

/**
 * 复核请求的判别标记：固定指令的第一行，逐字出现在复核请求最后那条 user 消息里（JSON 转义不影响它）。
 */
const REVIEW_MARKER = FIXED_INSTRUCTIONS.split('\n')[0] ?? FIXED_INSTRUCTIONS

/** 一条请求的脚本化答复；两者都给时优先 `toolCall`。 */
export interface MockModelReply {
  /** 纯文本答复，`finish_reason: stop`。 */
  readonly text?: string
  /** 工具调用答复，`finish_reason: tool_calls`；用它把 turn 撑过一步。 */
  readonly toolCall?: { readonly name: string, readonly arguments: string }
}

/** 一次被 mock 收到的请求：请求体，加上它是不是本插件的复核请求。 */
export interface MockModelRequest {
  readonly body: Record<string, unknown>
  /** 末段固定指令命中即复核请求——主会话自己的消息里不会出现它。 */
  readonly isReview: boolean
}

/** 运行中的 mock 模型服务。 */
export interface MockModelServer {
  /** 不带 `/v1` 的基点，直接喂 `DEEPSEEK_BASE_URL`。 */
  readonly baseURL: string
  /** 收到的请求体，按到达顺序。 */
  readonly requests: readonly Record<string, unknown>[]
  close(): Promise<void>
}

/**
 * 起一个 mock 模型服务。
 * @param respond - 按请求决定答复的函数；第二个参数是一基的请求序号。
 * @returns 运行中的服务与请求记录。
 */
export function startMockModel(
  respond: (request: MockModelRequest, attempt: number) => MockModelReply,
): Promise<MockModelServer> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      const attempt = requests.length + 1
      requests.push(body)
      const reply = respond({ body, isReview: JSON.stringify(body.messages ?? null).includes(REVIEW_MARKER) }, attempt)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = (payload: unknown): void => {
        res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
      }
      const usage = { prompt_tokens: 7, completion_tokens: 5 }
      write({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      if (reply.toolCall === undefined) {
        write({ choices: [{ index: 0, delta: { content: reply.text ?? '' }, finish_reason: null }] })
        write({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage })
      } else {
        write({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call-${attempt}`,
                type: 'function',
                function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments },
              }],
            },
            finish_reason: null,
          }],
        })
        write({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], usage })
      }
      write('[DONE]')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock model server bound no TCP port')
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done) => { server.close(() => done()) }),
      })
    })
  })
}

/**
 * 把主会话撑过一步的工具调用：真 bash 工具、无害命令，且那一步成功收尾而 turn 继续。
 * @param attempt - 一基请求序号，用作 `id` 的一部分（不要求唯一，只是可读）。
 * @returns 工具调用答复。
 */
export function keepTurnAlive(attempt: number): MockModelReply {
  return {
    toolCall: {
      name: 'bash',
      arguments: JSON.stringify({ command: `echo navigator-step-${attempt}`, description: 'navigator leg: keep the turn alive' }),
    },
  }
}

/**
 * 一条请求是不是本插件的复核请求（末段固定指令命中）。
 * @param request - 请求体。
 * @returns 是复核请求时为真。
 */
function isReviewRequest(request: Record<string, unknown>): boolean {
  return JSON.stringify(request.messages ?? null).includes(REVIEW_MARKER)
}

/**
 * 哪些**主会话**请求的模型可见上下文里含给定文本；复核请求不算——它的快照本来就会带上此前的建议，
 * 混进来会把「后续多轮里主会话上下文含它」读成恒真句。
 * @param requests - 待筛的请求体。
 * @param text - 要找的文本。
 * @returns 命中的请求体列表。
 */
export function mainRequestsContaining(
  requests: readonly Record<string, unknown>[],
  text: string,
): readonly Record<string, unknown>[] {
  return requests.filter(request => !isReviewRequest(request) && JSON.stringify(request).includes(text))
}
