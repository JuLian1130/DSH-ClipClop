/**
 * 票 08：三项全量闭合。它们只有在所有路径到位后才能断言，所以归在最后一张票。
 *
 * 1. **结果取值**：十一条已知路径各自产出**互不相同**的「动作 + 原因」取值，且每条都能在自己的 debug 记录
 *    里找到对应取值。断言方式是逐条路径取出它那条记录、与期望取值逐字段相等，再把全部取值放在一起查重。
 * 2. **debug 字段**：一条记录恰好是规格列出的七项（工具名、结果大小、准入结论、结果取值、调用耗时、缓存
 *    观测、判断器输入 token 数），且两个观测字段的读数与假 route 报告的用量对得上。
 * 3. **配置默认值**：schema 的逐字段默认、保存后立即生效、逐字段清掉覆盖后回落到底层默认。
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { mount, exec, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveConfig, LiveFixture } from './support/profile.ts'
import { FakeRoute } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 进得了摘要候选的正文（估价落在 `[1024, 12500)`）。 */
const LONG_BODY = 'x'.repeat(5000)

/** 低于摘要下限的正文。 */
const SHORT_BODY = 'short body'

/** 摘要模型交回的短说明。 */
const SUMMARY = '摘要正文-6c02'

/** 一条 `summarize` 的摘要答复。 */
const SUMMARY_REPLY = JSON.stringify({ action: 'summarize', summary: SUMMARY })

/** 一条 `keep` 答复。 */
const KEEP_REPLY = JSON.stringify({ action: 'keep', summary: null })

/** 判定敏感。 */
const SENSITIVE = JSON.stringify({ privacyVerdict: 'sensitive', action: 'summarize', summary: '不该采用' })

/** 未能判定。 */
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-closure-'))
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

/** 读回一整份 JSONL，逐行解析。 */
function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 一条已知路径取出的「结果取值」：动作 + 未改动原因。 */
interface Outcome {
  readonly action: unknown
  readonly reason?: unknown
}

/** 一条已知路径：它怎么搭、期望产出什么取值。 */
interface Scenario {
  readonly name: string
  /** 这条路径被测调用的工具名：用来确认取到的是它自己那条记录。 */
  readonly tool: string
  readonly expected: Outcome
  run(): Promise<Outcome>
}

/** 一条路由配置的公共前缀：主 route 与 debug 就位，其余按路径需要补。 */
function base(path: string): Schemastery.TypeS<typeof Config> {
  return { routeProvider: 'local', routeModel: 'qwen', debug: true, debugPath: path }
}

/**
 * 装着 debug 日志的十一个夹具，每条已知路径一个：各自独立挂载、互不共享台账。
 * @returns 场景清单。
 */
