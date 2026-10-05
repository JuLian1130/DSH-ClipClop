/**
 * 票 04 第 1–9 条：原结果入口与读回识别。
 *
 * 观察面：**工具执行的结果**（模型最终看到什么）、**假 route 的请求数**（跳过摘要路径要能被看见，不能只断言
 * 正文没变）、**假 spill 后端收到的 `saveText` 入参**（完整正文、会话归属、工具来源）与 **debug JSONL 的
 * 结果取值**。替换后的文本断言用 `摘要 + composeEntry(后端返回值, 工具名)`——入口说明是**摘要之后的兜底段**。
 *
 * 每条判据都配阳性对照：凡「没写盘 / 没发请求 / 没摘要」的断言，同文件里都有一条证明同一路径在条件改变后
 * 会写盘、会发请求。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { composeEntry } from '../src/entry.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { FakeRoute } from './support/route.ts'
import type { FakeReply } from './support/route.ts'
import { FakeSpill, RETRIEVAL_HINT } from './support/spill.ts'

/** 刚过摘要下限的正文：估价 ≥ 1024 个单位，且远大于入口说明的预留上界。 */
const LONG_BODY = 'x'.repeat(5000)

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-entry-'))
  roots.push(root)
  return root
}

/**
 * 装一份夹具：开启 debug、配好摘要 route，并把假 route 与假 spill 后端放进 context。
 * @param overrides - 覆盖默认的插件配置。
 * @param script - 假 route 的答复脚本。
 * @param spill - 假 spill 后端；显式传 `null` 表示 context 里没有后端。
 * @returns 夹具、假 route 与 debug 日志路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: REPLY }],
  spill: FakeSpill | null = new FakeSpill(),
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    { summarize: true, ruleSummary: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock', ...overrides } as Schemastery.TypeS<typeof Config>,
    undefined,
    route,
    spill,
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

describe('票 04 第 1 条：替换前把完整正文写入存储', () => {
  it('写一次存储：完整正文 + 会话归属 + 工具来源与调用 id', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    // 阳性对照：先坐实这条结果真的走了摘要路径（否则「写过一次」可能来自别的分支）。
    expect(route.requests).toHaveLength(1)
    expect(fixture.spill!.saves).toEqual([{
      owner: { sessionId: 's1' },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-bash', label: 'result' },
      suggestedName: 'bash.txt',
      content: LONG_BODY,
    }])
    expect(textOf(result.content)).toBe(SHORT_SUMMARY + composeEntry(fixture.spill!.refs[0]!, 'bash'))
  })
})

describe('票 04 第 2 条：存储不可用或写入失败时透传且不留入口', () => {
  it('context 里没有 spill 后端时原样透传、不留入口', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: REPLY }], null)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(route.requests).toHaveLength(1)
    expect(records(path).at(-1)).toMatchObject({ action: 'unmodified', reason: 'failed' })
  })

  it('saveText 失败时原样透传、不留入口', async () => {
    const { fixture, path } = await mounted()
    fixture.spill!.fail = true
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(fixture.spill!.saves).toHaveLength(0)
    expect(records(path).at(-1)).toMatchObject({ action: 'unmodified', reason: 'failed' })
  })
})

describe('票 04 第 3、4 条：入口说明的形状与位置', () => {
  it('摘要正文在最前、入口说明是它之后的兜底段（含 locator、取回方法与「够用就不必再读」）', async () => {
    const { fixture } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    const ref = fixture.spill!.refs[0]!
    expect(ref.retrievalHint).toBe(RETRIEVAL_HINT)
    const content = textOf(result.content)
    expect(content).toContain(ref.locator)
    expect(content).toContain(ref.retrievalHint)
    // 模型读到的第一段必须是摘要本身，不再是一条可读路径加一句祈使句。
    expect(content.startsWith(SHORT_SUMMARY)).toBe(true)
    expect(content.indexOf(SHORT_SUMMARY)).toBeLessThan(content.indexOf(ref.locator))
    expect(content.indexOf(ref.locator)).toBeLessThan(content.indexOf(ref.retrievalHint))
    // 兜底段自报身份与用途：说是本次结果的摘要、够用就不必再读、需要逐字核对时才取。
    expect(content).toContain('以上为本次 bash 结果的摘要')
    expect(content).toContain('够用就不必再读')
    expect(content.endsWith('）')).toBe(true)
  })

  it('摘要输出受固定的 512 token 上限约束（总长留在 8192 字符阈值内）', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    // 总长这一半由固定的输出上限兑现：正文最多 512 token（≈2048 字符）加入口说明，远低于裁剪器阈值 8192。
    expect(route.requests[0]?.maxTokens).toBe(512)
  })
})

describe('票 04 第 5 条：含入口说明的长度比较发生在写盘之前（裁决 A）', () => {
  it('摘要 + 入口预留不短于原文时不写盘、正文逐字不变；严格更短才写盘一次', async () => {
    // 只短 1 个字符：把入口说明算作 0 长也该写盘，所以这一臂钉住「比较必须计入入口说明的预留上界」。
    const nearly = 'z'.repeat(LONG_BODY.length - 1)
    const tight = await mounted({}, [{ text: JSON.stringify({ action: 'summarize', summary: nearly }) }])
    tight.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const kept = await tight.fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(kept.content)).toBe(LONG_BODY)
    expect(tight.fixture.spill!.saves).toHaveLength(0)
    expect(records(tight.path).at(-1)).toMatchObject({ action: 'unmodified', reason: 'not-shorter' })

    // 阳性对照：同一条正文换一段真正短的摘要就写盘一次——证明上一条不是「后端根本没接上」。
    const shorter = await mounted()
    shorter.fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const replaced = await shorter.fixture.ctx.tools.execute(exec('bash'))
    expect(shorter.fixture.spill!.saves).toHaveLength(1)
    expect(textOf(replaced.content)).toBe(SHORT_SUMMARY + composeEntry(shorter.fixture.spill!.refs[0]!, 'bash'))
  })
})

describe('票 04 第 6 条：keep 的正文不写存储', () => {
  it('模型要求保留全文时正文逐字不变、一次写盘都不发生', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: '{"action":"keep","summary":null}' }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(fixture.spill!.saves).toHaveLength(0)
    expect(records(path).at(-1)).toMatchObject({ action: 'unmodified', reason: 'kept' })
  })
})

describe('票 04 第 7、8 条：按入口读回跳过整个摘要路径', () => {
  it('read 的路径命中本会话写出的 locator 时不再摘要，debug 记 read-back', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    const locator = fixture.spill!.refs[0]!.locator
    expect(route.requests).toHaveLength(1)

    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const read = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(read.isError).toBe(false)
    expect(textOf(read.content)).toBe(LONG_BODY)
    // 整条摘要路径被跳过：既不再次摘要（零新请求），也不留下第二份存储副本。
    expect(route.requests).toHaveLength(1)
    expect(fixture.spill!.saves).toHaveLength(1)
    expect(records(path).at(-1)).toMatchObject({ toolName: 'read', action: 'unmodified', reason: 'read-back' })

    // 阳性对照：同一条 read 换成别的路径就照常摘要——证明上一条不是「read 从不进摘要路径」。
    const other = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: '/tmp/other.txt' }))
    expect(route.requests).toHaveLength(2)
    expect(textOf(other.content)).toBe(SHORT_SUMMARY + composeEntry(fixture.spill!.refs[1]!, 'read'))
  })
})

describe('票 04 第 9 条：会话失效后同一路径按普通 read 处理', () => {
  it('fork 出的新会话与重启后的新插件都不带旧台账，同一入口会被再摘要一次', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    const locator = fixture.spill!.refs[0]!.locator

    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(route.requests).toHaveLength(1)

    // fork：新会话 id 的台账是空的，同一入口不再被认成读回。
    const forked = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }, 's2'))
    expect(route.requests).toHaveLength(2)
    expect(textOf(forked.content)).toBe(SHORT_SUMMARY + composeEntry(fixture.spill!.refs[1]!, 'read'))

    // 重启：新装一份插件（进程重启的等价物），同一路径同样按普通 read 处理。
    const restarted = await mounted()
    restarted.fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const again = await restarted.fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    expect(restarted.route.requests).toHaveLength(1)
    expect(textOf(again.content)).toBe(SHORT_SUMMARY + composeEntry(restarted.fixture.spill!.refs[0]!, 'read'))
  })
})
