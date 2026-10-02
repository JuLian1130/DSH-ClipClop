/**
 * 票 08：干跑。
 *
 * 观察面分四处：**工具执行的最终正文**（干跑一个字都不该改）、**假 route 收到的请求**（完整流水线照走）、
 * **会话 append 的事件与假 spill 的写入**（干跑的副作用必须为零）、**写出的 debug JSONL**（「本应发生什么」
 * 的预报与 `dryRun` 标记）。每条「不产生副作用」的断言都配阳性对照：同一份夹具只把干跑关掉，副作用就出现。
 *
 * 「不写 memo」的写入侧只能在**同一份插件实例**里翻开关才可观察（干跑不写 → 随后真实运行仍重新发请求），
 * 所以这一条走真 profile；翻开关用的是 settings 的 volatile 写回，顺带证明干跑开关本身保存即生效。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { AppendedNotice, HostFixture } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'
import { FakeRoute } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 超过摘要下限、低于上限的正文：隐私关闭时本来会被摘要替换。 */
const LONG_BODY = 'x'.repeat(5000)

/** 摘要模型交回的短说明；它是「本应替换」的对象，也是禁写约束里的哨兵。 */
const SUMMARY = '摘要正文-SENTINEL-4f81'

/** 一条 `summarize` 的摘要答复（正文是 {@link SUMMARY}）。 */
const SUMMARY_REPLY = JSON.stringify({ action: 'summarize', summary: SUMMARY })

/** 隐私判定敏感的合并答复。 */
const SENSITIVE = JSON.stringify({ privacyVerdict: 'sensitive', action: 'summarize', summary: '不该采用' })

/** 未能判定的合并答复：按失败策略放行原文。 */
const UNCERTAIN = JSON.stringify({ privacyVerdict: 'uncertain', action: 'summarize', summary: '不该采用' })

/** 隐私判 `safe` 且要求摘要的合并答复。 */
const SAFE = JSON.stringify({ privacyVerdict: 'safe', action: 'summarize', summary: SUMMARY })

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-dry-'))
  roots.push(root)
  return root
}

/** 装一份被测插件并登记收场。 */
async function mounted(
  config: Schemastery.TypeS<typeof Config>,
  route?: FakeRoute,
  spill: FakeSpill | null = new FakeSpill(),
): Promise<HostFixture> {
  const fixture = await mount(config, undefined, route, spill)
  open.push(fixture)
  return fixture
}

/** 装一条 profile 并登记收场。 */
async function booted(config: Record<string, unknown>, route?: FakeRoute): Promise<LiveFixture> {
  const fixture = await bootProfile(config, route)
  live.push(fixture)
  return fixture
}

/** 读回一整份 JSONL，逐行解析。 */
function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('票 08 第 1 条：干跑要求 debug 开关与日志路径都就位', () => {
  it('两者都就位时干跑生效：正文逐字不变，且写出一行带 dryRun 标记的预报', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const fixture = await mounted({ summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ toolName: 'bash', action: 'summarized', dryRun: true }),
    ])
  })

  it('debug 关闭时干跑不生效：同一份夹具只把 debug 关掉，正文就被替换且不写盘', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const fixture = await mounted({ summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: false, debugPath: path, dryRun: true }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    // 干跑不生效＝照常替换（这正是页面提示要挡住的那件事）；debug 关闭时照旧零写盘。
    expect(textOf(result.content)).toContain(SUMMARY)
    expect(existsSync(path)).toBe(false)

    // 阳性对照：同一份夹具只把 debug 打开，干跑就生效、正文不再被替换。
    const dryPath = join(tempRoot(), 'dry.jsonl')
    const dryRoute = new FakeRoute([{ text: SUMMARY_REPLY }])
    const dry = await mounted({ summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: dryPath, dryRun: true }, dryRoute)
    dry.ctx.tools.register(textTool('bash', LONG_BODY))
    const kept = await dry.ctx.tools.execute(exec('bash'))
    expect(textOf(kept.content)).toBe(LONG_BODY)
  })

  it('日志路径为空时干跑不生效：正文被替换（不回退到任何默认路径）', async () => {
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const fixture = await mounted({ summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: '', dryRun: true }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(result.content)).toContain(SUMMARY)
  })
})

