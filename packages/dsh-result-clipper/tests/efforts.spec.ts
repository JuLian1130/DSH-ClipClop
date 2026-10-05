/**
 * 推理档位的**取值**：配置里的值 → 这次请求实际发的 id，以及"该 route 的档位表"的缓存语义。
 *
 * 两层观察面：
 * - `createEffortChoice` 直接对着一份 `Context` + 假 route 判：解析、判定、缓存、失效、失败不缓存；
 * - 整条插件走一遍（`mount` + 真工具运行时）：请求上真的带的那个档位。
 *
 * 关键判据是"表读到了就不再查"（`route.resolveCalls` 数次数）与"声明顺序不是升序时取序表最低的一档"。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createEffortChoice } from '../src/efforts.ts'
import { Config } from '../src/index.ts'
import { exec, mount, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { FakeRoute } from './support/route.ts'

type Schemastery = typeof import('@deepseek-ai/schemastery')

const LONG_BODY = 'x'.repeat(5000)
const SUMMARY_REPLY = { text: JSON.stringify({ action: 'summarize', summary: '这是一段短说明' }) }

const open: HostFixture[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

/** 一个只提供 `llm` 的最小宿主：直接判档位读数，不挂工具运行时。 */
function host(): { ctx: Context, route: FakeRoute, efforts: ReturnType<typeof createEffortChoice> } {
  const ctx = new Context()
  const route = new FakeRoute([SUMMARY_REPLY])
  ctx.provide('llm', route as never)
  return { ctx, route, efforts: createEffortChoice(ctx) }
}

/** 触发一次设置写入（真实现里 settings 服务写回后就这么发）。 */
function writeSettings(ctx: Context): void {
  ctx.emit('settings/document-updated', 'dsh-result-clipper' as SettingsNamespace, 2)
}

describe('档位读数：配置里的值 → 要发的 id', () => {
  it('留空＝不推理，按该 route 的表拼；显式值在表里就发它、不在就落到不推理', async () => {
    const { route, efforts } = host()
    route.reasonings.set('mock/mock', [{ id: 'none' }, { id: 'low' }, { id: 'medium' }])

    expect(await efforts.choose('mock', 'mock', '')).toBe('none')
    expect(await efforts.choose('mock', 'mock', 'medium')).toBe('medium')
    // 表里没有 `off`：这个值发出去只会被拒，所以按「不推理」解析（与卡片上显示的生效档位一致）。
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('none')
  })

  it('表里没有 off/none 时取已知次序最低的那一档，而不是声明的第一个', async () => {
    const { route, efforts } = host()
    route.reasonings.set('mock/mock', [{ id: 'high' }, { id: 'low' }])
    expect(await efforts.choose('mock', 'mock', '')).toBe('low')
  })

  it('该模型不提供档位：配置留空与显式值都不发（带值必被 DSH 拒）', async () => {
    const { route, efforts } = host()
    route.reasonings.set('mock/mock', null)
    expect(await efforts.choose('mock', 'mock', '')).toBeUndefined()
    expect(await efforts.choose('mock', 'mock', 'low')).toBeUndefined()
  })

  it('表读不到：显式值原样下发（还有错误码兜底），留空则不发', async () => {
    const { route, efforts } = host()
    route.resolveFailures.add('mock/mock')
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('off')
    expect(await efforts.choose('mock', 'mock', '')).toBeUndefined()
  })

  it('没有 llm 服务时同样按"表读不到"处理，不抛', async () => {
    const ctx = new Context()
    const efforts = createEffortChoice(ctx)
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('off')
    expect(await efforts.choose('mock', 'mock', '')).toBeUndefined()
  })
})

