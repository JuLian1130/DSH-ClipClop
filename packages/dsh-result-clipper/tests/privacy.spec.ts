/**
 * 票 07：隐私闸门。
 *
 * 观察面只有四个：**假 route 收到的请求**（条数、判断对象、走了哪条 route、是否关推理）、**工具执行的最终正文**
 * （透传了什么 / 被拦成了什么）、**debug JSONL 的结果取值**、**工具执行 append 的会话事件**（失效提醒）。
 *
 * 每条「不发请求 / 原文透传」的断言都配阳性对照（同一份夹具换一段脚本、换一个开关或确认位），证明那条路径
 * 本来会发请求、本来会替换。装载顺序用受控的 prepend 监听器搭：它截断下游投影，插件后注册即位于外层。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { composeEntry } from '../src/entry.ts'
import { DEFAULT_PRIVACY_RULE } from '../src/rules.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { AppendedNotice, HostFixture } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'
import { FakeRoute, UNSUPPORTED_EFFORT_REPLY, requestText } from './support/route.ts'
import type { FakeReply } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 超过摘要下限的正文：估价落在 `[1024, 12500)` 内，隐私关闭时本来会被摘要替换。 */
const LONG_BODY = 'x'.repeat(5000)

/** 低于摘要下限的短正文：隐私判断不设门槛，摘要候选设门槛。 */
const SHORT_BODY = 'short body'

/** 隐私模式判 `safe` 时随同一份答复交回的摘要。 */
const SAFE_SUMMARY = '安全摘要'

/** 一条 `safe` + `summarize` 的合并答复。 */
const SAFE = JSON.stringify({ privacyVerdict: 'safe', action: 'summarize', summary: SAFE_SUMMARY })

/** 一条 `safe` + `keep` 的合并答复：隐私通过但要求保留全文。 */
const SAFE_KEEP = JSON.stringify({ privacyVerdict: 'safe', action: 'keep', summary: null })

/** 判定敏感：即便带着 action/summary 也不该被采用。 */
const SENSITIVE = JSON.stringify({ privacyVerdict: 'sensitive', action: 'summarize', summary: '不该采用' })

/** 未能判定：连带取消摘要，按失败策略放行原文。 */
const UNCERTAIN = JSON.stringify({ privacyVerdict: 'uncertain', action: 'summarize', summary: '不该采用' })

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-privacy-'))
  roots.push(root)
  return root
}

/**
 * 装一份隐私模式夹具：开启隐私、摘要与 debug，配好摘要 route 并确认隐私 route 是本地的。
 * @param overrides - 覆盖默认的插件配置。
 * @param script - 假 route 的答复脚本；按请求顺序取用，用完后重复最后一段。
 * @returns 夹具、假 route 与 debug 日志路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: SAFE }],
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    {
      privacyGate: true, summarize: true, debug: true, debugPath: path,
      routeProvider: 'mock', routeModel: 'mock', privacyConfirmedLocal: true, ...overrides,
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
 * 一个位于下游的截断监听器：先 `next()`，再把超过上限的正文截断。两种装载顺序靠它制造观察面差异。
 * @param limit - 保留的字符数。
 * @returns 监听器。
 */
function truncatingListener(limit: number) {
  return async (
    _exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    const content = decision.kind === 'accept' ? decision.content ?? result.content : result.content
    const text = textOf(content)
    if (text.length <= limit) return decision
    return { kind: 'accept', content: [{ type: 'text', text: `${text.slice(0, limit)}…[截断]` }] }
  }
}

