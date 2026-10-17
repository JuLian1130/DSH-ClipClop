// @vitest-environment jsdom
/**
 * 票 19 第 7 条：设置页的写入只走 volatile 路径——在**客户端提交边界**注入一条非 volatile 字段的 `set`，宿主
 * 必须拒绝这次写入，既不生效也不落盘，页面要给出失败提示（静默忽略、或先写后报错的实现即红）。
 *
 * 为什么必须注在提交边界：`card.tsx` 的提交只枚举该组的字段表，草稿里多带一个键**不会**生成写操作；所以拿不到
 * 「页面自己写了一个非 volatile 字段」这种输入，只能把多出来的 op 加在卡片交出的 `saveFields` 上。
 *
 * 宿主是真的：一条真 profile（真 `settings` + 真 `configEditor` + 真 Loader），非 volatile 字段的拒绝来自
 * `settings.mutate` 自己的 volatile 校验。夹具只把客户端的远端表单换成了这个真宿主的写入口。
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResultClipperCardInjected, ResultClipperCardProps, ResultClipperSettingOp } from '../src/client/card.tsx'
import { CONDENSE_DEFAULTS } from '../src/condense.ts'
import { zh } from '../src/client/locales.ts'
import { SECTION_DEFAULTS, mountClient } from './support/client.ts'
import type { ClientFixture, StubForm } from './support/client.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'

const open: Array<ClientFixture & { readonly form: StubForm }> = []
const profiles: LiveFixture[] = []

afterEach(async () => {
  cleanup()
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  await Promise.all(profiles.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

afterAll(() => { cleanupProfiles() })

/**
 * 按渲染机的形状把 `hooks.<key>` 绑成 `use<Key>`（与 `client.spec.tsx` 同一份最小形状）。
 * @param hooks - 注册面注入的读数。
 * @returns 以 `use<Key>` 为键的 props 片段。
 */
function boundHooks(hooks: Record<string, ObservableSnapshot<unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(hooks).map(([key, source]) => [
    `use${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    <Selected,>(selector: (value: unknown) => Selected): Selected =>
      useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot())),
  ]))
}

/**
 * 装出「真宿主 + 浏览器半夹具」：客户端表单的 `mutate` 接到真 `ctx.settings` 上，渲染整张卡片。
 * @param inject - 是否在卡片的提交边界上多带一条非 volatile 字段的 `set`。
 * @returns 宿主、客户端夹具与渲染出来的页面。
 */
async function mounted(inject = true) {
  const host = await bootProfile({ summarize: false, privacyGate: false })
  profiles.push(host)
  const client = await mountClient()
  open.push(client)
  // 只替换写入口，读数仍用替身（这一段测的是写入被拒后的页面表现，不是读回）。
  client.form.value = { ...SECTION_DEFAULTS, summarize: true, privacyGate: false }
  client.form.mutate = async (ops) =>
    host.ctx.settings.mutate(PREFERENCE_NAMESPACE, ops as readonly ResultClipperSettingOp[]).then(() => true)

  const entry = client.entries('plugins.bundle.config')[0]!
  const face = entry.options.inject!() as ResultClipperCardInjected
  const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
  /** 卡片的提交边界：`inject` 时多带一条非 volatile 字段的 `set`（页面自己永远生成不出这一条）。 */
  const submit = (ops: readonly ResultClipperSettingOp[]): Promise<boolean> => face.saveFields(
    inject ? [...ops, { op: 'set', path: ['condenseMinUnits'], value: 7 }] : ops,
  )
  const props = {
    view: 'page',
    t: client.t,
    ...boundHooks(face.hooks),
    saveFields: submit,
    refreshModelCatalog: face.refreshModelCatalog,
  } as unknown as ResultClipperCardProps
  const { container } = render(<CardComponent {...props} />)
  return { host, client, container, face }
}

describe('票 19 第 7 条：写非 volatile 字段被宿主拒绝，页面给出失败提示', () => {
  it('在提交边界多带一条 condenseMinUnits 的 set：宿主拒绝、取值与 profile 文件都不变、页面出现失败提示', async () => {
    const { host, container } = await mounted()
    const before = readFileSync(host.patchPath)
    const toggle = (): HTMLInputElement =>
      container.querySelector('#plugin-config-result-clipper-condense input') as HTMLInputElement

    expect(toggle().checked).toBe(true)
    expect(host.plain.condenseMinUnits).toBe(CONDENSE_DEFAULTS.minUnits)

    // 点「工具结果精简」＝一次单字段立即写入；注入的多余 op 与它同属一次原子写入，宿主整次拒掉。
    await fireEvent.click(toggle())
    // 真实宿主写完才 resolve：等到失败提示出现，再断言「一条都没生效」。
    await waitFor(() => { expect(container.querySelector('[role="alert"]')?.textContent).toBe(zh.failedHint) })
    // 被拒的写入一条都没生效：运行时取值与 profile 文件逐字不变。
    expect(host.config.condense.get()).toBe(true)
    expect(host.plain.condenseMinUnits).toBe(CONDENSE_DEFAULTS.minUnits)
    expect(readFileSync(host.patchPath).equals(before)).toBe(true)
    // 页面不装作已生效。
    expect(toggle().checked).toBe(true)
  })

  it('阳性对照：同一条提交边界、不带那一条时写入被接受并落盘', async () => {
    const { host, container } = await mounted(false)
    const before = readFileSync(host.patchPath)
    const toggle = (): HTMLInputElement =>
      container.querySelector('#plugin-config-result-clipper-condense input') as HTMLInputElement
    expect(toggle().checked).toBe(true)

    // 同一个夹具、同一张卡片，只把注入的那一条去掉：这次写入必须成功，否则上一条断的只是「这个适配器总是拒绝」。
    await fireEvent.click(toggle())
    await waitFor(() => { expect(host.config.condense.get()).toBe(false) })
    expect(readFileSync(host.patchPath).equals(before)).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