describe('票 08 第 2 条：干跑走完整流水线但不产生副作用', () => {
  it('流水线照走：隐私判断与摘要请求都发出（请求数与真实运行相同），只有正文不被替换', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const route = new FakeRoute([{ text: SAFE }])
    const fixture = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true,
    }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toBe(LONG_BODY)

    // 阳性对照：同一份夹具把干跑关掉，同一条流水线这次真的替换。
    const realRoute = new FakeRoute([{ text: SAFE }])
    const real = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: join(tempRoot(), 'real.jsonl'),
    }, realRoute)
    real.ctx.tools.register(textTool('bash', LONG_BODY))
    const replaced = await real.ctx.tools.execute(exec('bash'))
    expect(realRoute.requests).toHaveLength(1)
    expect(textOf(replaced.content)).toContain(SUMMARY)
  })

  it('不 append 会话事件：隐私未判定放行时干跑不提醒；关掉干跑后同一条失效照常提醒一条', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const notices: AppendedNotice[] = []
    const fixture = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true,
    }, new FakeRoute([{ text: UNCERTAIN }]))
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))

    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(notices).toHaveLength(0)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'uncertain', dryRun: true }),
    ])

    // 阳性对照：同一份夹具只把干跑关掉，这次放行就带走一条会话提醒。
    const realNotices: AppendedNotice[] = []
    const real = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: join(tempRoot(), 'real.jsonl'),
    }, new FakeRoute([{ text: UNCERTAIN }]))
    real.ctx.tools.register(textTool('bash', LONG_BODY))
    await real.ctx.tools.execute(exec('bash', undefined, {}, 's1', realNotices))
    expect(realNotices).toHaveLength(1)
  })

  it('不调用存储：干跑一次 saveText 都不发；关掉干跑后同一条结果写一次', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const drySpill = new FakeSpill()
    const fixture = await mounted(
      { summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true }, new FakeRoute([{ text: SUMMARY_REPLY }]), drySpill,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(drySpill.saves).toHaveLength(0)

    const realSpill = new FakeSpill()
    const real = await mounted(
      { summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: join(tempRoot(), 'real.jsonl') },
      new FakeRoute([{ text: SUMMARY_REPLY }]), realSpill,
    )
    real.ctx.tools.register(textTool('bash', LONG_BODY))
    await real.ctx.tools.execute(exec('bash'))
    expect(realSpill.saves).toHaveLength(1)
  })

  it('干跑不写 memo：同一工具同一正文连续两次干跑各发一次请求；关掉干跑后仍重新发请求', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const fixture = await booted({
      summarize: true, minInlineTokens: 0, privacyGate: false,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true,
    }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    await fixture.ctx.tools.execute(exec('bash'))
    // 干跑既不写 memo 也不查它：第二次仍走完整流水线（若写了 memo，第二次会命中、请求数停在 1）。
    expect(route.requests).toHaveLength(2)

    // 写入侧：关掉干跑后同一条正文再跑一次仍必须重新发请求（若干跑写过 memo，这里会命中、请求数停在 2）。
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['dryRun'], value: false }])
    expect(fixture.config.dryRun.get()).toBe(false)
    await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(3)
  })

  it('干跑不占用失效提醒的名额：干跑时未判定放行不提醒，关掉干跑后同一条失效仍能得到提醒', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const notices: AppendedNotice[] = []
    const fixture = await booted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true,
    }, new FakeRoute([{ text: UNCERTAIN }]))
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    expect(notices).toHaveLength(0)

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['dryRun'], value: false }])
    await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's1', notices))
    // 干跑没把「未判定」记进提醒台账，所以真实运行这次仍拿得到一条；若干跑记了台账，这里会是 0 条。
    expect(notices).toHaveLength(1)
  })
})

describe('票 08 第 3 条：干跑在 debug 日志里写出本应发生什么', () => {
  it('本应替换：记录动作 summarized + dryRun 标记，正文与存储都不动', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const spill = new FakeSpill()
    const fixture = await mounted(
      { summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true }, new FakeRoute([{ text: SUMMARY_REPLY }]), spill,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(spill.saves).toHaveLength(0)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'summarized', dryRun: true }),
    ])
  })

  it('本应拦截：记录动作 rejected + dryRun 标记，模型看到的仍是原文（不是拒绝文案）', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const fixture = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true,
    }, new FakeRoute([{ text: SENSITIVE }]))
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'rejected', dryRun: true }),
    ])

    // 阳性对照：同一份夹具关掉干跑，这次真的拦下。
    const real = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: join(tempRoot(), 'real.jsonl'),
    }, new FakeRoute([{ text: SENSITIVE }]))
    real.ctx.tools.register(textTool('bash', LONG_BODY))
    const blocked = await real.ctx.tools.execute(exec('bash'))
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked.content)).toContain('不要重试')
  })

  it('本应跳过及原因：非候选记 not-candidate、未判定放行记 uncertain，两条都带 dryRun 标记', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const short = await mounted({ summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true })
    short.ctx.tools.register(textTool('bash', 'short body'))
    await short.ctx.tools.execute(exec('bash'))

    const uncertainPath = join(tempRoot(), 'uncertain.jsonl')
    const uncertain = await mounted({
      summarize: true, privacyGate: true, routeConfirmedLocal: true,
      routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: uncertainPath, dryRun: true,
    }, new FakeRoute([{ text: UNCERTAIN }]))
    uncertain.ctx.tools.register(textTool('bash', LONG_BODY))
    await uncertain.ctx.tools.execute(exec('bash'))

    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'not-candidate', dryRun: true }),
    ])
    expect(readRecords(uncertainPath)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'uncertain', dryRun: true }),
    ])
  })
})

describe('票 08 第 4 条：干跑记录受同一条禁写约束', () => {
  it('「本应替换」只记动作与原因：记录里没有摘要正文、没有原文，也没有入口 locator', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const spill = new FakeSpill()
    const fixture = await mounted(
      { summarize: true, routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path, dryRun: true },
      new FakeRoute([{ text: SUMMARY_REPLY }]), spill,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain(SUMMARY)
    expect(raw).not.toContain('x'.repeat(64))
    // 入口由 `saveText` 产生、干跑不调用它，所以记录里也不可能出现接口 locator。
    expect(raw).not.toContain('/spill/')
    expect(readRecords(path)[0]).toEqual(expect.objectContaining({ action: 'summarized', dryRun: true }))
  })
})
