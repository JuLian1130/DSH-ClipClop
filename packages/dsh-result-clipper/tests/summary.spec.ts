/**
 * 票 03 第 1–9 条：摘要最小闭环。
 *
 * 观察面只有两个：**工具执行的结果**（`ctx.tools.execute` 走完整个 post-execute 瀑布后模型拿到什么）与
 * **假 route 收到的请求**（`ctx.llm.stream` 的入参）。debug 取值从写出的 JSONL 读。每条阳性断言都要求
 * 假 route 真的收到过一次请求——否则「结果被改写」在「插件没发请求、下游监听器改的」下也可能为真。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { DEFAULT_SUMMARY_RULE } from '../src/summary.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { FakeRoute, requestText } from './support/route.ts'
import type { FakeReply } from './support/route.ts'

/** 刚过下限的正文：估价 = ceil(5000/4)+4，落在 `[1024, 12500)` 内。 */
const LONG_BODY = 'x'.repeat(5000)

/** 超过 `maxSummarizeTokens` 默认值的正文（估价 ≥ 12500）。 */
const HUGE_BODY = 'y'.repeat(52_000)

/** 摘要模型返回的一段短说明。 */
const SHORT_SUMMARY = '这是一段短说明'

/** 默认的摘要答复。 */
const REPLY = JSON.stringify({ action: 'summarize', summary: SHORT_SUMMARY })

const open: HostFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-summary-'))
  roots.push(root)
  return root
}

