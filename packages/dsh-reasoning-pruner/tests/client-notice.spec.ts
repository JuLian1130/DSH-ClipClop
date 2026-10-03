// @vitest-environment jsdom
/**
 * 票 09 第 9 条：浏览器半那四条提示约束（`spec.md:216`）。
 *
 * 观察面写死为**注册面 inject 暴露的读数**与**一条真事件窗口的推送**，不从颜色或位置读。装配照
 * `tests/support/client-runtime.ts`：真渲染机、真 `ui-session`、真 slots；只有服务面是替身，事件窗口是
 * 可推送的替身（真 wire 上历史就是这么加载/追加的）。
 *
 * 四条约束各一条用例：
 *
 * - 只对**当前显示**的会话渲染（切走即收，且不为后台会话保留提示）。
 * - 同一页面打开期间**最多展示一次**（关掉之后不再回来）。
 * - **可关闭**（关闭按钮真的关掉它）。
 * - **页面重载后可再展示一次**（重新求值整份客户端 bundle = 页面重载，`shown` 随之归零）。
 *
 * @module
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { CARRIER_EVENT_TYPE } from '../src/carrier.ts'
import { catalogOf, mountClientTab } from './support/client-runtime.ts'
import type { ClientTabHarness } from './support/client-runtime.ts'
import { bootSettingsHost, cleanupHosts, rowsWithPiAiRoutes } from './support/settings-host.ts'
import type { SettingsHost } from './support/settings-host.ts'

/** 夹具自己的 pi-ai 路由（提示的判据与路由无关，这里只把装配补完整）。 */
const FIXTURE_ROUTE = 'fixture-route'

/** 一条窗口条目：本插件的**还原 + 停用**事件。 */
function suspensionEntry(seq: number): unknown {
  return {
    type: 'event',
    event: {
      type: CARRIER_EVENT_TYPE,
      seq,
      time: 0,
      data: {
        clipclop: {
          restore: [],
          provider: 'deepseek',
          model: 'deepseek-v4',
          errorCode: 'INVALID_REQUEST',
          wording: 'reasoning-content-required',
        },
      },
    },
  }
}

/** 一条窗口条目：**宿主自己**写的同类型事件（没有 `clipclop` 键）。 */
function hostEntry(seq: number): unknown {
  return {
    type: 'event',
    event: {
      type: CARRIER_EVENT_TYPE,
      seq,
      time: 0,
      data: { endpoint: 'https://api.deepseek.com/anthropic/messages', apiVersion: 'v', body: {} },
    },
  }
}

/** 装配一条会话为一页。 */
async function mounted(): Promise<{ host: SettingsHost, tab: ClientTabHarness }> {
  // 路由与提示的判据无关，但装配要完整：`providers()` 读的就是真 `llm-pi-ai` 声明的目录。
  const host = await bootSettingsHost({
    rows: rowsWithPiAiRoutes(false, {
      [FIXTURE_ROUTE]: { api: 'openai-completions', displayName: 'Fixture Route', models: [{ id: 'm1' }] },
    }),
  })
  const directory = host.providers()
  const tab = await mountClientTab({
    settings: host.wire,
    providers: directory,
    catalog: catalogOf({ provider: FIXTURE_ROUTE, model: 'm1' }, directory.map(entry => entry.provider)),
  })
  open.push({ host, tab })
  return { host, tab }
}

const open: { host: SettingsHost, tab: ClientTabHarness }[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.tab.dispose()
    await entry.host.dispose()
  }
})

afterAll(() => { cleanupHosts() })

describe('票 09 第 9 条：提示注册在 shell.overlay，且只为当前显示的会话建引用', () => {
  it('座位上有且只有一条本插件的注册；宿主同类型事件不触发', async () => {
    const { tab } = await mounted()
    const entries = tab.overlayEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe('reasoning-pruner-notice')
    // 初始不可见；宿主自己的同类型事件（没有 `clipclop` 键）推进来也不可见。
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)
    tab.publishWindow([hostEntry(1)])
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)
    // 判据非空：同一条窗口换成我们的停用事件就会可见。
    tab.publishWindow([suspensionEntry(2)])
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(true)
    // 只为**当前显示**的会话建引用，且用插件自己的 source 标签。
    expect(tab.retainCalls()).toEqual([{ id: 'session-1', source: 'reasoningPruner' }])
  })

  it('切到另一条会话即收掉；切回来也不会重新展示（每页面一次）', async () => {
    const { tab } = await mounted()
    tab.publishWindow([suspensionEntry(1)])
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(true)

    tab.selectSession('session-1-other')
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)

    tab.selectSession('session-1')
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)
  })
})

describe('票 09 第 9 条：可关闭，且关掉之后不再回来', () => {
  it('关闭按钮真的关掉它；再推一条停用事件也不会重新出现', async () => {
    const { tab } = await mounted()
    tab.publishWindow([suspensionEntry(1)])
    const container = await tab.render()
    await waitFor(() => { expect(container.textContent).toContain('The endpoint rejected the pruned history') })

    // 按 aria-label 取，不取「第一个 button」——同一棵树里还有设置页签那个 `Switch`。
    const dismiss = container.querySelector('button[aria-label="Dismiss"]')
    expect(dismiss).not.toBeNull()
    fireEvent.click(dismiss!)
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)
    await waitFor(() => { expect(container.textContent).not.toContain('The endpoint rejected the pruned history') })

    tab.publishWindow([suspensionEntry(2)])
    expect(tab.notice().hooks.visible.getSnapshot()).toBe(false)
  })
})

describe('票 09 第 9 条：页面重载后再打开该会话可再展示一次', () => {
  it('重新求值整份客户端 bundle（= 重载）之后，同一条停用事件会再展示一次', async () => {
    const first = await mounted()
    first.tab.publishWindow([suspensionEntry(1)])
    expect(first.tab.notice().hooks.visible.getSnapshot()).toBe(true)
    first.tab.notice().dismiss()
    expect(first.tab.notice().hooks.visible.getSnapshot()).toBe(false)

    // 第二个装配：模块表重新求值、插件 `apply` 再跑一次——与页面重载同义。
    const second = await mounted()
    second.tab.publishWindow([suspensionEntry(1)])
    expect(second.tab.notice().hooks.visible.getSnapshot()).toBe(true)
  })
})
