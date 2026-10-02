/**
 * 票 06：摘要准入判断。
 *
 * 观察面只有三个：**假 route 收到的请求**（条数、有没有正文、走了哪条 route、是否关推理——准入与摘要共用这
 * 条假 route，按请求顺序取脚本，所以第一段答复给准入、第二段给摘要）、**工具执行的最终正文**（判 no 或判断
 * 失败时透传了什么）、**debug JSONL 的「结果取值 + 准入结论」**。
 *
 * 每条「不发请求 / 原文透传」的断言都配阳性对照：同一份夹具换一段脚本或换一个开关，证明那条路径本来会发
 * 请求、本来会替换。
 *
 * 「保存即生效」用真 profile（真 settings + 真 Loader）——开关与准入 route 都是 volatile 引用，改写后同一份
 * 插件实例的下一条结果就该按新值走，不需要重挂载。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { DEFAULT_ADMISSION_RULE } from '../src/admission.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'
import { FakeRoute, requestText } from './support/route.ts'
import type { FakeReply } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 刚过摘要下限的正文：估价 = ceil(5000/4) + 4，落在 `[1024, 12500)` 内。 */
const LONG_BODY = 'x'.repeat(5000)

/** `LONG_BODY` 的估算大小（估算器单位）：准入与摘要两次请求的共用前缀里要写它。 */
const ESTIMATED = 1254

/** 摘要模型返回的一段短说明。 */
const SHORT_SUMMARY = '这是一段短说明'

/** 摘要答复。 */
const SUMMARY_REPLY = JSON.stringify({ action: 'summarize', summary: SHORT_SUMMARY })

/** 准入判断的两段答复。 */
const YES: FakeReply = { text: 'yes' }
const NO: FakeReply = { text: 'no' }

const open: HostFixture[] = []
const live: LiveFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  await Promise.all(live.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => { cleanupProfiles() })

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-admission-'))
  roots.push(root)
  return root
}

/**
 * 装一份夹具：开启摘要、准入与 debug，配好主 route，并把假 route 放进 context。
 * @param overrides - 覆盖默认的插件配置。
 * @param script - 假 route 的答复脚本；按请求顺序取用，用完后重复最后一段。
 * @returns 夹具、假 route 与 debug 日志路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [YES, { text: SUMMARY_REPLY }],
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    {
      summarize: true, admissionJudge: true, debug: true, debugPath: path,
      routeProvider: 'mock', routeModel: 'mock', ...overrides,
    } as Schemastery.TypeS<typeof Config>,
    undefined,
    route,
  )
  open.push(fixture)
  return { fixture, route, path }
}

/**
 * 装一条真 profile 并登记收场：跨 settings 写入的用例要靠它把 volatile 引用**原地**改写。
 * @param config - 本插件那一行的 profile 配置。
 * @returns 夹具。
 */
async function booted(config: Record<string, unknown>): Promise<LiveFixture> {
  const fixture = await bootProfile(config)
  live.push(fixture)
  return fixture
}

/**
 * 读回 debug 记录。
 * @param path - 日志路径。
 * @returns 逐行解析出的记录；文件不存在时为空数组。
 */
function records(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * 两段文本逐字相同的开头部分。
 * @param a - 第一段。
 * @param b - 第二段。
 * @returns 从第一个字符起完全相同的那一段。
 */
function commonPrefix(a: string, b: string): string {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  return a.slice(0, index)
}

/**
 * 正文每次执行时现取的文本工具：跨 settings 写入的用例要靠它换一段正文，避免 memo 命中把准入短路。
 * @param name - 工具名。
 * @param body - 取当前正文的函数。
 * @returns 注册用的工具定义。
 */
function mutableTextTool(name: string, body: () => string): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: body() }] },
  })
}

describe('票 06 第 3、4 条：准入请求不含正文、含结果大小，且与摘要请求前缀逐字相同', () => {
  it('第一段请求是准入请求：不含工具正文；第二段是带正文的摘要请求', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    const admissionText = requestText(route.requests[0]!)
    const summaryText = requestText(route.requests[1]!)
    // 准入请求不含正文，也不带正文的分隔标记；含这次结果的估算大小。
    expect(admissionText).not.toContain(LONG_BODY)
    expect(admissionText).not.toContain('TOOL_RESULT')
    expect(admissionText).toContain(String(ESTIMATED))
    // 阳性对照：第二段确实是带正文的摘要请求，且结果被替换过。
    expect(summaryText).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(textOf(result.content)).not.toBe(LONG_BODY)
  })

  it('两次请求的前缀逐字相同，结果大小那一行在共用前缀里', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    const admissionText = requestText(route.requests[0]!)
    const summaryText = requestText(route.requests[1]!)
    const shared = commonPrefix(admissionText, summaryText)
    // 共用前缀必须包含「结果大小那一行」：只把这一行放进其中一次请求，这里的共同开头就会在它之前断开。
    expect(shared).toMatch(new RegExp(`估算大小[^\\n]*${ESTIMATED}`))
    // 两次请求都必须各自带上它（含 `yes`/`no` 输出格式的准入请求也带）。
    expect(admissionText).toMatch(new RegExp(`估算大小[^\\n]*${ESTIMATED}`))
    expect(summaryText).toMatch(new RegExp(`估算大小[^\\n]*${ESTIMATED}`))
  })
})

