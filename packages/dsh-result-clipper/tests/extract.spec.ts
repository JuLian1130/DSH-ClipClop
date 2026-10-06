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
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
    { summarize: true, ruleSummary: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock', ...overrides } as Schemastery.TypeS<typeof Config>,
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
  it('候选结果：结果逐字不变、记 exact-text、同类提醒只发一次', async () => {
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
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0]!.message.content)).toContain('offset/limit')
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(records.at(-1)).toMatchObject({ action: 'unmodified', reason: 'exact-text', extract: true })
    expect(records.at(-2)).toMatchObject({ action: 'unmodified', reason: 'exact-text' })
  })

  it('低于摘要下限时不认这条规则：仍记 not-candidate、不发提醒', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(100)))
    const notices: AppendedNotice[] = []
    await fixture.ctx.tools.execute(
      exec('bash', undefined, { command: 'ls', extract: 'verbatim please' }, 's1', notices),
    )

    expect(route.requests).toHaveLength(0)
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
  it('默认（规则摘要关）：结果原样透传、记 rule-summary-off，并追加一条带解法的提醒', async () => {
    const { fixture, route, path } = await mounted({ ruleSummary: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe(LONG_BODY)
    // 同一会话同类提醒只发一次。
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0]!.message.content)).toContain(WHOLE_RESULT)
    expect(textOf(notices[0]!.message.content)).toContain('extract')
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'rule-summary-off', extract: false })
  })

  it('规则摘要开着时照旧摘要，但提醒照发（漏填是模型侧的错误，与开关无关）', async () => {
    const { fixture, route } = await mounted({ ruleSummary: true })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const notices: AppendedNotice[] = []
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(notices).toHaveLength(1)
  })

  it('低于摘要下限时不提醒：不是候选的结果本来就不该有人填参数', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(10)))
    const notices: AppendedNotice[] = []
    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(notices).toHaveLength(0)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'unmodified', reason: 'not-candidate' })
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
    // 最小宿主：这里只验"挂回来 + 补参"这一步，服务用桩（工具本身不执行，所以桩只要有形）。
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    ctx.provide('web', {} as never)
    ctx.provide('shell', { sandboxMode: undefined } as never)
    ctx.provide('shellEnv', {} as never)
    // 两个原生工具此时都不在表里（=部署用 patch 关掉了条目），install 才会走接管。
    const reports: MountRecord[] = []
    installExtractArg(ctx as never, () => true, (record) => { reports.push(record) })
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
