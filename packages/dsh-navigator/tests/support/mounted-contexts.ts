/**
 * 各用例自建 context 的记账与释放。
 *
 * 释放是 vitest 的**文件级**钩子，所以本模块只提供记账与批量释放，
 * `afterEach(disposeTrackedContexts)` 仍写在各 spec 自己文件里。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'

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

/** 释放本文件登记过的所有 context；在 `afterEach` 里调用。 */
export async function disposeTrackedContexts(): Promise<void> {
  await Promise.all(tracked.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
}
