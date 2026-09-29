// @vitest-environment jsdom
/**
 * 票 06：主界面开关的四条行为判据（`测试决策`「主界面开关」的行为侧）。
 *
 * 装配是「真 settings 服务 + 真 Loader + 真 provider 目录 + 真 `ui-model-selection`」，浏览器半只有服务
 * 面是替身，见 `tests/support/client-runtime.ts` 的模块头。
 *
 * 第 3 条的观察面写死为 `slots.entries('settings.plugins.tab')` 的注册条目。**座位在 2026-09-29 按用户裁决
 * 从 `settings.general.item` 一行改成「设置 → 内置插件」的一个页签**（理由与影响见票面「座位变更」一节）；
 * 该槽位把 `options.label` 投影成页签按钮上的文字，所以这一条顺带钉住「页签名随语言切换、不是写死的英文」。
 * 第 4 条是**成对**的两个用例；第 5 条的观察面是**重挂载后解析出的配置值**，不是「写调用发生过」；第 6 条
 * 断派发出去的写操作恰一次、路径恰一条、别的键逐一不变；第 7 条断界面失败态（`role="alert"`），因为业务
 * 拒绝捕不到 `.catch()`。
 *
 * @module
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { catalogOf, mountClientTab, projectionOf } from './support/client-runtime.ts'
import type { ClientTabHarness, SlotEntryLike } from './support/client-runtime.ts'
import { bootSettingsHost, cleanupHosts, recordingWire, PREFERENCE_NAMESPACE, rowsWithPiAiRoutes } from './support/settings-host.ts'
import type { RecordedWrite, SettingsHost } from './support/settings-host.ts'

/** 夹具自己的 pi-ai 路由：显式 route 级 `api` + 一条模型，因此可确定判定（不是从 catalog 继承协议）。 */
const FIXTURE_ROUTE = 'fixture-route'

/** 一条「界面允许」的装配：当前路由是 pi-ai 的显式 `openai-completions` 路由。 */
async function allowed(options: { manualPrune?: boolean } = {}): Promise<{
  host: SettingsHost
  tab: ClientTabHarness
  writes: RecordedWrite[]
}> {
  const host = await bootSettingsHost({
    manualPrune: options.manualPrune ?? true,
    rows: rowsWithPiAiRoutes(options.manualPrune ?? true, {
      [FIXTURE_ROUTE]: { api: 'openai-completions', displayName: 'Fixture Route', models: [{ id: 'm1' }] },
    }),
  })
  const directory = host.providers()
  const route = directory.find(entry => entry.provider === FIXTURE_ROUTE)
  if (route === undefined) throw new Error('host fixture: the fixture route was not declared')
  const writes: RecordedWrite[] = []
  const tab = await mountClientTab({
    settings: recordingWire(host.wire, writes),
    providers: directory,
    catalog: catalogOf({ provider: route.provider, model: 'm1' }, [route.provider]),
    projection: projectionOf({ provider: route.provider, model: 'm1' }),
  })
  return { host, tab, writes }
}

const open: { host: SettingsHost, tab: ClientTabHarness }[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.tab.dispose()
    await entry.host.dispose()
  }
})

afterAll(() => { cleanupHosts() })

describe('票 06 第 3 条：开关注册到 settings.plugins.tab 一个页签', () => {
  it('apply 跑完后该 slot 恰有一条贡献，options.id 是写死的页签 id，页签名随语言切换', async () => {
    const { host, tab } = await allowed()
    open.push({ host, tab })
    const entries = tab.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe('reasoning-pruner')
    const label = entries[0]!.options.label as () => string
    expect(label()).toBe('Reasoning pruning')
    tab.setLocaleActive('zh')
    expect(label()).toBe('推理裁剪')
  })
})

