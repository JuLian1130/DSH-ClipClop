/**
 * Cordis 测试脚手架：`FiberState` 的数值镜像，以及各用例自建 context 的记账与释放。
 *
 * `FiberState` 是 const enum，不能运行时具名导入，只能用数值镜像。context 的释放在 vitest 里是
 * **文件级**钩子，所以这里只提供记账与批量释放，`afterEach` 仍写在各 spec 自己文件里。
 *
 * @module
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'

/** 条目在等它 `inject` 的服务，尚未激活。 */
export const PENDING = 0 as FiberState.PENDING
/** 条目已激活并完成接线。 */
export const ACTIVE = 2 as FiberState.ACTIVE
/** 条目在激活阶段报错。 */
export const FAILED = 3 as FiberState.FAILED

const tracked: Context[] = []

/**
 * 登记一个用例自己新建的根 context，交给 `disposeTrackedContexts` 释放。
 * @param ctx - 本用例新建的根 context。
 * @returns 同一个 context，便于就地赋值。
 */
export function trackContext(ctx: Context): Context {
  tracked.push(ctx)
  return ctx
}

/** 释放本文件登记过的所有 context；在 `afterEach(disposeTrackedContexts)` 里调用。 */
export async function disposeTrackedContexts(): Promise<void> {
  await Promise.all(tracked.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
}