describe('档位表的缓存语义', () => {
  it('一条 route 只查一次表：之后每次判定都是内存查表', async () => {
    const { route, efforts } = host()
    route.reasonings.set('mock/mock', [{ id: 'none' }, { id: 'low' }])

    expect(await efforts.choose('mock', 'mock', '')).toBe('none')
    expect(await efforts.choose('mock', 'mock', 'low')).toBe('low')
    // 表里没有 `off`：落到不推理（同样是内存查表，不额外调用）。
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('none')
    expect(route.resolveCalls).toEqual(['mock/mock'])

    // 换一条 route 才再查一次。
    route.reasonings.set('mock/small', [{ id: 'off' }])
    expect(await efforts.choose('mock', 'small', '')).toBe('off')
    expect(route.resolveCalls).toEqual(['mock/mock', 'mock/small'])
  })

  it('设置写入清空缓存：下一次判定重新查表', async () => {
    const { ctx, route, efforts } = host()
    route.reasonings.set('mock/mock', [{ id: 'none' }])
    expect(await efforts.choose('mock', 'mock', '')).toBe('none')
    expect(route.resolveCalls).toHaveLength(1)

    // 表变了（真实现里可能是换了 route 或模型的档位声明），设置写入是唯一的失效信号。
    route.reasonings.set('mock/mock', [{ id: 'off' }, { id: 'low' }])
    writeSettings(ctx)
    expect(await efforts.choose('mock', 'mock', '')).toBe('off')
    expect(route.resolveCalls).toHaveLength(2)
  })

  it('解析失败不缓存失败：下一次判定会再查', async () => {
    const { route, efforts } = host()
    route.resolveFailures.add('mock/mock')
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('off')
    expect(route.resolveCalls).toHaveLength(1)

    route.resolveFailures.delete('mock/mock')
    route.reasonings.set('mock/mock', [{ id: 'none' }])
    expect(await efforts.choose('mock', 'mock', 'off')).toBe('none')
    expect(route.resolveCalls).toHaveLength(2)
  })
})

describe('整条插件：请求上真的带的档位', () => {
  /** 挂一份插件 + 假 route 的夹具（摘要走 mock route）。 */
  async function mounted(overrides: Record<string, unknown>, route: FakeRoute): Promise<HostFixture> {
    const fixture = await mount(
      { summarize: true, ruleSummary: true, routeProvider: 'mock', routeModel: 'mock', ...overrides } as Schemastery.TypeS<typeof Config>,
      undefined,
      route,
    )
    open.push(fixture)
    return fixture
  }

  it('留空时请求带上该 route 解析出的「不推理」档位', async () => {
    const route = new FakeRoute([SUMMARY_REPLY])
    route.reasonings.set('mock/mock', [{ id: 'none' }, { id: 'low' }])
    const fixture = await mounted({}, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.resolveCalls).toEqual(['mock/mock'])
    expect(route.requests[0]?.reasoningEffort).toBe('none')
    expect(textOf(result.content)).toContain('这是一段短说明')
  })

  it('声明顺序不是升序时，请求带的是序表最低的那一档', async () => {
    const route = new FakeRoute([SUMMARY_REPLY])
    route.reasonings.set('mock/mock', [{ id: 'high' }, { id: 'low' }])
    const fixture = await mounted({}, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests[0]?.reasoningEffort).toBe('low')
  })

  it('显式值不在表里时按不推理下发，请求只发一次（不靠失败重发兜底）', async () => {
    const route = new FakeRoute([SUMMARY_REPLY])
    route.reasonings.set('mock/mock', [{ id: 'none' }, { id: 'low' }])
    const fixture = await mounted({ summaryReasoningEffort: 'medium' }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(route.requests[0]?.reasoningEffort).toBe('none')
    expect(textOf(result.content)).toContain('这是一段短说明')
  })

  it('同一 route 的两条结果只查一次表', async () => {
    const route = new FakeRoute([SUMMARY_REPLY])
    route.reasonings.set('mock/mock', [{ id: 'none' }, { id: 'low' }])
    const fixture = await mounted({}, route)
    // 两个工具、两份正文：避开 memo 命中（memo 键是工具名 + 正文），两次都真的发请求。
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    fixture.ctx.tools.register(textTool('web_fetch', 'y'.repeat(5000)))
    await fixture.ctx.tools.execute(exec('bash'))
    await fixture.ctx.tools.execute(exec('web_fetch'))

    expect(route.requests).toHaveLength(2)
    expect(route.resolveCalls).toEqual(['mock/mock'])
  })
})