/**
 * 装一份夹具：开启 debug、配好主 route，并把假 route 放进 context。
 * @param overrides - 覆盖默认的插件配置。
 * @param script - 假 route 的答复脚本。
 * @returns 夹具、假 route 与 debug 日志路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: REPLY }],
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    { summarize: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock', ...overrides } as Schemastery.TypeS<typeof Config>,
    undefined,
    route,
  )
  open.push(fixture)
  return { fixture, route, path }
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

describe('票 03：三类工具的长文本结果被改写成短说明、只替换 content', () => {
  it.each(['bash', 'web_fetch', 'read'])('%s 的长文本结果被替换为短说明，且假 route 收到过一次请求', async (toolName) => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool(toolName, LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec(toolName))

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: SHORT_SUMMARY }])
    expect(route.requests).toHaveLength(1)
    expect(records(path)).toEqual([
      expect.objectContaining({ toolName, action: 'summarized' }),
    ])
  })

  it('只替换 content：下游附加上下文原样保留', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const attached = createUserMessage({ content: [{ type: 'text', text: 'attached context' }], source: { kind: 'user' } })
    fixture.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept', additionalContexts: [attached],
    }))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(result.content).toEqual([{ type: 'text', text: SHORT_SUMMARY }])
    expect(result.additionalContexts).toEqual([attached])
  })
})

describe('票 03：候选之外的结果与原样透传', () => {
  it('非目标工具的结果不摘要、不发请求（记 not-candidate）', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('grep', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('grep'))
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(0)
    expect(records(path)).toEqual([expect.objectContaining({ reason: 'not-candidate' })])
  })

  it('含图片等非文本块的结果透传、不发请求', async () => {
    const { fixture, route, path } = await mounted()
    const multimodal = [
      { type: 'text', text: LONG_BODY },
      { type: 'image', attachment: {} },
    ] as unknown as ContentBlock[]
    fixture.ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'bash', parameters: {},
      async execute(): Promise<ContentBlock[]> { return multimodal },
    }))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(0)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path)).toEqual([expect.objectContaining({ reason: 'not-candidate' })])
  })

  it('低于下限的结果原样保留、不发请求', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'short body'))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(result.content)).toBe('short body')
    expect(route.requests).toHaveLength(0)
    expect(records(path)).toEqual([expect.objectContaining({ reason: 'not-candidate' })])
  })

  it('bash / web_fetch 超过上限的结果交给 spill（不摘要、不发请求），read 不受上限约束', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', HUGE_BODY))
    const huge = await fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(huge.content)).toBe(HUGE_BODY)
    expect(route.requests).toHaveLength(0)

    fixture.ctx.tools.register(textTool('read', HUGE_BODY))
    const read = await fixture.ctx.tools.execute(exec('read'))
    expect(textOf(read.content)).toBe(SHORT_SUMMARY)
    expect(route.requests).toHaveLength(1)
  })
})

describe('票 03：摘要路径的失败一律原样透传且不抛出', () => {
  it('context 里没有 llm 服务（模型不可用）时透传并记 failed', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const fixture = await mount({
      summarize: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock',
    } as Schemastery.TypeS<typeof Config>)
    open.push(fixture)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'failed' }))
  })

  it('主 route 未配置时透传并记 failed（一次请求都不发）', async () => {
    const { fixture, route, path } = await mounted({ routeProvider: '', routeModel: '' })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(0)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ reason: 'failed' }))
  })

  it.each([
    ['调用失败', [{ error: 'boom' }]],
    ['空结果', [{ text: '' }]],
    ['非法结果', [{ text: 'not json' }]],
    ['形状非法的结果', [{ text: '{"action":"summarize","summary":null}' }]],
  ] as const)('%s 时透传并记 failed', async (_label, script) => {
    const { fixture, route, path } = await mounted({}, [...script])
    fixture.ctx.tools.register(textTool('web_fetch', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('web_fetch'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(1)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'failed' }))
  })

  it('请求被中止（超时走的就是这条 signal）时透传并记 failed', async () => {
    const { fixture, route, path } = await mounted({}, [{ hang: true }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const pending = fixture.ctx.tools.execute(exec('bash'))
    // 实现必须把请求的 signal 交给 route；没有它这条 await 会一直挂着，用例超时变红。
    await vi.waitFor(() => { expect(route.requests).toHaveLength(1) })
    route.requests[0]?.signal?.dispatchEvent(new Event('abort'))
    const result = await pending
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ reason: 'failed' }))
  })
})

describe("票 03：keep 与「没变短」", () => {
  it('模型返回 keep 时正文逐字不变，且不采用模型输出的任何正文', async () => {
    const { fixture, route, path } = await mounted(
      {},
      [{ text: JSON.stringify({ action: 'keep', summary: 'MODEL-SUPPLIED-BODY' }) }],
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(JSON.stringify(result.content)).not.toContain('MODEL-SUPPLIED-BODY')
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'kept' }))
  })

  it('摘要正文没比原文短时保留原文（本票只比摘要正文）', async () => {
    const { fixture, path } = await mounted({}, [{ text: JSON.stringify({ action: 'summarize', summary: 'z'.repeat(LONG_BODY.length) }) }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'not-shorter' }))
  })
})

describe('票 03：摘要请求的内容与形态', () => {
  it('请求含工具正文，且正文落在不可信数据的分隔标记内', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    const text = requestText(route.requests[0]!)
    expect(text).toContain(LONG_BODY)
    expect(text).toMatch(/<<<TOOL_RESULT>>>\n[\s\S]*<<<END_TOOL_RESULT>>>/)
  })

  it('提示词 = 内置规则正文 + 固定外壳；配置了规则正文就换成它（外壳与输出格式不变）', async () => {
    const builtin = await mounted()
    builtin.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await builtin.fixture.ctx.tools.execute(exec('bash'))
    const builtinText = requestText(builtin.route.requests[0]!)
    expect(builtinText).toContain(DEFAULT_SUMMARY_RULE)
    expect(builtinText).toContain('{"action":"summarize"|"keep","summary":string|null}')

    const edited = await mounted({ summaryPrompt: '只看目标与阻塞' })
    edited.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await edited.fixture.ctx.tools.execute(exec('bash'))
    const editedText = requestText(edited.route.requests[0]!)
    expect(editedText).toContain('只看目标与阻塞')
    expect(editedText).not.toContain(DEFAULT_SUMMARY_RULE)
    // 外壳与 schema 由程序写死：可编辑段之外的部分两种情况下逐字相同。
    expect(editedText.split('只看目标与阻塞')[1]).toBe(builtinText.split(DEFAULT_SUMMARY_RULE)[1])
  })

  it('默认关闭推理：请求显式带 off；关掉该开关则不传 reasoningEffort', async () => {
    const off = await mounted()
    off.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await off.fixture.ctx.tools.execute(exec('bash'))
    expect(off.route.requests[0]?.reasoningEffort).toBe('off')

    const on = await mounted({ summaryDisableReasoning: false })
    on.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await on.fixture.ctx.tools.execute(exec('bash'))
    expect(on.route.requests[0]?.reasoningEffort).toBeUndefined()
  })
})

describe('票 03：透传路径的结果取值互不相同', () => {
  it('非候选、keep、没变短、失败四条路径各留一条互不相同的结果取值', async () => {
    const reasons: unknown[] = []

    const skipped = await mounted()
    skipped.fixture.ctx.tools.register(textTool('grep', LONG_BODY))
    await skipped.fixture.ctx.tools.execute(exec('grep'))
    reasons.push(records(skipped.path).at(-1)?.reason)

    const kept = await mounted({}, [{ text: '{"action":"keep","summary":null}' }])
    kept.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await kept.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(kept.path).at(-1)?.reason)

    const shorter = await mounted({}, [{ text: JSON.stringify({ action: 'summarize', summary: 'z'.repeat(LONG_BODY.length) }) }])
    shorter.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await shorter.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(shorter.path).at(-1)?.reason)

    const failed = await mounted({}, [{ error: 'boom' }])
    failed.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await failed.fixture.ctx.tools.execute(exec('bash'))
    reasons.push(records(failed.path).at(-1)?.reason)

    expect(reasons).toEqual(['not-candidate', 'kept', 'not-shorter', 'failed'])
    expect(new Set(reasons).size).toBe(4)
  })
})
