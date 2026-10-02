// @vitest-environment jsdom
/**
 * 票 02 第 2 条：设置页里的两个开关（以及 debug 开关与路径）与保存即生效。
 *
 * 观察面分两层：注册层断言两处座位与它们的 id / 页签名（`settings.plugins.tab` 一个页签放开关，`plugins.item`
 * 一张详情卡片放参数）；控件层把注册面注入的业务面按渲染机的形状绑定到组件上，断言点了开关就写对应字段、
 * Host 拒绝时出现 `role="alert"`、路径输入失焦即写。
 *
 * 注册 id、页签名与字段名都是判据的一部分：`{ id: 'result-clipper', locale }` 决定页签出现在哪里，
 * `set('summarize', true)` 决定写回的是哪个 settings 键。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResultClipperCardInjected, ResultClipperCardProps } from '../src/client/card.tsx'
import type { ResultClipperTabInjected, ResultClipperTabProps } from '../src/client/tab.tsx'
import { mountClient } from './support/client.ts'
import type { ClientFixture, StubForm } from './support/client.ts'

const open: Array<ClientFixture & { readonly form: StubForm }> = []

afterEach(async () => {
  cleanup()
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

/**
 * 按渲染机的形状把 `hooks.<key>` 绑成 `use<Key>`：夹具不求响应式，选择器直接投影当前快照。
 * @param hooks - 注册面注入的读数。
 * @returns 以 `use<Key>` 为键的 props 片段。
 */
function boundHooks(hooks: Record<string, ObservableSnapshot<unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(hooks).map(([key, source]) => [
    `use${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    <Selected,>(selector: (value: unknown) => Selected): Selected => selector(source.getSnapshot()),
  ]))
}

/** 装一份夹具并登记收场。 */
async function mounted(): Promise<ClientFixture & { readonly form: StubForm }> {
  const fixture = await mountClient()
  open.push(fixture)
  return fixture
}

/** 取某个槽位唯一的注册条目。 */
function only(fixture: ClientFixture, slot: string) {
  const entries = fixture.entries(slot)
  expect(entries).toHaveLength(1)
  return entries[0]!
}

describe('票 02 第 2 条：两处座位注册在设置页里', () => {
  it('插件页签注册一个开关页，id 与页签名（随语言切换）都是写死的', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    expect(entry.options.id).toBe('result-clipper')
    expect(entry.options.locale).toBe('resultClipper')
    const label = entry.options.label as () => string
    expect(label()).toBe('工具结果裁剪')
    fixture.setLocale('en')
    expect(label()).toBe('Result clipper')
  })

  it('插件详情卡片注册一个参数页，id 与插件本体一致', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.item')
    expect(entry.options.id).toBe('dsh-result-clipper')
    expect((entry.options.label as () => string)()).toBe('工具结果裁剪')
  })
})

describe('票 02 第 2 条：两个开关可分别开关，保存即生效', () => {
  it('页面上有摘要、隐私闸门、debug 三个开关，初始都读 host 的默认值（关闭）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    const switches = [...container.querySelectorAll('[role="switch"]')]
    expect(switches).toHaveLength(3)
    expect(switches.map(control => control.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
    expect(container.textContent).toContain('工具结果摘要')
    expect(container.textContent).toContain('隐私闸门')
    expect(container.textContent).toContain('debug 记录')
  })

  it('点摘要开关写 summarize=true，点隐私开关写 privacyGate=true（各写各的字段）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    const switches = [...container.querySelectorAll('[role="switch"]')]
    await fireEvent.click(switches[0]!)
    await fireEvent.click(switches[1]!)
    expect(fixture.form.writes).toEqual([
      { field: 'summarize', value: true },
      { field: 'privacyGate', value: true },
    ])
    // 写入落在同一个 settings section 上，下一次读快照就是新值（不需要重启）。
    expect(fixture.form.value).toMatchObject({ summarize: true, privacyGate: true, debug: false })
  })

  it('debug 开关写 debug=true', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    await fireEvent.click([...container.querySelectorAll('[role="switch"]')][2]!)
    expect(fixture.form.writes).toEqual([{ field: 'debug', value: true }])
  })

  it('Host 业务拒绝（resolve false）时该行出现 role="alert"', async () => {
    const fixture = await mounted()
    fixture.form.accepted = false
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    await fireEvent.click([...container.querySelectorAll('[role="switch"]')][0]!)
    await Promise.resolve()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    // 被拒绝时不装作已生效：快照仍是旧值。
    expect(fixture.form.value.summarize).toBe(false)
  })
})

describe('票 02 第 2 条：debug 路径参数在详情卡片上', () => {
  it('summary 视图只给一行简介，不渲染输入控件', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.item')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = { view: 'summary', t: fixture.t, ...boundHooks(face.hooks), setDebugPath: face.setDebugPath } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).toBe(fixture.t('description'))
  })

  it('page 视图渲染路径输入框，编辑后失焦写回 debugPath', async () => {
    const fixture = await mounted()
    fixture.form.value.debugPath = '/tmp/result-clipper.jsonl'
    const entry = only(fixture, 'plugins.item')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = { view: 'page', t: fixture.t, ...boundHooks(face.hooks), setDebugPath: face.setDebugPath } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)

    const input = container.querySelector('input')!
    expect(input.value).toBe('/tmp/result-clipper.jsonl')
    await fireEvent.change(input, { target: { value: '/tmp/other.jsonl' } })
    await fireEvent.blur(input)
    expect(fixture.form.writes).toEqual([{ field: 'debugPath', value: '/tmp/other.jsonl' }])
    expect(fixture.form.value.debugPath).toBe('/tmp/other.jsonl')
  })

  it('Host 拒绝路径写入时卡片显示 role="alert"', async () => {
    const fixture = await mounted()
    fixture.form.accepted = false
    const entry = only(fixture, 'plugins.item')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = { view: 'page', t: fixture.t, ...boundHooks(face.hooks), setDebugPath: face.setDebugPath } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)

    await fireEvent.change(container.querySelector('input')!, { target: { value: '/tmp/x.jsonl' } })
    await fireEvent.blur(container.querySelector('input')!)
    await Promise.resolve()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
