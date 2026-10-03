// @vitest-environment jsdom
/**
 * 票 02 第 2 条：设置页里的两个开关（以及 debug 开关与路径）与保存即生效。
 *
 * 观察面分两层：注册层断言两处座位与它们的 id / 页签名 / 包名键（`settings.plugins.tab` 一个页签放开关，
 * `plugins.bundle.config` 以包名为键放参数）；控件层把注册面注入的业务面按渲染机的形状绑定到组件上，断言点了
 * 开关就写对应字段、Host 拒绝时出现 `role="alert"`、路径输入失焦即写。
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
import type { ClientFixture, StubForm, StubSection } from './support/client.ts'

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

  it('包详情页配置区以包名为键注册一个参数页，与 profile 里的包名逐字相同', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.bundle.config')
    expect(entry.options.key).toBe('@dsh-clipclop/dsh-result-clipper')
  })
})

describe('票 02 第 2 条：两个开关可分别开关，保存即生效', () => {
  it('页面上有摘要、摘要准入判断、隐私闸门、debug、干跑五个开关，初始都读 host 的默认值（关闭）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    const switches = [...container.querySelectorAll('[role="switch"]')]
    expect(switches).toHaveLength(5)
    expect(switches.map(control => control.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'false', 'false'])
    expect(container.textContent).toContain('工具结果摘要')
    expect(container.textContent).toContain('摘要准入判断')
    expect(container.textContent).toContain('隐私闸门')
    expect(container.textContent).toContain('debug 记录')
    expect(container.textContent).toContain('干跑')
    // 五个开关各自都在**自己那一行**里，行文案与控件成对出现。
    expect(rowSwitch(container, '工具结果摘要')).not.toBeNull()
    expect(rowSwitch(container, '摘要准入判断')).not.toBeNull()
    expect(rowSwitch(container, '隐私闸门')).not.toBeNull()
    expect(rowSwitch(container, 'debug 记录')).not.toBeNull()
    expect(rowSwitch(container, '干跑')).not.toBeNull()
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

  it('点摘要准入判断开关写 admissionJudge=true（不是摘要或隐私那一路）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    await fireEvent.click(rowSwitch(container, '摘要准入判断'))
    expect(fixture.form.writes).toEqual([{ field: 'admissionJudge', value: true }])
    // 读回绑定也要落在准入那个字段上：只断言写入数组的话，把 hook 映射到别的字段仍会绿。
    expect(face.hooks.admissionJudge.getSnapshot()).toBe(true)
    expect(face.hooks.summarize.getSnapshot()).toBe(false)
    expect(face.hooks.privacyGate.getSnapshot()).toBe(false)
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

describe('票 02 第 2 条 / 票 03 第 8 条 / 票 06 / 票 07：debug 路径与摘要、准入、隐私参数在包详情页配置区上', () => {
  /**
   * 按配置区页的形状渲染一次，返回容器与注入面。
   * @param initial - 渲染前先写进 settings 替身的取值（常驻警告这类静态状态的用例要用它）。
   */
  async function renderPage(
    initial: Partial<StubSection> = {},
  ): Promise<{ fixture: ClientFixture & { readonly form: StubForm }, container: HTMLElement, face: ResultClipperCardInjected }> {
    const fixture = await mounted()
    fixture.form.value = { ...fixture.form.value, ...initial }
    const entry = only(fixture, 'plugins.bundle.config')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = {
      view: 'page',
      t: fixture.t,
      ...boundHooks(face.hooks),
      setField: face.setField,
      resetSummaryPrompt: face.resetSummaryPrompt,
      resetAdmissionPrompt: face.resetAdmissionPrompt,
      resetPrivacyPrompt: face.resetPrivacyPrompt,
    } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)
    return { fixture, container, face }
  }

  /**
   * 某一行提示词里的「恢复默认」按钮。同一张卡片有多份提示词、按钮文案相同，所以按文本域所在的那一行取。
   * @param container - 渲染出来的页面。
   * @param textareaId - 该行文本域的 id。
   * @param label - 按钮文案。
   * @returns 该行里的恢复默认按钮。
   */
  function promptReset(container: HTMLElement, textareaId: string, label: string): Element {
    const section = container.querySelector(`#${textareaId}`)?.closest('section')
    const button = [...(section?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === label)
    if (button === undefined) throw new Error(`fixture: no reset button in row ${textareaId}`)
    return button
  }

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
    await fireEvent.click(promptReset(container, 'plugin-config-result-clipper-summary-prompt', fixture.t('resetPrompt')))
    expect(fixture.form.resets).toEqual(['summaryPrompt'])
    expect(fixture.form.value.summaryPrompt).toBe('')
  })

  it('编辑准入 route 与「关闭推理」开关后各写回自己的字段（不是摘要那一路）', async () => {
    const { fixture, container } = await renderPage()
    const provider = container.querySelector('#plugin-config-result-clipper-admission-provider')!
    const model = container.querySelector('#plugin-config-result-clipper-admission-model')!
    await fireEvent.change(provider, { target: { value: 'local' } })
    await fireEvent.blur(provider)
    await fireEvent.change(model, { target: { value: 'small' } })
    await fireEvent.blur(model)
    expect(fixture.form.writes).toEqual([
      { field: 'admissionProvider', value: 'local' },
      { field: 'admissionModel', value: 'small' },
    ])
    // 卡片上三个「关闭推理」开关（摘要 / 准入 / 隐私）：默认都关推理（aria-checked=true），各自只写自己那一路的字段。
    const initials = [...container.querySelectorAll('[role="switch"]')] as HTMLElement[]
    expect(initials.map(control => control.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
    await fireEvent.click(initials[0]!)
    expect(fixture.form.writes.at(-1)).toEqual({ field: 'summaryDisableReasoning', value: false })
    // 第一次点击后 React 重渲染，重新取一次第二批控件（不拿旧节点引用）。
    const after = [...container.querySelectorAll('[role="switch"]')] as HTMLElement[]
    await fireEvent.click(after[1]!)
    expect(fixture.form.writes.at(-1)).toEqual({ field: 'admissionDisableReasoning', value: false })
  })

  it('编辑准入提示词失焦写 admissionPrompt；「恢复默认」清掉该字段的覆盖', async () => {
    const { fixture, container } = await renderPage()
    const prompt = container.querySelector('#plugin-config-result-clipper-admission-prompt')!
    await fireEvent.change(prompt, { target: { value: '只看体积与工具名' } })
    await fireEvent.blur(prompt)
    expect(fixture.form.writes).toEqual([{ field: 'admissionPrompt', value: '只看体积与工具名' }])

    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await fireEvent.click(promptReset(container, 'plugin-config-result-clipper-admission-prompt', fixture.t('resetPrompt')))
    expect(fixture.form.resets).toEqual(['admissionPrompt'])
    expect(fixture.form.value.admissionPrompt).toBe('')
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

  it('勾选「主 route 已确认为本地」写 routeConfirmedLocal=true', async () => {
    const { fixture, container } = await renderPage()
    const confirmed = container.querySelector('#plugin-config-result-clipper-route-confirmed input')!
    expect((confirmed as HTMLInputElement).checked).toBe(false)
    await fireEvent.click(confirmed)
    expect(fixture.form.writes).toEqual([{ field: 'routeConfirmedLocal', value: true }])
    expect(fixture.form.value.routeConfirmedLocal).toBe(true)
  })

  it('失败策略默认读 schema 的放行；点「拦截」写 failurePolicy=block', async () => {
    const { fixture, container } = await renderPage()
    const control = container.querySelector('#plugin-config-result-clipper-failure-policy')!
    const tabs = (): Element[] => [...control.querySelectorAll('[role="tab"]')]
    // 阳性对照：默认选中的是「放行原文」，说明这条控件绑在失败策略上而不是随便两个按钮。
    expect(tabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])

    const block = tabs().find(tab => tab.textContent === fixture.t('failurePolicyBlock'))!
    await fireEvent.click(block)
    expect(fixture.form.writes).toEqual([{ field: 'failurePolicy', value: 'block' }])
    expect(fixture.form.value.failurePolicy).toBe('block')
  })

  it('隐私「关闭推理」开关默认关推理；点它写 privacyDisableReasoning=false', async () => {
    const { fixture, container } = await renderPage()
    const switches = [...container.querySelectorAll('[role="switch"]')] as HTMLElement[]
    // 摘要、准入、隐私三路各一个开关，默认都关推理。
    expect(switches.map(control => control.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
    await fireEvent.click(switches[2]!)
    expect(fixture.form.writes).toEqual([{ field: 'privacyDisableReasoning', value: false }])
  })

  it('编辑隐私提示词失焦写 privacyPrompt；「恢复默认」清掉该字段的覆盖', async () => {
    const { fixture, container } = await renderPage()
    const prompt = container.querySelector('#plugin-config-result-clipper-privacy-prompt')!
    await fireEvent.change(prompt, { target: { value: '只按我定义的机密判断' } })
    await fireEvent.blur(prompt)
    expect(fixture.form.writes).toEqual([{ field: 'privacyPrompt', value: '只按我定义的机密判断' }])

    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await fireEvent.click(promptReset(container, 'plugin-config-result-clipper-privacy-prompt', fixture.t('resetPrompt')))
    expect(fixture.form.resets).toEqual(['privacyPrompt'])
    expect(fixture.form.value.privacyPrompt).toBe('')
  })

  it('隐私开启且主 route 未确认为本地时显示常驻警告；确认后或关闭隐私开关后消失', async () => {
    const warned = await renderPage({ privacyGate: true, routeConfirmedLocal: false })
    expect(warned.container.textContent).toContain(warned.fixture.t('routeUnconfirmedWarning'))

    const confirmed = await renderPage({ privacyGate: true, routeConfirmedLocal: true })
    expect(confirmed.container.textContent).not.toContain(confirmed.fixture.t('routeUnconfirmedWarning'))

    const off = await renderPage({ privacyGate: false, routeConfirmedLocal: false })
    expect(off.container.textContent).not.toContain(off.fixture.t('routeUnconfirmedWarning'))
  })
})

describe('票 08 第 1 条：干跑开关与「干跑不生效」提示', () => {
  /**
   * 按页签的形状渲染一次。
   * @param initial - 渲染前先写进 settings 替身的取值（干跑提示这类静态状态的用例要用它）。
   */
  async function renderTab(
    initial: Partial<StubSection> = {},
  ): Promise<{ fixture: ClientFixture & { readonly form: StubForm }, container: HTMLElement, face: ResultClipperTabInjected }> {
    const fixture = await mounted()
    fixture.form.value = { ...fixture.form.value, ...initial }
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)
    return { fixture, container, face }
  }

  it('点干跑开关写 dryRun=true（不是 debug 那一路）', async () => {
    const { fixture, container, face } = await renderTab()
    await fireEvent.click(rowSwitch(container, '干跑'))
    expect(fixture.form.writes).toEqual([{ field: 'dryRun', value: true }])
    // 读回绑定也要落在干跑那个字段上：只断言写入数组的话，把 hook 映射到别的字段仍会绿。
    expect(face.hooks.dryRun.getSnapshot()).toBe(true)
    expect(face.hooks.debug.getSnapshot()).toBe(false)
  })

  it('干跑开启而 debug 关闭或日志路径为空时提示不生效；两者都就位后提示消失', async () => {
    const noDebug = await renderTab({ dryRun: true, debug: false, debugPath: '/tmp/dry.jsonl' })
    expect(noDebug.container.textContent).toContain(noDebug.fixture.t('dryRunInactiveHint'))

    const noPath = await renderTab({ dryRun: true, debug: true, debugPath: '' })
    expect(noPath.container.textContent).toContain(noPath.fixture.t('dryRunInactiveHint'))

    const ready = await renderTab({ dryRun: true, debug: true, debugPath: '/tmp/dry.jsonl' })
    expect(ready.container.textContent).not.toContain(ready.fixture.t('dryRunInactiveHint'))

    // 阳性对照：干跑没开时这一行根本不该出现提示（否则上一条断的就只是「这行文案一直在」）。
    const off = await renderTab({ dryRun: false, debug: false, debugPath: '' })
    expect(off.container.textContent).not.toContain(off.fixture.t('dryRunInactiveHint'))
  })
})
