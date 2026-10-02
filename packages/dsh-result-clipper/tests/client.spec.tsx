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

/**
 * 取某一行文案对应的那个开关：把「行文案」与「该行写哪个字段」绑在一起。
 * @param container - 渲染出来的页面。
 * @param label - 该行的标题文案。
 * @returns 该行里的开关元素。
 */
function rowSwitch(container: HTMLElement, label: string): Element {
  const section = [...container.querySelectorAll('section')].find(node => node.textContent?.includes(label))
  if (section === undefined) throw new Error(`fixture: no switch row labelled ${label}`)
  const control = section.querySelector('[role="switch"]')
  if (control === null) throw new Error(`fixture: the row labelled ${label} has no switch`)
  return control
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
    // 三个开关各自都在**自己那一行**里，行文案与控件成对出现。
    expect(rowSwitch(container, '工具结果摘要')).not.toBeNull()
    expect(rowSwitch(container, '隐私闸门')).not.toBeNull()
    expect(rowSwitch(container, 'debug 记录')).not.toBeNull()
  })

  it('点摘要开关写 summarize=true，点隐私开关写 privacyGate=true（各写各的字段）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    // 按**行文案**点，而不是按 DOM 次序：把两行文案对调、或把某行接到别的字段，都会在这里变红。
    await fireEvent.click(rowSwitch(container, '工具结果摘要'))
    await fireEvent.click(rowSwitch(container, '隐私闸门'))
    expect(fixture.form.writes).toEqual([
      { field: 'summarize', value: true },
      { field: 'privacyGate', value: true },
    ])
    // 写入落在同一个 settings section 上，下一次读快照就是新值（不需要重启）。
    expect(fixture.form.value).toMatchObject({ summarize: true, privacyGate: true, debug: false })
    // 读回绑定也要落到各自的字段上：只断言写入数组的话，把某个 hook 映射到别的字段仍会绿。
    expect(face.hooks.summarize.getSnapshot()).toBe(true)
    expect(face.hooks.privacyGate.getSnapshot()).toBe(true)
    expect(face.hooks.debug.getSnapshot()).toBe(false)
  })

  it('读数订阅在写入后收到通知（页面读的就是被写的那几个字段）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    const notified: boolean[] = []
    const off = face.hooks.summarize.subscribe(() => { notified.push(face.hooks.summarize.getSnapshot()) })
    await fireEvent.click([...container.querySelectorAll('[role="switch"]')][0]!)
    off()
    expect(notified).toEqual([true])
  })

  it('debug 开关写 debug=true', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    await fireEvent.click(rowSwitch(container, 'debug 记录'))
    expect(fixture.form.writes).toEqual([{ field: 'debug', value: true }])
    expect(face.hooks.debug.getSnapshot()).toBe(true)
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

describe('票 02 第 2 条 / 票 03 第 8 条：debug 路径与摘要参数在详情卡片上', () => {
  /** 按详情卡片页的形状渲染一次，返回容器与注入面。 */
  async function renderPage(): Promise<{ fixture: ClientFixture & { readonly form: StubForm }, container: HTMLElement, face: ResultClipperCardInjected }> {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.item')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = { view: 'page', t: fixture.t, ...boundHooks(face.hooks), setField: face.setField, resetSummaryPrompt: face.resetSummaryPrompt } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)
    return { fixture, container, face }
  }

  it('summary 视图只给一行简介，不渲染输入控件', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.item')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = { view: 'summary', t: fixture.t, ...boundHooks(face.hooks), setField: face.setField, resetSummaryPrompt: face.resetSummaryPrompt } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).toBe(fixture.t('description'))
  })

  it('page 视图显示「摘要会把工具正文发送给所选 route」与 schema 的默认值', async () => {
    const { container } = await renderPage()
    expect(container.textContent).toContain('摘要会把工具正文发送给所选 route')
    // 默认值来自 schema：阈值 1024 / 12500，摘要请求默认关闭推理。
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLInputElement).value).toBe('1024')
    expect((container.querySelector('#plugin-config-result-clipper-max-summarize') as HTMLInputElement).value).toBe('12500')
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('编辑主 route 与两个阈值后各写回自己的字段', async () => {
    const { fixture, container } = await renderPage()
    const provider = container.querySelector('#plugin-config-result-clipper-route-provider')!
    const model = container.querySelector('#plugin-config-result-clipper-route-model')!
    const min = container.querySelector('#plugin-config-result-clipper-min-inline')!
    const max = container.querySelector('#plugin-config-result-clipper-max-summarize')!

    await fireEvent.change(provider, { target: { value: 'local' } })
    await fireEvent.blur(provider)
    await fireEvent.change(model, { target: { value: 'qwen' } })
    await fireEvent.blur(model)
    await fireEvent.change(min, { target: { value: '256' } })
    await fireEvent.blur(min)
    await fireEvent.change(max, { target: { value: '9000' } })
    await fireEvent.blur(max)

    expect(fixture.form.writes).toEqual([
      { field: 'routeProvider', value: 'local' },
      { field: 'routeModel', value: 'qwen' },
      { field: 'minInlineTokens', value: 256 },
      { field: 'maxSummarizeTokens', value: 9000 },
    ])
    expect(fixture.form.value).toMatchObject({ routeProvider: 'local', minInlineTokens: 256, maxSummarizeTokens: 9000 })
  })

  it('点「关闭推理」开关写 summaryDisableReasoning=false', async () => {
    const { fixture, container } = await renderPage()
    await fireEvent.click(container.querySelector('[role="switch"]')!)
    expect(fixture.form.writes).toEqual([{ field: 'summaryDisableReasoning', value: false }])
  })

  it('编辑摘要提示词失焦写 summaryPrompt；「恢复默认」清掉该字段的覆盖', async () => {
    const { fixture, container } = await renderPage()
    const prompt = container.querySelector('#plugin-config-result-clipper-summary-prompt')!
    await fireEvent.change(prompt, { target: { value: '只看目标' } })
    await fireEvent.blur(prompt)
    expect(fixture.form.writes).toEqual([{ field: 'summaryPrompt', value: '只看目标' }])

    // 上一次写入把它自己置成 busy（按钮被禁用）直到 promise 结算，等一个宏任务让 busy 落下。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // `Switch` 也是 button，所以按文案取「恢复默认」那一个。
    const reset = [...container.querySelectorAll('button')]
      .find(button => button.textContent === fixture.t('resetPrompt'))
    if (reset === undefined) throw new Error('fixture: no reset button')
    await fireEvent.click(reset)
    expect(fixture.form.resets).toEqual(['summaryPrompt'])
    expect(fixture.form.value.summaryPrompt).toBe('')
  })

  it('page 视图渲染路径输入框，编辑后失焦写回 debugPath', async () => {
    const { fixture, container } = await renderPage()
    const input = container.querySelector('#plugin-config-result-clipper-debug-path')!
    await fireEvent.change(input, { target: { value: '/tmp/other.jsonl' } })
    await fireEvent.blur(input)
    expect(fixture.form.writes).toEqual([{ field: 'debugPath', value: '/tmp/other.jsonl' }])
    expect(fixture.form.value.debugPath).toBe('/tmp/other.jsonl')
  })

  it('Host 拒绝路径写入时卡片显示 role="alert"', async () => {
    const { fixture, container } = await renderPage()
    fixture.form.accepted = false
    const input = container.querySelector('#plugin-config-result-clipper-debug-path')!
    await fireEvent.change(input, { target: { value: '/tmp/x.jsonl' } })
    await fireEvent.blur(input)
    await Promise.resolve()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
