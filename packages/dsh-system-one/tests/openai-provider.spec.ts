/**
 * 票据 03：`openai` provider（OpenAI Decisions API）的映射与拒绝规则。
 *
 * HTTP 用桩住的 `fetch` 夹具，夹具按**官方载荷**写：题面是 `name` 的数组、概率是 `[{value, probability}]`、
 * 拒答是 `type: "refusal"`。**未对真实端点实测**——夹具依据 2026-10-23 的官方指南，接上真实端点后补一次。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../src/config.ts'
import * as SystemOne from '../src/index.ts'
import type { AskRequest, Question } from '../src/types.ts'

const ENTRY = {
  id: 'openai-decisions',
  label: 'OpenAI Decisions',
  kind: 'openai',
  // 末尾的斜杠是有意的：拼接端点路径时不能出现 `//v1/decisions`。
  baseUrl: 'https://api.openai.com/',
  model: 'gpt-6-luna',
} satisfies Entry

/** 三种题型各一道；predicate 没有两侧含义的位置，所以是非题不带 `optionDescriptions`。 */
const QUESTIONS = {
  'turn.continue': { type: 'boolean', instructions: '本轮是否应该继续？' },
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

/** 一次记录下来的 HTTP 调用。 */
interface Call {
  url: string
  init: RequestInit
}

/** 桩住 `fetch`：记下调用，按脚本作答（返回 `Response` 就原样交回，否则包成 200 JSON）。 */
function stubFetch(script: (call: Call) => unknown, status = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    const scripted = script(call)
    return Promise.resolve(scripted instanceof Response ? scripted : json(scripted, status))
  })
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 解析夹具收到的请求体（默认第一次调用）。 */
function sentBody(calls: readonly Call[], index = 0): unknown {
  return JSON.parse(String(calls[index]?.init.body))
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai provider', () => {
  it('配置里的 openai 条目装载后注册成功，ask 打到条目的 /v1/decisions', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    expect((ctx.systemOne as SystemOne.SystemOneService).providers()).toEqual(['openai-decisions'])
    await ctx.systemOne.ask(ask(QUESTIONS))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/decisions')
    expect(calls[0]?.init.method).toBe('POST')
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('三种题型映射成 predicate/choice/score 的题面数组，答案映射回契约形状', async () => {
    const calls = stubFetch(() => ({
      answers: [
        { type: 'predicate', name: 'turn.continue', probability: 0.82 },
        {
          type: 'choice',
          name: 'turn.route',
          choice: 'fix',
          // 分布按 `value` 对齐，所以故意不按请求里的选项顺序给。
          probabilities: [
            { value: 'ask', probability: 0.1 },
            { value: 'fix', probability: 0.9 },
          ],
          confidence: 0.93,
        },
        {
          type: 'score',
          name: 'turn.severity',
          score: 1.1,
          probabilities: [
            { value: 2, label: 'high', probability: 0.2 },
            { value: 0, label: 'low', probability: 0.1 },
            { value: 1, label: 'mid', probability: 0.7 },
          ],
          confidence: 0.55,
        },
      ],
      // 官方只承诺 `usage.input_tokens`（输出不计费）；`output_tokens` 读得到就带上，所以夹具给一个数。
      usage: { input_tokens: 120, output_tokens: 30 },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    expect(sentBody(calls)).toEqual({
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: [{ type: 'input_json', data: { step: 3 } }] }],
      questions: [
        { type: 'predicate', name: 'turn.continue', instructions: '本轮是否应该继续？' },
        {
          type: 'choice',
          name: 'turn.route',
          instructions: '下一步走哪条路？',
          choices: [{ value: 'fix', description: '直接修' }, { value: 'ask' }],
        },
        {
          type: 'score',
          name: 'turn.severity',
          instructions: '问题有多严重？',
          levels: [{ label: 'low' }, { label: 'mid' }, { label: 'high' }],
        },
      ],
    })

    expect(result.answers).toEqual({
      'turn.continue': { type: 'boolean', probability: 0.82 },
      'turn.route': { type: 'choice', choice: 'fix', probabilities: [0.9, 0.1], confidence: 0.93 },
      'turn.severity': { type: 'score', score: 1.1, probabilities: [0.1, 0.7, 0.2], confidence: 0.55 },
    })
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(result.requests).toBe(1)
    expect(typeof result.latencyMs).toBe('number')
  })

  it('具名拒答：该题从 answers 缺席，provider 自报一条带 questionId 的警告', async () => {
    stubFetch(() => ({
      answers: [
        { type: 'refusal', name: 'turn.route' },
        // 同一题既拒答又给了答案时按拒答处理：拒答是「没有判断结果」，答案不能拿来顶。
        { type: 'choice', name: 'turn.route', choice: 'fix', confidence: 0.9 },
        { type: 'predicate', name: 'turn.continue', probability: 0.4 },
      ],
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    expect(result.answers).toEqual({ 'turn.continue': { type: 'boolean', probability: 0.4 } })
    expect(result.warnings).toEqual([{ type: 'refusal', questionId: 'turn.route' }])
  })

  it('未具名的拒答对不上任何题：按 provider 级失败抛错', async () => {
    stubFetch(() => ({ answers: [{ type: 'refusal' }] }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS))).rejects.toThrow(
      'system-one: entry "openai-decisions": the decisions endpoint refused without naming a question',
    )
  })

  it('字符串 state 落成 input_text，images 追加成 input_image 内容块', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await ctx.systemOne.ask(ask(QUESTIONS, { state: '订单被重复扣费', images: ['https://example.com/a.png'] }))

    expect(sentBody(calls)).toHaveProperty('input', [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '订单被重复扣费' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
        ],
      },
    ])
  })

  it('数组 state 原样落成 input_json', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await ctx.systemOne.ask(ask(QUESTIONS, { state: [1, 'two'] }))

    expect(sentBody(calls)).toHaveProperty('input', [
      { role: 'user', content: [{ type: 'input_json', data: [1, 'two'] }] },
    ])
  })

  it('请求级 instructions 是共享 input 里前置的 developer 消息；空串不出现在请求体里', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await ctx.systemOne.ask(ask(QUESTIONS, { instructions: '你是会话导航器。' }))
    await ctx.systemOne.ask(ask(QUESTIONS, { instructions: '' }))

    expect(sentBody(calls, 0)).toHaveProperty('input', [
      { role: 'developer', content: [{ type: 'input_text', text: '你是会话导航器。' }] },
      { role: 'user', content: [{ type: 'input_json', data: { step: 3 } }] },
    ])
    expect(JSON.stringify(sentBody(calls, 1))).not.toContain('developer')
  })

  it('state 是 null 或标量时抛错并点名字段，不发请求', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    for (const state of [null, 7, true]) {
      await expect(ctx.systemOne.ask(ask(QUESTIONS, { state })))
        .rejects.toThrow('system-one: entry "openai-decisions": state must be a string, object or array for the decisions endpoint')
    }
    expect(calls).toHaveLength(0)
  })

  it('chatTemplateKwargs 非空时抛错并点名字段、不发请求；空对象放行且不进请求体', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS, { chatTemplateKwargs: { enable_thinking: false } })))
      .rejects.toThrow('system-one: entry "openai-decisions": chatTemplateKwargs has no place in a decisions request')
    expect(calls).toHaveLength(0)

    await ctx.systemOne.ask(ask(QUESTIONS, { chatTemplateKwargs: {} }))
    expect(calls).toHaveLength(1)
    expect(sentBody(calls)).not.toHaveProperty('chat_template_kwargs')
  })

  it('是非题带 optionDescriptions 时抛错并点名字段、不发请求；空对象等于没给、放行', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask({
      'turn.continue': { type: 'boolean', instructions: '?', optionDescriptions: { true: '继续' } },
    }))).rejects.toThrow('system-one: entry "openai-decisions": question "turn.continue": optionDescriptions has no place in a decisions predicate')
    expect(calls).toHaveLength(0)

    await ctx.systemOne.ask(ask({
      'turn.continue': { type: 'boolean', instructions: '?', optionDescriptions: {} },
    }))
    expect(sentBody(calls)).toHaveProperty('questions', [
      { type: 'predicate', name: 'turn.continue', instructions: '?' },
    ])
  })

  it('非字符串档位时抛错并点出 levels，不发请求', async () => {
    const calls = stubFetch(() => ({ answers: [] }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask({
      'turn.severity': { type: 'score', instructions: '?', levels: ['low', { label: '严重' }] },
    }))).rejects.toThrow('system-one: entry "openai-decisions": question "turn.severity": levels[1] cannot be expressed')
    expect(calls).toHaveLength(0)
  })

  it('分布缺项、缺概率或不是数组时抛错并点出字段', async () => {
    const ctx = await mount()
    stubFetch(() => ({
      answers: [{ type: 'choice', name: 'turn.route', choice: 'fix', probabilities: [{ value: 'fix', probability: 0.9 }] }],
    }))

    await expect(ctx.systemOne.ask(ask({ 'turn.route': QUESTIONS['turn.route'] })))
      .rejects.toThrow('system-one: entry "openai-decisions": question "turn.route": the response has no probabilities[value "ask"]')

    vi.unstubAllGlobals()
    stubFetch(() => ({
      answers: [{
        type: 'choice',
        name: 'turn.route',
        choice: 'fix',
        probabilities: [{ value: 'fix' }, { value: 'ask', probability: 0.1 }],
      }],
    }))
    await expect(ctx.systemOne.ask(ask({ 'turn.route': QUESTIONS['turn.route'] })))
      .rejects.toThrow('system-one: entry "openai-decisions": question "turn.route": the response has no probabilities[value "fix"]')

    vi.unstubAllGlobals()
    stubFetch(() => ({ answers: [{ type: 'choice', name: 'turn.route', choice: 'fix', probabilities: 'all of them' }] }))
    await expect(ctx.systemOne.ask(ask({ 'turn.route': QUESTIONS['turn.route'] })))
      .rejects.toThrow('system-one: entry "openai-decisions": question "turn.route": probabilities is not an array')
  })

  it('后端没报分布时答案照常交回、不带 probabilities', async () => {
    stubFetch(() => ({ answers: [{ type: 'score', name: 'turn.severity', score: 1, confidence: 0.5 }] }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.severity': QUESTIONS['turn.severity'] }))

    // 分布是 provider 的自报项：缺席表示没报，不是均匀分布，也不是失败。
    expect(result.answers['turn.severity']).toEqual({ type: 'score', score: 1, confidence: 0.5 })
  })

  it('三种题型的答案缺必填项时分别抛错并点出字段', async () => {
    const ctx = await mount()
    const cases = [
      { id: 'turn.continue', answer: { type: 'predicate', name: 'turn.continue' }, field: 'probability' },
      { id: 'turn.route', answer: { type: 'choice', name: 'turn.route' }, field: 'choice' },
      { id: 'turn.severity', answer: { type: 'score', name: 'turn.severity' }, field: 'score' },
    ] as const

    for (const { id, answer, field } of cases) {
      stubFetch(() => ({ answers: [answer] }))
      await expect(ctx.systemOne.ask(ask({ [id]: QUESTIONS[id] })))
        .rejects.toThrow(`system-one: entry "openai-decisions": question "${id}": the response has no ${field}`)
    }
  })

  it('两个 kind 的条目同时存在时各按 target 命中自己的端点', async () => {
    const calls = stubFetch((call) => (call.url.endsWith('/v1/systemone')
      ? { answers: { q: { type: 'noul', noul: 0.3, x_label_mass: 1 } } }
      : { answers: [{ type: 'predicate', name: 'q', probability: 0.7 }] }))
    const ctx = await mount([
      { id: 'sglang-local', label: '本地 SGLang', kind: 'systemone', baseUrl: 'http://127.0.0.1:30000', model: 'qwen3-4b' },
      ENTRY,
    ])
    const questions = { q: { type: 'boolean', instructions: '?' } } satisfies Record<string, Question>

    const local = await ctx.systemOne.ask({ target: 'sglang-local', state: { step: 1 }, questions })
    const remote = await ctx.systemOne.ask({ target: 'openai-decisions', state: { step: 2 }, questions })

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:30000/v1/systemone',
      'https://api.openai.com/v1/decisions',
    ])
    expect(local.answers['q']).toMatchObject({ type: 'boolean', probability: 0.3 })
    expect(remote.answers['q']).toMatchObject({ type: 'boolean', probability: 0.7 })
  })
})
