/**
 * 可选参数 `extract`：目标提取的读法、定义扩展、以及"声明了目标就不再问准入模型"这条策略。
 *
 * 观察面：模型侧看得到的定义（参数表与说明）、原生执行体收到的参数（`extract` 必须被摘掉），以及假 route
 * 收到的请求（声明目标时只有一次摘要请求，没有准入请求）。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Config, PLUGIN_VERSION } from '../src/index.ts'
import type { MountRecord } from '../src/index.ts'
import {
  EXTRACT_DESCRIPTION,
  WHOLE_RESULT,
  extractGoalOf,
  extractRule,
  isWholeResult,
  wantsExactText,
  extendedDefinition,
  extendInPlace,
  installExtractArg,
  READ_GUIDANCE,
  takeoverPlan,
} from '../src/extract.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { AppendedNotice, HostFixture } from './support/host.ts'
import { runLoop } from './support/loop.ts'
import type { LoopFixture } from './support/loop.ts'
import { FakeRoute, requestText } from './support/route.ts'
import type { FakeReply } from './support/route.ts'

const LONG_BODY = 'x'.repeat(5000)
const SHORT_SUMMARY = '这是一段短说明'
const REPLY = JSON.stringify({ action: 'summarize', summary: SHORT_SUMMARY })
const YES = JSON.stringify({ answer: true })

const open: HostFixture[] = []
const loops: LoopFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  await Promise.all(loops.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-extract-'))
  roots.push(root)
  return root
}

/**
 * 挂一份开启摘要与 debug 的夹具。
 * @param overrides - 覆盖的配置项。
 * @param script - 假 route 的答复序列。
 * @returns 夹具、假 route 与 debug 路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: REPLY }],
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    { summarize: true, ruleSummary: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock',
      // 本用例测的是摘要与提取目标路：把精简层的尺寸下限抬到夹具正文之上，本层判 unchanged（不表态），既有取值与正文逐字保留；精简层自己的行为见 condense-pipeline.spec.ts。
      condenseMinUnits: 1e9,
      ...overrides } as Schemastery.TypeS<typeof Config>,
    undefined,
    route,
  )
  open.push(fixture)
  return { fixture, route, path }
}

type Schemastery = typeof import('@deepseek-ai/schemastery')

describe('extractGoalOf：只认 arguments.extract 上的非空字符串', () => {
  it.each([
    [{}, undefined],
    [{ extract: '' }, undefined],
    [{ extract: '   ' }, undefined],
    [{ extract: 42 }, undefined],
    [{ extract: null }, undefined],
    [{ extract: ' 只要标题 ' }, '只要标题'],
  ])('%j → %s', (args, expected) => {
    expect(extractGoalOf({ arguments: args })).toBe(expected)
  })

  it('参数不是对象时不抛', () => {
    expect(extractGoalOf({ arguments: undefined })).toBeUndefined()
    expect(extractGoalOf({ arguments: 'x' })).toBeUndefined()
  })
})

describe('wantsExactText：只认明确针对文本的逐字要求', () => {
  it.each([
    ['the exact 400 error message, verbatim', true],
    ['Exact text of lines 1-50, verbatim.', true],
    ['character-for-character copy of the signature', true],
    ['exactly as written in the docs', true],
    ['Quote verbatim: the cap constants (READ_LIMIT, maxLineLength)', true],
    ['逐字给出那几行', true],
    ['把原来的那段原样贴出来', true],
    // 反例：`exact` 修饰的是"概念"而不是正文，这类目标的摘要是对的。
    ['exact conditions and codes of failures thrown in the compaction region', false],
    ['which values does the config accept, and what are the defaults', false],
    ['quote the relevant doc lines about retries', false],
  ])('%s → %s', (goal, expected) => {
    expect(wantsExactText(goal)).toBe(expected)
  })
})

describe('声明逐字原文时按原文透传（不发摘要请求）', () => {
  it('候选结果：结果逐字不变、记 exact-text、同类提醒只交回一次', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const first = await fixture.ctx.tools.execute(
      exec('bash', undefined, { command: 'ls', extract: 'the exact output, verbatim' }, 's1', notices),
    )
    const second = await fixture.ctx.tools.execute(
      exec('bash', undefined, { command: 'ls', extract: 'verbatim once more' }, 's1', notices),
    )

    expect(route.requests).toHaveLength(0)
    expect(textOf(first.content)).toBe(LONG_BODY)
    expect(textOf(second.content)).toBe(LONG_BODY)
    expect(first.additionalContexts).toHaveLength(1)
    expect(second.additionalContexts ?? []).toHaveLength(0)
    expect(textOf(first.additionalContexts![0]!.content)).toContain('offset/limit')
    expect(notices).toHaveLength(0)
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(records.at(-1)).toMatchObject({ action: 'unmodified', reason: 'exact-text', extract: true })
    expect(records.at(-2)).toMatchObject({ action: 'unmodified', reason: 'exact-text' })
  })

  it('低于摘要下限时不认这条规则：仍记 not-candidate、不交回提醒', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(100)))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(
      exec('bash', undefined, { command: 'ls', extract: 'verbatim please' }, 's1', notices),
    )

    expect(route.requests).toHaveLength(0)
    expect(result.additionalContexts ?? []).toHaveLength(0)
    expect(notices).toHaveLength(0)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'not-candidate' })
  })

  it('规则摘要开着也一样：逐字目标不交给摘要器', async () => {
    const { fixture, route } = await mounted({ ruleSummary: true })
    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const result = await fixture.ctx.tools.execute(
      exec('read', undefined, { file_path: 'a.ts', extract: 'character-for-character copy' }),
    )

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe(LONG_BODY)
  })
})

describe('isWholeResult：要整份结果的唯一写法', () => {
  it.each([
    [WHOLE_RESULT, true],
    ['whole_result', true],
    ['Whole_Result', true],
    // 反例：这些是**目标**（结果会被缩成这几个词），不是"要整份"。
    ['whole file', false],
    ['everything', false],
    ['full text', false],
    ['WHOLE_RESULT please', false],
  ])('%s → %s', (goal, expected) => {
    expect(isWholeResult(goal)).toBe(expected)
  })
})

describe('哨兵 WHOLE_RESULT：显式要整份就按原文透传', () => {
  it('候选结果：一个请求都不发、结果逐字不变、记 whole-result、不发提醒', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(
      exec('bash', undefined, { command: 'ls', extract: WHOLE_RESULT }, 's1', notices),
    )

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(notices).toHaveLength(0)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'whole-result', extract: true })
  })

  it('规则摘要开着也一样：哨兵不是"没声明"，不走通用摘要那条退路', async () => {
    const { fixture, route } = await mounted({ ruleSummary: true })
    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: 'a.ts', extract: 'whole_result' }))

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe(LONG_BODY)
  })

  it('低于摘要下限的哨兵仍记 not-candidate：哨兵不改变候选判定', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(10)))
    await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'ls', extract: WHOLE_RESULT }))

    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'not-candidate' })
  })
})

describe('必填参数漏填：照默认处理，同时提醒一次', () => {
  it('默认（规则摘要关）：结果原样透传、记 rule-summary-off，并交回一条带解法的提醒', async () => {
    const { fixture, route, path } = await mounted({ ruleSummary: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const first = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    const second = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(route.requests).toHaveLength(0)
    expect(textOf(first.content)).toBe(LONG_BODY)
    // 同一会话同类提醒只交回一次。
    expect(first.additionalContexts).toHaveLength(1)
    expect(second.additionalContexts ?? []).toHaveLength(0)
    const text = textOf(first.additionalContexts![0]!.content)
    expect(text).toContain(WHOLE_RESULT)
    expect(text).toContain('extract')
    expect(text.startsWith('[dsh-result-clipper] ')).toBe(true)
    expect(notices).toHaveLength(0)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'rule-summary-off', extract: false })
  })

  it('规则摘要开着时照旧摘要，但提醒照交回（漏填是模型侧的错误，与开关无关）', async () => {
    const { fixture, route } = await mounted({ ruleSummary: true })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(result.additionalContexts).toHaveLength(1)
    expect(notices).toHaveLength(0)
  })

  it('低于摘要下限时不提醒：不是候选的结果本来就不该有人填参数', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(10)))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(result.additionalContexts ?? []).toHaveLength(0)
    expect(notices).toHaveLength(0)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'not-candidate' })
  })

  it('填过一次之后名额放回：同一个会话里再漏填，仍会得到一条提醒', async () => {
    const { fixture } = await mounted({ ruleSummary: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const missed = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    const filled = await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'ls', extract: '只要标题' }, 's1', notices))
    const missedAgain = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(missed.additionalContexts).toHaveLength(1)
    expect(filled.additionalContexts ?? []).toHaveLength(0)
    expect(missedAgain.additionalContexts).toHaveLength(1)
    expect(notices).toHaveLength(0)
  })
})

describe('extractRule：目标进规则正文，且不再提 keep', () => {
  it('含目标原文，且说明"原样"也可以只贴片段', () => {
    const rule = extractRule('只要 redis 段的两个值')
    expect(rule).toContain('只要 redis 段的两个值')
    expect(rule).toContain('只贴相关的那几行或那个片段')
    expect(rule).toContain('不要交回整段结果')
  })

  it('正文里不出现 keep：这条路径的"不摘要"只有「低于摘要下限」一种来源', () => {
    expect(extractRule('只要 redis 段的两个值')).not.toContain('keep')
  })
})

describe('声明了提取目标时输出契约里没有 keep', () => {
  it('带 extract 的摘要请求只提供 summarize 一种动作', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要 ERROR 的时间戳' }))

    const text = requestText(route.requests[0]!)
    expect(text).toContain('{"action":"summarize","summary":string}')
    expect(text).not.toContain('keep')
  })

  it('阴性对照：同一配置下不带 extract 的请求照旧提供 keep', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(requestText(route.requests[0]!)).toContain('{"action":"summarize"|"keep","summary":string|null}')
  })

  it('结果低于摘要下限时一个模型请求都不发，原样透传（带 extract 也一样）', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(10)))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要标题' }))

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe('x'.repeat(10))
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'not-candidate', extract: true })
  })
})

describe('extendedDefinition：补参数、追加说明、执行时摘掉 extract', () => {
  /** 记下原生执行体收到的参数，再逐字返回正文。 */
  function recordingTool(name: string, seen: unknown[]): ToolDefinition {
    return {
      ...textTool(name, LONG_BODY),
      async execute(args: unknown) {
        seen.push(args)
        return [{ type: 'text', text: LONG_BODY }]
      },
    } as unknown as ToolDefinition
  }

  it('参数表多出 extract 并把它标为必填，原有参数与说明都保留', () => {
    const native = textTool('read', LONG_BODY)
    const extended = extendedDefinition(native, 'read')
    expect(Object.keys(extended.parameters.properties ?? {})).toContain('extract')
    expect(extended.parameters.required).toEqual(['extract'])
    expect(extended.parameters).not.toBe(native.parameters)
    expect(extended.description).toContain(native.description)
    expect(extended.description).toContain(READ_GUIDANCE)
    const properties = extended.parameters.properties as Record<string, { description?: string }> | undefined
    expect(properties?.extract?.description).toBe(EXTRACT_DESCRIPTION)
  })

  it('同一份定义扩展两次拿到同一个对象（不重复补参数）', () => {
    const native = textTool('read', LONG_BODY)
    const once = extendedDefinition(native, 'read')
    expect(extendedDefinition(once, 'read')).toBe(once)
    expect(once.description.split(READ_GUIDANCE)).toHaveLength(2)
  })

  it('原生已有的必填项照旧保留：必填表是追加，不是顶替', () => {
    const native = defineContentToolFixture({
      name: 'read',
      description: 'read',
      parameters: { file_path: { type: 'string', required: true } },
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: LONG_BODY }] },
    })
    expect(extendedDefinition(native, 'read').parameters.required).toEqual(['file_path', 'extract'])
  })

  it('执行体把 extract 摘掉后委托原生', async () => {
    const seen: unknown[] = []
    const extended = extendedDefinition(recordingTool('read', seen), 'read')
    await extended.execute({ file_path: 'a.txt', extract: '只要标题' }, exec('read') as never)
    expect(seen).toEqual([{ file_path: 'a.txt' }])
  })
})

