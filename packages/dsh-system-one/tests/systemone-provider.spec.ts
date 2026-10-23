/**
 * 票据 02b：`systemone` provider 的映射与拒绝规则。
 *
 * HTTP 用桩住的 `fetch` 夹具。夹具按**线上形状**写（vllm 把可信度放在 `diagnostics`、SGLang 放在
 * 答案的 `x_label_mass` 上），不按厂商身份——这个 provider 本来就不认后端是哪一家：后端会大声拒绝的
 * 交给后端，响应里留着痕迹的按响应核对，响应证不了的（请求级 `instructions`）直接拒绝。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../src/config.ts'
import * as SystemOne from '../src/index.ts'
import type { AskRequest, Question } from '../src/types.ts'

const ENTRY = {
  id: 'local',
  label: '本地决策端点',
  kind: 'systemone',
  // 末尾的斜杠是有意的：拼接端点路径时不能出现 `//v1/systemone`。
  baseUrl: 'http://127.0.0.1:30000/',
  model: 'qwen3-4b',
} satisfies Entry

const QUESTIONS = {
  'turn.continue': {
    type: 'boolean',
    instructions: '本轮是否应该继续？',
    optionDescriptions: { true: '继续', false: '停下' },
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
    levels: ['low', 'high'],
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

/** 假凭据服务：只实现 provider 用到的那一半，解析行为由用例给。 */
class FakeCredentials extends Service {
  constructor(ctx: Context, private readonly resolveRef: (ref: string) => Promise<{ value: string } | undefined>) {
    super(ctx, 'credentials')
  }

  resolve(ref: string): Promise<{ value: string } | undefined> {
    return this.resolveRef(ref)
  }
}

