import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as SystemOne from '../src/index.ts'
import { SystemOneProvider, type ProviderRequest } from '../src/provider.ts'
import type { Answer, ProviderResponse, Question } from '../src/types.ts'

const QUESTIONS: Record<string, Question> = {
  'turn.continue': { type: 'boolean', instructions: '本轮是否应该继续？' },
  'turn.route': { type: 'choice', instructions: '下一步走哪条路？', options: ['fix', 'ask'] },
}

const ANSWERS: Record<string, Answer> = {
  'turn.continue': { type: 'boolean', probability: 0.25 },
  'turn.route': { type: 'choice', choice: 'ask', probabilities: [0.3, 0.7] },
}

/** 记下每次调用、按脚本作答的条目实现。 */
class StubProvider extends SystemOneProvider {
  readonly calls: ProviderRequest[] = []

  constructor(private readonly scripted: ProviderResponse = { answers: ANSWERS }) {
    super()
  }

  async evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request)
    return this.scripted
  }
}

/** 挂上插件入口的宿主上下文。 */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemOne)
  return ctx
}

/**
 * 读服务上的只读投影 `providers()`。
 *
 * 插件面（`Context['systemOne']`）故意只声明 register/ask，所以断言它得越过那一面直接看服务实例。
 */
function providerIds(ctx: Context): readonly string[] {
  return (ctx.systemOne as SystemOne.SystemOneService).providers()
}

describe('ctx.systemOne', () => {
  it('把题面交给 target 指名的条目，并把答案与耗时交回', async () => {
    const ctx = await mount()
    const provider = new StubProvider()
    ctx.systemOne.register('stub', provider)

    const result = await ctx.systemOne.ask({ target: 'stub', state: { step: 3 }, questions: QUESTIONS })

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.state).toEqual({ step: 3 })
    expect(provider.calls[0]?.questions).toEqual(QUESTIONS)
    expect(result.answers).toEqual(ANSWERS)
    expect(typeof result.latencyMs).toBe('number')
  })

  it('provider 漏答的题从 answers 缺席，warnings 原样交回', async () => {
    const ctx = await mount()
    const scripted: ProviderResponse = {
      answers: { 'turn.continue': { type: 'boolean', probability: 0.8 } },
      warnings: [{ type: 'truncated', questionId: 'turn.route', message: '输入被截断' }],
    }
    ctx.systemOne.register('stub', new StubProvider(scripted))

    const result = await ctx.systemOne.ask({ target: 'stub', state: null, questions: QUESTIONS })

    expect(Object.keys(result.answers)).toEqual(['turn.continue'])
    expect(result.warnings).toEqual(scripted.warnings)
  })

  it('target 没有注册时抛错，并点名该 id 与已注册的 id', async () => {
    const ctx = await mount()
    ctx.systemOne.register('stub', new StubProvider())

    await expect(ctx.systemOne.ask({ target: 'nope', state: null, questions: QUESTIONS }))
      .rejects.toThrow('system-one: no provider registered as "nope" (registered: stub)')
  })

  it('同一个 id 注册两次抛错', async () => {
    const ctx = await mount()
    ctx.systemOne.register('stub', new StubProvider())

    expect(() => ctx.systemOne.register('stub', new StubProvider()))
      .toThrow('system-one: provider "stub" is already registered')
  })

  it('providers() 按注册顺序列出 id', async () => {
    const ctx = await mount()
    ctx.systemOne.register('a', new StubProvider())
    ctx.systemOne.register('b', new StubProvider())

    expect(providerIds(ctx)).toEqual(['a', 'b'])
  })

  it('注册随注册方的 fiber 卸载而释放', async () => {
    const ctx = await mount()
    const owner = await ctx.plugin({
      name: 'stub-owner',
      inject: ['systemOne'],
      apply(fiber: Context) {
        fiber.systemOne.register('stub', new StubProvider())
      },
    })
    expect(providerIds(ctx)).toEqual(['stub'])

    await owner.dispose()

    expect(providerIds(ctx)).toEqual([])
  })
})
