// @vitest-environment jsdom
/**
 * 票 06 第 9、10 条：置灰读数的三个分支与「置灰时不派发写入」。
 *
 * 三个事实都取自真实输入：路由目录来自真 `listConfigurableProviders()`（真 `llm-pi-ai` / `llm-deepseek`
 * 插件声明），显式 `api` 与「没有 `api` 键」都读真 settings 命名空间的值，**当前路由**取
 * `ctx.modelDirectories.directoryFor(sessionId)` 快照的 `current`（真的 `ui-model-selection` 实现）。
 *
 * 观察面写死为注册面 inject 暴露的**布尔读数**，不从 DOM 的 `disabled` 属性、颜色或文案读。正例（会话中途
 * 换过路由）钉住第三个事实的来源：catalog 的部署 `default` 指向会置灰的那条路由，耐久投影的 `next` 指向可
 * 受益的那条，读数必须跟着 `next` 走。
 *
 * @module
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { catalogOf, mountClientTab, projectionOf } from './support/client-runtime.ts'
import type { ClientTabHarness } from './support/client-runtime.ts'
import { bootSettingsHost, cleanupHosts, recordingWire, rowsWithPiAiRoutes } from './support/settings-host.ts'
import type { RecordedWrite, SettingsHost } from './support/settings-host.ts'

/** 两条显式 route 级 `api` 的 pi-ai 路由：一条可受益，一条不可。 */
const PRUNABLE_ROUTE = 'fixture-openai'
const OTHER_ROUTE = 'fixture-anthropic'

/** 记录派发出去的写操作。 */
const writes: RecordedWrite[] = []

const open: { host: SettingsHost, tab: ClientTabHarness }[] = []

afterEach(async () => {
  writes.splice(0)
  for (const entry of open.splice(0)) {
    await entry.tab.dispose()
    await entry.host.dispose()
  }
})

afterAll(() => { cleanupHosts() })

/**
 * 装一条 host + 浏览器半。
 * @param current - 会话当前路由（耐久投影的 `next`）。
 * @param deployed - catalog 的部署 `default`。
 * @returns 装配好的两侧。
 */
async function assemble(current: { provider: string, model: string }, deployed?: { provider: string, model: string }) {
  const host = await bootSettingsHost({
    rows: rowsWithPiAiRoutes(true, {
      [PRUNABLE_ROUTE]: { api: 'openai-completions', displayName: 'OpenAI Route', models: [{ id: 'm1' }] },
      [OTHER_ROUTE]: { api: 'anthropic-messages', displayName: 'Anthropic Route', models: [{ id: 'm1' }] },
    }),
  })
  const directory = host.providers()
  const tab = await mountClientTab({
    settings: recordingWire(host.wire, writes),
    providers: directory,
    catalog: catalogOf(deployed ?? current, directory.map(entry => entry.provider)),
    projection: projectionOf(current),
  })
  open.push({ host, tab })
  return { host, tab, directory }
}

/** 当前路由在真目录里的条目。 */
function entryOf(directory: readonly { provider: string, settingsNs: string, declared?: boolean }[], provider: string) {
  const entry = directory.find(candidate => candidate.provider === provider)
  if (entry === undefined) throw new Error(`host fixture: no directory entry for ${provider}`)
  return entry
}

describe('票 06 第 9 条：判不准的路由被置灰', () => {
  it('① 当前路由的命名空间是 llm-deepseek（Messages 传输）时置灰', async () => {
    const host = await bootSettingsHost()
    try {
      const directory = host.providers()
      const deepseek = entryOf(directory, 'deepseek-official')
      expect(deepseek.settingsNs).toBe('llm-deepseek')
      const tab = await mountClientTab({
        settings: host.wire,
        providers: directory,
        catalog: catalogOf({ provider: deepseek.provider, model: 'model-1' }, [deepseek.provider]),
        projection: projectionOf({ provider: deepseek.provider, model: 'model-1' }),
      })
      try {
        expect(tab.injected().hooks.disabled.getSnapshot()).toBe(true)
      } finally {
        await tab.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('② 命名空间是 llm-pi-ai 且 profile 带显式 api 时，按那个值判', async () => {
    const prunable = await assemble({ provider: PRUNABLE_ROUTE, model: 'm1' })
    expect(prunable.tab.injected().hooks.disabled.getSnapshot()).toBe(false)
    const other = await assemble({ provider: OTHER_ROUTE, model: 'm1' })
    expect(other.tab.injected().hooks.disabled.getSnapshot()).toBe(true)
  })

  it('③ 命名空间是 llm-pi-ai 但 profile 没有 api 键时置灰（判不准，保守闸门）', async () => {
    const { host, tab, directory } = await assemble({ provider: PRUNABLE_ROUTE, model: 'm1' })
    // 从真目录里取一条 **catalog 自带**的路由（`declared !== true`），把它的 profile 写进 settings——只写
    // 一个 `displayName`，不写 `api`。这就是「协议来源是 catalog 而不是 profile」的那种路由。
    const catalogRoute = directory.find(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared !== true)
    expect(catalogRoute).toBeDefined()
    await host.ctx.settings.mutate(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', catalogRoute!.provider, 'displayName'], value: 'Catalog route' }],
      undefined,
    )
    tab.push('settings/document-updated')
    await waitFor(() => { expect(tab.injected().hooks.enabled.getSnapshot()).toBe(true) })

    const switched = await assemble({ provider: catalogRoute!.provider, model: 'model-1' })
    expect(switched.tab.injected().hooks.disabled.getSnapshot()).toBe(true)
  })

  it('正例：会话中途换过路由后读到的是新路由，不是 catalog 的部署默认', async () => {
    // 部署默认指向会置灰的 llm-deepseek 路由；耐久投影的 `next` 指向可受益的 pi-ai 路由。
    const probe = await bootSettingsHost()
    const deepseek = entryOf(probe.providers(), 'deepseek-official')
    await probe.dispose()

    const { tab } = await assemble(
      { provider: PRUNABLE_ROUTE, model: 'm1' },
      { provider: deepseek.provider, model: 'model-1' },
    )
    expect(tab.injected().hooks.disabled.getSnapshot()).toBe(false)
  })
})

describe('票 06 第 10 条：置灰时不派发写入', () => {
  it('置灰为真的分支下翻转，写路径零调用（不是「调了但被 Host 拒」）', async () => {
    const host = await bootSettingsHost()
    try {
      const directory = host.providers()
      const deepseek = entryOf(directory, 'deepseek-official')
      const tab = await mountClientTab({
        settings: recordingWire(host.wire, writes),
        providers: directory,
        catalog: catalogOf({ provider: deepseek.provider, model: 'model-1' }, [deepseek.provider]),
        projection: projectionOf({ provider: deepseek.provider, model: 'model-1' }),
      })
      try {
        const container = await tab.render()
        expect(tab.injected().hooks.disabled.getSnapshot()).toBe(true)
        // 真的点一次：控件被灰时用户点不动；「只灰样式、但仍可写」的实现会在这里把写派发出去。
        await fireEvent.click(container.querySelector('[role="switch"]')!)
        await Promise.resolve()
        expect(writes).toHaveLength(0)
      } finally {
        await tab.dispose()
      }
    } finally {
      await host.dispose()
    }
  })
})