describe('票 06 第 4 条：当前值来自 host 半的 Config', () => {
  it('settings 文档里没有这个键时，读到的是 schema 的默认（默认给出，不是默认关闭）', async () => {
    const rows = rowsWithPiAiRoutes(true, {
      [FIXTURE_ROUTE]: { api: 'openai-completions', displayName: 'Fixture Route', models: [{ id: 'm1' }] },
    }).map(entry => entry.id === PREFERENCE_NAMESPACE
      ? { ...entry, config: { everySteps: 50, keepRecentSteps: 10 } }
      : entry)
    const host = await bootSettingsHost({ rows })
    try {
      const directory = host.providers()
      const route = directory.find(entry => entry.provider === FIXTURE_ROUTE)!
      const tab = await mountClientTab({
        settings: host.wire,
        providers: directory,
        catalog: catalogOf({ provider: route.provider, model: 'm1' }, [route.provider]),
        projection: projectionOf({ provider: route.provider, model: 'm1' }),
      })
      try {
        expect(host.manualPrune()).toBe(true)
        expect(tab.injected().hooks.enabled.getSnapshot()).toBe(true)
      } finally {
        await tab.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('host 半以布尔 true 装载时，注册面读到的当前值是 true', async () => {
    const { host, tab } = await allowed({ manualPrune: true })
    open.push({ host, tab })
    expect(tab.injected().hooks.enabled.getSnapshot()).toBe(true)
  })

  it('host 半以布尔 false 装载时，注册面读到的当前值是 false', async () => {
    const { host, tab } = await allowed({ manualPrune: false })
    open.push({ host, tab })
    expect(tab.injected().hooks.enabled.getSnapshot()).toBe(false)
  })
})

describe('票 06 第 5 条：开关可翻转并持久', () => {
  it('翻转派发写操作，且用同一个 settings 文档重挂载 host 半后解析出的配置等于新值', async () => {
    const { host, tab, writes } = await allowed({ manualPrune: true })
    open.push({ host, tab })
    const container = await tab.render()
    const control = container.querySelector('[role="switch"]')
    expect(control).not.toBeNull()
    expect(control!.getAttribute('aria-checked')).toBe('true')

    await fireEvent.click(control!)
    await Promise.resolve()

    // ① 写操作被派发（观察面是「写到了哪份文档」，不是「调用发生过」）。
    expect(writes).toHaveLength(1)
    expect(writes[0]!.ns).toBe(PREFERENCE_NAMESPACE)

    // ② 重挂载 host 半（同一个 settings 文档）后解析出的 `Config` 里那个布尔等于新值。
    await tab.dispose()
    await host.dispose()
    open.splice(0, open.length)
    const remounted = await bootSettingsHost({ dir: host.dir })
    try {
      expect(remounted.manualPrune()).toBe(false)
    } finally {
      await remounted.dispose()
    }
  })
})

describe('票 06 第 6 条：翻转只写这一个字段', () => {
  it('派发的写操作恰一次、路径变更恰一条，命名空间里别的键逐一不变', async () => {
    const { host, tab, writes } = await allowed({ manualPrune: true })
    open.push({ host, tab })
    const container = await tab.render()
    await fireEvent.click(container.querySelector('[role="switch"]')!)
    await Promise.resolve()

    expect(writes).toHaveLength(1)
    expect(writes[0]!.ops).toHaveLength(1)
    expect(writes[0]!.ops[0]).toMatchObject({ op: 'set', path: ['manualPrune'], value: false })

    await tab.dispose()
    await host.dispose()
    open.splice(0, open.length)
    const remounted = await bootSettingsHost({ dir: host.dir })
    try {
      // 别的键（非 volatile 的数值）逐一不变，只有开关换了值。
      expect([...remounted.ctx.loader.entries()].find(entry => entry.options.id === PREFERENCE_NAMESPACE)?.options.config)
        .toMatchObject({ everySteps: 50, keepRecentSteps: 10, manualPrune: false })
      expect(remounted.manualPrune()).toBe(false)
    } finally {
      await remounted.dispose()
    }
  })
})

describe('票 06 第 7 条：写回被拒绝时界面显示失败', () => {
  it('Host 业务拒绝（陈旧 revision）后该行出现 role="alert"，且开关不保持在新值', async () => {
    const { host, tab, writes } = await allowed({ manualPrune: true })
    open.push({ host, tab })
    const container = await tab.render()

    // 用两次带外写把该命名空间的 revision 推到客户端镜像之后（值转一圈回到 `true`，所以「界面该显示什么」
    // 不与客户端这次要写的新值重合）：客户端下一次写带着陈旧 revision，被 Host 以业务拒绝结算——
    // `ConfigForm.set` 于是 resolve `false`（不是 reject，也不抛）。
    await host.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['manualPrune'], value: false }], undefined)
    await host.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['manualPrune'], value: true }], undefined)

    await fireEvent.click(container.querySelector('[role="switch"]')!)
    await waitFor(() => { expect(container.querySelector('[role="alert"]')).not.toBeNull() })
    // 这一条同时钉住「拒绝」这个词的取值：Host 给的是业务拒绝，不是抛错。
    expect(writes).toHaveLength(1)
    expect(writes[0]!.ok).toBe(false)
    expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })
})
