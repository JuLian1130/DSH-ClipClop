/**
 * 条目构建：把配置里的每一条建成 provider，并交给注册表。
 *
 * `kind` 到实现的映射是一张**穷尽的**工厂表：枚举里加一个 `kind` 而不实现它，`tsc` 就报错——
 * 不会出现一条没有实现的条目注册成功、到 `ask` 时才炸。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Kind } from './config.ts'
import type { SystemOneProvider } from './provider.ts'
import { deepseek } from './providers/deepseek.ts'
import { openai } from './providers/openai.ts'
import { systemone } from './providers/systemone.ts'

/**
 * 一个条目怎么变成 provider。
 *
 * `ctx` 是给实现取装载期依赖用的（凭据要经 `ctx.get('credentials')` 解析），不是给实现注册东西的。
 */
export type ProviderFactory = (entry: Entry, ctx: Context) => SystemOneProvider

/** `kind` → provider 工厂。 */
export const FACTORIES: Record<Kind, ProviderFactory> = { systemone, openai, deepseek }

/**
 * 校验条目并建出 provider。
 * @param ctx - 插件的 context，转交给工厂。
 * @param entries - 配置里的条目。
 * @returns id 与 provider，按配置顺序。
 * @throws `id` 重复：两个条目同名会让 `ask` 指向不确定的实现。
 */
export function buildEntries(ctx: Context, entries: readonly Entry[]): Array<[string, SystemOneProvider]> {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`system-one: entry id "${entry.id}" is used twice`)
    seen.add(entry.id)
  }
  return entries.map((entry) => [entry.id, FACTORIES[entry.kind](entry, ctx)])
}