describe('票 06 第 1 条：准入开关、准入 route 与准入请求的关闭推理', () => {
  it('准入 route 留空时跟随主 route', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(route.requests[0]?.provider).toBe('mock')
    expect(route.requests[0]?.model).toBe('mock')
    expect(route.requests[1]?.provider).toBe('mock')
  })

  it('配了准入 route 时准入请求发往它，摘要请求仍发往主 route', async () => {
    const { fixture, route } = await mounted({ admissionProvider: 'local', admissionModel: 'small' })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(route.requests[0]?.provider).toBe('local')
    expect(route.requests[0]?.model).toBe('small')
    expect(route.requests[1]?.provider).toBe('mock')
    expect(route.requests[1]?.model).toBe('mock')
  })

  it('准入请求默认关闭推理；关掉该开关则不传 reasoningEffort', async () => {
    const off = await mounted()
    off.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await off.fixture.ctx.tools.execute(exec('bash'))
    expect(off.route.requests[0]?.reasoningEffort).toBe('off')

    const on = await mounted({ admissionDisableReasoning: false })
    on.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await on.fixture.ctx.tools.execute(exec('bash'))
    // 先坐实这一臂真的发过准入请求：没有它，「不传 reasoningEffort」在「压根不发请求」下也为真。
    expect(on.route.requests).toHaveLength(2)
    expect(on.route.requests[0]?.reasoningEffort).toBeUndefined()
  })

  it('准入开关默认关闭：同一份夹具只发摘要请求', async () => {
    const { fixture, route } = await mounted({ admissionJudge: false }, [{ text: SUMMARY_REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
  })

  it('保存即生效：同一份真 profile 里写入准入开关与准入 route 后，下一条结果立刻按新值走', async () => {
    const fixture = await booted({ summarize: true, routeProvider: 'mock', routeModel: 'mock' })
    const route = new FakeRoute([{ text: SUMMARY_REPLY }, YES, { text: SUMMARY_REPLY }, YES, { text: SUMMARY_REPLY }])
    fixture.ctx.provide('llm', route as never)
    fixture.ctx.provide('spillStore', new FakeSpill() as never)
    let body = `${LONG_BODY}A`
    fixture.ctx.tools.register(mutableTextTool('bash', () => body))

    // 默认关闭：只发一次带正文的摘要请求。
    expect(fixture.config.admissionJudge.get()).toBe(false)
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(body)

    // 写入开关（不重挂载）：下一条结果先发一次不带正文的准入请求。
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['admissionJudge'], value: true }])
    expect(fixture.config.admissionJudge.get()).toBe(true)
    body = `${LONG_BODY}B`
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(3)
    expect(requestText(route.requests[1]!)).not.toContain(body)
    expect(requestText(route.requests[2]!)).toContain(body)

    // 写入准入 route：下一条结果的准入请求发往它，摘要请求仍发往主 route。
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [
      { op: 'set', path: ['admissionProvider'], value: 'local' },
      { op: 'set', path: ['admissionModel'], value: 'small' },
    ])
    expect(fixture.config.admissionProvider.get()).toBe('local')
    body = `${LONG_BODY}C`
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(5)
    expect(route.requests[3]?.provider).toBe('local')
    expect(route.requests[3]?.model).toBe('small')
    expect(route.requests[4]?.provider).toBe('mock')
  })
})

describe('票 06 第 2 条：摘要能力关闭时不发准入请求', () => {
  it('摘要关闭（准入开关开着）时一次请求都不发，结果记 summary-off / 准入不适用', async () => {
    const { fixture, route, path } = await mounted({ summarize: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'summary-off', admission: 'not-applicable' }),
    ])

    // 阳性对照：同一份夹具只把摘要能力打开，准入请求与摘要请求各发一次。
    const control = await mounted()
    control.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await control.fixture.ctx.tools.execute(exec('bash'))
    expect(control.route.requests).toHaveLength(2)
  })
})

