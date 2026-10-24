/**
 * 票据 02c 第 1 步：`deepseek` provider 的题面、请求与 `top_logprobs` 读出。
 *
 * HTTP 用桩住的 `fetch`：返回 chat completion 形状（`choices[0].logprobs.content[0].top_logprobs`）。
 * 不碰真实 API——真实端点的 pilot 是票据第 2 步。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../src/config.ts'
import * as SystemOne from '../src/index.ts'
import type { AskRequest, Question } from '../src/types.ts'

const ENTRY = {
  id: 'deepseek-flash',
  label: 'DeepSeek 官方',
  kind: 'deepseek',
  // 末尾的斜杠是有意的：拼接端点路径时不能出现 `//chat/completions`。
  baseUrl: 'https://api.deepseek.com/',
  model: 'deepseek-flash',
} satisfies Entry

/** system 那句是题面契约的一部分：改它等于改 provider 的输入。 */
const SYSTEM = 'You are a decision engine. Reply with exactly one identifier. Do not explain.'

const QUESTIONS = {
  'turn.continue': {
    type: 'boolean',
    instructions: '本轮是否应该继续？',
    optionDescriptions: { true: '继续', false: '停止' },
  },
  'turn.route': {
    type: 'choice',
    instructions: '下一步走哪条路？',
    options: ['fix', 'ask'],
    optionDescriptions: { fix: '直接修' },
  },
  'turn.severity': {
    type: 'score',
    instructions: '问题有多严重？',
    levels: ['low', 'mid', 'high'],
  },
} satisfies Record<string, Question>

/** 答案位置的候选 token。 */
interface TopToken {
  token: string
  logprob: number
}

/** 一次记录下来的 HTTP 调用。 */
interface Call {
  url: string
  init: RequestInit
}

/** 桩住 `fetch`：记下调用，按脚本作答（返回 `Response` 就原样交回，否则包成 200 JSON）。 */
function stubFetch(script: (call: Call, index: number) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    const scripted = script(call, calls.length - 1)
    return Promise.resolve(scripted instanceof Response ? scripted : json(scripted))
  })
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一次 chat completion 的夹具；`message.content` 只放采样值，不参与判分。 */
function completion(tops: readonly TopToken[], extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'deepseek-flash-2026-09',
    choices: [{ message: { content: tops[0]?.token ?? '' }, logprobs: { content: [{ top_logprobs: tops }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
    ...extra,
  }
}

/** 解析夹具收到的请求体（默认第一次调用）。 */
function sentBody(calls: readonly Call[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]?.init.body)) as Record<string, unknown>
}

/** 请求里 user 消息的内容。 */
function sentUser(calls: readonly Call[], index = 0): unknown {
  return (sentBody(calls, index).messages as Array<{ role: string; content: unknown }>)[1]?.content
}

/** 按真实装载路径把条目装上。 */
async function mount(entries: readonly Entry[] = [ENTRY]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemOne, { entries } as never)
  return ctx
}

/** `ask` 的最小请求。 */
function ask(questions: Record<string, Question>, extra: Partial<AskRequest> = {}): AskRequest {
  return { target: ENTRY.id, state: { step: 3 }, questions, ...extra }
}