describe('extendInPlace：就地改写已注册的定义', () => {
  it('同一个对象被改写、可执行、且幂等', async () => {
    const seen: unknown[] = []
    const definition = {
      ...textTool('bash', LONG_BODY),
      async execute(args: unknown) {
        seen.push(args)
        return [{ type: 'text', text: LONG_BODY }]
      },
    } as unknown as ToolDefinition
    extendInPlace(definition, 'bash')
    expect(Object.keys(definition.parameters.properties ?? {})).toContain('extract')
    await definition.execute({ command: 'ls', extract: '只要文件名' }, exec('bash') as never)
    expect(seen).toEqual([{ command: 'ls' }])
    const after = definition.description
    extendInPlace(definition, 'bash')
    expect(definition.description).toBe(after)
  })
})

describe('策略：主模型声明了目标就不再问准入模型', () => {
  it('开了准入判断，但这次调用带了 extract → 只有一次摘要请求，且规则正文是目标', async () => {
    // 准入被跳过，所以第一发就是摘要请求，脚本里只给摘要答复。
    const { fixture, route, path } = await mounted({ admissionJudge: true }, [{ text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要 ERROR 的时间戳' }))

    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain('只要 ERROR 的时间戳')
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'summarized', admission: 'not-applicable', extract: true })
    expect(existsSync(path)).toBe(true)
  })

  it('阴性对照：没带 extract 时准入请求照发（同一配置）', async () => {
    const { fixture, route, path } = await mounted({ admissionJudge: true }, [{ text: YES }, { text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).not.toContain('主模型这次的提取目标')
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ extract: false })
  })

  it('摘要关着时传了也不认：不发任何请求，工具结果原样（关闭＝不生效）', async () => {
    const { fixture, route } = await mounted({ summarize: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要 ERROR 的时间戳' }))

    expect(route.requests).toHaveLength(0)
  })
})

describe('声明了目标就跳过 memo', () => {
  it('带目标的那次不复用 memo：同一份正文先不带目标再带目标，两发都真的发请求', async () => {
    const { fixture, route } = await mounted({}, [{ text: REPLY }, { text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要出错的那几行' }))

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).toContain('只要出错的那几行')
  })

  it('带目标的那次也不写 memo：先带目标再不带目标，后一发要重新请求', async () => {
    const { fixture, route } = await mounted({}, [{ text: REPLY }, { text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要出错的那几行' }))
    // 目标摘要若被写进 memo，这一发会命中它、不发请求。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).not.toContain('主模型这次的提取目标')

    // 这一发不带目标、上一发同样是通用摘要，所以这次命中 memo：请求数不再增长。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(2)
  })

  it('阳性对照：两次都不带目标时第二次命中 memo，只发一次请求', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
  })
})

/**
 * 假的 `appReady`：语义照 `apps/cli/src/profile-boot.ts` 的 `createAppReady`——已 ready 时 `onReady` 在调用内
 * 同步回调、返回空 disposer；未 ready 时先登记，`commit()` 时按登记顺序各回调一次。
 */
class FakeAppReady {
  #ready = false
  readonly #listeners = new Set<() => void>()

  /**
   * @param listener - boot 成功后要跑的一次性回调。
   * @returns 撤销登记（已 ready 时没有可撤销的东西）。
   */
  onReady(listener: () => void): () => void {
    if (this.#ready) {
      listener()
      return () => {}
    }
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** 模拟 boot 成功：登记的监听器各跑一次，之后再登记的立即跑。 */
  commit(): void {
    if (this.#ready) return
    this.#ready = true
    for (const listener of [...this.#listeners]) listener()
    this.#listeners.clear()
  }
}

/**
 * 「真单关」最小宿主：原生 `bash` / `web_fetch` 都不在表里，工具以外的服务用桩（工具本身不执行，桩有形即可）。
 * @returns 只差被测插件的 context。
 */
async function takeoverContext(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  ctx.provide('web', {} as never)
  ctx.provide('shell', { sandboxMode: undefined } as never)
  ctx.provide('shellEnv', {} as never)
  return ctx
}

/**
 * 装一个**可单独释放**的插件实例：重载测试要模拟「旧实例连同它挂的工具一起 dispose，新实例重装」。
 * @param ctx - 宿主 context。
 * @param reports - 接收挂载记录。
 * @param options - 测试接缝：启用判据与接管工厂表。
 * @returns 实例的 fiber；`dispose()` 即卸载。
 */
async function scopedInstance(
  ctx: Context,
  reports: MountRecord[],
  options: { enabled?: () => boolean, takeover?: Record<string, (ctx: Context) => unknown> } = {},
): Promise<Fiber> {
  const fiber = ctx.plugin({
    // 与被测插件同样的 inject：`ctx.tools` 不加声明在子 fiber 上取不到。
    inject: ['tools'],
    apply: (inner: Context) => {
      installExtractArg(inner as never, options.enabled ?? (() => true), (record) => { reports.push(record) }, options.takeover)
    },
  })
  await fiber
  return fiber
}

/**
 * 装好宿主并装上被测插件。
 * @param options - 测试接缝：接管工厂表（缺省走生产实现）、启用判据、假 `appReady`，以及装插件**之前**的钩子。
 * @returns context 与安装时收到的挂载记录。
 */
async function takeoverHost(options: {
  takeover?: Record<string, (ctx: Context) => unknown>
  enabled?: () => boolean
  appReady?: FakeAppReady
  before?: (ctx: Context) => void
} = {}): Promise<{ ctx: Context, reports: MountRecord[] }> {
  const ctx = await takeoverContext()
  // 与真实部署同序：`appReady` 在树装载前由 launcher 提供，插件 apply 时才去取。
  if (options.appReady) ctx.provide('appReady', options.appReady as never)
  const reports: MountRecord[] = []
  options.before?.(ctx)
  installExtractArg(ctx as never, options.enabled ?? (() => true), (record) => { reports.push(record) }, options.takeover)
  return { ctx, reports }
}

describe('装载：agent 创建时按 agent 作用域遮蔽', () => {
  it('摘要开着时，这个 agent 的工具表与模型侧 schema 当场多出 extract；全局那份定义不动', async () => {
    // 真 agent loop：`bash` 在装载后才注册，然后才创建 agent —— 遮蔽必须发生在 agent/created 上，
    // 且早于第一次组装提示词，所以模型侧 schema 里应当直接看得到 `extract`。
    const fixture = await runLoop(
      { summarize: true, routeProvider: 'mock', routeModel: 'mock' } as Schemastery.TypeS<typeof Config>,
      LONG_BODY,
      SHORT_SUMMARY,
    )
    loops.push(fixture)

    const agentView = fixture.ctx.tools.get('bash', fixture.agent)!
    expect(Object.keys(agentView.parameters?.properties ?? {})).toContain('extract')
    // 遮蔽是复制一份，不改全局同名定义：别的 agent 看到的仍是原生那份。
    expect(Object.keys(fixture.ctx.tools.get('bash')!.parameters?.properties ?? {})).not.toContain('extract')
    expect(JSON.stringify(fixture.requests[0]!.tools)).toContain('extract')
  })

  it('关掉摘要时不覆盖工具：agent 的工具表与模型侧 schema 都没有 extract', async () => {
    const off = await runLoop(
      { summarize: false } as Schemastery.TypeS<typeof Config>,
      LONG_BODY,
      SHORT_SUMMARY,
    )
    loops.push(off)

    expect(Object.keys(off.ctx.tools.get('bash', off.agent)?.parameters?.properties ?? {})).not.toContain('extract')
    expect(JSON.stringify(off.requests[0]!.tools)).not.toContain('extract')
  })

  it('原生条目已被 patch 关掉时全局挂回来并就地补参；接管失败不会把 agent 创建带崩', async () => {
    const { ctx, reports } = await takeoverHost()
    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId('takeover-probe'), { provider: 'mock', model: 'mock' })

    for (const name of ['bash', 'web_fetch']) {
      const mounted = ctx.tools.get(name)
      expect(mounted, `${name} 应当被挂回来`).toBeDefined()
      expect(Object.keys(mounted!.parameters?.properties ?? {})).toContain('extract')
    }
    // 只挂取回那一个：搜索仍由原生条目提供，我们不复刻。
    expect(ctx.tools.get('web_search')).toBeUndefined()
    // 挂载决策记录：这四个工具各走哪条路，是"真单关有没有生效"唯一的观测点。
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      kind: 'mount',
      pluginVersion: expect.any(String),
      platform: process.platform,
      tools: { bash: 'takeover', web_fetch: 'takeover', pwsh: 'absent' },
    })
    expect(Object.keys(reports[0]!.tools).sort()).toEqual(['bash', 'pwsh', 'read', 'web_fetch'])
    // 第二个 agent 不再写一次：这条记录是"本次装载"的，不是"每个 agent"的。
    await harness.create(SessionId('takeover-probe-2'), { provider: 'mock', model: 'mock' })
    expect(reports).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('首次挂载抛错后，下一个 agent 创建时再试：bash 最终可见，且失败只告警一次', async () => {
    let attempts = 0
    const { ctx, reports } = await takeoverHost({
      takeover: {
        bash: (ctx) => {
          attempts += 1
          if (attempts === 1) throw new Error('mount exploded')
          ctx.tools.register(textTool('bash', LONG_BODY))
        },
      },
    })
    const warned: string[] = []
    ctx.logger.exporter({
      levels: { default: 99 },
      export: (message) => {
        if (message.type === 'warn' && String(message.args[0]).includes('mounting bash failed')) warned.push(String(message.args[0]))
      },
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const first = await harness.create(SessionId('mount-retry-1'), { provider: 'mock', model: 'mock' })
    // 挂载失败不得把 agent 创建弄失败，这一轮 bash 确实缺失、只有一条告警。
    expect(ctx.tools.get('bash', first)).toBeUndefined()
    expect(warned).toHaveLength(1)

    const second = await harness.create(SessionId('mount-retry-2'), { provider: 'mock', model: 'mock' })
    expect(attempts, '第二个 agent 创建时应当再试一次').toBe(2)
    const mounted = ctx.tools.get('bash', second)
    expect(mounted, '重试成功后应当能看到 bash').toBeDefined()
    expect(Object.keys(mounted!.parameters?.properties ?? {})).toContain('extract')
    expect(warned).toHaveLength(1)
    // 挂载记录仍只反映首个 agent 时点（那次是 absent），重试成功不补写。
    expect(reports).toHaveLength(1)
    expect(reports[0]!.tools).toMatchObject({ bash: 'absent' })
    await ctx.fiber.dispose()
  })

  it('接管来的工具从表里消失后，下一个 agent 创建时重新挂回来', async () => {
    let remove: (() => void) | undefined
    let mounts = 0
    const { ctx, reports } = await takeoverHost({
      takeover: {
        bash: (ctx) => {
          mounts += 1
          remove = ctx.tools.register(textTool('bash', LONG_BODY))
        },
      },
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const first = await harness.create(SessionId('mount-lost-1'), { provider: 'mock', model: 'mock' })
    expect(ctx.tools.get('bash', first)).toBeDefined()
    // 夹具模拟"挂载来的工具从工具表里消失"：卸掉那次注册，不碰挂载 fiber。
    remove!()
    expect(ctx.tools.get('bash')).toBeUndefined()

    const second = await harness.create(SessionId('mount-lost-2'), { provider: 'mock', model: 'mock' })
    expect(mounts).toBe(2)
    expect(ctx.tools.get('bash', second), '重挂或遮蔽，二者之一').toBeDefined()
    // 连续创建 agent 不重复注册（同层同名会当场抛错）；已经挂回来之后不再挂第三次。
    const third = await harness.create(SessionId('mount-lost-3'), { provider: 'mock', model: 'mock' })
    expect(ctx.tools.get('bash', third)).toBeDefined()
    expect(mounts).toBe(2)
    // 挂载记录仍只有首条，且反映首个 agent 时点（当时是接管）。
    expect(reports).toHaveLength(1)
    expect(reports[0]!.tools).toMatchObject({ bash: 'takeover' })
    await ctx.fiber.dispose()
  })

  it('摘要关着时不接管、不遮蔽、不写挂载记录', async () => {
    const { ctx, reports } = await takeoverHost({ enabled: () => false })
    ctx.tools.register(textTool('read', LONG_BODY))
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('mount-off'), { provider: 'mock', model: 'mock' })

    expect(ctx.tools.get('bash')).toBeUndefined()
    expect(Object.keys(ctx.tools.get('read', agent)!.parameters?.properties ?? {})).not.toContain('extract')
    expect(reports).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('插件重载后应用已 ready：立即补挂，活会话不建新 agent 也重新看得到 bash / web_fetch', async () => {
    const ctx = await takeoverContext()
    const ready = new FakeAppReady()
    ctx.provide('appReady', ready as never)
    const reports: MountRecord[] = []
    const first = await scopedInstance(ctx, reports)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('reload-1'), { provider: 'mock', model: 'mock' })
    expect(ctx.tools.get('bash')).toBeDefined()

    // 重载：旧实例连同它挂的工具一起释放；应用没有重启，`appReady` 仍是 ready。
    await first.dispose()
    ready.commit()
    expect(ctx.tools.get('bash')).toBeUndefined()

    await scopedInstance(ctx, reports)
    // 补挂是异步的（`ctx.plugin` 交回的 fiber），等它落地即可——这个等待里没有 agent 创建。
    await vi.waitFor(() => {
      for (const name of ['bash', 'web_fetch']) {
        const mounted = ctx.tools.get(name)
        expect(mounted, `${name} 应当在重载后立即挂回来`).toBeDefined()
        expect(Object.keys(mounted!.parameters?.properties ?? {})).toContain('extract')
      }
    })
    // 不建新 agent，既有 agent 的工具视角也重新含 bash（会话侧验收）。
    expect(ctx.tools.get('bash', agent)).toBeDefined()
    // 没有第二条挂载记录：记录仍是首个 agent 时点的那条。
    expect(reports).toHaveLength(1)
    expect(reports[0]!.tools).toMatchObject({ bash: 'takeover', web_fetch: 'takeover' })
    await ctx.fiber.dispose()
  })

  it('冷启动：appReady 未 ready 时装载期不抢挂，commit 后补挂且挂载记录仍取首个 agent 时点', async () => {
    const ready = new FakeAppReady()
    const { ctx, reports } = await takeoverHost({ appReady: ready })
    expect(ctx.tools.get('bash'), '装载未完成时不该挂').toBeUndefined()
    expect(reports).toHaveLength(0)

    ready.commit()
    await vi.waitFor(() => { expect(ctx.tools.get('bash')).toBeDefined() })
    expect(Object.keys(ctx.tools.get('web_fetch')!.parameters?.properties ?? {})).toContain('extract')

    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId('cold-ready'), { provider: 'mock', model: 'mock' })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.tools).toMatchObject({ bash: 'takeover', web_fetch: 'takeover' })
    await ctx.fiber.dispose()
  })

  it('ready 回调里的挂载抛错被吞掉：commit 调用方不收到异常，下一个 agent 仍会重试', async () => {
    const ready = new FakeAppReady()
    const planned = takeoverPlan(process.platform)
    let attempts = 0
    const takeover: Record<string, (ctx: Context) => unknown> = {}
    for (const name of planned) takeover[name] = () => { attempts += 1; throw new Error('ready mount exploded') }
    const { ctx, reports } = await takeoverHost({ appReady: ready, takeover })
    const warned: string[] = []
    ctx.logger.exporter({
      levels: { default: 99 },
      export: (message) => {
        if (message.type === 'warn' && String(message.args[0]).includes('mounting')) warned.push(String(message.args[0]))
      },
    })

    expect(() => ready.commit()).not.toThrow()
    // 失败只告警、不挂工具；commit 已经返回（异常没有从监听器漏出去）。
    await vi.waitFor(() => { expect(warned).toHaveLength(planned.length) })
    expect(attempts).toBe(planned.length)
    expect(ctx.tools.get('bash')).toBeUndefined()

    // 票 28 的重试语义不变：下一个 agent 创建时还会再试，且创建本身不失败。
    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId('ready-throw'), { provider: 'mock', model: 'mock' })
    expect(attempts).toBe(planned.length * 2)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.tools).toMatchObject({ bash: 'absent' })
    await ctx.fiber.dispose()
  })

  it('插件在 ready 之前被卸掉时，onReady 的挂载回调随实例撤销', async () => {
    const ready = new FakeAppReady()
    const ctx = await takeoverContext()
    ctx.provide('appReady', ready as never)
    const reports: MountRecord[] = []
    // 计数启用判据：回调真的被撤销时它一次都不该被读到。只看"没挂上工具"区分不出「disposer 生效」与
    // 「回调照跑、失败被 ensureTakeover 吞掉」。
    let polls = 0
    const first = await scopedInstance(ctx, reports, { enabled: () => { polls += 1; return true } })
    await first.dispose()

    ready.commit()
    await Promise.resolve()
    expect(polls, '悬空回调不该被调用').toBe(0)
    expect(ctx.tools.get('bash')).toBeUndefined()
    expect(reports).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('原生工具还在的部署：重载路径立即判断也只看到"原生在"，不接管、不就地改写原生定义', async () => {
    const ready = new FakeAppReady()
    ready.commit()
    const { ctx, reports } = await takeoverHost({
      appReady: ready,
      before: (ctx) => {
        ctx.tools.register(textTool('bash', LONG_BODY))
        ctx.tools.register(textTool('web_fetch', LONG_BODY))
      },
    })
    for (const name of ['bash', 'web_fetch']) {
      expect(Object.keys(ctx.tools.get(name)!.parameters?.properties ?? {}), `${name} 不该被接管改写`).not.toContain('extract')
    }

    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('reload-native'), { provider: 'mock', model: 'mock' })
    expect(Object.keys(ctx.tools.get('bash', agent)!.parameters?.properties ?? {})).toContain('extract')
    expect(reports[0]!.tools).toMatchObject({ bash: 'shadow', web_fetch: 'shadow' })
    await ctx.fiber.dispose()
  })

  it('摘要关着时，已 ready 的重载路径同样不挂载、不写挂载记录', async () => {
    const ready = new FakeAppReady()
    ready.commit()
    const { ctx, reports } = await takeoverHost({ appReady: ready, enabled: () => false })
    await Promise.resolve()
    expect(ctx.tools.get('bash')).toBeUndefined()
    expect(ctx.tools.get('web_fetch')).toBeUndefined()

    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId('reload-off'), { provider: 'mock', model: 'mock' })
    expect(reports).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('Windows 上的 shell（注册名 pwsh）只走遮蔽：从不 import 那个包', async () => {
    // 本机（macOS/Linux）没有 `pwsh`，所以这里装一条同名的假工具代表那个平台；遮蔽按 agent 作用域装，
    // 平台条件由 `ctx.tools.get('pwsh', agent)` 判定，插件不需要 import `dsh-tool-pwsh`。
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    ctx.tools.register(textTool('pwsh', LONG_BODY))
    const reports: MountRecord[] = []
    installExtractArg(ctx as never, () => true, (record) => { reports.push(record) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('pwsh-probe'), { provider: 'mock', model: 'mock' })

    const agentView = ctx.tools.get('pwsh', agent)!
    expect(Object.keys(agentView.parameters?.properties ?? {})).toContain('extract')
    // 说明用的是 shell 那一段（`bash` 与 `pwsh` 共用），不是 read 或 web_fetch 的。
    expect(agentView.description).toContain('large command output')
    // 全局那条不动，且没有因为 `pwsh` 而凭空造出 `bash`。
    expect(Object.keys(ctx.tools.get('pwsh')!.parameters?.properties ?? {})).not.toContain('extract')
    expect(ctx.tools.get('bash')).toBeUndefined()
    expect(reports[0]!.tools).toMatchObject({ pwsh: 'shadow' })
    await ctx.fiber.dispose()
  })

  it.each([
    ['darwin', ['bash', 'web_fetch']],
    ['linux', ['bash', 'web_fetch']],
    ['win32', ['web_fetch']],
  ] as const)('接管只挑这个平台上挂得回来的工具：%s → %j', (platform, expected) => {
    // 与 base bundle preset 行的 `!!js process.platform` 条件同源：Windows 上不去挂 `bash`（那里没有它）。
    // 两边都不挂 `pwsh`：那个包在本包的解析基点上不存在，接管失败在这里等于"Windows 上一个 shell 都不剩"。
    expect(takeoverPlan(platform)).toEqual(expected)
  })

  it('首个 agent 创建时往 debug 文件写一行挂载决策记录', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const fixture = await runLoop(
      { summarize: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock' } as Schemastery.TypeS<typeof Config>,
      LONG_BODY,
      SHORT_SUMMARY,
    )
    loops.push(fixture)

    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const mountRecord = records.find(record => record.kind === 'mount')
    expect(mountRecord, '装载时应当留下一行挂载决策记录').toBeDefined()
    // 与结果记录同一契约：这条记录也要能归属到当时在跑的构建（取值等于本包的版本号）。
    expect(mountRecord).toMatchObject({ pluginVersion: PLUGIN_VERSION, platform: process.platform })
    // 这条夹具里的 `bash` 由测试先注册（=原生还在），所以插件走遮蔽而不是接管。
    expect(mountRecord!.tools).toMatchObject({ bash: 'shadow' })
  })
})