describe('票 07 第 1 条：隐私 route 确认位与三类请求的推理档位', () => {
  it('未确认为本地时不发请求、原文透传、记 failed；确认后同一条结果发一次请求并被替换', async () => {
    const unconfirmed = await mounted({ privacyConfirmedLocal: false })
    unconfirmed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const passed = await unconfirmed.fixture.ctx.tools.execute(exec('bash'))
    expect(unconfirmed.route.requests).toHaveLength(0)
    expect(textOf(passed.content)).toBe(LONG_BODY)
    expect(records(unconfirmed.path)).toEqual([expect.objectContaining({ action: 'unmodified', reason: 'failed' })])

    // 阳性对照：同一份夹具只把确认位打开，这一条结果就发一次隐私请求并被摘要替换。
    const confirmed = await mounted()
    confirmed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const replaced = await confirmed.fixture.ctx.tools.execute(exec('bash'))
    expect(confirmed.route.requests).toHaveLength(1)
    expect(textOf(replaced.content)).toContain(SAFE_SUMMARY)
  })

  it('未确认且失败策略为 block 时给出拒绝结果，不是透传', async () => {
    const { fixture, route, path } = await mounted({ privacyConfirmedLocal: false, failurePolicy: 'block' })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(0)
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('bash')
    expect(records(path)).toEqual([expect.objectContaining({ action: 'rejected' })])
  })

  it('隐私请求默认档位是「不推理」；改选别的档位就带那一个（两臂都先坐实发过请求）', async () => {
    const off = await mounted()
    off.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await off.fixture.ctx.tools.execute(exec('bash'))
    expect(off.route.requests).toHaveLength(1)
    expect(off.route.requests[0]?.reasoningEffort).toBe('off')

    const chosen = await mounted({ privacyReasoningEffort: 'xhigh' })
    chosen.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await chosen.fixture.ctx.tools.execute(exec('bash'))
    expect(chosen.route.requests).toHaveLength(1)
    expect(chosen.route.requests[0]?.reasoningEffort).toBe('xhigh')
  })

  it('隐私 route 独立于摘要 route：隐私请求发往 privacyProvider/privacyModel，而不是摘要那一条', async () => {
    const { fixture, route } = await mounted({ privacyProvider: 'guard', privacyModel: 'guard-model' })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(route.requests[0]?.provider).toBe('guard')
    expect(route.requests[0]?.model).toBe('guard-model')

    // 阳性对照：只清掉隐私 route 的两个字段，同一条结果就转发往摘要 route（mock/mock）。
    const followed = await mounted()
    followed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await followed.fixture.ctx.tools.execute(exec('bash'))
    expect(followed.route.requests[0]?.provider).toBe('mock')
    expect(followed.route.requests[0]?.model).toBe('mock')
  })

  it('保存即生效：同一份真 profile 里勾上确认位后，下一条结果立刻开始判断', async () => {
    const fixture = await booted({
      summarize: true, privacyGate: true, privacyConfirmedLocal: false,
      routeProvider: 'mock', routeModel: 'mock',
    })
    const route = new FakeRoute([{ text: SAFE }])
    fixture.ctx.provide('llm', route as never)
    fixture.ctx.provide('spillStore', new FakeSpill() as never)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    // 默认未确认：不发请求、原文透传（失败策略默认放行）。
    expect(fixture.config.privacyConfirmedLocal.get()).toBe(false)
    const passed = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(0)
    expect(textOf(passed.content)).toBe(LONG_BODY)

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['privacyConfirmedLocal'], value: true }])
    expect(fixture.config.privacyConfirmedLocal.get()).toBe(true)
    const judged = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(1)
    expect(textOf(judged.content)).toContain(SAFE_SUMMARY)
  })
})

describe('票 07 第 2 条：每个标准工具结果的隐私判断', () => {
  it('非目标工具（skill）的结果同样被判断；带父派发的子派发不被判断', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('skill', '技能正文'))
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    // 非目标工具不在摘要候选内，但仍在隐私判断面上。
    await fixture.ctx.tools.execute(exec('skill'))
    expect(route.requests).toHaveLength(1)
    // 阳性对照：普通派发的 bash 也判一次（判断面不限于三类目标工具）。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(2)
    // PTC 子派发是程序内部的中途值：不进判断面。`run_code` 的外层结果走的是同一条普通派发路径
    // （模块里唯一可用、且设计文档点名的判据就是 `exec.parent`），真实 PTC 外层因此同样被判断。
    await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(route.requests).toHaveLength(2)
  })

  it('判 safe 且动作为 summarize 时仍走摘要路径：写一次入口、正文被摘要替换', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(fixture.spill!.saves).toHaveLength(1)
    expect(fixture.spill!.saves[0]!.content).toBe(LONG_BODY)
    expect(textOf(result.content)).toBe(SAFE_SUMMARY + composeEntry(fixture.spill!.refs[0]!, 'bash'))
  })

  it('判 safe 且动作为 keep 时正文逐字不变、不写存储、记 kept', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: SAFE_KEEP }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(fixture.spill!.saves).toHaveLength(0)
    expect(records(path)).toEqual([expect.objectContaining({ action: 'unmodified', reason: 'kept' })])
  })

  it('摘要能力关闭时只发那一次隐私请求，判 safe 与按 passthrough 放行都记 summary-off', async () => {
    const { fixture, route, path } = await mounted({ summarize: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path)).toEqual([expect.objectContaining({ action: 'unmodified', reason: 'summary-off' })])

    // 放行侧同理（规格「契约 · 判定顺序」：摘要关闭时判 `safe` 或按 `passthrough` 放行都记 `summary-off`）：
    // 隐私判断照常发出，但「为什么这条结果没被改动」的取值仍是摘要能力关闭。
    const uncertain = await mounted({ summarize: false }, [{ text: UNCERTAIN }])
    uncertain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const passed = await uncertain.fixture.ctx.tools.execute(exec('bash'))
    expect(uncertain.route.requests).toHaveLength(1)
    expect(textOf(passed.content)).toBe(LONG_BODY)
    expect(records(uncertain.path)).toEqual([expect.objectContaining({ action: 'unmodified', reason: 'summary-off' })])
  })
})