describe('票 06 第 5 条：准入判断失败仍继续摘要', () => {
  it.each([
    ['调用失败', [{ error: 'boom' }]],
    ['空结果', [{ text: '' }]],
    ['非法结果', [{ text: 'maybe' }]],
  ] as const)('%s 时照样发起带正文的摘要请求', async (_label, head) => {
    const { fixture, route, path } = await mounted({}, [...head, { text: SUMMARY_REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'summarized', admission: 'failed' }))
  })

  it('准入请求被中止（超时走的就是这条 signal）时照样继续摘要', async () => {
    const { fixture, route, path } = await mounted({}, [{ hang: true }, { text: SUMMARY_REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const pending = fixture.ctx.tools.execute(exec('bash'))
    // 实现必须把请求的 signal 交给 route；没有它这条 await 会一直挂着，用例超时变红。
    await vi.waitFor(() => { expect(route.requests).toHaveLength(1) })
    route.requests[0]?.signal?.dispatchEvent(new Event('abort'))
    const result = await pending

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'summarized', admission: 'failed' }))
  })

  it('准入之后的写盘抛出时，准入结论仍如实记那次判断的结果（不谎报没发过准入请求）', async () => {
    const { fixture, route, path } = await mounted()
    fixture.spill!.fail = true
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    // 阳性对照：准入与摘要各发过一次，所以这一次的准入结论是 yes 而不是「不适用」。
    expect(route.requests).toHaveLength(2)
    expect(records(path).at(-1)).toEqual(
      expect.objectContaining({ action: 'unmodified', reason: 'failed', admission: 'yes' }),
    )
  })
})

describe('票 06 第 6 条：memo 命中与按入口读回时都不发准入请求', () => {
  it('memo 命中：第二次不发任何新请求，复用同一条摘要', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    // 阳性对照：第一次确实走了「准入 + 摘要」两次请求，也确实被替换过。
    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain(SHORT_SUMMARY)

    const second = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(2)
    expect(textOf(second.content)).toBe(textOf(first.content))
    expect(records(path)).toEqual([
      expect.objectContaining({ action: 'summarized', admission: 'yes' }),
      expect.objectContaining({ action: 'summarized', admission: 'not-applicable' }),
    ])
  })

  it('按入口读回：不发任何新请求、不再次摘要；换成别的路径照常走准入与摘要', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    const locator = fixture.spill!.refs[0]!.locator
    expect(route.requests).toHaveLength(2)

    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const read = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(textOf(read.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(2)
    expect(records(path).at(-1)).toEqual(
      expect.objectContaining({ toolName: 'read', action: 'unmodified', reason: 'read-back', admission: 'not-applicable' }),
    )

    // 阳性对照：同一条 read 换成别的路径，准入与摘要各发一次。
    const other = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: '/tmp/other.txt' }))
    expect(route.requests).toHaveLength(4)
    expect(textOf(other.content)).toContain(SHORT_SUMMARY)
  })
})

describe('票 06 第 7 条：准入判 no 时原文透传、不再发起带正文的摘要请求', () => {
  it('判 no：只发一次准入请求、正文逐字不变、debug 记 admission-no 与准入结论 no', async () => {
    const { fixture, route, path } = await mounted({}, [NO, { text: SUMMARY_REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(1)
    // 那一次请求就是不含正文的准入请求：整条摘要路径上没有出现过带正文的请求。
    expect(route.requests.every(request => !requestText(request).includes(LONG_BODY))).toBe(true)
    expect(records(path)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'admission-no', admission: 'no' }),
    ])

    // 阳性对照：同一份夹具只把答复换成 yes，就照常发起带正文的摘要请求并替换。
    const control = await mounted({}, [YES, { text: SUMMARY_REPLY }])
    control.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const replaced = await control.fixture.ctx.tools.execute(exec('bash'))
    expect(control.route.requests).toHaveLength(2)
    expect(textOf(replaced.content)).toContain(SHORT_SUMMARY)
  })
})

describe('票 06 第 8 条：隐私闸门开启时准入不发', () => {
  it('隐私开启时只发一次带正文的请求（07 会把它换成隐私判断请求），没有准入请求', async () => {
    const { fixture, route, path } = await mounted({ privacyGate: true }, [{ text: SUMMARY_REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    // 阳性对照嵌在断言里：这一次请求带着工具正文，说明它是摘要那条请求而不是不含正文的准入请求。
    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ admission: 'not-applicable' }))
  })
})

describe('票 06 第 9 条：准入提示词可编辑，安全外壳与输出格式不可改', () => {
  it('默认用内置规则正文；配了规则正文就换成它，外壳与输出格式两种情况下逐字相同', async () => {
    const builtin = await mounted()
    builtin.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await builtin.fixture.ctx.tools.execute(exec('bash'))
    const builtinText = requestText(builtin.route.requests[0]!)
    expect(builtinText).toContain(DEFAULT_ADMISSION_RULE)
    expect(builtinText).toContain('yes')
    expect(builtinText).not.toContain(LONG_BODY)

    const edited = await mounted({ admissionPrompt: '只看体积与工具名' })
    edited.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await edited.fixture.ctx.tools.execute(exec('bash'))
    const editedText = requestText(edited.route.requests[0]!)
    expect(editedText).toContain('只看体积与工具名')
    expect(editedText).not.toContain(DEFAULT_ADMISSION_RULE)
    // 外壳与输出格式由程序写死：可编辑段之外的部分两种情况下逐字相同。
    expect(editedText.split('只看体积与工具名')[1]).toBe(builtinText.split(DEFAULT_ADMISSION_RULE)[1])
  })
})
