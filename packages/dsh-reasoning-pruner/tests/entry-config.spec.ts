/**
 * 票 01 第 9、10、14 条：插件入口与配置契约。
 *
 * 配置错误必须**大声失败**，且两处都断言：`Config` schema 在装载路径上失败，绕过 loader 直接调用
 * `apply` 时也失败——只测 schema 的话，绕过 loader 的调用路径没有判据。不做静默回退。
 *
 * 最后一条是本票的前置：承载类型的宿主包必须能被解析（类型图靠它的模块增强，见 `projection.ts`）。
 *
 * @module
 */

import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, ValidationError } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { Config, inject, name, reasoningPrunerProjection } from '../src/index.ts'

/** `FiberState` 是 const enum，不能运行时具名导入；这两个是本文件用到的取值。 */
const ACTIVE = 2
const FAILED = 3

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** 挂真实 `SessionStore` 与命令表：投影注册与 ④ 的命令注册都走真实服务，装载结果用公开面读。 */
async function mountSessionStore(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  return ctx
}

/**
 * 装载插件并等它收场。
 * @param ctx - 已经挂好服务的根 context。
 * @param config - 装载配置。
 * @returns fiber 与 rejection 的原因；装载成功时原因为 `undefined`。
 */
async function load(ctx: Context, config: Schemastery.TypeS<typeof Config>) {
  const fiber = ctx.plugin(plugin, config)
  const error = await fiber.then(() => undefined, (reason: unknown) => reason)
  return { fiber, error }
}

describe('插件入口', () => {
  it('具名导出 name、inject、Config、apply', () => {
    expect(name).toBe('dsh-reasoning-pruner')
    expect(typeof plugin.apply).toBe('function')
    expect(Config).toBeDefined()
    expect(inject).toContain('sessions')
    // ④ 的命令只能在 host 半注册（承载事件要落进会话日志）：未 inject 就读 `ctx.commands` 会抛。
    expect(inject).toContain('commands')
  })
})

describe('配置契约', () => {
  it('默认配置合法且可装载，装载后注册了投影', async () => {
    const ctx = await mountSessionStore()
    const { fiber, error } = await load(ctx, {})
    expect(error).toBeUndefined()
    expect(fiber.state).toBe(ACTIVE)
    expect(ctx.sessions.messageProjections).toEqual([reasoningPrunerProjection])
  })

  it('显式取值可覆盖默认值，且 ④ 的开关默认给出', async () => {
    const ctx = await mountSessionStore()
    const { fiber } = await load(ctx, { everySteps: 7, keepRecentSteps: 3 })
    expect(fiber.config).toMatchObject({ everySteps: 7, keepRecentSteps: 3 })
    expect(fiber.config?.manualPrune.get()).toBe(true)
  })

  it('④ 的开关可以显式关掉（volatile 引用，装载后按它读）', async () => {
    const ctx = await mountSessionStore()
    const { fiber } = await load(ctx, { manualPrune: false })
    expect(fiber.config?.manualPrune.get()).toBe(false)
  })

  it('M 为 0 时在装载阶段失败，不静默回落到默认值', async () => {
    const ctx = await mountSessionStore()
    const { fiber, error } = await load(ctx, { everySteps: 0 })
    expect(error).toBeInstanceOf(ValidationError)
    expect(String(error)).toContain('everySteps')
    expect(fiber.state).toBe(FAILED)
    expect(fiber.config).toBeUndefined()
  })

  it('K 为负数时在装载阶段失败，不静默回落到默认值', async () => {
    const ctx = await mountSessionStore()
    const { fiber, error } = await load(ctx, { keepRecentSteps: -1 })
    expect(error).toBeInstanceOf(ValidationError)
    expect(String(error)).toContain('keepRecentSteps')
    expect(fiber.state).toBe(FAILED)
    expect(fiber.config).toBeUndefined()
  })

  it('直接调用 apply 时的重复校验同样大声失败', () => {
    const ctx = new Context()
    contexts.push(ctx)
    // 直接调用要传 loader 解析后的形状；这两次都在读到开关之前就抛，所以引用给一个恒真的替身即可。
    const manualPrune = { get: () => true }
    expect(() => plugin.apply(ctx, { everySteps: 0, keepRecentSteps: 10, manualPrune })).toThrow(
      /dsh-reasoning-pruner: everySteps must be an integer >= 1, got 0/,
    )
    expect(() => plugin.apply(ctx, { everySteps: 50, keepRecentSteps: -1, manualPrune })).toThrow(
      /dsh-reasoning-pruner: keepRecentSteps must be an integer >= 0, got -1/,
    )
  })
})

describe('前置：承载类型的宿主包可解析', () => {
  it('@deepseek-ai/dsh-web-search-deepseek 从本包解析得到（类型专用 devDependency）', () => {
    const require = createRequire(import.meta.url)
    expect(require.resolve('@deepseek-ai/dsh-web-search-deepseek/package.json')).toMatch(/dsh-web-search-deepseek/)
  })

  it('@deepseek-ai/dsh-compaction-basic 与 @deepseek-ai/dsh-token-meter 从本包解析得到（03 第 7 条观测顺序的前置）', () => {
    // 本仓根**没有** `node_modules/@deepseek-ai/` 这一层：这些包只作为 `dsh` / `dsh-web-app` / `dsh-base`
    // 的传递依赖存在于 `node_modules/.pnpm/**` 下，而 hoist 目录 `.pnpm/node_modules/` 不在本包的模块解析
    // 路径上——从 `packages/` 下实测 `require.resolve('@deepseek-ai/dsh-compaction-basic/package.json')`
    // 为 MISS。所以它必须是本包显式的 devDependency，否则第 7 条只剩「注册成功」可断。
    const require = createRequire(import.meta.url)
    expect(require.resolve('@deepseek-ai/dsh-compaction-basic/package.json')).toMatch(/dsh-compaction-basic/)
    expect(require.resolve('@deepseek-ai/dsh-token-meter/package.json')).toMatch(/dsh-token-meter/)
  })
})