describe('票 07 第 3 条：判定敏感返回固定 block 文案', () => {
  it.each(['passthrough', 'block'] as const)('失败策略为 %s 时判定敏感都拦截，文案含工具名、不含参数与正文', async (failurePolicy) => {
    const { fixture, route, path } = await mounted({ failurePolicy }, [{ text: SENSITIVE }])
    const body = 'SENSITIVE-BODY-SENTINEL'
    fixture.ctx.tools.register(textTool('bash', body))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { secret: 'ARG-SENTINEL' }))

    expect(route.requests).toHaveLength(1)
    expect(result.isError).toBe(true)
    const feedback = textOf(result.content)
    expect(feedback).toContain('bash')
    expect(feedback).toContain('不要重试')
    expect(feedback).toContain('ask_user_question')
    expect(feedback).not.toContain(body)
    expect(feedback).not.toContain('ARG-SENTINEL')
    expect(records(path)).toEqual([expect.objectContaining({ action: 'rejected' })])
  })
})

describe('隐私闸门默认不覆盖 web_fetch', () => {
  it('默认不判：web_fetch 不发隐私请求，照常走摘要路径被替换；勾上开关后同一条结果被拦下', async () => {
    // 隐私关闭时 web_fetch 是摘要候选，所以这里第一发就是摘要请求；用 SAFE 当答复是因为它的字段形状同时满足
    // 摘要解析（action/summary），从而能证明这条结果确实走了摘要路径。
    const off = await mounted()
    off.fixture.ctx.tools.register(textTool('web_fetch', LONG_BODY))
    const rewritten = await off.fixture.ctx.tools.execute(exec('web_fetch'))

    expect(off.route.requests).toHaveLength(1)
    expect(requestText(off.route.requests[0]!)).not.toContain('privacyVerdict')
    expect(textOf(rewritten.content)).toBe(SAFE_SUMMARY + composeEntry(off.fixture.spill!.refs[0]!, 'web_fetch'))
    expect(records(off.path)).toEqual([expect.objectContaining({ action: 'summarized' })])

    // 阳性对照：同一个工具、只把开关勾上，就发隐私请求、判定敏感就拦截。
    const on = await mounted({ webFetchPrivacyGate: true }, [{ text: SENSITIVE }])
    on.fixture.ctx.tools.register(textTool('web_fetch', LONG_BODY))
    const blocked = await on.fixture.ctx.tools.execute(exec('web_fetch'))

    expect(on.route.requests).toHaveLength(1)
    expect(requestText(on.route.requests[0]!)).toContain('privacyVerdict')
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked.content)).toContain('web_fetch')
    expect(records(on.path)).toEqual([expect.objectContaining({ action: 'rejected' })])
  })

  it('只挪 web_fetch：同一份夹具里 bash 仍逐条判断', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('web_fetch', LONG_BODY))
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    await fixture.ctx.tools.execute(exec('web_fetch'))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[0]!)).not.toContain('privacyVerdict')
    expect(requestText(route.requests[1]!)).toContain('privacyVerdict')
  })
})