/** 用 log 概率表示给定的概率，夹具读出的概率才能对得上。 */
function log(probability: number): number {
  return Math.log(probability)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deepseek provider', () => {
  it('三种题型的题面与请求体固定，每题一次请求打到 /chat/completions', async () => {
    const calls = stubFetch((_call, index) => [
      completion([{ token: 'no', logprob: log(0.75) }, { token: 'yes', logprob: log(0.25) }]),
      completion([{ token: 'a', logprob: log(0.7) }, { token: 'b', logprob: log(0.3) }]),
      completion([
        { token: '0', logprob: log(0.2) },
        { token: '1', logprob: log(0.5) },
        { token: '2', logprob: log(0.3) },
      ]),
    ][index])
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS, { instructions: '你是会话导航器。' }))

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.deepseek.com/chat/completions',
      'https://api.deepseek.com/chat/completions',
      'https://api.deepseek.com/chat/completions',
    ])
    expect(result.requests).toBe(3)
    expect(sentBody(calls, 0)).toEqual({
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: '你是会话导航器。\n\n{"step":3}\n\n本轮是否应该继续？\n\nOptions:\n- no: 停止\n- yes: 继续\n\nAnswer with exactly one word: no or yes.',
        },
      ],
      thinking: { type: 'disabled' },
      temperature: 1,
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 20,
    })
    expect(sentUser(calls, 1)).toBe(
      '你是会话导航器。\n\n{"step":3}\n\n下一步走哪条路？\n\nOptions:\n- a: 直接修\n- b: ask\n\nAnswer with exactly one letter: a, b.',
    )
    expect(sentUser(calls, 2)).toBe(
      '你是会话导航器。\n\n{"step":3}\n\n问题有多严重？\n\nLevels:\n0: low\n1: mid\n2: high\n\nAnswer with exactly one digit: 0, 1, 2.',
    )
  })

  it('读出：no/yes 重归一、choice 按选项顺序、score = Σ i·p_i，诊断项齐全', async () => {
    stubFetch((_call, index) => [
      completion([{ token: 'no', logprob: log(0.75) }, { token: 'yes', logprob: log(0.25) }]),
      completion([{ token: 'a', logprob: log(0.7) }, { token: 'b', logprob: log(0.3) }]),
      completion([
        { token: '0', logprob: log(0.2) },
        { token: '1', logprob: log(0.5) },
        { token: '2', logprob: log(0.3) },
      ]),
    ][index])
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    const noul = result.answers['turn.continue'] as SystemOne.BooleanAnswer
    expect(noul.probability).toBeCloseTo(0.25)
    expect(noul.confidence).toBeCloseTo(0.75)
    expect(noul.labelMass).toBeCloseTo(1)
    expect(noul.argmaxIsLabel).toBe(true)

    const choice = result.answers['turn.route'] as SystemOne.ChoiceAnswer
    expect(choice.choice).toBe('fix')
    expect(choice.probabilities).toHaveLength(2)
    expect(choice.probabilities?.[0]).toBeCloseTo(0.7)
    expect(choice.probabilities?.[1]).toBeCloseTo(0.3)
    expect(choice.labelMass).toBeCloseTo(1)

    const score = result.answers['turn.severity'] as SystemOne.ScoreAnswer
    expect(score.score).toBeCloseTo(0.2 * 0 + 0.5 * 1 + 0.3 * 2)
    expect(score.probabilities?.map((p) => Math.round(p * 10) / 10)).toEqual([0.2, 0.5, 0.3])
    expect(score.legend).toEqual(QUESTIONS['turn.severity'].levels)
    expect(score.confidence).toBeCloseTo(0.5)
  })

  it('答案取 top_logprobs 的 argmax，不取 message.content 的采样值', async () => {
    stubFetch(() => ({
      model: 'deepseek-flash-2026-09',
      choices: [{
        message: { content: 'b' },
        logprobs: { content: [{ top_logprobs: [{ token: 'a', logprob: log(0.7) }, { token: 'b', logprob: log(0.3) }] }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.route': QUESTIONS['turn.route'] }))

    // 采样值是 b（= ask），但分布里 a（= fix）概率更高。
    expect((result.answers['turn.route'] as SystemOne.ChoiceAnswer).choice).toBe('fix')
  })

  it('标识符部分缺失：仍返回答案，choice/score 省略 probabilities 并报 coverage；boolean 的 probability 仍返回', async () => {
    stubFetch((_call, index) => [
      completion([{ token: 'no', logprob: log(0.7) }, { token: 'maybe', logprob: log(0.1) }]),
      completion([{ token: 'a', logprob: log(0.6) }, { token: 'x', logprob: log(0.1) }]),
      completion([{ token: '0', logprob: log(0.5) }, { token: 'x', logprob: log(0.1) }]),
    ][index])
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    const noul = result.answers['turn.continue'] as SystemOne.BooleanAnswer
    expect(noul.probability).toBe(0)
    expect(noul.labelMass).toBeCloseTo(0.7)
    expect(noul.argmaxIsLabel).toBe(true)

    const choice = result.answers['turn.route'] as SystemOne.ChoiceAnswer
    expect(choice.choice).toBe('fix')
    expect(choice).not.toHaveProperty('probabilities')

    const score = result.answers['turn.severity'] as SystemOne.ScoreAnswer
    expect(score.score).toBe(0)
    expect(score).not.toHaveProperty('probabilities')

    expect(result.warnings).toEqual([
      { type: 'coverage', questionId: 'turn.continue' },
      { type: 'coverage', questionId: 'turn.route' },
      { type: 'coverage', questionId: 'turn.severity' },
    ])
  })

  it('argmaxIsLabel=false：答案仍取域内 argmax，confidence 取域内原始最大概率', async () => {
    stubFetch(() => completion([
      // 表面形式各带空白/引号/尾随标点：规范化后分别是 a / no / yes。
      { token: ' A', logprob: log(0.5) },
      { token: 'No', logprob: log(0.3) },
      { token: '"YES":', logprob: log(0.1) },
    ]))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] }))

    const answer = result.answers['turn.continue'] as SystemOne.BooleanAnswer
    expect(answer.probability).toBeCloseTo(0.25)
    expect(answer.confidence).toBeCloseTo(0.3)
    expect(answer.labelMass).toBeCloseTo(0.4)
    expect(answer.argmaxIsLabel).toBe(false)
  })

  it('temperature 0 的症状：非哨兵条目 ≤ 1 时按 provider 级失败，不返回 argmax 答案', async () => {
    const ctx = await mount()

    stubFetch(() => completion([{ token: 'no', logprob: -0.1 }, { token: 'yes', logprob: -9999 }]))
    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('check the temperature is not 0')

    stubFetch(() => completion([{ token: 'no', logprob: -9999 }, { token: 'yes', logprob: -9999 }]))
    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('top_logprobs has 0 real entries')

    stubFetch(() => completion([{ token: 'no', logprob: -0.1 }]))
    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('top_logprobs has 1 entries (need at least 2)')

    stubFetch(() => ({ choices: [{ message: { content: 'no' } }] }))
    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('the response has no logprobs')

    stubFetch(() => ({ choices: [{ logprobs: { content: [{}] } }] }))
    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('the response has no top_logprobs')
  })

  it('没有标识符命中：该题从 answers 缺席，warnings 带 questionId', async () => {
    stubFetch(() => completion([{ token: 'A', logprob: log(0.5) }, { token: 'Let', logprob: log(0.3) }]))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] }))

    expect(result.answers).toEqual({})
    expect(result.warnings).toEqual([{ type: 'no-identifier', questionId: 'turn.continue' }])
  })

  it('上限与拒绝：选项/档位越界、空数组、chatTemplateKwargs 非空，都在发请求前抛错', async () => {
    const calls = stubFetch(() => completion([{ token: 'no', logprob: -0.1 }, { token: 'yes', logprob: -0.2 }]))
    const ctx = await mount()

    const options = Array.from({ length: 21 }, (_, index) => `o${index}`)
    await expect(ctx.systemOne.ask(ask({ q: { type: 'choice', instructions: '?', options } })))
      .rejects.toThrow('options has 21 items (at most 20 can be identified)')

    const levels = Array.from({ length: 11 }, (_, index) => `l${index}`)
    await expect(ctx.systemOne.ask(ask({ q: { type: 'score', instructions: '?', levels } })))
      .rejects.toThrow('levels has 11 items (at most 10 can be identified)')

    await expect(ctx.systemOne.ask(ask({ q: { type: 'choice', instructions: '?', options: [] } })))
      .rejects.toThrow('options is empty')
    await expect(ctx.systemOne.ask(ask({ q: { type: 'score', instructions: '?', levels: [] } })))
      .rejects.toThrow('levels is empty')
    await expect(ctx.systemOne.ask(ask(QUESTIONS, { chatTemplateKwargs: { enable_thinking: false } })))
      .rejects.toThrow('chatTemplateKwargs has no place in a chat completions request')

    expect(calls).toHaveLength(0)

    // 空对象等于没给：放行，且不进请求体。
    await ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] }, { chatTemplateKwargs: {} }))
    expect(calls).toHaveLength(1)
    expect(sentBody(calls)).not.toHaveProperty('chat_template_kwargs')
  })

  it('可表达字段：字符串 state 原样、图片落成 image_url 内容块、富档位 JSON 与 legend 回显', async () => {
    const calls = stubFetch(() => completion([{ token: '0', logprob: log(0.5) }, { token: '1', logprob: log(0.5) }]))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({
      q: { type: 'score', instructions: '多严重？', levels: ['low', { label: '严重' }] },
    }, { state: '订单被重复扣费', images: ['https://example.com/a.png'] }))

    expect(sentUser(calls)).toEqual([
      {
        type: 'text',
        text: '订单被重复扣费\n\n多严重？\n\nLevels:\n0: low\n1: {"label":"严重"}\n\nAnswer with exactly one digit: 0, 1.',
      },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ])
    expect((result.answers['q'] as SystemOne.ScoreAnswer).legend).toEqual(['low', { label: '严重' }])
  })

  it('usage 求和、modelId 取首个成功响应；单题 HTTP 失败只让该题缺席，全失败时抛第一个错误', async () => {
    const calls = stubFetch((_call, index) => {
      if (index === 0) return new Response('upstream down', { status: 500 })
      return completion(
        [{ token: 'no', logprob: log(0.75) }, { token: 'yes', logprob: log(0.25) }],
        { model: 'deepseek-flash-2026-09', usage: { prompt_tokens: 20, completion_tokens: 2 } },
      )
    })
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({
      first: { type: 'boolean', instructions: '?' },
      second: { type: 'boolean', instructions: '?' },
    }))

    expect(calls).toHaveLength(2)
    expect(Object.keys(result.answers)).toEqual(['second'])
    expect(result.warnings).toEqual([
      { type: 'http-error', questionId: 'first', message: expect.stringContaining('HTTP 500') },
    ])
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 2 })
    expect(result.modelId).toBe('deepseek-flash-2026-09')
    expect(result.requests).toBe(2)

    vi.unstubAllGlobals()
    stubFetch(() => new Response('upstream down', { status: 500 }))
    await expect(ctx.systemOne.ask(ask({
      first: { type: 'boolean', instructions: '?' },
      second: { type: 'boolean', instructions: '?' },
    }))).rejects.toThrow('HTTP 500')
  })

  it('401/403/404 直接抛出，不当成单题失败', async () => {
    stubFetch(() => new Response('nope', { status: 401 }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('HTTP 401')
  })
})
