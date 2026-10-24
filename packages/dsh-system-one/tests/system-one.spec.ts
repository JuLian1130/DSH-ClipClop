import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORIES } from '../src/entries.ts'
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

afterEach(() => {
  vi.restoreAllMocks()
})

/** 一个合法条目；热更新只关心 id，其余字段给能过 schema 的占位值。 */
function entry(id: string): SystemOne.Entry {
  return { id, label: id, kind: 'systemone', baseUrl: 'http://127.0.0.1:1', model: 'stub' }
}

/**
 * 带 `get()` 的 volatile 替身：模拟 loader 把新值提交进运行中的 fiber 后，配置引用读到的快照。
 * @param initial - 初始条目。
 * @returns 交给 `apply` 的配置，以及替换快照的入口。
 */
function volatileConfig(initial: SystemOne.Entry[]) {
  let current = initial
  const config = { entries: { get: () => current } } as Required<SystemOne.Config>
  return {
    config,
    update(next: SystemOne.Entry[]): void {
      current = next
    },
  }
}

/** 工厂表是条目与网络实现之间的接缝：热更新用例把它换成不联网的 StubProvider，并可记下收到的条目。 */
function stubFactories(seen?: SystemOne.Entry[]): void {
  vi.spyOn(FACTORIES, 'systemone').mockImplementation((current) => {
    seen?.push(current)
    return new StubProvider()
  })
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

  it('可选的请求字段原样交给 provider，target 不进入 provider 请求', async () => {
    const ctx = await mount()
    const provider = new StubProvider()
    ctx.systemOne.register('stub', provider)

    const questions: Record<string, Question> = {
      'turn.continue': {
        type: 'boolean',
        instructions: '',
        optionDescriptions: { true: '继续', false: '停下' },
      },
      'turn.route': {
        type: 'choice',
        instructions: '下一步走哪条路？',
        options: ['fix', 'ask'],
        optionDescriptions: { fix: '直接修', ask: '先问用户' },
      },
      'turn.severity': {
        type: 'score',
        instructions: '问题有多严重？',
        levels: ['low', { label: 'high', examples: ['数据丢失'] }],
      },
    }
    const request: SystemOne.AskRequest = {
      target: 'stub',
      state: { step: 3 },
      questions,
      instructions: '你是会话导航器。',
      images: ['https://example.com/a.png', 'data:image/png;base64,AAAA'],
      chatTemplateKwargs: { enable_thinking: false },
    }

    await ctx.systemOne.ask(request)

    const { target: _target, ...expected } = request
    expect(provider.calls[0]).toEqual(expected)
    expect('target' in (provider.calls[0] as object)).toBe(false)
  })

  it('答案的可信度信号与档位回显原样交回', async () => {
    const ctx = await mount()
    const scripted: ProviderResponse = {
      answers: {
        'turn.continue': {
          type: 'boolean',
          probability: 0.8,
          confidence: 0.7,
          labelMass: 0.9,
          argmaxIsLabel: true,
        },
        'turn.severity': {
          type: 'score',
          score: 0.4,
          probabilities: [0.6, 0.4],
          confidence: 0.5,
          labelMass: 1,
          argmaxIsLabel: true,
          legend: ['low', { label: 'high', examples: ['数据丢失'] }],
        },
      },
    }
    ctx.systemOne.register('stub', new StubProvider(scripted))

    const result = await ctx.systemOne.ask({
      target: 'stub',
      state: null,
      questions: {
        'turn.continue': { type: 'boolean', instructions: '?' },
        'turn.severity': { type: 'score', instructions: '?', levels: ['low', 'high'] },
      },
    })

    expect(result.answers).toEqual(scripted.answers)
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

describe('条目配置热生效', () => {
  it('volatile 更新新增的条目不需要重挂载就能 ask', async () => {
    stubFactories()
    const { config, update } = volatileConfig([])
    const ctx = new Context()
    SystemOne.apply(ctx, config)
    await expect(ctx.systemOne.ask({ target: 'added', state: null, questions: QUESTIONS }))
      .rejects.toThrow('system-one: no provider registered as "added" (registered: none)')

    update([entry('added')])
    ctx.emit('loader/volatile-update', [['entries']])

    const result = await ctx.systemOne.ask({ target: 'added', state: { step: 1 }, questions: QUESTIONS })
    expect(result.answers).toEqual(ANSWERS)
  })

  it('从配置去掉的条目在 volatile 更新后不再可 ask，报错点出现在还有的 id', async () => {
    stubFactories()
    const { config, update } = volatileConfig([entry('keep'), entry('drop')])
    const ctx = new Context()
    SystemOne.apply(ctx, config)
    expect(providerIds(ctx)).toEqual(['keep', 'drop'])

    update([entry('keep')])
    ctx.emit('loader/volatile-update', [['entries']])

    expect(providerIds(ctx)).toEqual(['keep'])
    await expect(ctx.systemOne.ask({ target: 'drop', state: null, questions: QUESTIONS }))
      .rejects.toThrow('system-one: no provider registered as "drop" (registered: keep)')
  })

  it('volatile 更新里改过的条目重新建出 provider，新字段生效', async () => {
    const seen: SystemOne.Entry[] = []
    stubFactories(seen)
    const { config, update } = volatileConfig([entry('kept')])
    const ctx = new Context()
    SystemOne.apply(ctx, config)

    update([{ ...entry('kept'), model: 'changed' }])
    ctx.emit('loader/volatile-update', [['entries']])

    expect(providerIds(ctx)).toEqual(['kept'])
    expect(seen.at(-1)?.model).toBe('changed')
  })

  it('重复 id 的非法新配置保留旧注册表，事件不把异常抛出去', async () => {
    stubFactories()
    const { config, update } = volatileConfig([entry('kept')])
    const ctx = new Context()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    SystemOne.apply(ctx, config)

    update([entry('kept'), entry('kept')])
    expect(() => ctx.emit('loader/volatile-update', [['entries']])).not.toThrow()

    expect(providerIds(ctx)).toEqual(['kept'])
    // 报错要能定位到出问题的条目。
    expect(logged.mock.calls.flat().some((arg) => String(arg).includes('"kept" is used twice'))).toBe(true)
    const result = await ctx.systemOne.ask({ target: 'kept', state: null, questions: QUESTIONS })
    expect(result.answers).toEqual(ANSWERS)
  })
})