/** 装一个带凭据服务的 context 与一个引用了凭据的条目。 */
async function mountWithCredentials(resolveRef: (ref: string) => Promise<{ value: string } | undefined>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({ name: 'fake-credentials', apply: (fiber: Context) => void new FakeCredentials(fiber, resolveRef) })
  await ctx.plugin(SystemOne, { entries: [{ ...ENTRY, apiKeyEnv: 'DECISION_KEY' }] } as never)
  return ctx
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('systemone provider', () => {
  it('配置里的 systemone 条目装载后注册成功，ask 打到条目的 /v1/systemone', async () => {
    const calls = stubFetch(() => ({ model: 'qwen3-4b', answers: {} }))
    const ctx = await mount()

    expect((ctx.systemOne as SystemOne.SystemOneService).providers()).toEqual(['local'])
    await ctx.systemOne.ask(ask(QUESTIONS))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:30000/v1/systemone')
    expect(calls[0]?.init.method).toBe('POST')
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    // 没配 apiKeyEnv 就不带凭据。
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('三种题型映射成 noul/choice/score 的题面，答案映射回契约形状', async () => {
    const calls = stubFetch(() => ({
      model: 'qwen3-4b',
      answers: {
        'turn.continue': { type: 'noul', noul: 0.82, x_label_mass: 0.97 },
        'turn.route': {
          type: 'choice',
          choice: 'fix',
          confidence: 0.6,
          probabilities: { fix: 0.6, ask: 0.4 },
          x_label_mass: 0.9,
        },
        'turn.severity': {
          type: 'score',
          score: 0.25,
          confidence: 0.5,
          legend: { 0: 'low', 1: 'high' },
          probabilities: { 0: 0.75, 1: 0.25 },
          x_label_mass: 0.8,
        },
      },
      usage: { input_tokens: 120, output_tokens: 0 },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    expect(sentBody(calls)).toEqual({
      model: 'qwen3-4b',
      state: { step: 3 },
      questions: {
        'turn.continue': { type: 'noul', instructions: '本轮是否应该继续？', criteria: { true: '继续', false: '停下' } },
        'turn.route': { type: 'choice', instructions: '下一步走哪条路？', criteria: { fix: '直接修', ask: null } },
        'turn.severity': { type: 'score', instructions: '问题有多严重？', criteria: ['low', 'high'] },
      },
    })

    expect(result.answers).toEqual({
      'turn.continue': { type: 'boolean', probability: 0.82, labelMass: 0.97 },
      'turn.route': {
        type: 'choice',
        choice: 'fix',
        probabilities: [0.6, 0.4],
        confidence: 0.6,
        labelMass: 0.9,
      },
      'turn.severity': {
        type: 'score',
        score: 0.25,
        probabilities: [0.75, 0.25],
        legend: ['low', 'high'],
        confidence: 0.5,
        labelMass: 0.8,
      },
    })
    expect(result.modelId).toBe('qwen3-4b')
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 0 })
    expect(result.requests).toBe(1)
    expect(typeof result.latencyMs).toBe('number')
  })

  it('可信度信号放在 diagnostics 的那一家（vllm 形状）也能读出来', async () => {
    const calls = stubFetch(() => ({
      model: 'D3ForSequenceClassification',
      answers: { 'turn.continue': { type: 'noul', noul: 0.9, probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 } },
      diagnostics: { 'turn.continue': { label_mass: 0.8, argmax_is_label: true } },
      usage: { input_tokens: 40, output_tokens: 0 },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] }))

    expect(sentBody(calls)).toEqual({
      model: 'qwen3-4b',
      state: { step: 3 },
      questions: {
        'turn.continue': { type: 'noul', instructions: '本轮是否应该继续？', criteria: { true: '继续', false: '停下' } },
      },
    })
    expect(result.answers['turn.continue']).toEqual({
      type: 'boolean',
      probability: 0.9,
      confidence: 0.9,
      labelMass: 0.8,
      argmaxIsLabel: true,
    })
  })

  it('后端省略 label_mass 时按 1.0 归一化', async () => {
    stubFetch(() => ({
      answers: {
        'turn.severity': {
          type: 'score',
          score: 1,
          confidence: 1,
          legend: { 0: 'low', 1: 'high' },
          probabilities: { 0: 0, 1: 1 },
        },
      },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.severity': QUESTIONS['turn.severity'] }))

    expect(result.answers['turn.severity']).toEqual({
      type: 'score',
      score: 1,
      probabilities: [0, 1],
      legend: ['low', 'high'],
      confidence: 1,
      labelMass: 1,
    })
  })

  it('legend 长度与 levels 不符时抛错并点出 legend', async () => {
    stubFetch(() => ({
      answers: {
        'turn.severity': { type: 'score', score: 0.5, legend: { 0: 'low' }, probabilities: { 0: 0.5, 1: 0.5 } },
      },
    }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask({ 'turn.severity': QUESTIONS['turn.severity'] })))
      .rejects.toThrow('system-one: entry "local": question "turn.severity": legend has 1 values for 2 levels')
  })

  it('富 levels 被后端串化成字符串时抛错并点出 levels', async () => {
    const questions = {
      'turn.severity': { type: 'score', instructions: '?', levels: ['low', { label: '严重' }] },
    } satisfies Record<string, Question>
    stubFetch(() => ({
      answers: {
        // vllm 对每档做 str(level)：富值回来的是 Python 的 repr，不是请求里那个对象。
        'turn.severity': {
          type: 'score',
          score: 1,
          legend: { 0: 'low', 1: "{'label': '严重'}" },
          probabilities: { 0: 0, 1: 1 },
        },
      },
    }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(questions)))
      .rejects.toThrow('system-one: entry "local": question "turn.severity": levels[1] cannot be echoed faithfully')
  })

  it('富 levels 被原样回显时（另一家的形状）档位原样交回', async () => {
    const levels = ['low', { label: '严重' }]
    stubFetch(() => ({
      answers: {
        'turn.severity': { type: 'score', score: 1, legend: { 0: 'low', 1: { label: '严重' } }, probabilities: { 0: 0, 1: 1 } },
      },
    }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask({ 'turn.severity': { type: 'score', instructions: '?', levels } }))

    expect(result.answers['turn.severity']).toMatchObject({ legend: levels })
  })

  it('后端非 2xx 按 provider 级失败抛错，消息带上后端原文', async () => {
    stubFetch(() => ({ error: { message: 'this model does not take image inputs' } }), 400)
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS)))
      .rejects.toThrow('system-one: entry "local": HTTP 400 from http://127.0.0.1:30000/v1/systemone: {"error":{"message":"this model does not take image inputs"}}')
  })

  it('state 原样进请求体：后端表达不了时抛错并带上点名字段的后端原文', async () => {
    // 只收字符串/对象/数组的那一家对 null 与标量直接 422，`loc` 里点着 state。
    const calls = stubFetch(
      () => ({ detail: [{ loc: ['body', 'state'], msg: 'Input should be a valid string, dict or list', type: 'union_type' }] }),
      422,
    )
    const ctx = await mount()
    const reason = (error: unknown) => error as Error

    const nullError = await ctx.systemOne.ask(ask(QUESTIONS, { state: null })).then(() => undefined, reason)
    const scalarError = await ctx.systemOne.ask(ask(QUESTIONS, { state: 7 })).then(() => undefined, reason)

    // 不静默改写：null 还是 null、标量还是标量——不字符串化、不包成对象。
    expect(sentBody(calls, 0)).toHaveProperty('state', null)
    expect(sentBody(calls, 1)).toHaveProperty('state', 7)
    expect(nullError?.message).toContain('HTTP 422')
    expect(nullError?.message).toContain('state')
    expect(scalarError?.message).toContain('HTTP 422')
  })

  it('请求级 instructions 非空时抛错并点名字段、不发请求；空串放行也不进请求体', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS, { instructions: '你是会话导航器。' })))
      .rejects.toThrow('system-one: entry "local": instructions cannot be honored by every systemone backend')
    expect(calls).toHaveLength(0)

    // 空串不改变任何后端的输入，所以放行；它没有可发的值，也就不进请求体。
    await ctx.systemOne.ask(ask(QUESTIONS, { instructions: '' }))
    expect(calls).toHaveLength(1)
    expect(sentBody(calls)).not.toHaveProperty('instructions')
  })

  it('images 与 chat_template_kwargs 原样进请求体', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mount()

    await ctx.systemOne.ask(
      ask({ 'turn.continue': QUESTIONS['turn.continue'] }, {
        images: ['https://example.com/a.png'],
        chatTemplateKwargs: { enable_thinking: false },
      }),
    )

    expect(sentBody(calls)).toMatchObject({
      images: ['https://example.com/a.png'],
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('取消信号原样交给 fetch，deadline 转成超时信号', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mount()
    const controller = new AbortController()

    await ctx.systemOne.ask(ask(QUESTIONS, { signal: controller.signal }))
    await ctx.systemOne.ask(ask(QUESTIONS, { timeoutMs: 60_000 }))

    expect(calls[0]?.init.signal).toBe(controller.signal)
    expect(calls[1]?.init.signal).toBeInstanceOf(AbortSignal)
    expect(calls[1]?.init.signal).not.toBe(controller.signal)
  })

  it('apiKeyEnv 非空时经凭据服务解析并带上 Bearer 凭据', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mountWithCredentials(async () => ({ value: 'sk-local' }))

    await ctx.systemOne.ask(ask(QUESTIONS))

    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-local')
  })

  it('凭据解析不到时按 provider 级失败抛错，且不发请求', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mountWithCredentials(async () => undefined)

    await expect(ctx.systemOne.ask(ask(QUESTIONS)))
      .rejects.toThrow('system-one: entry "local": apiKeyEnv "DECISION_KEY" is not configured')
    expect(calls).toHaveLength(0)
  })

  it('profile 没装载凭据服务时抛错并点名 apiKeyEnv', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mount([{ ...ENTRY, apiKeyEnv: 'DECISION_KEY' }])

    await expect(ctx.systemOne.ask(ask(QUESTIONS)))
      .rejects.toThrow('system-one: entry "local": apiKeyEnv "DECISION_KEY" needs the credentials service')
    expect(calls).toHaveLength(0)
  })

  it('后端漏答的题从 answers 缺席，也不补警告', async () => {
    stubFetch(() => ({ answers: { 'turn.continue': { type: 'noul', noul: 0.4 } } }))
    const ctx = await mount()

    const result = await ctx.systemOne.ask(ask(QUESTIONS))

    expect(Object.keys(result.answers)).toEqual(['turn.continue'])
    expect(result.warnings).toBeUndefined()
  })

  it('端点不可达时按 provider 级失败抛错，消息带条目 id', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS)))
      .rejects.toThrow('system-one: entry "local": fetch failed')
  })

  it('响应不是 JSON 时抛错并带上原文', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask(QUESTIONS))).rejects.toThrow(
      'system-one: entry "local": http://127.0.0.1:30000/v1/systemone answered with non-JSON: <html>gateway</html>',
    )
  })

  it('答案缺少该题型的必填项时抛错并点出字段', async () => {
    stubFetch(() => ({ answers: { 'turn.continue': {} } }))
    const ctx = await mount()

    await expect(ctx.systemOne.ask(ask({ 'turn.continue': QUESTIONS['turn.continue'] })))
      .rejects.toThrow('system-one: entry "local": question "turn.continue": the response has no noul')
  })

  it('凭据解析抛错时按 provider 级失败抛错并点名引用名', async () => {
    const calls = stubFetch(() => ({ answers: {} }))
    const ctx = await mountWithCredentials(async () => {
      throw new TypeError('credentials document is unreadable')
    })

    await expect(ctx.systemOne.ask(ask(QUESTIONS)))
      .rejects.toThrow('system-one: entry "local": apiKeyEnv "DECISION_KEY": credentials document is unreadable')
    expect(calls).toHaveLength(0)
  })
})