describe('隐私模式与提取目标：同一份隐私规则，带目标时按「不牵涉隐私」提取', () => {
  it('带目标时请求里既有隐私规则正文、也有目标与脱敏要求；不带目标时没有这一段', async () => {
    const withGoal = await mounted({ extractArg: true })
    withGoal.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await withGoal.fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要所有邮箱地址' }))

    expect(withGoal.route.requests).toHaveLength(1)
    const text = requestText(withGoal.route.requests[0]!)
    expect(text).toContain(DEFAULT_PRIVACY_RULE)
    expect(text).toContain('只要所有邮箱地址')
    expect(text).toContain('不牵涉隐私')
    expect(text).toContain('"sensitive"')

    // 阴性对照：不带目标时提示词里没有目标那一段（与关闭该参数之前一致）。
    const plain = await mounted({ extractArg: true })
    plain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await plain.fixture.ctx.tools.execute(exec('bash'))
    expect(requestText(plain.route.requests[0]!)).not.toContain('提取目标')
  })

  it('目标模式仍然走隐私结论：判 sensitive 时照旧拦截', async () => {
    const { fixture, route } = await mounted({ extractArg: true }, [{ text: SENSITIVE }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要邮箱地址' }))

    expect(route.requests).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('bash')
  })
})

describe('票 07 第 4 条：uncertain 与技术失败按失败策略处理', () => {
  it('passthrough：uncertain 与技术失败都放行原文，取值分别是 uncertain / failed', async () => {
    const uncertain = await mounted({}, [{ text: UNCERTAIN }])
    uncertain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const passed = await uncertain.fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(passed.content)).toBe(LONG_BODY)
    expect(records(uncertain.path)).toEqual([expect.objectContaining({ reason: 'uncertain' })])

    const failed = await mounted({}, [{ error: 'boom' }])
    failed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const passedOnError = await failed.fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(passedOnError.content)).toBe(LONG_BODY)
    expect(records(failed.path)).toEqual([expect.objectContaining({ reason: 'failed' })])
  })

  it('block：uncertain 与技术失败都给出拒绝结果', async () => {
    const uncertain = await mounted({ failurePolicy: 'block' }, [{ text: UNCERTAIN }])
    uncertain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const blocked = await uncertain.fixture.ctx.tools.execute(exec('bash'))
    expect(blocked.isError).toBe(true)
    expect(records(uncertain.path)).toEqual([expect.objectContaining({ action: 'rejected' })])

    const failed = await mounted({ failurePolicy: 'block' }, [{ error: 'boom' }])
    failed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const blockedOnError = await failed.fixture.ctx.tools.execute(exec('bash'))
    expect(blockedOnError.isError).toBe(true)
    expect(records(failed.path)).toEqual([expect.objectContaining({ action: 'rejected' })])
  })
})

describe('票 07 第 5 条：窗口不足、普通失败与 uncertain 在记录里取值不同', () => {
  it('三种失效各落一个不同取值', async () => {
    const reasons: unknown[] = []
    // 底层按上下文超窗报回（真实适配器的 `CONTEXT_WINDOW_EXCEEDED` 走的是同一条分类）。
    const window = await mounted({}, [{ error: 'Context length exceeded: 40000 > 32768' }])
    window.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await window.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(window.path)[0]?.reason)

    const plain = await mounted({}, [{ error: 'boom' }])
    plain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await plain.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(plain.path)[0]?.reason)

    const uncertain = await mounted({}, [{ text: UNCERTAIN }])
    uncertain.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await uncertain.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(uncertain.path)[0]?.reason)

    expect(reasons).toEqual(['failed-window', 'failed', 'uncertain'])
  })
})

describe('票 07 第 6 条：隐私判断不受结果长度限制；含图片按文本判定', () => {
  it('低于摘要下限的短结果照样判断隐私（阳性对照：关掉隐私闸门后不发请求）', async () => {
    const on = await mounted()
    on.fixture.ctx.tools.register(textTool('bash', SHORT_BODY))
    const short = await on.fixture.ctx.tools.execute(exec('bash'))
    expect(on.route.requests).toHaveLength(1)
    expect(requestText(on.route.requests[0]!)).toContain(SHORT_BODY)
    // 短结果进不了摘要候选，但隐私判断确实发生过（不是被长度门槛静默跳过）。
    expect(textOf(short.content)).toBe(SHORT_BODY)
    expect(records(on.path)).toEqual([expect.objectContaining({ reason: 'not-candidate' })])

    const off = await mounted({ privacyGate: false })
    off.fixture.ctx.tools.register(textTool('bash', SHORT_BODY))
    await off.fixture.ctx.tools.execute(exec('bash'))
    expect(off.route.requests).toHaveLength(0)
  })

  it('含图片的结果按其文本判定，图片块不进请求', async () => {
    const { fixture, route } = await mounted()
    const multimodal = [
      { type: 'text', text: LONG_BODY },
      { type: 'image', attachment: { name: 'IMAGE-SENTINEL.png' } },
    ] as unknown as ContentBlock[]
    fixture.ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'bash', parameters: {},
      async execute(): Promise<ContentBlock[]> { return multimodal },
    }))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(LONG_BODY)
    expect(requestText(route.requests[0]!)).not.toContain('IMAGE-SENTINEL')
    expect(result.content.some(block => block.type === 'image')).toBe(true)
  })
})

