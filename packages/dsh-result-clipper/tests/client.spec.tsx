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
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResultClipperCardInjected, ResultClipperCardProps } from '../src/client/card.tsx'
import type { ResultClipperTabInjected, ResultClipperTabProps } from '../src/client/tab.tsx'
import { DEFAULT_ADMISSION_RULE, DEFAULT_PRIVACY_RULE, DEFAULT_SUMMARY_RULE } from '../src/rules.ts'
import { en } from '../src/client/locales.ts'
import { mountClient } from './support/client.ts'
import type { ClientFixture, StubForm, StubSection } from './support/client.ts'

const open: Array<ClientFixture & { readonly form: StubForm }> = []

afterEach(async () => {
  cleanup()
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

/**
 * 按渲染机的形状把 `hooks.<key>` 绑成 `use<Key>`：选择器从 `ObservableSnapshot` 投影当前值，并订阅它的
 * `subscribe`，所以 Host 写回后控件会重新渲染——提示词框「清掉覆盖后回落」这类判据必须观察重渲染后的控件。
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
async function mounted(): Promise<ClientFixture & { readonly form: StubForm, readonly catalogCalls: () => number }> {
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
  it('页面上有摘要、隐私闸门、debug、干跑四个开关，初始都读 host 的默认值（关闭）', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    const switches = [...container.querySelectorAll('[role="switch"]')]
    expect(switches).toHaveLength(4)
    expect(switches.map(control => control.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'false'])
    expect(container.textContent).toContain('工具结果摘要')
    expect(container.textContent).toContain('隐私闸门')
    expect(container.textContent).toContain('debug 记录')
    expect(container.textContent).toContain('干跑')
    // 四个开关各自都在**自己那一行**里，行文案与控件成对出现。
    expect(rowSwitch(container, '工具结果摘要')).not.toBeNull()
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

  it('这一页只剩四个开关：摘要准入判断的启用跟着它的 route 搬进了包详情页的准入组', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    const face = entry.options.inject!() as ResultClipperTabInjected
    const props = { t: fixture.t, ...boundHooks(face.hooks), setToggle: face.setToggle } as unknown as ResultClipperTabProps
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...props} />)

    expect([...container.querySelectorAll('[role="switch"]')]).toHaveLength(4)
    expect(container.textContent).not.toContain(fixture.t('admissionJudge'))
    // 业务面也不再读它：一个字段只有一处写入路径，不留下两套语义（这边立即写、那边要保存）。
    expect('admissionJudge' in face.hooks).toBe(false)
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

describe('票 02 第 2 条 / 票 03 第 8 条 / 票 06 / 票 07 / 票 12：配置区的分组草稿与保存', () => {
  /**
   * 按配置区页的形状渲染一次，返回容器与注入面。
   * @param initial - 渲染前先写进 settings 替身的取值（已存值、常驻警告这类静态状态的用例要用它）。
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
      saveFields: face.saveFields,
      refreshModelCatalog: face.refreshModelCatalog,
    } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)
    return { fixture, container, face }
  }

  /**
   * 标题所在的那一组：分组标题的父元素就是这一组的容器。
   * @param container - 渲染出来的页面。
   * @param title - 分组标题文案。
   * @returns 该分组的元素。
   */
  function groupOf(container: HTMLElement, title: string): Element {
    const heading = [...container.querySelectorAll('h4')].find(node => node.textContent === title)
    if (heading === undefined) throw new Error(`fixture: no group titled ${title}`)
    return heading.parentElement!
  }

  /**
   * 某组底部的「保存」或「恢复默认」按钮。
   * @param container - 渲染出来的页面。
   * @param title - 分组标题文案。
   * @param label - 按钮文案。
   * @returns 该组里的那个按钮。
   */
  function groupButton(container: HTMLElement, title: string, label: string): HTMLButtonElement {
    const button = [...groupOf(container, title).querySelectorAll('button')]
      .find(candidate => candidate.textContent === label)
    if (button === undefined) throw new Error(`fixture: no button labelled ${label} in group ${title}`)
    return button
  }

  /** 一次点击后等异步写入结算并让重渲染落定。 */
  const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })

  it('page 视图显示数据流向与端点归属提示，控件读 schema 的默认值', async () => {
    // 准入组默认是收起的，要看到它的控件得先启用（默认折叠的用例在下面单列）。
    const { container, fixture } = await renderPage({ admissionJudge: true })
    expect(container.textContent).toContain('摘要与隐私分别把工具正文发送给各自所选 route')
    // 端点与凭据不在本插件：顶部提示把用户指到「设置 → 模型」，三个 provider 行同样各指一次。
    expect(container.textContent).toContain(fixture.t('modelSourceHint'))
    expect(container.textContent).toContain('设置 → 模型')
    // 默认值来自 schema：阈值 1024 / 12500，三个角色的推理档位默认都是「不推理」。
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLInputElement).value).toBe('1024')
    expect((container.querySelector('#plugin-config-result-clipper-max-summarize') as HTMLInputElement).value).toBe('12500')
    for (const role of ['summary', 'admission', 'privacy']) {
      expect((container.querySelector(`#plugin-config-result-clipper-${role}-effort`) as HTMLSelectElement).value).toBe('off')
    }
  })

  it('三个角色各自成组：每组的 route、推理档位与该角色的其余设置都在同一个标题下，组间用长横线隔开', async () => {
    const { fixture, container } = await renderPage({ admissionJudge: true })
    for (const [title, prefix, role] of [
      ['摘要模型', 'route', 'summary'],
      ['摘要准入判断模型', 'admission', 'admission'],
      ['隐私闸门模型', 'privacy', 'privacy'],
    ] as const) {
      const group = groupOf(container, title)
      expect(group.querySelector(`#plugin-config-result-clipper-${prefix}-provider`)).not.toBeNull()
      expect(group.querySelector(`#plugin-config-result-clipper-${prefix}-model`)).not.toBeNull()
      expect(group.querySelector(`#plugin-config-result-clipper-${role}-effort`)).not.toBeNull()
      expect(group.querySelector(`#plugin-config-result-clipper-${role}-prompt`)).not.toBeNull()
    }
    // 摘要组还带该角色的两个阈值与可选参数开关；隐私组带确认位与失败策略；诊断组只放 debug 路径。
    const summary = groupOf(container, '摘要模型')
    expect(summary.querySelector('#plugin-config-result-clipper-min-inline')).not.toBeNull()
    expect(summary.querySelector('#plugin-config-result-clipper-max-summarize')).not.toBeNull()
    expect(summary.querySelector('#plugin-config-result-clipper-extract')).not.toBeNull()
    const privacy = groupOf(container, '隐私闸门模型')
    expect(privacy.querySelector('#plugin-config-result-clipper-privacy-confirmed')).not.toBeNull()
    expect(privacy.querySelector('#plugin-config-result-clipper-webfetch-gate')).not.toBeNull()
    expect(privacy.querySelector('#plugin-config-result-clipper-failure-policy')).not.toBeNull()
    expect(groupOf(container, '诊断').querySelector('#plugin-config-result-clipper-debug-path')).not.toBeNull()
    // 四个分组之间三条长横线：三个模型组各有自己的边界，诊断组同样被隔开。
    expect([...container.querySelectorAll('hr')]).toHaveLength(3)
    // 每个分组都有一行「这是做什么的」。
    for (const [title, hint] of [
      ['摘要模型', 'summaryGroupHint'],
      ['摘要准入判断模型', 'admissionGroupHint'],
      ['隐私闸门模型', 'privacyGroupHint'],
      ['诊断', 'diagnosticsGroupHint'],
    ] as const) {
      expect(groupOf(container, title).textContent).toContain(fixture.t(hint))
    }
  })

  it('一行放得下：provider、model 与推理档位同一行，摘要下限与上限同一行；控件照搬「设置 → 模型」那一页', async () => {
    const { container } = await renderPage({ admissionJudge: true })
    /** 某个控件所在的那一格（每格自己是一个 section）。 */
    const cell = (id: string): Element => container.querySelector(`#${id}`)!.closest('section')!
    const row = cell('plugin-config-result-clipper-route-provider').parentElement as HTMLElement
    expect(row).toBe(cell('plugin-config-result-clipper-route-model').parentElement)
    expect(row).toBe(cell('plugin-config-result-clipper-summary-effort').parentElement)
    expect(row.style.gridTemplateColumns).toBe('1fr 1fr 1fr')
    // 准入与隐私两组也是同一行的三格。
    expect((cell('plugin-config-result-clipper-admission-provider').parentElement as HTMLElement).style.gridTemplateColumns)
      .toBe('1fr 1fr 1fr')
    expect((cell('plugin-config-result-clipper-privacy-provider').parentElement as HTMLElement).style.gridTemplateColumns)
      .toBe('1fr 1fr 1fr')

    const pair = cell('plugin-config-result-clipper-min-inline').parentElement as HTMLElement
    expect(pair).toBe(cell('plugin-config-result-clipper-max-summarize').parentElement)
    expect(pair.style.gridTemplateColumns).toBe('1fr 1fr')

    // 控件照搬「设置 → 模型 → 提供商」那一页：同为整格宽，32px 高、0.5px 描边、同一档圆角与底色。
    for (const id of [
      'plugin-config-result-clipper-route-provider',
      'plugin-config-result-clipper-summary-effort',
      'plugin-config-result-clipper-privacy-effort',
    ]) {
      const control = container.querySelector(`#${id}`) as HTMLElement
      expect(control.style.width).toBe('100%')
      expect(control.style.height).toBe('32px')
      expect(control.style.border).toBe('0.5px solid var(--dsw-alias-border-l4)')
      expect(control.style.borderRadius).toBe('var(--dsw-radius-md)')
      expect(control.style.background).toBe('var(--dsw-alias-bg-layer-1)')
    }
    // 单行输入框与文本域是同一套外观（同一份排版常量展开出来的，不会各写各的）。
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLElement).style.height).toBe('32px')
    const textarea = container.querySelector('#plugin-config-result-clipper-summary-prompt') as HTMLElement
    expect(textarea.style.minHeight).toBe('80px')
    expect(textarea.style.height).toBe('auto')
    expect(textarea.style.padding).toBe('6px 10px')
    expect(textarea.style.resize).toBe('vertical')

    // 下拉另外三样：系统箭头换成内缩的雪佛龙、宽度封顶 240px、指针形状（值取自那一页的 `.selectInput`）。
    const select = container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLElement
    expect(select.style.appearance).toBe('none')
    expect(select.style.paddingRight).toBe('32px')
    expect(select.style.maxWidth).toBe('240px')
    expect(select.style.cursor).toBe('pointer')
    expect(select.style.backgroundImage).toContain('data:image/svg+xml')
    expect(select.style.backgroundImage).toContain('%2381858C')
    expect(select.style.backgroundRepeat).toBe('no-repeat')
    expect(select.style.backgroundSize).toBe('12px 12px')
  })

  it('准入组默认收起（收起＝不启用）：勾上启用位才出现整组设置，保存时把启用与其他改动一次写回', async () => {
    const { fixture, container } = await renderPage()
    const group = groupOf(container, '摘要准入判断模型')
    const toggle = (): HTMLInputElement =>
      group.querySelector('#plugin-config-result-clipper-admission-enabled input') as HTMLInputElement

    expect(toggle().checked).toBe(false)
    // 收起时整组设置都不在 DOM 上：route、档位、提示词一个都不渲染。
    for (const id of [
      'plugin-config-result-clipper-admission-provider',
      'plugin-config-result-clipper-admission-model',
      'plugin-config-result-clipper-admission-effort',
      'plugin-config-result-clipper-admission-prompt',
    ]) {
      expect(group.querySelector(`#${id}`)).toBeNull()
    }
    // 没勾也没改别的字段：这一组没有可保存的东西。
    expect(groupButton(container, '摘要准入判断模型', fixture.t('saveGroup')).disabled).toBe(true)

    // 勾上启用位：整组设置出现，但还只是草稿——不点保存什么都不写。
    await fireEvent.click(toggle())
    expect(group.querySelector('#plugin-config-result-clipper-admission-provider')).not.toBeNull()
    expect(group.querySelector('#plugin-config-result-clipper-admission-prompt')).not.toBeNull()
    expect(fixture.form.mutations).toEqual([])
    await fireEvent.click(groupButton(container, '摘要准入判断模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['admissionJudge'], value: true }]])
    expect(fixture.form.value.admissionJudge).toBe(true)
  })

  it('已启用的准入组直接展开：勾上启用位那里的读回落在 admissionJudge 上', async () => {
    const { container } = await renderPage({ admissionJudge: true })
    const group = groupOf(container, '摘要准入判断模型')
    expect((group.querySelector('#plugin-config-result-clipper-admission-enabled input') as HTMLInputElement).checked).toBe(true)
    expect(group.querySelector('#plugin-config-result-clipper-admission-provider')).not.toBeNull()
    expect(group.querySelector('#plugin-config-result-clipper-admission-prompt')).not.toBeNull()
  })

  it('换 provider 时 model 跟着走：不属于新 provider 的 model 被清空，不留跨 provider 的配对', async () => {
    const { fixture, container } = await renderPage({ routeProvider: 'local', routeModel: 'qwen3' })
    const provider = container.querySelector('#plugin-config-result-clipper-route-provider')!
    const model = (): HTMLSelectElement => container.querySelector('#plugin-config-result-clipper-route-model') as HTMLSelectElement
    expect(model().value).toBe('qwen3')

    // 换到另一条 route：候选跟着换，原来的 model 不属于它 → 清空，只改草稿。
    await fireEvent.change(provider, { target: { value: 'remote' } })
    expect(model().value).toBe('')
    expect([...model().querySelectorAll('option')].map(option => option.value)).toEqual(['', 'big-model'])
    expect(fixture.form.mutations).toEqual([])

    // 把 provider 清空（摘要组＝不摘要）同样不留孤儿 model。
    await fireEvent.change(provider, { target: { value: 'local' } })
    await fireEvent.change(model(), { target: { value: 'llama3' } })
    await fireEvent.change(provider, { target: { value: '' } })
    expect(model().value).toBe('')
  })

  it('隐私 route 换一半就作废「已确认为本地」：确认是对具体 route 的声明，不跟着 route 走', async () => {
    const { fixture, container } = await renderPage({
      privacyProvider: 'local', privacyModel: 'qwen3', privacyConfirmedLocal: true,
    })
    const confirmed = (): HTMLInputElement =>
      container.querySelector('#plugin-config-result-clipper-privacy-confirmed input') as HTMLInputElement
    expect(confirmed().checked).toBe(true)

    // 换成另一条 route：确认位在草稿里被清掉（host 侧只读这个布尔、不校验它对应哪条 route，
    // 沿用旧确认就会把敏感正文发往没确认过的 route）。
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-privacy-provider')!, { target: { value: 'remote' } })
    expect(confirmed().checked).toBe(false)
    await fireEvent.click(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['privacyProvider'], value: 'remote' },
      { op: 'set', path: ['privacyModel'], value: '' },
      { op: 'set', path: ['privacyConfirmedLocal'], value: false },
    ]])
    expect(fixture.form.value).toMatchObject({ privacyProvider: 'remote', privacyModel: '', privacyConfirmedLocal: false })
  })

  it('只换 model 也作废确认：同一条 provider 换模型同样是一次 route 变更', async () => {
    const { fixture, container } = await renderPage({
      privacyProvider: 'local', privacyModel: 'qwen3', privacyConfirmedLocal: true,
    })
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-privacy-model')!, { target: { value: 'llama3' } })
    expect((container.querySelector('#plugin-config-result-clipper-privacy-confirmed input') as HTMLInputElement).checked).toBe(false)
    await fireEvent.click(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['privacyModel'], value: 'llama3' },
      { op: 'set', path: ['privacyConfirmedLocal'], value: false },
    ]])
  })

  it('三个角色的下拉都能把取值清空：第一项就是清空，选中并保存后字段变空串', async () => {
    const { fixture, container } = await renderPage({ admissionJudge: true, routeProvider: 'local', routeModel: 'qwen3' })
    /** 某个下拉第一项（置空项）的文案与取值。 */
    const blankOf = (id: string): { text: string; value: string } => {
      const option = container.querySelector(`#${id}`)!.querySelector('option')! as HTMLOptionElement
      return { text: option.textContent ?? '', value: option.value }
    }
    // 摘要组清空后是「没配」；准入与隐私组清空后是「跟随摘要模型」。
    expect(blankOf('plugin-config-result-clipper-route-provider')).toEqual({ text: fixture.t('routeUnset'), value: '' })
    expect(blankOf('plugin-config-result-clipper-route-model')).toEqual({ text: fixture.t('routeUnset'), value: '' })
    expect(blankOf('plugin-config-result-clipper-admission-provider')).toEqual({ text: fixture.t('followSummaryRoute'), value: '' })
    expect(blankOf('plugin-config-result-clipper-privacy-provider')).toEqual({ text: fixture.t('followSummaryRoute'), value: '' })
    // 文案里点明这是清空动作，不是又一种选项。
    expect(fixture.t('routeUnset')).toContain('清空')
    expect(fixture.t('followSummaryRoute')).toContain('清空')

    // 清空 provider（摘要组＝不摘要）时 model 也跟着清掉，两条 op 一次写回——不留孤儿 model。
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: '' } })
    expect((container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLSelectElement).value).toBe('')
    expect((container.querySelector('#plugin-config-result-clipper-route-model') as HTMLInputElement).value).toBe('')
    expect(fixture.form.mutations).toEqual([])
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['routeProvider'], value: '' },
      { op: 'set', path: ['routeModel'], value: '' },
    ]])
    expect(fixture.form.value).toMatchObject({ routeProvider: '', routeModel: '' })
  })

  it('四个按钮向原语要的是同一套样式：两组动作 outline，两处小入口 ghost + sm', async () => {
    const { container, fixture } = await renderPage()
    // 期望值由原语自己算出来（同一个 Button、同一组 props），**不写死它的 CSS module 类名**：DSH 那边重命名
    // 不会让本插件的用例变红，但「这里到底要了哪个 variant / size」仍然被钉住——退回裸 `<button>` 或者换档
    // 都会和这份参考类名不等。
    const classesFor = (variant: 'outline' | 'ghost', size: 'md' | 'sm'): string => {
      const one = render(<Button variant={variant} size={size}>参考</Button>)
      return one.container.querySelector('button')!.className
    }
    const actions = classesFor('outline', 'md')
    const entries = classesFor('ghost', 'sm')
    for (const title of ['摘要模型', '隐私闸门模型']) {
      const save = groupButton(container, title, fixture.t('saveGroup'))
      const reset = groupButton(container, title, fixture.t('resetGroup'))
      // 仍是原生 button 语义：`type="button"`，且禁用态照旧跟着草稿的脏值走（没改动时保存不可点）。
      expect(save.tagName).toBe('BUTTON')
      expect(save.getAttribute('type')).toBe('button')
      expect(save.disabled).toBe(true)
      expect(save.className).toBe(actions)
      expect(reset.className).toBe(actions)
    }
    const custom = [...container.querySelectorAll('button')]
      .find(candidate => candidate.textContent === fixture.t('customValue'))!
    expect(custom.className).toBe(entries)
  })

  it('三个模型组的标注只用用户指定的原文（只讲带来什么），阈值单位写明 token', async () => {
    const { fixture, container } = await renderPage()
    // 这一轮用户把三条说明逐字定死，并明确「只留」这些字：多的一个「好处：/怎么设：」层级都会被这里拦下。
    expect(fixture.t('summaryGroupHint')).toBe(
      '主模型不用反复读长正文——节省缓存计费，上下文也更干净，可以提升模型效果。清空等于请求不发，结果原样透传。',
    )
    expect(fixture.t('admissionGroupHint')).toBe(
      '不值得摘要的结果不会再产生摘要请求，省下这部分 token 费用，强烈建议跟随摘要模型。不启用会直接走摘要模型。',
    )
    expect(fixture.t('privacyGroupHint')).toBe(
      '每条工具结果先判一次，判定敏感就在进主模型之前拦下，敏感内容不会发往外部网络，应该设成本地模型。',
    )
    // 卡片上的说明都不出现「角色」这类内部说法（用户在反馈里点名的就是这个口吻）。
    for (const hint of ['modelSourceHint', 'summaryGroupHint', 'admissionGroupHint', 'privacyGroupHint'] as const) {
      expect(fixture.t(hint)).not.toContain('角色')
    }
    // 两个阈值都注明单位是 token。
    expect(fixture.t('minInlineTokens')).toContain('token')
    expect(fixture.t('maxSummarizeTokens')).toContain('token')
    // 隐私确认位是对具体 route 的声明：文案要说清「换了 route 就作废」。
    expect(fixture.t('privacyConfirmedLocalHint')).toContain('作废')

    // 英文侧逐条对上中文（它不经 `fixture.t` 渲染，所以要单独断言，避免单独漂移）。
    expect(en.routeUnset).toContain('clear')
    expect(en.followSummaryRoute).toContain('clear')
    expect(en.summaryGroupHint).toContain('cache billing')
    expect(en.summaryGroupHint).toContain('improve model output')
    expect(en.summaryGroupHint).toContain('passed through unchanged')
    expect(en.admissionGroupHint).toContain('strongly recommended')
    expect(en.admissionGroupHint).toContain('follow')
    expect(en.admissionGroupHint).toContain('straight to summarization')
    expect(en.privacyGroupHint).toContain('local model')
    expect(en.privacyGroupHint).toContain('never leaves for an external network')
    expect(en.privacyGroupHint).toContain('blocked before it reaches the main model')
    // 准入的启用位是卡片上的复选框，它的文案也在这一份字典里。
    expect(en.admissionJudge).toContain('Enable')
    expect(en.admissionJudgeHint).toContain('Unchecked')
    for (const hint of ['modelSourceHint', 'summaryGroupHint', 'admissionGroupHint', 'privacyGroupHint'] as const) {
      expect(en[hint]).not.toContain('role')
    }
    expect(en.minInlineTokens).toContain('tokens')
    expect(en.maxSummarizeTokens).toContain('tokens')
    expect(en.privacyConfirmedLocalHint).toContain('invalidates the confirmation')

    // 页面上渲染的就是这些文案（简介与阈值标题都进了 DOM）。
    expect(groupOf(container, '摘要模型').textContent).toContain(fixture.t('summaryGroupHint'))
    expect(groupOf(container, '隐私闸门模型').textContent).toContain(fixture.t('privacyGroupHint'))
    expect(container.textContent).toContain(fixture.t('minInlineTokens'))
    expect(container.textContent).toContain(fixture.t('maxSummarizeTokens'))
  })

  it('provider 与 model 是下拉框：候选来自 DSH 已配置的 route，model 候选跟着该角色的 provider 走', async () => {
    const { fixture, container } = await renderPage({ admissionJudge: true })
    /** 某个下拉框当前列出的全部选项值。 */
    const optionsOf = (id: string): string[] => {
      const control = container.querySelector(`#${id}`)
      if (control === null || control.tagName !== 'SELECT') throw new Error(`fixture: ${id} is not a select`)
      return [...control.querySelectorAll('option')].map(option => (option as HTMLOptionElement).value)
    }

    // 空串那一档有自己的说法：摘要组是「未配置」，另外两组是「跟随摘要 route」。
    expect(optionsOf('plugin-config-result-clipper-route-provider')).toEqual(['', 'local', 'remote'])
    expect(optionsOf('plugin-config-result-clipper-admission-provider')).toEqual(['', 'local', 'remote'])
    expect(optionsOf('plugin-config-result-clipper-privacy-provider')).toEqual(['', 'local', 'remote'])
    // 摘要组还没选 provider：model 没有候选，控件退回手填（不是「只显示当前选择」——选了 provider 就有全量候选）。
    expect(container.querySelector('#plugin-config-result-clipper-route-model')!.tagName).toBe('INPUT')

    // 选了 provider 之后，model 列出那条 route 的全部模型；换 provider 就换一批。
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'local' } })
    expect(optionsOf('plugin-config-result-clipper-route-model')).toEqual(['', 'qwen3', 'llama3'])
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'remote' } })
    expect(optionsOf('plugin-config-result-clipper-route-model')).toEqual(['', 'big-model'])
    // 换候选只是改草稿，不写任何字段。
    expect(fixture.form.writes).toEqual([])
    expect(fixture.form.mutations).toEqual([])
  })

  it('目录外的取值不会丢：它不是当前选择也不是候选，但作为一条带后缀的选项留在下拉里', async () => {
    const { fixture, container } = await renderPage({ routeProvider: 'hand-typed' })
    const provider = container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLSelectElement
    expect(provider.value).toBe('hand-typed')
    const options = [...provider.querySelectorAll('option')]
    expect(options.map(option => option.value)).toEqual(['', 'hand-typed', 'local', 'remote'])
    expect(options[1]!.textContent).toBe(`hand-typed${fixture.t('notInCatalog')}`)
  })

  it('「自定义…」切到文本输入，「从目录里选」切回下拉；两种形态都只改草稿', async () => {
    const { fixture, container } = await renderPage()
    const rowButton = (id: string, label: string): HTMLButtonElement => {
      const section = container.querySelector(`#${id}`)!.closest('section')!
      const button = [...section.querySelectorAll('button')].find(candidate => candidate.textContent === label)
      if (button === undefined) throw new Error(`fixture: no button labelled ${label} in row ${id}`)
      return button
    }
    const providerId = 'plugin-config-result-clipper-route-provider'

    // 从下拉切到手填：控件换成文本输入，原值保留。
    await fireEvent.click(rowButton(providerId, fixture.t('customValue')))
    const typed = container.querySelector(`#${providerId}`)!
    expect(typed.tagName).toBe('INPUT')
    await fireEvent.change(typed, { target: { value: 'unlisted-route' } })
    expect((container.querySelector(`#${providerId}`) as HTMLInputElement).value).toBe('unlisted-route')

    // 切回下拉：目录可用，控件回到 select，手填的值作为「不在目录里」的一条选项留下。
    await fireEvent.click(rowButton(providerId, fixture.t('pickFromCatalog')))
    const picked = container.querySelector(`#${providerId}`) as HTMLSelectElement
    expect(picked.tagName).toBe('SELECT')
    expect([...picked.querySelectorAll('option')].map(option => option.value))
      .toEqual(['', 'unlisted-route', 'local', 'remote'])
    // 两条路都只改草稿。
    expect(fixture.form.writes).toEqual([])
    expect(fixture.form.mutations).toEqual([])
  })

  it('卡片挂载时重读一次目录：刚在「设置 → 模型」里配好的 route 能进候选', async () => {
    const fixture = await mounted()
    // 装载时读一次。
    expect(fixture.catalogCalls()).toBe(1)
    fixture.form.value = { ...fixture.form.value }
    const entry = only(fixture, 'plugins.bundle.config')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = {
      view: 'page', t: fixture.t, ...boundHooks(face.hooks), saveFields: face.saveFields,
      refreshModelCatalog: face.refreshModelCatalog,
    } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    render(<CardComponent {...props} />)
    // 挂载后再读一次。
    expect(fixture.catalogCalls()).toBe(2)
  })

  it('目录读不到时候选为空：provider 与 model 退回手填，且改 provider 不会清掉手填的 model', async () => {
    const fixture = await mountClient([])
    open.push(fixture)
    const entry = only(fixture, 'plugins.bundle.config')
    const face = entry.options.inject!() as ResultClipperCardInjected
    const props = {
      view: 'page', t: fixture.t, ...boundHooks(face.hooks), saveFields: face.saveFields,
      refreshModelCatalog: face.refreshModelCatalog,
    } as unknown as ResultClipperCardProps
    const CardComponent = entry.component as ComponentType<ResultClipperCardProps>
    const { container } = render(<CardComponent {...props} />)

    // 没有候选：两个控件都是手填输入框（不是空下拉）。
    expect(container.querySelector('#plugin-config-result-clipper-route-provider')!.tagName).toBe('INPUT')
    expect(container.querySelector('#plugin-config-result-clipper-route-model')!.tagName).toBe('INPUT')
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'hand-typed' } })
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-model')!, { target: { value: 'unlisted-model' } })
    // 换 provider 时「model 跟着走」只在有目录时不猜：目录读不到就保留手填值，否则这个部署会变成不可配置。
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'hand-typed-2' } })
    expect((container.querySelector('#plugin-config-result-clipper-route-model') as HTMLInputElement).value).toBe('unlisted-model')
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['routeProvider'], value: 'hand-typed-2' },
      { op: 'set', path: ['routeModel'], value: 'unlisted-model' },
    ]])
  })

  it('编辑只改草稿：不点该组的「保存」，一个字段都不落盘', async () => {
    const { fixture, container } = await renderPage()
    const edit = async (selector: string, value: string): Promise<void> => {
      await fireEvent.change(container.querySelector(selector)!, { target: { value } })
    }
    await edit('#plugin-config-result-clipper-route-provider', 'local')
    await edit('#plugin-config-result-clipper-route-model', 'qwen')
    await edit('#plugin-config-result-clipper-summary-effort', 'high')
    await edit('#plugin-config-result-clipper-min-inline', '256')
    await edit('#plugin-config-result-clipper-summary-prompt', '只看目标')
    await edit('#plugin-config-result-clipper-debug-path', '/tmp/other.jsonl')

    expect(fixture.form.writes).toEqual([])
    expect(fixture.form.mutations).toEqual([])
    // 草稿已经改了，所以两组的「保存」都从禁用变成可用。
    expect(groupButton(container, '摘要模型', fixture.t('saveGroup')).disabled).toBe(false)
    expect(groupButton(container, '诊断', fixture.t('saveGroup')).disabled).toBe(false)
    // 没改过的组仍没有可保存的东西。
    expect(groupButton(container, '摘要准入判断模型', fixture.t('saveGroup')).disabled).toBe(true)
  })

  it('点某组「保存」把该组全部改动作为一次原子写入提交，其它组一个字段都不写', async () => {
    const { fixture, container } = await renderPage()
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'local' } })
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-summary-effort')!, { target: { value: 'high' } })
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-min-inline')!, { target: { value: '256' } })
    // 另一组也改一个字段：它不该被摘要组的保存带走。
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-privacy-provider')!, { target: { value: 'remote' } })

    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()

    // 一次原子写入，op 顺序按该组字段表的顺序（provider、model、档位、下限、上限、提示词）。
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['routeProvider'], value: 'local' },
      { op: 'set', path: ['summaryReasoningEffort'], value: 'high' },
      { op: 'set', path: ['minInlineTokens'], value: 256 },
    ]])
    expect(fixture.form.value).toMatchObject({
      routeProvider: 'local', summaryReasoningEffort: 'high', minInlineTokens: 256, privacyProvider: '',
    })
    // 保存后草稿与已存值一致：该组的「保存」回到禁用。
    expect(groupButton(container, '摘要模型', fixture.t('saveGroup')).disabled).toBe(true)
    // 隐私组的草稿仍在（它没被保存），下一次保存只写它自己。
    expect(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')).disabled).toBe(false)
  })

  it('Host 拒绝时该组显示 role="alert"，草稿保留、已存值不变', async () => {
    const { fixture, container } = await renderPage()
    fixture.form.accepted = false
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'local' } })
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()

    expect(fixture.form.mutations).toHaveLength(1)
    expect((groupOf(container, '摘要模型').querySelector('[role="alert"]'))?.textContent).toBe(fixture.t('failedHint'))
    // 被拒绝时不装作已生效：已存值没变，用户打的草稿还在框里（可以改完重试）。
    expect(fixture.form.value.routeProvider).toBe('')
    expect((container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLInputElement).value).toBe('local')
  })

  it('「恢复默认」把推理档位、两个阈值与提示词规则正文送回内置默认（未保存前不落盘）', async () => {
    const { fixture, container } = await renderPage({
      summaryReasoningEffort: 'high', minInlineTokens: 256, maxSummarizeTokens: 9000, summaryPrompt: '旧口径',
    })
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('resetGroup')))
    await settle()

    expect((container.querySelector('#plugin-config-result-clipper-summary-effort') as HTMLSelectElement).value).toBe('off')
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLInputElement).value).toBe('1024')
    expect((container.querySelector('#plugin-config-result-clipper-max-summarize') as HTMLInputElement).value).toBe('12500')
    expect((container.querySelector('#plugin-config-result-clipper-summary-prompt') as HTMLTextAreaElement).value)
      .toBe(DEFAULT_SUMMARY_RULE)
    // 恢复默认只改草稿：没点保存就一条都不写。
    expect(fixture.form.mutations).toEqual([])
  })

  it('「恢复默认」把 provider、model 与 debug 路径送回上一次保存的值（丢掉未保存的改动）', async () => {
    const { fixture, container } = await renderPage({ routeProvider: 'local', routeModel: 'qwen3', debugPath: '/tmp/saved.jsonl' })
    const provider = container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLSelectElement
    const debugPath = container.querySelector('#plugin-config-result-clipper-debug-path') as HTMLInputElement
    await fireEvent.change(provider, { target: { value: 'remote' } })
    await fireEvent.change(debugPath, { target: { value: '/tmp/draft.jsonl' } })
    expect(provider.value).toBe('remote')

    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('resetGroup')))
    await fireEvent.click(groupButton(container, '诊断', fixture.t('resetGroup')))
    await settle()

    expect((container.querySelector('#plugin-config-result-clipper-route-provider') as HTMLSelectElement).value).toBe('local')
    expect((container.querySelector('#plugin-config-result-clipper-route-model') as HTMLSelectElement).value).toBe('qwen3')
    expect((container.querySelector('#plugin-config-result-clipper-debug-path') as HTMLInputElement).value).toBe('/tmp/saved.jsonl')
    expect(fixture.form.mutations).toEqual([])
  })

  it('提示词框显示生效正文；把覆盖改回内置正文后保存，以 unset 清掉覆盖', async () => {
    const { fixture, container } = await renderPage({ summaryPrompt: '旧口径' })
    const id = 'plugin-config-result-clipper-summary-prompt'
    const box = (): HTMLTextAreaElement => container.querySelector(`#${id}`) as HTMLTextAreaElement
    // 有覆盖时框里是覆盖正文；改回内置正文再保存等于「没有覆盖」，走 unset 而不是写一条逐字相同的覆盖。
    expect(box().value).toBe('旧口径')
    await fireEvent.change(box(), { target: { value: DEFAULT_SUMMARY_RULE } })
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()

    expect(fixture.form.mutations).toEqual([[{ op: 'unset', path: ['summaryPrompt'] }]])
    expect(fixture.form.value.summaryPrompt).toBe('')
    expect(box().value).toBe(DEFAULT_SUMMARY_RULE)
  })

  it('提示词没有覆盖时框里显示内置正文，且没改动就没有可保存的东西', async () => {
    const { fixture, container } = await renderPage({ admissionJudge: true })
    for (const [id, rule] of [
      ['plugin-config-result-clipper-summary-prompt', DEFAULT_SUMMARY_RULE],
      ['plugin-config-result-clipper-admission-prompt', DEFAULT_ADMISSION_RULE],
      ['plugin-config-result-clipper-privacy-prompt', DEFAULT_PRIVACY_RULE],
    ] as const) {
      expect((container.querySelector(`#${id}`) as HTMLTextAreaElement).value).toBe(rule)
    }
    expect(groupButton(container, '摘要模型', fixture.t('saveGroup')).disabled).toBe(true)
    expect(groupButton(container, '摘要准入判断模型', fixture.t('saveGroup')).disabled).toBe(true)
    expect(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')).disabled).toBe(true)
  })

  it('隐私组的确认位与失败策略也走草稿：点保存才把两个字段一次写回', async () => {
    const { fixture, container } = await renderPage()
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-privacy-confirmed input')!)
    const block = [...container.querySelectorAll('#plugin-config-result-clipper-failure-policy [role="tab"]')]
      .find(tab => tab.textContent === fixture.t('failurePolicyBlock'))!
    await fireEvent.click(block)
    expect(fixture.form.mutations).toEqual([])

    await fireEvent.click(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['privacyConfirmedLocal'], value: true },
      { op: 'set', path: ['failurePolicy'], value: 'block' },
    ]])
    expect(fixture.form.value).toMatchObject({ privacyConfirmedLocal: true, failurePolicy: 'block' })
  })

  it('可选参数 extract 的开关默认不勾，勾上后随摘要组一次写回', async () => {
    const { fixture, container } = await renderPage()
    const box = container.querySelector('#plugin-config-result-clipper-extract input') as HTMLInputElement
    expect(box.checked).toBe(false)
    await fireEvent.click(box)
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['extractArg'], value: true }]])
  })

  it('web_fetch 的隐私开关默认不勾，勾上后随隐私组一次写回', async () => {
    const { fixture, container } = await renderPage()
    const box = container.querySelector('#plugin-config-result-clipper-webfetch-gate input') as HTMLInputElement
    expect(box.checked).toBe(false)
    await fireEvent.click(box)
    await fireEvent.click(groupButton(container, '隐私闸门模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['webFetchPrivacyGate'], value: true }]])
  })

  it('诊断组的 debug 路径同样要点「保存」才写回', async () => {
    const { fixture, container } = await renderPage()
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-debug-path')!, { target: { value: '/tmp/other.jsonl' } })
    expect(fixture.form.mutations).toEqual([])
    await fireEvent.click(groupButton(container, '诊断', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['debugPath'], value: '/tmp/other.jsonl' }]])
    expect(fixture.form.value.debugPath).toBe('/tmp/other.jsonl')
  })

  it('数字框里不是数字时该组保存被拦下：一条都不写，只报失败', async () => {
    const { fixture, container } = await renderPage()
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-route-provider')!, { target: { value: 'local' } })
    await fireEvent.change(container.querySelector('#plugin-config-result-clipper-min-inline')!, { target: { value: 'abc' } })
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()

    // 一个字段不合法就整组不写：provider 那条也不该单独落盘。
    expect(fixture.form.mutations).toEqual([])
    expect(fixture.form.value.routeProvider).toBe('')
    expect(groupOf(container, '摘要模型').querySelector('[role="alert"]')).not.toBeNull()
  })

  it('隐私开启且隐私 route 未确认为本地时显示常驻警告；确认后或关闭隐私开关后消失', async () => {
    const warned = await renderPage({ privacyGate: true, privacyConfirmedLocal: false })
    expect(warned.container.textContent).toContain(warned.fixture.t('routeUnconfirmedWarning'))

    const confirmed = await renderPage({ privacyGate: true, privacyConfirmedLocal: true })
    expect(confirmed.container.textContent).not.toContain(confirmed.fixture.t('routeUnconfirmedWarning'))

    const off = await renderPage({ privacyGate: false, privacyConfirmedLocal: false })
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
