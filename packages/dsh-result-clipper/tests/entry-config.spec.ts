/**
 * 票 02 第 1、2 条：插件入口与配置契约。
 *
 * 判据要对上配置契约（摘要默认开启、隐私闸门默认关闭）与「设置页保存即生效」的 host 半：字段都是 volatile
 * 引用，装载后按
 * `.get()` 读到的就是当前值——这正是「不需要重启」的实现方式。观察面是 `fiber.config`（装载期解析结果），
 * 不是包内函数。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { Config, inject, name } from '../src/index.ts'
import { CONDENSE_DEFAULTS } from '../src/condense.ts'
import { exec, textOf, textTool } from './support/host.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/**
 * 装载被测插件（先装好它 inject 的工具运行时与 systemPrompt）。
 * @param config - 装载配置。
 * @returns fiber 与 rejection 的原因；装载成功时原因为 `undefined`。
 */
async function load(config: Schemastery.TypeS<typeof Config>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin(plugin, config)
  const error = await fiber.then(() => undefined, (reason: unknown) => reason)
  return { ctx, fiber, error }
}

describe('插件入口', () => {
  it('具名导出 name、inject、Config、apply', () => {
    expect(name).toBe('dsh-result-clipper')
    expect(typeof plugin.apply).toBe('function')
    expect(Config).toBeDefined()
    // 监听 tools/post-execute 的插件要等工具运行时在场。
    expect(inject).toContain('tools')
  })
})