describe('票 07 第 7 条：隐私模式只发一次请求且覆盖完整文本投影', () => {
  it('一次请求包含正文与附加上下文，只发这一条', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    // 下游交回一条附加上下文：它是模型即将看到的内容，也在判断面内。
    fixture.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text: 'CONTEXT-SENTINEL' }],
        source: { kind: 'user' },
      })],
    }))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    const judged = requestText(route.requests[0]!)
    expect(judged).toContain(LONG_BODY)
    expect(judged).toContain('CONTEXT-SENTINEL')
  })

  it('同一工具同一正文连续两次各发一次隐私判断请求，不复用 memo', async () => {
    const { fixture, route } = await mounted({}, [
      { text: SAFE },
      { text: JSON.stringify({ privacyVerdict: 'safe', action: 'summarize', summary: '第二次摘要' }) },
    ])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    const second = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain(SAFE_SUMMARY)
    expect(textOf(second.content)).toContain('第二次摘要')
    expect(textOf(second.content)).not.toBe(textOf(first.content))
  })

  it('准入开关也开着时仍然只发那一条合并请求，准入不发', async () => {
    const { fixture, route, path } = await mounted({ admissionJudge: true })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SAFE_SUMMARY)
    expect(records(path)).toEqual([
      expect.objectContaining({ action: 'summarized', admission: 'not-applicable' }),
    ])
  })
})

describe('票 07 第 8 条：失效可见性', () => {
  it('同一会话内三类原因各提醒一条、文案互不相同、来源不是真实用户；同类不再重复', async () => {
    const notices: AppendedNotice[] = []
    const { fixture } = await mounted({}, [
      { text: UNCERTAIN },
      { error: 'boom' },
      { error: 'Context length exceeded: 40000 > 32768' },
      { text: UNCERTAIN },
    ])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    for (let index = 0; index < 4; index++) {
      await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    }

    expect(notices).toHaveLength(3)
    const texts = notices.map(notice => textOf(notice.message.content))
    expect(new Set(texts).size).toBe(3)
    expect(texts.some(text => text.includes('未能判定'))).toBe(true)
    expect(texts.some(text => text.includes('判断') && text.includes('失败'))).toBe(true)
    expect(texts.some(text => text.includes('窗口'))).toBe(true)
    for (const notice of notices) {
      expect(notice.type).toBe('user/message')
      expect(notice.message.source.kind).not.toBe('user')
      expect(notice.opts).toEqual({ surfaceOp: 'append' })
    }
  })

  it('失败策略为 block 时不发会话提醒（拦截本身在对话里可见）', async () => {
    const notices: AppendedNotice[] = []
    const { fixture } = await mounted({ failurePolicy: 'block' }, [{ text: UNCERTAIN }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(result.isError).toBe(true)
    expect(notices).toHaveLength(0)
  })

  it('关闭隐私开关后不再提醒：同一份真 profile 里关掉开关，下一条结果既不判断也不新增提醒', async () => {
    const fixture = await booted({
      summarize: false, privacyGate: true, privacyConfirmedLocal: true,
      routeProvider: 'mock', routeModel: 'mock',
    })
    const route = new FakeRoute([{ text: UNCERTAIN }])
    fixture.ctx.provide('llm', route as never)
    fixture.ctx.provide('spillStore', new FakeSpill() as never)
    const notices: AppendedNotice[] = []
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    expect(route.requests).toHaveLength(1)
    expect(notices).toHaveLength(1)

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['privacyGate'], value: false }])
    expect(fixture.config.privacyGate.get()).toBe(false)
    // 摘要能力也关着，所以这一条结果既不发请求、也不再提醒（取值回到 summary-off）。
    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    expect(route.requests).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })
})