function scenarios(): readonly Scenario[] {
  /** 每个场景一个新的日志路径。 */
  const paths = (): string => join(tempRoot(), 'debug.jsonl')

  /** 取出最后一条记录的取值，并核对它属于期望的工具。 */
  const lastOutcome = (path: string, tool: string): Outcome => {
    const records = readRecords(path)
    const last = records[records.length - 1]
    if (last === undefined) throw new Error(`fixture: no debug record at ${path}`)
    expect(last.toolName).toBe(tool)
    return last.reason === undefined ? { action: last.action } : { action: last.action, reason: last.reason }
  }

  return [
    {
      name: '已替换',
      tool: 'bash',
      expected: { action: 'summarized' },
      run: async () => {
        const path = paths()
        const fixture = await mounted({ ...base(path), summarize: true }, new FakeRoute([{ text: SUMMARY_REPLY }]))
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '已拦截',
      tool: 'bash',
      expected: { action: 'rejected' },
      run: async () => {
        const path = paths()
        const fixture = await mounted(
          { ...base(path), summarize: true, privacyGate: true, privacyConfirmedLocal: true },
          new FakeRoute([{ text: SENSITIVE }]),
        )
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '准入判 no',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'admission-no' },
      run: async () => {
        const path = paths()
        const fixture = await mounted(
          { ...base(path), summarize: true, admissionJudge: true },
          new FakeRoute([{ text: 'no' }]),
        )
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '模型要求保留全文',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'kept' },
      run: async () => {
        const path = paths()
        const fixture = await mounted({ ...base(path), summarize: true }, new FakeRoute([{ text: KEEP_REPLY }]))
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '按入口读回',
      tool: 'read',
      expected: { action: 'unmodified', reason: 'read-back' },
      run: async () => {
        const path = paths()
        const fixture = await mounted({ ...base(path), summarize: true }, new FakeRoute([{ text: SUMMARY_REPLY }]))
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        fixture.ctx.tools.register(textTool('read', '原文'))
        await fixture.ctx.tools.execute(exec('bash'))
        // 第一次替换写出的入口就是 `/spill/bash.txt`（假后端的形状）；按它读回即命中读回识别。
        await fixture.ctx.tools.execute(exec('read', undefined, { file_path: '/spill/bash.txt' }))
        return lastOutcome(path, 'read')
      },
    },
    {
      name: '摘要没变短',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'not-shorter' },
      run: async () => {
        const path = paths()
        const body = 'y'.repeat(400)
        const fixture = await mounted(
          // 下限放到 0 让短正文进候选，摘要与原文同长即触发「含入口说明不短于原文」的透传。
          { ...base(path), summarize: true, minInlineTokens: 0 },
          new FakeRoute([{ text: JSON.stringify({ action: 'summarize', summary: 'z'.repeat(400) }) }]),
        )
        fixture.ctx.tools.register(textTool('bash', body))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '未进入候选',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'not-candidate' },
      run: async () => {
        const path = paths()
        const fixture = await mounted({ ...base(path), summarize: true }, new FakeRoute([{ text: SUMMARY_REPLY }]))
        fixture.ctx.tools.register(textTool('bash', SHORT_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '未判定放行',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'uncertain' },
      run: async () => {
        const path = paths()
        const fixture = await mounted(
          { ...base(path), summarize: true, privacyGate: true, privacyConfirmedLocal: true },
          new FakeRoute([{ text: UNCERTAIN }]),
        )
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '摘要关闭',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'summary-off' },
      run: async () => {
        const path = paths()
        const fixture = await mounted({ ...base(path), summarize: false })
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '普通失败',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'failed' },
      run: async () => {
        const path = paths()
        // 没有 `llm` 服务：候选命中后摘要路径失败。
        const fixture = await mounted({ ...base(path), summarize: true })
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
    {
      name: '窗口不足',
      tool: 'bash',
      expected: { action: 'unmodified', reason: 'failed-window' },
      run: async () => {
        const path = paths()
        const fixture = await mounted(
          { ...base(path), summarize: true, privacyGate: true, privacyConfirmedLocal: true },
          new FakeRoute([{ error: 'Context length exceeded: 40000 > 32768' }]),
        )
        fixture.ctx.tools.register(textTool('bash', LONG_BODY))
        await fixture.ctx.tools.execute(exec('bash'))
        return lastOutcome(path, 'bash')
      },
    },
  ]
}

describe('票 08 全量闭合一：上述已知路径的取值互不相同，且每条都能找到', () => {
  it('十一条路径逐条产出各自的取值，全部取值放进一张表里两两不重合', async () => {
    const seen = new Map<string, string>()
    for (const scenario of scenarios()) {
      const outcome = await scenario.run()
      // 每条路径都能找到**对应**取值：不是「有条记录」，而是这条记录正好是期望的那一个。
      expect(outcome, `${scenario.name} 的取值`).toEqual(scenario.expected)
      const key = outcome.reason === undefined ? String(outcome.action) : `${String(outcome.action)}/${String(outcome.reason)}`
      expect(seen.has(key), `取值 ${key} 与「${seen.get(key)}」重合，两条路径分不开`).toBe(false)
      seen.set(key, scenario.name)
    }
    // 取值域闭合：概览里既不能少一条已知路径，也不能多出没人认领的取值。
    expect([...seen.keys()].sort()).toEqual([
      'rejected',
      'summarized',
      'unmodified/admission-no',
      'unmodified/failed',
      'unmodified/failed-window',
      'unmodified/kept',
      'unmodified/not-candidate',
      'unmodified/not-shorter',
      'unmodified/read-back',
      'unmodified/summary-off',
      'unmodified/uncertain',
    ])
  })
})

describe('票 08 全量闭合二：debug 字段齐全', () => {
  it('一次完整摘要的记录恰好是七项，两个观测字段与假 route 报告的用量对得上', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    // 第一段是准入判断（yes），第二段是摘要；两段都带用量，且第二段命中前缀缓存。
    const route = new FakeRoute([
      { text: 'yes', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 40, cacheWriteTokens: 7 } },
      { text: SUMMARY_REPLY, usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 200 } },
    ])
    const fixture = await mounted(
      { ...base(path), summarize: true, admissionJudge: true }, route,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    const [record] = readRecords(path)
    expect(Object.keys(record!).sort()).toEqual([
      'action', 'admission', 'cacheObservation', 'durationMs', 'judgeInputTokens', 'resultBytes', 'toolName',
    ])
    expect(record).toEqual({
      toolName: 'bash',
      resultBytes: Buffer.byteLength(LONG_BODY, 'utf8'),
      admission: 'yes',
      durationMs: expect.any(Number),
      // 缓存观测＝这次结果各次请求里命中的前缀缓存之和（准入 40 + 摘要 200）。
      cacheObservation: 240,
      // 判断器输入 token 数＝准入那次请求的输入规模（未缓存 + 缓存读 + 缓存写）。
      judgeInputTokens: 147,
      action: 'summarized',
    })
  })

  it('没发任何模型请求的记录同样七项齐全，两个观测字段是「没有观测」的取值', async () => {
    const path = join(tempRoot(), 'debug.jsonl')
    const fixture = await mounted({ summarize: false, debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', SHORT_BODY))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        toolName: 'bash',
        resultBytes: Buffer.byteLength(SHORT_BODY, 'utf8'),
        admission: 'not-applicable',
        durationMs: expect.any(Number),
        cacheObservation: 0,
        judgeInputTokens: null,
        action: 'unmodified',
        reason: 'summary-off',
      }),
    ])
  })
})

describe('票 08 全量闭合三：配置默认值、保存即生效与逐字段恢复默认', () => {
  /** 每个字段的 schema 默认（与 `design.md`「配置面与设置座位」的可配清单一一对应）。 */
  const defaults: Record<keyof LiveConfig, unknown> = {
    summarize: false,
    privacyGate: false,
    admissionJudge: false,
    debug: false,
    dryRun: false,
    debugPath: '',
    routeProvider: '',
    routeModel: '',
    admissionProvider: '',
    admissionModel: '',
    privacyProvider: '',
    privacyModel: '',
    minInlineTokens: 1024,
    maxSummarizeTokens: 12500,
    summaryReasoningEffort: 'off',
    admissionReasoningEffort: 'off',
    privacyReasoningEffort: 'off',
    privacyConfirmedLocal: false,
    failurePolicy: 'passthrough',
    summaryPrompt: '',
    admissionPrompt: '',
    privacyPrompt: '',
  }

  /** 每个字段的显式覆盖值：布尔取反、数字换值、字符串非空、策略取另一支。 */
  const overrides: Record<keyof LiveConfig, unknown> = {
    summarize: true,
    privacyGate: true,
    admissionJudge: true,
    debug: true,
    dryRun: true,
    debugPath: '/tmp/closure.jsonl',
    routeProvider: 'local',
    routeModel: 'qwen',
    admissionProvider: 'local',
    admissionModel: 'small',
    privacyProvider: 'local-guard',
    privacyModel: 'guard',
    minInlineTokens: 256,
    maxSummarizeTokens: 9000,
    summaryReasoningEffort: 'medium',
    admissionReasoningEffort: 'low',
    privacyReasoningEffort: 'high',
    privacyConfirmedLocal: true,
    failurePolicy: 'block',
    summaryPrompt: '只看目标',
    admissionPrompt: '只看体积',
    privacyPrompt: '只看我定义的机密',
  }

  /** 字段名清单：默认、覆盖、恢复默认三轮共用同一份，少一个字段就少一列断言。 */
  const fields = Object.keys(defaults) as Array<keyof LiveConfig>

  /** 一条字段的当前读数。 */
  const read = (fixture: LiveFixture, field: keyof LiveConfig): unknown => fixture.config[field].get()

  it('schema 的逐字段默认值正确', async () => {
    const fixture = await bootProfile({})
    live.push(fixture)
    for (const field of fields) expect(read(fixture, field), field).toBe(defaults[field])
  })

  it('逐字段写入后立刻读得到，逐字段清掉覆盖后回落到底层默认', async () => {
    const fixture = await bootProfile({})
    live.push(fixture)

    await fixture.ctx.settings.mutate(
      PREFERENCE_NAMESPACE,
      fields.map(field => ({ op: 'set' as const, path: [field], value: overrides[field] })),
    )
    for (const field of fields) expect(read(fixture, field), `${field} 写入后`).toBe(overrides[field])

    await fixture.ctx.settings.mutate(
      PREFERENCE_NAMESPACE,
      fields.map(field => ({ op: 'unset' as const, path: [field] })),
    )
    for (const field of fields) expect(read(fixture, field), `${field} 恢复默认后`).toBe(defaults[field])
  })
})
