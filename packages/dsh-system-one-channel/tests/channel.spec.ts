/**
 * 票据 05：决策通道的宿主半（工具面、两档引导、技能、阈值）。
 *
 * 判据都在票面的「验收」里：工具存在与否、参数形状、题面与答案原样透传、两档引导只差那一句、
 * 技能缺席时照常加载、阈值两种确定性各一条、算不出确定性时标 `abstain`、卸载后全部消失。
 */

import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import type { Answer, ProviderResponse } from '@dsh-clipclop/dsh-system-one'
import * as Channel from '../src/index.ts'
import { BOOLEAN_QUESTION, STATE, TARGET, callTool, mount, mountSwitch, prompt, skills, tool } from './support/channel.ts'

/** 一题是非题的回应：0.9 的确定性正好给是非题公式用。 */
const BOOLEAN_RESPONSE = { answers: { ok: { type: 'boolean', probability: 0.9 } } } satisfies ProviderResponse

/** 读出工具拿到的规范值。 */
function valueOf(result: unknown): Record<string, unknown> {
  return result as Record<string, unknown>
}

describe('工具面', () => {
  it('开关打开：工具注册，描述写明什么时候该用、什么时候不该用，也写明 decisions 层的含义', async () => {
    const { ctx, error } = await mount({ channel: { enabled: true, target: TARGET } })
    expect(error).toBeUndefined()
    const definition = tool(ctx)
    expect(definition?.name).toBe('systemone_ask')
    const description = definition!.description
    expect(description).toContain('Use it when')
    expect(description).toContain('Do not use it')
    // `abstain` 是「低于门槛」不是「答案错了」——不写这一句，阈值等于白设。
    expect(description).toContain('abstain')
    expect(description).toContain('not "the answer is wrong"')
  })

  it('开关关闭：工具不存在，第二档的引导段也不存在', async () => {
    const { ctx, error } = await mount({ channel: { enabled: false, target: TARGET, guidance: 'context' } })
    expect(error).toBeUndefined()
    expect(tool(ctx)).toBeUndefined()
    expect(await prompt(ctx)).not.toContain(Channel.CONTEXT_GUIDANCE)
  })

  it('参数只有 state 与 questions：target 与请求级的三个字段都不在顶层', async () => {
    const { ctx } = await mount({ channel: { enabled: true, target: TARGET } })
    const parameters = tool(ctx)!.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['state', 'questions'])
    expect(parameters.required).toEqual(['state', 'questions'])
    // 每题的 `instructions` 是契约要求的题面字段，与「请求级 instructions 不暴露」不是一回事。
  })

  it('阈值不在工具参数里：模型能自己放宽的闸门不是闸门', async () => {
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
    })
    const parameters = tool(ctx)!.parameters as { properties: Record<string, unknown> }
    expect(parameters.properties).not.toHaveProperty('threshold')
  })

  it('target 指向未注册的条目：工具交回点名 id 的错误', async () => {
    const { ctx } = await mount({ channel: { enabled: true, target: 'missing' } })
    await expect(callTool(ctx, { state: STATE, questions: [BOOLEAN_QUESTION] })).rejects.toThrow('missing')
  })

  it('空题单：派发前拦下，不为一次手滑白跑一趟决策模型', async () => {
    const { ctx, provider } = await mount({ channel: { enabled: true, target: TARGET } })
    await expect(callTool(ctx, { state: STATE, questions: [] })).rejects.toThrow('at least one question')
    expect(provider.requests).toHaveLength(0)
  })

  it('同 id 的两道题：点名 id 报错，不悄悄顶掉前一道', async () => {
    const { ctx, provider } = await mount({ channel: { enabled: true, target: TARGET } })
    await expect(callTool(ctx, { state: STATE, questions: [BOOLEAN_QUESTION, BOOLEAN_QUESTION] }))
      .rejects.toThrow('"ok"')
    expect(provider.requests).toHaveLength(0)
  })

  it('题面与答案原样透传：state、每题的 instructions 进 provider 请求，结果就是 provider 的答案', async () => {
    const { ctx, provider } = await mount({
      channel: { enabled: true, target: TARGET },
      respond: () => BOOLEAN_RESPONSE,
    })
    const signal = new AbortController().signal
    const result = await callTool(ctx, { state: STATE, questions: [BOOLEAN_QUESTION] }, signal)
    const request = provider.requests[0]!
    expect(request.state).toEqual(STATE)
    expect(request.questions).toEqual({
      ok: { type: 'boolean', instructions: BOOLEAN_QUESTION.instructions },
    })
    // `target` 是服务按条目解析的，进不了 provider 请求。
    expect('target' in request).toBe(false)
    // 取消信号原样透传；运行上下文里没有 deadline 字段，所以 `timeoutMs` 不传。
    expect(request.signal).toBe(signal)
    expect('timeoutMs' in request).toBe(false)
    expect(valueOf(result)).toEqual({ ...BOOLEAN_RESPONSE, latencyMs: expect.any(Number) })
  })

  it('卸载后工具与技能都消失', async () => {
    const { ctx, fiber } = await mount({ channel: { enabled: true, target: TARGET }, skills: true })
    expect(tool(ctx)).toBeDefined()
    expect((await skills(ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
    await fiber.dispose()
    expect(tool(ctx)).toBeUndefined()
    expect(await skills(ctx).list()).toEqual([])
  })
})

describe('总开关热切换', () => {
  it('同一会话里关掉：工具、引导段与技能一起消失；再打开都回来', async () => {
    const { ctx, update } = await mountSwitch({
      config: { enabled: true, target: TARGET, guidance: 'context' },
      skills: true,
    })
    expect(tool(ctx)).toBeDefined()
    expect(await prompt(ctx)).toContain(Channel.CONTEXT_GUIDANCE)
    expect((await skills(ctx).list()).map(skill => skill.name)).toEqual(['systemone'])

    update({ enabled: false })

    expect(tool(ctx)).toBeUndefined()
    expect(await prompt(ctx)).not.toContain(Channel.CONTEXT_GUIDANCE)
    expect(await skills(ctx).list()).toEqual([])

    update({ enabled: true })

    expect(tool(ctx)).toBeDefined()
    expect(await prompt(ctx)).toContain(Channel.CONTEXT_GUIDANCE)
    expect((await skills(ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
  })

  it('开-关-开之后工具与引导段各恰好一份，技能不重复注册', async () => {
    const { ctx, update } = await mountSwitch({ config: { target: TARGET, guidance: 'context' }, skills: true })
    expect(tool(ctx)).toBeUndefined()

    update({ enabled: true })
    update({ enabled: false })
    update({ enabled: true })
    update({ enabled: false })
    update({ enabled: true })

    expect(tool(ctx)).toBeDefined()
    // 引导段按名字注册：重复注册会撞名，段落重复则这句会出现两遍。
    expect((await prompt(ctx)).split(Channel.CONTEXT_GUIDANCE)).toHaveLength(2)
    expect((await skills(ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
  })

  it('技能子系统缺席：照样能开关，只是没有技能', async () => {
    const { ctx, update } = await mountSwitch({ config: { target: TARGET } })
    expect(ctx.get('skills')).toBeUndefined()

    update({ enabled: true })
    expect(tool(ctx)).toBeDefined()

    update({ enabled: false })
    expect(tool(ctx)).toBeUndefined()
  })

  it('运行时被改成「开却没选条目」：保持关闭；补上条目后按新配置打开', async () => {
    const { ctx, update } = await mountSwitch()

    update({ enabled: true })
    expect(tool(ctx)).toBeUndefined()

    update({ target: TARGET })
    expect(tool(ctx)).toBeDefined()
  })

  it('target 指向已删条目：配置照旧保留（调用期才报错），开关仍能关掉', async () => {
    const { ctx, update } = await mountSwitch({ config: { enabled: true, target: 'gone' } })
    expect(tool(ctx)).toBeDefined()

    update({ enabled: false })
    expect(tool(ctx)).toBeUndefined()
  })
})

describe('两档引导与技能', () => {  it('第一档注册技能、不含那句；第二档含且只含那一句', async () => {
    const first = await mount({ channel: { enabled: true, target: TARGET, guidance: 'tool' }, skills: true })
    const second = await mount({ channel: { enabled: true, target: TARGET, guidance: 'context' }, skills: true })
    const firstPrompt = await prompt(first.ctx)
    const secondPrompt = await prompt(second.ctx)
    expect(firstPrompt).not.toContain(Channel.CONTEXT_GUIDANCE)
    expect(secondPrompt).toContain(Channel.CONTEXT_GUIDANCE)
    // 「只含」：把那一句摘掉，两档的提示一模一样。
    expect(secondPrompt.replace(Channel.CONTEXT_GUIDANCE, '').trim()).toBe(firstPrompt.trim())
    // 技能属于第一档，两档都有。
    expect((await skills(first.ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
    expect((await skills(second.ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
  })

  it('技能子系统比本插件晚装：技能仍会补上（可选依赖等它出现，不是装载时的快照）', async () => {
    const { ctx } = await mount({ channel: { enabled: true, target: TARGET } })
    expect(ctx.get('skills')).toBeUndefined()
    await ctx.plugin(SkillRegistry)
    expect((await skills(ctx).list()).map(skill => skill.name)).toEqual(['systemone'])
  })

  it('技能注册表缺席时插件仍加载、工具可用，只是没有技能', async () => {
    const { ctx, error } = await mount({ channel: { enabled: true, target: TARGET } })
    expect(error).toBeUndefined()
    expect(tool(ctx)).toBeDefined()
    expect(ctx.get('skills')).toBeUndefined()
  })
})

describe('可信度门槛', () => {
  it('阈值未开启：返回里没有 decisions 这一层', async () => {
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET },
      respond: () => BOOLEAN_RESPONSE,
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions: [BOOLEAN_QUESTION] }))
    expect(result).not.toHaveProperty('decisions')
  })

  it('是非题按 |probability − 0.5| × 2 × labelMass（缺席按 1）：够门槛标 act，不够标 abstain 且答案原样交回', async () => {
    const answers = {
      sure: { type: 'boolean', probability: 0.9 },
      unsure: { type: 'boolean', probability: 0.55 },
    } satisfies Readonly<Record<string, Answer>>
    const questions = [
      { id: 'sure', type: 'boolean', instructions: 'Is the build green?' },
      { id: 'unsure', type: 'boolean', instructions: 'Is the diff complete?' },
    ]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
      respond: () => ({ answers }),
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      answers: unknown
      decisions: Record<string, { verdict: string; reason?: string }>
    }
    // 0.9 → 0.8 ≥ 0.6；0.55 → 0.1 < 0.6（两条都没报 labelMass，按 1）。
    expect(result.decisions.sure).toEqual({ verdict: 'act' })
    expect(result.decisions.unsure?.verdict).toBe('abstain')
    expect(result.decisions.unsure?.reason).toContain('certainty')
    // 标记只加一层，答案本体两种情况下都一样。
    expect(result.answers).toEqual(answers)
  })

  it('是非题的 labelMass 参与确定性：低覆盖把重归一后的 0.99 拉回 abstain', async () => {
    const answers = {
      whole: { type: 'boolean', probability: 0.99, labelMass: 0.9 },
      thin: { type: 'boolean', probability: 0.99, labelMass: 0.2 },
    } satisfies Readonly<Record<string, Answer>>
    const questions = [
      { id: 'whole', type: 'boolean', instructions: 'Is the build green?' },
      { id: 'thin', type: 'boolean', instructions: 'Is the diff complete?' },
    ]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
      respond: () => ({ answers }),
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      answers: unknown
      decisions: Record<string, { verdict: string }>
    }
    // 0.99 → 0.98；×0.9 = 0.882 ≥ 0.6；×0.2 = 0.196 < 0.6。
    expect(result.decisions.whole).toEqual({ verdict: 'act' })
    expect(result.decisions.thin?.verdict).toBe('abstain')
    expect(result.answers).toEqual(answers)
  })

  it('choice/score 用 provider 自报的 confidence', async () => {
    const answers = {
      pick: { type: 'choice', choice: 'b', confidence: 0.95 },
      rate: { type: 'score', score: 2, confidence: 0.2 },
    } satisfies Readonly<Record<string, Answer>>
    const questions = [
      { id: 'pick', type: 'choice', instructions: 'Which parser fits?', options: ['a', 'b'] },
      { id: 'rate', type: 'score', instructions: 'How risky is this change?', levels: ['low', 'mid', 'high'] },
    ]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
      respond: () => ({ answers }),
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      answers: unknown
      decisions: Record<string, { verdict: string; reason?: string }>
    }
    expect(result.decisions.pick).toEqual({ verdict: 'act' })
    expect(result.decisions.rate?.verdict).toBe('abstain')
    expect(result.answers).toEqual(answers)
  })

  it('题 id 与对象原型上的键同名时，漏答照常报「没答」而不是「没报 confidence」', async () => {
    const questions = [{ id: 'constructor', type: 'boolean', instructions: 'Is the build green?' }]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      decisions: Record<string, { verdict: string; reason?: string }>
    }
    expect(result.decisions['constructor']?.verdict).toBe('abstain')
    expect(result.decisions['constructor']?.reason).toContain('no answer')
  })

  it('题 id 是 `__proto__` 这类键时标记照样出：它是模型给的不可信输入', async () => {
    const questions = [{ id: '__proto__', type: 'boolean', instructions: 'Is the build green?' }]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      decisions: Record<string, { verdict: string }>
    }
    expect(Object.keys(result.decisions)).toEqual(['__proto__'])
    expect(result.decisions['__proto__']?.verdict).toBe('abstain')
  })

  it('确定性算不出来时同样标 abstain 并写明原因', async () => {
    const answers = { pick: { type: 'choice', choice: 'b' } } satisfies Readonly<Record<string, Answer>>
    const questions = [
      { id: 'pick', type: 'choice', instructions: 'Which parser fits?', options: ['a', 'b'] },
      { id: 'missing', type: 'boolean', instructions: 'Is the build green?' },
    ]
    const { ctx } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 0.6 } },
      respond: () => ({ answers }),
    })
    const result = valueOf(await callTool(ctx, { state: STATE, questions })) as {
      answers: unknown
      decisions: Record<string, { verdict: string; reason?: string }>
    }
    // 没报 confidence：判不出来不等于放行。
    expect(result.decisions.pick?.verdict).toBe('abstain')
    expect(result.decisions.pick?.reason).toContain('no confidence')
    // 该题压根没答：同样给标记，原因说清是漏答。
    expect(result.decisions.missing?.verdict).toBe('abstain')
    expect(result.decisions.missing?.reason).toContain('no answer')
    expect(result.answers).toEqual(answers)
  })
})