describe('票 07 第 10 条：按入口读回的结果仍过隐私判断', () => {
  it('读回命中入口时跳过摘要，但仍发一次隐私判断请求、仍可被拦', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: SAFE }, { text: SENSITIVE }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(1)
    expect(textOf(first.content)).toContain(SAFE_SUMMARY)
    const locator = fixture.spill!.refs[0]!.locator

    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const read = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(route.requests).toHaveLength(2)
    expect(read.isError).toBe(true)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ toolName: 'read', action: 'rejected' }))
  })

  it('读回且判 safe 时跳过摘要（记 read-back），正文不被再次替换', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: SAFE }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    const locator = fixture.spill!.refs[0]!.locator

    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const read = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(route.requests).toHaveLength(2)
    expect(textOf(read.content)).toBe(LONG_BODY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ reason: 'read-back' }))
  })
})

describe('票 07 第 11 条：受控装载顺序的两种顺序', () => {
  /** 一个截断下游正文的受控监听器能保留多少字符。 */
  const LIMIT = 100

  /**
   * 按给定顺序装出夹具：`plugin-outer` 让截断监听器先注册（插件后注册＝外层），`plugin-inner` 相反。
   * @param order - 装载顺序。
   * @returns 夹具、假 route 与日志路径。
   */
  async function mountedInOrder(order: 'plugin-outer' | 'plugin-inner') {
    const path = join(tempRoot(), 'debug.jsonl')
    const route = new FakeRoute([{ text: SAFE_KEEP }])
    const config = {
      privacyGate: true, summarize: true, debug: true, debugPath: path,
      routeProvider: 'mock', routeModel: 'mock', privacyConfirmedLocal: true,
    } as Schemastery.TypeS<typeof Config>
    const truncate = truncatingListener(LIMIT)
    const fixture = await mount(
      config,
      order === 'plugin-outer' ? (ctx) => { ctx.on('tools/post-execute', truncate, { prepend: true }) } : undefined,
      route,
    )
    if (order === 'plugin-inner') fixture.ctx.on('tools/post-execute', truncate, { prepend: true })
    open.push(fixture)
    return { fixture, route, path }
  }

  it('常见顺序（本插件在 spill 外层）：判断对象是截断后的正文', async () => {
    const { fixture, route } = await mountedInOrder('plugin-outer')
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(route.requests).toHaveLength(1)
    const judged = requestText(route.requests[0]!)
    expect(judged).toContain('…[截断]')
    expect(judged).not.toContain(LONG_BODY)
  })

  it('相反顺序：不报错，判断对象退化为原文', async () => {
    const { fixture, route } = await mountedInOrder('plugin-inner')
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain(LONG_BODY)
  })
})

describe('票 07 第 12 条：隐私提示词可编辑，安全外壳与输出格式不可改', () => {
  it('默认用内置规则正文；配了规则正文就换成它，外壳与输出格式两种情况下逐字相同', async () => {
    const builtin = await mounted()
    builtin.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await builtin.fixture.ctx.tools.execute(exec('bash'))
    const builtinText = requestText(builtin.route.requests[0]!)
    expect(builtinText).toContain(DEFAULT_PRIVACY_RULE)
    expect(builtinText).toContain('privacyVerdict')

    const edited = await mounted({ privacyPrompt: '只看我定义的机密' })
    edited.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await edited.fixture.ctx.tools.execute(exec('bash'))
    const editedText = requestText(edited.route.requests[0]!)
    expect(editedText).toContain('只看我定义的机密')
    expect(editedText).not.toContain(DEFAULT_PRIVACY_RULE)
    // 外壳与输出格式由程序写死：可编辑段之后的部分两种情况下逐字相同。
    expect(editedText.split('只看我定义的机密')[1]).toBe(builtinText.split(DEFAULT_PRIVACY_RULE)[1])
  })
})

describe('票 09：隐私请求的「关闭推理」在无 off 档的 route 上重试一次', () => {
  it('隐私判断先被拒收、去掉 reasoningEffort 重发后得到 safe 结论并替换正文', async () => {
    const { fixture, route, path } = await mounted({}, [UNSUPPORTED_EFFORT_REPLY, { text: SAFE }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(route.requests[0]?.reasoningEffort).toBe('off')
    expect(route.requests[1]?.reasoningEffort).toBeUndefined()
    // 重发的是同一次隐私判断：判断对象仍是模型即将看到的正文投影。
    expect(requestText(route.requests[1]!)).toContain(LONG_BODY)
    expect(textOf(result.content)).toContain(SAFE_SUMMARY)
    expect(records(path)).toEqual([expect.objectContaining({ action: 'summarized' })])
  })
})
