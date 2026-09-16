import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, ValidationError } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import * as navigator from '../src/index.ts'
import type { Config as NavigatorConfig, NavigatorMode } from '../src/index.ts'
import { ACTIVE, FAILED, PENDING } from './support/fiber-state.ts'
import { disposeTrackedContexts, trackContext } from './support/mounted-contexts.ts'
import { createStubServices } from './support/stub-services.mjs'

/**
 * 装载与配置契约（票据 02）。
 *
 * 夹具拓扑是硬约束：三个注入服务的桩必须由**独立的插件 fiber** provide。把桩直接 provide 在
 * 被测插件的同一个根 ctx 上会让服务绕过 `inject` 检查——即使本插件的 `inject` 漏掉某个服务，
 * 插件照样能取到它并进入 ACTIVE，那两个「服务缺失」的用例就不再检验 `inject` 的完整性。
 */

/** 每个用例一个独立 context；桩是全局的，串用会互相干扰。 */
afterEach(disposeTrackedContexts)

/**
 * 由独立插件 fiber 挂桩，再返回可供装载被测插件的根 context。
 * @param services - 服务名到桩值的映射。
 * @returns 根 context。
 */
async function mountStubs(services: Readonly<Record<string, unknown>>) {
  const ctx = trackContext(new Context())
  await ctx.plugin({
    name: 'navigator-test-stubs',
    apply(stubCtx: Context) {
      for (const [name, value] of Object.entries(services)) stubCtx.provide(name, value)
    },
  })
  return ctx
}

/**
 * 装载插件并等它收场。
 * @param ctx - 已经挂好桩的根 context。
 * @param config - 装载配置。
 * @returns fiber 与 rejection 的原因；装载成功时为 `undefined`。
 */
async function load(ctx: Context, config: NavigatorConfig) {
  const fiber = ctx.plugin(navigator, config)
  const error = await fiber.then(() => undefined, (reason: unknown) => reason)
  return { fiber, error }
}

describe('插件入口与配置契约', () => {
  it('入口具名导出 name、inject、Config、apply，name 取值是 dsh-navigator', () => {
    expect(navigator.name).toBe('dsh-navigator')
    expect(typeof navigator.apply).toBe('function')
    expect(navigator.Config).toBeDefined()
    expect(navigator.inject).toEqual(expect.arrayContaining(['llm', 'sessions', 'sessionProjections']))
  })

  it('cordis.patch.yml 的配置键集合与 Config 的字段集合逐一相等', () => {
    const patches = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{
      insert?: Array<{ name?: string, config?: Record<string, unknown> }>
    }>
    const entry = patches
      .flatMap((patch) => patch.insert ?? [])
      .find((item) => item.name === '@dsh-clipclop/dsh-navigator')
    expect(entry?.config).toBeDefined()
    expect(Object.keys(entry?.config ?? {}).sort()).toEqual(Object.keys(navigator.Config.dict ?? {}).sort())
  })

  it('triggerEverySteps 非法时在加载阶段报错，不静默回落到默认值', async () => {
    const { services } = createStubServices()
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, { triggerEverySteps: 0 })
    expect(error).toBeInstanceOf(ValidationError)
    expect(String(error)).toContain('triggerEverySteps')
    expect(fiber.state).toBe(FAILED)
    expect(fiber.config).toBeUndefined()
  })

  it('mode 取枚举外的值时在加载阶段报错，不静默回落到默认值', async () => {
    const { services } = createStubServices()
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, { mode: 'nope' as NavigatorMode })
    expect(error).toBeInstanceOf(ValidationError)
    expect(String(error)).toContain('mode')
    expect(fiber.state).toBe(FAILED)
    expect(fiber.config).toBeUndefined()
  })

  it('装载后解析出的配置等于六个默认值', async () => {
    const { services } = createStubServices()
    const ctx = await mountStubs(services)
    const { fiber } = await load(ctx, {})
    expect(fiber.config).toEqual({
      triggerEverySteps: 50,
      mode: 'wait',
      reviewTimeoutMs: 120_000,
      maxOutputTokens: 4096,
      failurePolicy: 'continue',
      prompt: '',
    })
  })
})

describe('激活门禁', () => {
  it('llm.stream 缺失时激活阶段报错，错误点名 llm.stream', async () => {
    const { services } = createStubServices()
    services['llm'] = {}
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, {})
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('llm.stream')
    expect(String(error)).not.toContain('sessions.get')
    expect(fiber.state).toBe(FAILED)
  })

  it('sessions.get 缺失时激活阶段报错，错误点名 sessions.get', async () => {
    const { services } = createStubServices()
    services['sessions'] = {}
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, {})
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('sessions.get')
    expect(String(error)).not.toContain('llm.stream')
    expect(fiber.state).toBe(FAILED)
  })

  it('llm.stream 存在但不是函数时报错，错误点名 llm.stream', async () => {
    const { services } = createStubServices()
    services['llm'] = { stream: 'not-a-function' }
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, {})
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('llm.stream')
    expect(String(error)).not.toContain('sessions.get')
    expect(fiber.state).toBe(FAILED)
  })

  it('只缺 llm 时插件停在 PENDING，配置没有被解析，投影也没有注册', async () => {
    const { services, registered } = createStubServices()
    delete services['llm']
    const ctx = await mountStubs(services)
    const { fiber, error } = await load(ctx, {})
    expect(fiber.state).toBe(PENDING)
    expect(error).toBeUndefined()
    expect(fiber.config).toBeUndefined()
    expect(registered).toEqual([])
  })

  it('三个服务都就绪时插件进入 ACTIVE，并注册 navigatorSteps 投影', async () => {
    const { services, registered } = createStubServices()
    const ctx = await mountStubs(services)
    const { fiber } = await load(ctx, {})
    expect(fiber.state).toBe(ACTIVE)
    expect(registered).toEqual(['navigatorSteps'])
  })
})
