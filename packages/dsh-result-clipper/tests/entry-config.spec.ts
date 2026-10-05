/**
 * 票 02 第 1、2 条：插件入口与配置契约。
 *
 * 判据要对上票面「两个能力默认关闭」与「设置页保存即生效」的 host 半：四个字段都是 volatile 引用，装载后按
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
  it('默认配置合法且可装载，两个能力与 debug、干跑都默认关闭、路径为空，route/阈值/提示词取首版默认', async () => {
    const { fiber, error } = await load({})
    expect(error).toBeUndefined()
    expect(fiber.config?.summarize.get()).toBe(false)
    expect(fiber.config?.privacyGate.get()).toBe(false)
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
    expect(fiber.config?.minInlineTokens.get()).toBe(1024)
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
})
