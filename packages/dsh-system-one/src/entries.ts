/**
 * 条目构建：把配置里的每一条建成 provider，并交给注册表。
 *
 * `kind` 到实现的映射是一张**工厂表**。枚举里有值但没有对应工厂时在装载期报错——不能让一个没有实现的
 * 条目注册成功、到 `ask` 时才炸。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Kind } from './config.ts'
import type { SystemOneProvider } from './provider.ts'

/**
 * 一个条目怎么变成 provider。
 *
 * `ctx` 是给实现取装载期依赖用的（凭据要经 `ctx.credentials` 解析），不是给实现注册东西的。
 */
export type ProviderFactory = (entry: Entry, ctx: Context) => SystemOneProvider

/**
 * `kind` → provider 工厂。
 *
 * 现在是空表，所以配了条目也只会在装载期报错点名 `kind`；`systemone` 由 02b 填、`openai` 由 03 填。
 */
export const FACTORIES: Partial<Record<Kind, ProviderFactory>> = {}

/**
 * 校验条目并建出 provider。
 * @param ctx - 插件的 context，转交给工厂。
 * @param entries - 配置里的条目。
 * @returns id 与 provider，按配置顺序。
 * @throws `id` 重复（两个条目同名会让 `ask` 指向不确定的实现）；`kind` 没有对应工厂。
 */
export function buildEntries(ctx: Context, entries: readonly Entry[]): Array<[string, SystemOneProvider]> {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`system-one: entry id "${entry.id}" is used twice`)
    seen.add(entry.id)
  }
  return entries.map((entry) => {
    const factory = FACTORIES[entry.kind]
    if (factory === undefined) {
      throw new Error(`system-one: no provider factory for kind "${entry.kind}" (entry "${entry.id}")`)
    }
    return [entry.id, factory(entry, ctx)]
  })
}