describe('配置契约', () => {
  it('默认配置合法且可装载：摘要默认开启，隐私闸门与 debug、干跑默认关闭，路径为空，route/阈值/提示词取默认', async () => {
    const { fiber, error } = await load({})
    expect(error).toBeUndefined()
    // 摘要默认开启；默认只摘要主模型主动请求摘要的那些结果（下面的 ruleSummary 关着）。
    expect(fiber.config?.summarize.get()).toBe(true)
    expect(fiber.config?.privacyGate.get()).toBe(false)
    // 规则摘要默认关闭：默认只摘要主模型主动请求摘要的调用（提取路径不受它影响）。
    expect(fiber.config?.ruleSummary.get()).toBe(false)
    expect(fiber.config?.admissionJudge.get()).toBe(false)
    expect(fiber.config?.debug.get()).toBe(false)
    expect(fiber.config?.debugPath.get()).toBe('')
    expect(fiber.config?.dryRun.get()).toBe(false)
    expect(fiber.config?.routeProvider.get()).toBe('')
    expect(fiber.config?.routeModel.get()).toBe('')
    expect(fiber.config?.admissionProvider.get()).toBe('')
    expect(fiber.config?.admissionModel.get()).toBe('')
    expect(fiber.config?.privacyProvider.get()).toBe('')
    expect(fiber.config?.privacyModel.get()).toBe('')
    expect(fiber.config?.minInlineTokens.get()).toBe(512)
    expect(fiber.config?.maxSummarizeTokens.get()).toBe(12500)
    // 档位留空＝「不推理」，具体发哪个 id 由该 route 的档位表在请求前决定。
    expect(fiber.config?.summaryReasoningEffort.get()).toBe('')
    expect(fiber.config?.admissionReasoningEffort.get()).toBe('')
    expect(fiber.config?.privacyReasoningEffort.get()).toBe('')
    expect(fiber.config?.summaryPrompt.get()).toBe('')
    expect(fiber.config?.admissionPrompt.get()).toBe('')
    expect(fiber.config?.privacyPrompt.get()).toBe('')
    // 隐私的确认位与失败策略：默认未确认、默认放行。
    expect(fiber.config?.privacyConfirmedLocal.get()).toBe(false)
    expect(fiber.config?.failurePolicy.get()).toBe('passthrough')
  })

  it('显式取值覆盖默认值（volatile 引用，装载后按它读）', async () => {
    const { fiber } = await load({ summarize: true, debug: true, debugPath: '/tmp/result-clipper.jsonl', dryRun: true })
    expect(fiber.config?.summarize.get()).toBe(true)
    expect(fiber.config?.debug.get()).toBe(true)
    expect(fiber.config?.debugPath.get()).toBe('/tmp/result-clipper.jsonl')
    expect(fiber.config?.dryRun.get()).toBe(true)
    expect(fiber.config?.privacyGate.get()).toBe(false)

    const rulesOn = await load({ ruleSummary: true })
    expect(rulesOn.fiber.config?.ruleSummary.get()).toBe(true)

    const tuned = await load({
      routeProvider: 'local', routeModel: 'qwen', minInlineTokens: 0,
      maxSummarizeTokens: 9000, summaryReasoningEffort: 'medium', summaryPrompt: '只看目标',
    })
    expect(tuned.fiber.config?.routeProvider.get()).toBe('local')
    expect(tuned.fiber.config?.routeModel.get()).toBe('qwen')
    expect(tuned.fiber.config?.minInlineTokens.get()).toBe(0)
    expect(tuned.fiber.config?.maxSummarizeTokens.get()).toBe(9000)
    expect(tuned.fiber.config?.summaryReasoningEffort.get()).toBe('medium')
    expect(tuned.fiber.config?.summaryPrompt.get()).toBe('只看目标')

    const admitted = await load({
      admissionJudge: true, admissionProvider: 'local', admissionModel: 'small',
      admissionReasoningEffort: 'minimal', admissionPrompt: '只看体积',
    })
    expect(admitted.fiber.config?.admissionJudge.get()).toBe(true)
    expect(admitted.fiber.config?.admissionProvider.get()).toBe('local')
    expect(admitted.fiber.config?.admissionModel.get()).toBe('small')
    expect(admitted.fiber.config?.admissionReasoningEffort.get()).toBe('minimal')
    expect(admitted.fiber.config?.admissionPrompt.get()).toBe('只看体积')

    const gated = await load({
      privacyProvider: 'local-privacy', privacyModel: 'guard', privacyReasoningEffort: 'high',
      privacyConfirmedLocal: true, failurePolicy: 'block', privacyPrompt: '只看我定义的机密',
    })
    expect(gated.fiber.config?.privacyProvider.get()).toBe('local-privacy')
    expect(gated.fiber.config?.privacyModel.get()).toBe('guard')
    expect(gated.fiber.config?.privacyReasoningEffort.get()).toBe('high')
    expect(gated.fiber.config?.privacyConfirmedLocal.get()).toBe(true)
    expect(gated.fiber.config?.failurePolicy.get()).toBe('block')
    expect(gated.fiber.config?.privacyPrompt.get()).toBe('只看我定义的机密')
  })

  it('档位字段接受任意字符串（合法性由 route 的档位表判定，不在装载期判定）', async () => {
    // 档位 id 由 route 声明、各家词表不同（cline-pass 是 `none`、deepseek 是 `off`），还可能声明兜底词表以外的
    // id，所以 schema 不能拦。判"能不能发"挪到请求前：不在表里就不下发（`src/efforts.ts`）。
    const { fiber, error } = await load({ summaryReasoningEffort: 'ultra' } as unknown as Schemastery.TypeS<typeof Config>)
    expect(error).toBeUndefined()
    expect(fiber?.config?.summaryReasoningEffort.get()).toBe('ultra')
  })

  it('装上插件后工具运行时仍可用，且监听器没有替换任何结果', async () => {
    const { ctx } = await load({ summarize: false })
    ctx.tools.register(textTool('bash', 'unchanged'))
    const result = await ctx.tools.execute(exec('bash'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe('unchanged')
  })

  it('票 15：六个通用精简参数都是非 volatile 的普通值，写在配置文件里可读、改值即生效', async () => {
    const { fiber } = await load({})
    // 六个参数只影响配置文件里的 A/B，不进设置页（计划 §4.5）：装载后是**普通值**，没有 `.get()`。
    const config = fiber.config as unknown as Record<string, unknown>
    expect(config.condenseMinUnits).toBe(CONDENSE_DEFAULTS.minUnits)
    expect(config.condenseMinNetGainUnits).toBe(CONDENSE_DEFAULTS.minNetGainUnits)
    expect(config.condenseHeadLines).toBe(CONDENSE_DEFAULTS.headLines)
    expect(config.condenseTailLines).toBe(CONDENSE_DEFAULTS.tailLines)
    expect(config.condenseMaxLines).toBe(CONDENSE_DEFAULTS.maxLines)
    expect(config.condenseMaxLineChars).toBe(CONDENSE_DEFAULTS.maxLineChars)
    expect(Object.hasOwn(config, 'condenseMinUnits')).toBe(true)

    // 写在配置文件里可读、改值即按其取值生效：A/B 就是逐档改这几个值各跑一遍。
    const tuned = await load({
      condenseMinUnits: 64,
      condenseMinNetGainUnits: 12,
      condenseHeadLines: 10,
      condenseTailLines: 40,
      condenseMaxLines: 80,
      condenseMaxLineChars: 120,
    })
    const tunedConfig = tuned.fiber.config as unknown as Record<string, unknown>
    expect(tunedConfig.condenseMinUnits).toBe(64)
    expect(tunedConfig.condenseMinNetGainUnits).toBe(12)
    expect(tunedConfig.condenseHeadLines).toBe(10)
    expect(tunedConfig.condenseTailLines).toBe(40)
    expect(tunedConfig.condenseMaxLines).toBe(80)
    expect(tunedConfig.condenseMaxLineChars).toBe(120)
  })

  it('票 16：分派层的五个字段——两个开关的默认值与三个封顶参数', async () => {
    const { fiber } = await load({})
    expect(fiber.config?.condense.get()).toBe(true)
    // 「按命令语义精简」默认开：与总开关一致，有损替换有回退入口、模型要整份/逐字时整层让路。
    expect(fiber.config?.condenseByCommand.get()).toBe(true)
    // 四个非 volatile 字段装载后是**普通值**（没有 `.get()`）——设置页只保留 volatile 字段，所以它们不回页面；
    // `condenseGitDiff` 默认关（省幅来自明细截断、被截明细的恢复量更大），三个封顶参数仍取票 14 实测的那一档
    // （明细 100 / 整体 200 / 前导 3）。
    const config = fiber.config as unknown as Record<string, unknown>
    expect(config.condenseGitDiff).toBe(false)
    expect(config.condenseGitDiffMaxHunkLines).toBe(100)
    expect(config.condenseGitDiffMaxLines).toBe(200)
    expect(config.condenseGitDiffLeadingContext).toBe(3)

    // 写在配置文件里可读、改值即按其取值生效（这是「非 volatile 只影响 A/B」的可观察面）。
    const tuned = await load({
      condenseByCommand: false,
      condenseGitDiff: false,
      condenseGitDiffMaxHunkLines: 7,
      condenseGitDiffMaxLines: 60,
      condenseGitDiffLeadingContext: 0,
    })
    expect(tuned.fiber.config?.condenseByCommand.get()).toBe(false)
    const tunedConfig = tuned.fiber.config as unknown as Record<string, unknown>
    expect(tunedConfig.condenseGitDiff).toBe(false)
    expect(tunedConfig.condenseGitDiffMaxHunkLines).toBe(7)
    expect(tunedConfig.condenseGitDiffMaxLines).toBe(60)
    expect(tunedConfig.condenseGitDiffLeadingContext).toBe(0)
  })

  it('票 17：两族的九个字段——两个开关的默认值与七个参数', async () => {
    const { fiber } = await load({})
    // 九个字段同样是非 volatile 的**普通值**（没有 `.get()`）：设置页只保留 volatile 字段，所以它们不回页面。
    // 默认值取票 14 实测的那一档（`sed` 窗口 20/20/60、转储 15/15/60/20），换一档门槛读数就不可比。
    const config = fiber.config as unknown as Record<string, unknown>
    expect(config.condenseSedWindow).toBe(true)
    expect(config.condenseSedWindowHeadLines).toBe(20)
    expect(config.condenseSedWindowTailLines).toBe(20)
    expect(config.condenseSedWindowMinLines).toBe(60)
    expect(config.condenseRawDump).toBe(true)
    expect(config.condenseRawDumpHeadLines).toBe(15)
    expect(config.condenseRawDumpTailLines).toBe(15)
    expect(config.condenseRawDumpMinLines).toBe(60)
    expect(config.condenseRawDumpHits).toBe(20)

    // 写在配置文件里可读、改值即按其取值生效（这是「非 volatile 只影响 A/B」的可观察面）：开关关掉一族、
    // 一个参数改成非默认值，读回的都是改后的值。
    const tuned = await load({ condenseSedWindow: false, condenseRawDump: true, condenseRawDumpTailLines: 3 })
    const tunedConfig = tuned.fiber.config as unknown as Record<string, unknown>
    expect(tunedConfig.condenseSedWindow).toBe(false)
    expect(tunedConfig.condenseRawDump).toBe(true)
    expect(tunedConfig.condenseRawDumpTailLines).toBe(3)
  })
})
