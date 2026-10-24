/**
 * 真实 Loader 下的热更新链路：设置页写回走的就是「Entry.update → 提交 volatile 值 → 向插件 fiber 派发
 * `loader/volatile-update`」。这里不用手发事件，而是让真实 Loader 走一遍，证明「保存后不用重载」是端到端的。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORIES } from '../src/entries.ts'
import * as SystemOne from '../src/index.ts'
import { SystemOneProvider, type ProviderRequest } from '../src/provider.ts'
import type { Answer, ProviderResponse, Question } from '../src/types.ts'

const QUESTIONS: Record<string, Question> = {
  'turn.continue': { type: 'boolean', instructions: '本轮是否应该继续？' },
}

const ANSWERS: Record<string, Answer> = {
  'turn.continue': { type: 'boolean', probability: 0.25 },
}

/** 不联网、按脚本作答的条目实现。 */
class StubProvider extends SystemOneProvider {
  async evaluate(_request: ProviderRequest): Promise<ProviderResponse> {
    return { answers: ANSWERS }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** 一个能过 schema 的条目；热更新只关心 id 与字段值。 */
function entry(id: string, model = 'stub'): SystemOne.Entry {
  return { id, label: id, kind: 'systemone', baseUrl: 'http://127.0.0.1:1', model }
}

describe('真实 Loader 的 volatile 更新', () => {
  it('改配置后新条目不用重载插件就能 ask', async () => {
    // 工厂表是条目与网络实现之间的接缝：换成 StubProvider，重复 id 等校验仍是真实现。
    vi.spyOn(FACTORIES, 'systemone').mockImplementation(() => new StubProvider())
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins['system-one-under-test'] = SystemOne
    const id = await ctx.loader.create({ name: 'cordis:system-one-under-test', config: { entries: [] } })
    const fiber = ctx.loader.resolve(id).fiber!
    await fiber.await()

    await expect(ctx.systemOne.ask({ target: 'added', state: null, questions: QUESTIONS }))
      .rejects.toThrow('system-one: no provider registered as "added" (registered: none)')

    await fiber.entry!.update({ config: { entries: [entry('added')] } })
    await fiber.await()

    const result = await ctx.systemOne.ask({ target: 'added', state: { step: 1 }, questions: QUESTIONS })
    expect(result.answers).toEqual(ANSWERS)
  })
})
