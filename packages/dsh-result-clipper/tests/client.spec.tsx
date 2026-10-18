// @vitest-environment jsdom
/**
 * 票 02 第 2 条 / 票 28 / 票 29：设置界面只有一个**设置**座位（包详情页的配置区），另加一个只做指路的页签。
 *
 * 观察面分两层：注册层断言两处座位的键（`plugins.bundle.config` 的 key 是包名；`settings.plugins.tab` 的页签
 * 只指路、不注入业务面），控件层把注册面注入的业务面按渲染机的形状绑定到组件上，断言能力开关点了就写对应
 * 字段、Host 拒绝时出现 `role="alert"`、分组里的字段要按该组的「保存」才写回。
 *
 * 注册键与字段名都是判据的一部分：`key: '@dsh-clipclop/dsh-result-clipper'` 决定配置区落在哪个包的详情页，
 * `{ op: 'set', path: ['summarize'] }` 决定写回的是哪个 settings 键。
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
import type { ResultClipperTabProps } from '../src/client/tab.tsx'
import { DEFAULT_ADMISSION_RULE, DEFAULT_PRIVACY_RULE, DEFAULT_SUMMARY_RULE } from '../src/rules.ts'
import { Config } from '../src/config.ts'
import { en, zh } from '../src/client/locales.ts'
import { mountClient } from './support/client.ts'
import type { ClientFixture, StubCatalogProvider, StubForm, StubSection } from './support/client.ts'

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
 * 按配置区的形状渲染一次：装配夹具、绑定注入面、渲染组件。
 *
 * **摘要与隐私两个能力开关默认关着**，它们关着的组不显示；这一层大多要看展开后的控件，所以默认把两个都打开，
 * 用例需要收起的状态时显式覆盖。
 * @param initial - 渲染前先写进 settings 替身的取值（已存值、常驻警告这类静态状态的用例要用它）。
 * @param catalog - 模型目录替身；不给就用夹具的默认目录。
 * @returns 夹具、容器与注入面。
 */
async function renderCard(
  initial: Partial<StubSection> = {},
  catalog?: readonly StubCatalogProvider[],
): Promise<{ fixture: ClientFixture & { readonly form: StubForm }, container: HTMLElement, face: ResultClipperCardInjected }> {
  const fixture = await mounted(catalog)
  fixture.form.value = { ...fixture.form.value, summarize: true, privacyGate: true, ...initial }
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

/** 一次点击后等异步写入结算并让重渲染落定。 */
const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })

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

/** 装一份夹具并登记收场。 */
async function mounted(catalog?: readonly StubCatalogProvider[]): Promise<ClientFixture & { readonly form: StubForm, readonly catalogCalls: () => number }> {
  const fixture = catalog === undefined ? await mountClient() : await mountClient(catalog)
  open.push(fixture)
  return fixture
}

/** 取某个槽位唯一的注册条目。 */
function only(fixture: ClientFixture, slot: string) {
  const entries = fixture.entries(slot)
  expect(entries).toHaveLength(1)
  return entries[0]!
}

describe('票 02 第 2 条 / 票 28 / 票 29：设置座位只有一个，另加一个指路页签', () => {
  it('配置区以包名为键注册，与 profile 里的包名逐字相同', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'plugins.bundle.config')
    expect(entry.options.key).toBe('@dsh-clipclop/dsh-result-clipper')
  })

  it('「设置 → 内置插件」里保留一个页签：id 与页签名（随语言切换）都是写死的', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    expect(entry.options.id).toBe('result-clipper')
    expect(entry.options.locale).toBe('resultClipper')
    const label = entry.options.label as () => string
    expect(label()).toBe('工具结果裁剪')
    fixture.setLocale('en')
    expect(label()).toBe('Result clipper')
  })

  it('那个页签只指路：一句话、没有任何控件，也不注入业务面', async () => {
    const fixture = await mounted()
    const entry = only(fixture, 'settings.plugins.tab')
    // 不注入业务面：这一页没有可写的东西，也就没有「点一下写哪个字段」这回事。
    expect(entry.options.inject).toBeUndefined()
    const TabComponent = entry.component as ComponentType<ResultClipperTabProps>
    const { container } = render(<TabComponent {...{ t: fixture.t } as unknown as ResultClipperTabProps} />)

    expect(container.textContent).toBe(fixture.t('tabPointer'))
    // 阴性对照：一个控件都没有——否则用户又会在这一页上看到按了没反应的开关。
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0)
    expect(container.querySelectorAll('input, textarea, select, button')).toHaveLength(0)
    // 这句话只回答「去哪设」：点明目的地（侧边栏「插件」页里这个插件的详情页）。
    expect(fixture.t('tabPointer')).toContain('插件')
    expect(fixture.t('tabPointer')).toContain('详情页')
    // 页面上不解释这个界面为什么这样安排（那是对开发者说的话，规则见 AGENTS.md「插件页面文案」）：
    // 上一版那句「这一页不放开关——它们离开自己的 route 或日志路径按不动」就是被这条判据删掉的。
    expect(fixture.t('tabPointer')).not.toContain('不放开关')
    expect(fixture.t('tabPointer')).not.toContain('按不动')
  })
})

describe('票 02 第 2 条 / 票 28：能力开关保存即生效，诊断组的开关随该组保存', () => {
  it('摘要开关默认不勾；点一下当场写回 summarize=true，不经过任何「保存」', async () => {
    const { fixture, container } = await renderCard({ summarize: false })
    const toggle = container.querySelector('#plugin-config-result-clipper-summarize input') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await fireEvent.click(toggle)
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['summarize'], value: true }]])
    expect(fixture.form.value.summarize).toBe(true)
  })

  it('隐私闸门开关默认不勾、就在隐私组之上：勾上当场写回并展开那一组，取消勾选再收起', async () => {
    const { fixture, container } = await renderCard({ privacyGate: false, privacyConfirmedLocal: true })
    const toggle = (): HTMLInputElement =>
      container.querySelector('#plugin-config-result-clipper-privacy-enabled input') as HTMLInputElement
    // 关着时整组（标题、route、确认位、失败策略、提示词与它的保存 / 恢复默认）都不在 DOM 上。
    expect(toggle().checked).toBe(false)
    expect(container.querySelector('#plugin-config-result-clipper-privacy-provider')).toBeNull()
    expect([...container.querySelectorAll('h4')].map(node => node.textContent)).not.toContain(fixture.t('privacyGroup'))
    // 开关不在那一组里：否则取消勾选会把承载「保存」按钮的那一组连开关一起收起。
    expect(container.querySelector('#plugin-config-result-clipper-privacy-enabled')).not.toBeNull()

    await fireEvent.click(toggle())
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['privacyGate'], value: true }]])
    expect(fixture.form.value.privacyGate).toBe(true)
    expect(container.querySelector('#plugin-config-result-clipper-privacy-provider')).not.toBeNull()

    await fireEvent.click(toggle())
    await settle()
    expect(container.querySelector('#plugin-config-result-clipper-privacy-provider')).toBeNull()
  })

  it('摘要与隐私两个开关各写各的字段，读回也落在各自字段上', async () => {
    const { fixture, container, face } = await renderCard({ summarize: false, privacyGate: false })
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summarize input')!)
    await settle()
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-privacy-enabled input')!)
    await settle()
    expect(fixture.form.mutations).toEqual([
      [{ op: 'set', path: ['summarize'], value: true }],
      [{ op: 'set', path: ['privacyGate'], value: true }],
    ])
    // 读回绑定也要落到各自的字段上：只断言写入的话，把某个 hook 映射到别的字段仍会绿。
    expect(face.hooks.summarize.getSnapshot()).toBe(true)
    expect(face.hooks.privacyGate.getSnapshot()).toBe(true)
    expect(face.hooks.debug.getSnapshot()).toBe(false)
  })

  it('Host 业务拒绝（resolve false）时该开关下面出现 role="alert"，快照仍是旧值', async () => {
    // 两个开关都关着：页面上不该有别的 alert（隐私开着又没确认本地时顶部就有一条常驻警告）。
    const { fixture, container } = await renderCard({ summarize: false, privacyGate: false })
    fixture.form.accepted = false
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summarize input')!)
    await settle()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    // 被拒绝时不装作已生效：快照仍是旧值。
    expect(fixture.form.value.summarize).toBe(false)
  })

  it('诊断组的 debug 与干跑是草稿：点开关一个字段都不落盘，点该组「保存」才一次写回', async () => {
    const { fixture, container } = await renderCard()
    const debug = container.querySelector('#plugin-config-result-clipper-debug input') as HTMLInputElement
    const dryRun = container.querySelector('#plugin-config-result-clipper-dry-run input') as HTMLInputElement
    expect(debug.checked).toBe(false)
    expect(dryRun.checked).toBe(false)

    await fireEvent.click(debug)
    await fireEvent.click(dryRun)
    expect(fixture.form.mutations).toEqual([])
    expect(debug.checked).toBe(true)

    await fireEvent.click(groupButton(container, '诊断', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['debug'], value: true },
      { op: 'set', path: ['dryRun'], value: true },
    ]])
    expect(fixture.form.value).toMatchObject({ debug: true, dryRun: true })
  })

  it('干跑没在跑时给出提示：读的是已保存的 debug 与日志路径，两者都就位后消失', async () => {
    const noDebug = await renderCard({ dryRun: true, debug: false, debugPath: '/tmp/dry.jsonl' })
    expect(noDebug.container.textContent).toContain(noDebug.fixture.t('dryRunInactiveHint'))

    const noPath = await renderCard({ dryRun: true, debug: true, debugPath: '' })
    expect(noPath.container.textContent).toContain(noPath.fixture.t('dryRunInactiveHint'))

    const ready = await renderCard({ dryRun: true, debug: true, debugPath: '/tmp/dry.jsonl' })
    expect(ready.container.textContent).not.toContain(ready.fixture.t('dryRunInactiveHint'))

    // 阳性对照：干跑没开时不该出现这句提示（否则上一条断的就只是「这行文案一直在」）。
    const off = await renderCard({ dryRun: false, debug: false, debugPath: '' })
    expect(off.container.textContent).not.toContain(off.fixture.t('dryRunInactiveHint'))
  })
})

describe('票 02 第 2 条 / 票 03 第 8 条 / 票 06 / 票 07 / 票 12：配置区的分组草稿与保存', () => {
  /** 这一组用例的入口名：与顶层的 {@link renderCard} 是同一份实现（默认展开摘要与隐私两组）。 */
  const renderPage = renderCard

  it('page 视图显示数据流向与端点归属提示，控件读 schema 的默认值', async () => {
    // 准入组默认是收起的，要看到它的控件得先启用（默认折叠的用例在下面单列）。
    const { container, fixture } = await renderPage({ ruleSummary: true, admissionJudge: true })
    expect(container.textContent).toContain('摘要与隐私会分别把工具正文发送给它们各自所选的模型')
    // 端点与凭据不在本插件：顶部提示把用户指到「设置 → 模型」，三个 provider 行同样各指一次。
    expect(container.textContent).toContain(fixture.t('modelSourceHint'))
    expect(container.textContent).toContain('设置 → 模型')
    // 默认值来自 schema：阈值 512 / 12500；三个角色的推理档位默认是空串＝「不推理」（具体 id 按 route 的档位表在
    // 请求前解析，所以控件上显示的是空项）。
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLInputElement).value).toBe('512')
    expect((container.querySelector('#plugin-config-result-clipper-max-summarize') as HTMLInputElement).value).toBe('12500')
    for (const role of ['summary', 'admission', 'privacy']) {
      expect((container.querySelector(`#plugin-config-result-clipper-${role}-effort`) as HTMLSelectElement).value).toBe('')
    }
  })

  it('三个角色各自成组：每组的 route、推理档位与该角色的其余设置都在同一个标题下，组间用长横线隔开', async () => {
    const { fixture, container } = await renderPage({ ruleSummary: true, admissionJudge: true })
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
    // 两个能力开关都在各自那一组之上（不在任何组里）；摘要组还带两个阈值；隐私组带确认位与失败策略；
    // 诊断组放 debug 与干跑两个开关加它们的日志路径。
    for (const id of ['summarize', 'privacy-enabled']) {
      expect(container.querySelector(`#plugin-config-result-clipper-${id}`)).not.toBeNull()
    }
    const summary = groupOf(container, '摘要模型')
    expect(summary.querySelector('#plugin-config-result-clipper-min-inline')).not.toBeNull()
    expect(summary.querySelector('#plugin-config-result-clipper-max-summarize')).not.toBeNull()
    const privacy = groupOf(container, '隐私闸门模型')
    expect(privacy.querySelector('#plugin-config-result-clipper-privacy-confirmed')).not.toBeNull()
    expect(privacy.querySelector('#plugin-config-result-clipper-webfetch-gate')).not.toBeNull()
    expect(privacy.querySelector('#plugin-config-result-clipper-failure-policy')).not.toBeNull()
    const diagnostics = groupOf(container, '诊断')
    for (const id of ['debug', 'dry-run', 'debug-path']) {
      expect(diagnostics.querySelector(`#plugin-config-result-clipper-${id}`)).not.toBeNull()
    }
    // 两个能力开关都不在任何一组里：否则它们会被自己折叠起来。
    expect(groupOf(container, '摘要模型').querySelector('#plugin-config-result-clipper-summarize')).toBeNull()
    expect(groupOf(container, '隐私闸门模型').querySelector('#plugin-config-result-clipper-privacy-enabled')).toBeNull()
    // 位置契约：两个精简开关排在诊断分组之后（配置区末尾），子开关紧跟总开关。
    const ordered = [...container.querySelectorAll('[id^="plugin-config-result-clipper-"]')].map(node => node.id)
    expect(ordered.indexOf('plugin-config-result-clipper-condense'))
      .toBeLessThan(ordered.indexOf('plugin-config-result-clipper-condense-by-command'))
    expect(ordered.lastIndexOf('plugin-config-result-clipper-debug-path'))
      .toBeLessThan(ordered.indexOf('plugin-config-result-clipper-condense'))
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
    const { container } = await renderPage({ ruleSummary: true, admissionJudge: true })
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

  it('三态默认「不自动摘要」：准入组不出现；选「先判断再摘要」要按摘要组的「保存」才写回两个字段并展开准入组', async () => {
    const { fixture, container } = await renderPage()
    // 默认停在第一项；准入组（标题、route、档位、提示词与它的保存 / 恢复默认）都不在 DOM 上。
    expect(container.querySelector('#plugin-config-result-clipper-summary-mode-off')!.getAttribute('aria-selected')).toBe('true')
    expect([...container.querySelectorAll('h4')].map(node => node.textContent))
      .not.toContain(fixture.t('admissionGroup'))

    // 选「先判断再摘要」只改草稿：两个字段都不落盘，准入组也还不展开。
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summary-mode-gated')!)
    expect(fixture.form.mutations).toEqual([])
    expect([...container.querySelectorAll('h4')].map(node => node.textContent))
      .not.toContain(fixture.t('admissionGroup'))

    // 保存摘要组：一次原子写回两个字段；准入组随已保存值展开。
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['ruleSummary'], value: true },
      { op: 'set', path: ['admissionJudge'], value: true },
    ]])
    expect(fixture.form.value).toMatchObject({ ruleSummary: true, admissionJudge: true })
    expect(groupOf(container, '摘要准入判断模型')).toBeDefined()
  })

  it('已保存的「先判断再摘要」展开准入组，缩排比摘要组再退一级', async () => {
    const { container } = await renderPage({ ruleSummary: true, admissionJudge: true })
    expect(container.querySelector('#plugin-config-result-clipper-summary-mode-gated')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('#plugin-config-result-clipper-admission-provider')).not.toBeNull()
    expect(container.querySelector('#plugin-config-result-clipper-admission-prompt')).not.toBeNull()

    // 从属关系用缩排表示，每级 32px（16px 在真机上几乎看不出来）：摘要组与隐私组各比自己的开关退一级；
    // 准入组是摘要组的下属，再退一级。
    expect((groupOf(container, '摘要模型').parentElement as HTMLElement).style.marginLeft).toBe('32px')
    expect((groupOf(container, '隐私闸门模型').parentElement as HTMLElement).style.marginLeft).toBe('32px')
    expect((groupOf(container, '摘要准入判断模型').parentElement as HTMLElement).style.marginLeft).toBe('64px')
    // 诊断组没有上级开关，顶格。
    expect((groupOf(container, '诊断').parentElement as HTMLElement).style.marginLeft).toBe('')
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
    const { fixture, container } = await renderPage({ ruleSummary: true, admissionJudge: true, routeProvider: 'local', routeModel: 'qwen3' })
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

  it('四个按钮向原语要的是同一套样式：两组动作 outline + md，两处小入口 outline + sm（小入口也要边框）', async () => {
    const { container, fixture } = await renderPage()
    // 期望值由原语自己算出来（同一个 Button、同一组 props），**不写死它的 CSS module 类名**：DSH 那边重命名
    // 不会让本插件的用例变红，但「这里到底要了哪个 variant / size」仍然被钉住——退回裸 `<button>` 或者换档
    // 都会和这份参考类名不等。
    const classesFor = (variant: 'outline' | 'ghost', size: 'md' | 'sm'): string => {
      const one = render(<Button variant={variant} size={size}>参考</Button>)
      return one.container.querySelector('button')!.className
    }
    const actions = classesFor('outline', 'md')
    // 小入口与动作按钮同一个 variant、只是小一号：ghost 没有边框，用户看不到那是一个按钮。
    const entries = classesFor('outline', 'sm')
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
    // 自动摘要三态：说明它管的是"主模型没主动请求摘要"的那些结果，默认停在「不自动摘要」。
    expect(fixture.t('ruleSummaryHint')).toContain('非主模型主动请求')
    expect(fixture.t('ruleSummaryHint')).toContain('默认选「不自动摘要」')
    expect(fixture.t('summaryModeOff')).toBe('不自动摘要')
    expect(fixture.t('summaryModeDirect')).toBe('直接摘要')
    expect(fixture.t('summaryModeGated')).toBe('先判断再摘要')

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
    // 三态控件的三个选项名也在这一份字典里。
    expect(en.summaryModeOff).toContain('auto-summarize')
    expect(en.summaryModeDirect).toContain('directly')
    expect(en.summaryModeGated).toContain('first')
    for (const hint of ['modelSourceHint', 'summaryGroupHint', 'admissionGroupHint', 'privacyGroupHint'] as const) {
      expect(en[hint]).not.toContain('role')
    }
    expect(en.minInlineTokens).toContain('tokens')
    expect(en.maxSummarizeTokens).toContain('tokens')
    expect(en.privacyConfirmedLocalHint).toContain('invalidates the confirmation')
    expect(en.ruleSummaryHint).toContain('did not ask to summarize')
    expect(en.ruleSummaryHint).toContain('Don’t auto-summarize')

    // 页面上渲染的就是这些文案（简介与阈值标题都进了 DOM）。
    expect(groupOf(container, '摘要模型').textContent).toContain(fixture.t('summaryGroupHint'))
    expect(groupOf(container, '隐私闸门模型').textContent).toContain(fixture.t('privacyGroupHint'))
    expect(container.textContent).toContain(fixture.t('minInlineTokens'))
    expect(container.textContent).toContain(fixture.t('maxSummarizeTokens'))
  })

  it('provider 与 model 是下拉框：候选来自 DSH 已配置的 route，model 候选跟着该角色的 provider 走', async () => {
    const { fixture, container } = await renderPage({ ruleSummary: true, admissionJudge: true })
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
    // 摘要总开关默认关着会把摘要组折起来，这一组的用例要展开后的控件。
    fixture.form.value = { ...fixture.form.value, summarize: true }
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
    // 准入组只在三态为「先判断再摘要」时展开，它是否可保存的那条断言要先把组展开。
    const { fixture, container } = await renderPage({ ruleSummary: true, admissionJudge: true })
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

    // 档位的内置默认是空串＝「不推理」（具体发哪个 id 由该 route 的档位表在请求前决定）。
    expect((container.querySelector('#plugin-config-result-clipper-summary-effort') as HTMLSelectElement).value).toBe('')
    expect((container.querySelector('#plugin-config-result-clipper-min-inline') as HTMLInputElement).value).toBe('512')
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
    const { fixture, container } = await renderPage({ ruleSummary: true, admissionJudge: true })
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

  it('摘要总开关默认关着：摘要组（含三态与保存 / 恢复默认）整组不出现；打开后组回来，准入组仍要选「先判断再摘要」并保存才出现', async () => {
    const off = await renderPage({ summarize: false })
    expect((off.container.querySelector('#plugin-config-result-clipper-summarize input') as HTMLInputElement).checked).toBe(false)
    expect(off.container.querySelector('#plugin-config-result-clipper-route-provider')).toBeNull()
    expect(off.container.querySelector('#plugin-config-result-clipper-summary-prompt')).toBeNull()
    expect(off.container.querySelector('#plugin-config-result-clipper-summary-mode')).toBeNull()
    // 「摘要模型」「摘要准入判断模型」两个标题与它们底部的保存按钮都不在页面上。
    const titles = [...off.container.querySelectorAll('h4')].map(node => node.textContent)
    expect(titles).not.toContain(off.fixture.t('summaryGroup'))
    expect(titles).not.toContain(off.fixture.t('admissionGroup'))
    expect(off.container.textContent).toContain(off.fixture.t('summarizeOffHint'))
    // 隐私组与诊断组不受总开关影响。
    expect(off.container.querySelector('#plugin-config-result-clipper-privacy-confirmed')).not.toBeNull()
    expect(off.container.querySelector('#plugin-config-result-clipper-debug-path')).not.toBeNull()

    await fireEvent.click(off.container.querySelector('#plugin-config-result-clipper-summarize input')!)
    await settle()
    expect(groupOf(off.container, '摘要模型')).toBeDefined()
    // 三态默认停在「不自动摘要」，准入组不展开；选「先判断再摘要」并保存摘要组后它才回来。
    expect(off.container.querySelector('#plugin-config-result-clipper-summary-mode-off')!.getAttribute('aria-selected')).toBe('true')
    expect([...off.container.querySelectorAll('h4')].map(node => node.textContent))
      .not.toContain(off.fixture.t('admissionGroup'))
    await fireEvent.click(off.container.querySelector('#plugin-config-result-clipper-summary-mode-gated')!)
    await fireEvent.click(groupButton(off.container, '摘要模型', off.fixture.t('saveGroup')))
    await settle()
    expect(groupOf(off.container, '摘要准入判断模型')).toBeDefined()
  })

  it('摘要总开关保存即生效（不走分组草稿）：点一下当场写回，不需要按任何「保存」', async () => {
    const { fixture, container } = await renderPage({ summarize: false })
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summarize input')!)
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['summarize'], value: true }]])
  })

  it('摘要总开关被 Host 拒绝时当场给出提示，不装作已生效', async () => {
    // 隐私也关掉：页面上不该有别的 alert，这一条断的才是这个开关自己的失败提示。
    const { fixture, container } = await renderPage({ summarize: false, privacyGate: false })
    fixture.form.accepted = false
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summarize input')!)
    await settle()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(fixture.form.value.summarize).toBe(false)
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

  it('三态默认「不自动摘要」：选「直接摘要」后随摘要组一次写回 ruleSummary', async () => {
    const { fixture, container } = await renderPage()
    expect(container.querySelector('#plugin-config-result-clipper-summary-mode-off')!.getAttribute('aria-selected')).toBe('true')
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summary-mode-direct')!)
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[{ op: 'set', path: ['ruleSummary'], value: true }]])
  })

  it('旧存值 (ruleSummary=false, admissionJudge=true) 按「不自动摘要」显示；改选任一态后两字段按三态归一', async () => {
    const { fixture, container } = await renderPage({ ruleSummary: false, admissionJudge: true })
    expect(container.querySelector('#plugin-config-result-clipper-summary-mode-off')!.getAttribute('aria-selected')).toBe('true')
    expect([...container.querySelectorAll('h4')].map(node => node.textContent))
      .not.toContain(fixture.t('admissionGroup'))

    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summary-mode-direct')!)
    await fireEvent.click(groupButton(container, '摘要模型', fixture.t('saveGroup')))
    await settle()
    expect(fixture.form.mutations).toEqual([[
      { op: 'set', path: ['ruleSummary'], value: true },
      { op: 'set', path: ['admissionJudge'], value: false },
    ]])
    expect(fixture.form.value).toMatchObject({ ruleSummary: true, admissionJudge: false })
  })

  it('镜像里没有这两个键时按 host 的默认显示「不自动摘要」（老版本存过的 section 不变样）', async () => {
    const { container } = await renderPage({
      ruleSummary: undefined as unknown as boolean,
      admissionJudge: undefined as unknown as boolean,
    })
    expect(container.querySelector('#plugin-config-result-clipper-summary-mode-off')!.getAttribute('aria-selected')).toBe('true')
  })

  it('三态为「不自动摘要」时用不到那段规则正文：文本域只读、灰字并给出原因，选另两项才可编辑', async () => {
    const { fixture, container } = await renderPage()
    const field = (): HTMLTextAreaElement =>
      container.querySelector('#plugin-config-result-clipper-summary-prompt') as HTMLTextAreaElement
    expect(field().disabled).toBe(true)
    // 灰字：这段现在用不上一眼要看得出来。用字色而不是底色——浅色主题里 `bg-layer-2` 与 `bg-layer-1` 同值。
    expect(field().style.color).toBe('var(--dsw-alias-label-tertiary)')
    expect(field().style.cursor).toBe('not-allowed')
    expect(container.textContent).toContain(fixture.t('summaryPromptInactive'))

    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-summary-mode-direct')!)
    expect(field().disabled).toBe(false)
    expect(field().style.color).toBe('var(--dsw-alias-label-primary)')
    expect(field().style.cursor).toBe('')
    expect(container.textContent).not.toContain(fixture.t('summaryPromptInactive'))
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

describe('推理档位：候选来自 route 声明的档位表（目录里那条模型的 reasoning）', () => {
  /** 一份目录：同一 route 下三种模型——cline-pass 词表、deepseek 词表、不提供档位。 */
  const catalog: readonly StubCatalogProvider[] = [
    {
      id: 'local',
      name: '本地 route',
      models: [
        {
          id: 'gateway',
          name: 'Gateway',
          reasoning: { efforts: [{ id: 'none', name: 'None' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
        {
          id: 'deepseek',
          name: 'DeepSeek',
          reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
        { id: 'plain', name: 'Plain' },
      ],
    },
  ]

  const SUMMARY_EFFORT = 'plugin-config-result-clipper-summary-effort'
  const ADMISSION_EFFORT = 'plugin-config-result-clipper-admission-effort'
  const PRIVACY_EFFORT = 'plugin-config-result-clipper-privacy-effort'

  /** 某个档位下拉的选项（值 + 显示文本）。 */
  const options = (container: HTMLElement, id: string): { value: string; label: string }[] =>
    [...(container.querySelector(`#${id}`) as HTMLSelectElement).options]
      .map(option => ({ value: option.value, label: option.textContent ?? '' }))

  it('候选恰是该模型声明的档位（标签取声明名）；留空显示的就是会落成的那一档，且它不重复出现', async () => {
    const { container } = await renderPage({ routeProvider: 'local', routeModel: 'gateway' }, catalog)

    expect(options(container, SUMMARY_EFFORT)).toEqual([
      { value: 'none', label: 'None' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ])
    // 留空＝不推理：控件上选中的就是插件会落成的 `none`（供应商给的名字），不另造一个「不推理（None）」的空项。
    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('none')
    // 阴性对照：这台 route 的词表里没有 off，所以它不该出现在候选里。
    expect(options(container, SUMMARY_EFFORT).some(option => option.value === 'off')).toBe(false)
  })

  it('换成声明 off 的模型：出现 Off、不出现 None', async () => {
    const { container } = await renderPage({ routeProvider: 'local', routeModel: 'deepseek' }, catalog)

    expect(options(container, SUMMARY_EFFORT)).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ])
    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('off')
    expect(options(container, SUMMARY_EFFORT).some(option => option.label.includes('None'))).toBe(false)
  })

  it('表里没有 off/none 时，留空显示的是已知次序里最低的那一档（不是声明的第一个）', async () => {
    const highLow: readonly StubCatalogProvider[] = [{
      id: 'local',
      name: '本地 route',
      models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }],
    }]
    const { container } = await renderPage({ routeProvider: 'local', routeModel: 'm' }, highLow)

    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('low')
  })

  it('模型不提供推理档位：控件禁用、只剩一条说明', async () => {
    const { container } = await renderPage({ routeProvider: 'local', routeModel: 'plain' }, catalog)
    const control = container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement

    expect(control.disabled).toBe(true)
    expect(options(container, SUMMARY_EFFORT)).toEqual([{ value: '', label: '当前模型未提供推理等级' }])
  })

  it('配置里存着这条 route 不接受的档位：候选仍是声明的那些，显示按会落成的那一档（那个值不会被下发）', async () => {
    const { container } = await renderPage(
      { routeProvider: 'local', routeModel: 'gateway', summaryReasoningEffort: 'medium' },
      catalog,
    )

    expect(options(container, SUMMARY_EFFORT).map(option => option.value)).toEqual(['none', 'low', 'high'])
    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('none')
  })

  it('目录里查不到这条 route：退回静态兜底词表，值原样保留', async () => {
    const { container } = await renderPage(
      { routeProvider: 'ghost', routeModel: 'nope', summaryReasoningEffort: 'low' },
      catalog,
    )

    const list = options(container, SUMMARY_EFFORT)
    expect(list[0]).toEqual({ value: '', label: '不推理' })
    expect(list.slice(1).map(option => option.value))
      .toEqual(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('low')
  })

  it('三个 role 各按各自 route 的档位表算（留空时跟随摘要 route）', async () => {
    const { container } = await renderPage(
      {
        ruleSummary: true, admissionJudge: true, privacyGate: true,
        routeProvider: 'local', routeModel: 'gateway',
        admissionProvider: 'local', admissionModel: 'deepseek',
        privacyProvider: 'local', privacyModel: 'plain',
      },
      catalog,
    )

    expect((container.querySelector(`#${SUMMARY_EFFORT}`) as HTMLSelectElement).value).toBe('none')
    expect(options(container, ADMISSION_EFFORT).map(option => option.value)).toEqual(['off', 'low', 'high'])
    expect((container.querySelector(`#${ADMISSION_EFFORT}`) as HTMLSelectElement).value).toBe('off')
    expect((container.querySelector(`#${PRIVACY_EFFORT}`) as HTMLSelectElement).disabled).toBe(true)
  })
})

})

describe('票 15/16/17：精简参数只写在配置文件里，设置页上没有它们', () => {
  it('19 个非 volatile 字段在页面上没有任何控件（阴性对照），既有控件照旧渲染', async () => {
    const { container, face } = await renderCard()
    const ids = [...container.querySelectorAll('[id]')].map(node => node.getAttribute('id') ?? '')

    // 阳性对照：页面确实把既有配置项渲染成了控件，否则下面几条阴性断言是空转的。
    expect(ids).toContain('plugin-config-result-clipper-min-inline')

    // 这些字段是非 volatile（只影响配置文件里的 A/B）：页面上既没有它们的控件，id 里也不出现它们的名字。
    // 前六个是票 15 的通用参数，接着四个是票 16 的 `git diff` 族，最后九个是票 17 的两族（开关与参数）。
    // 页面上那两个总开关（`condense` / `condenseByCommand`）是 volatile、控件归票 19，不在这一批里。
    for (const field of [
      'condense-min-units',
      'condense-min-net-gain-units',
      'condense-head-lines',
      'condense-tail-lines',
      'condense-max-lines',
      'condense-max-line-chars',
      'condense-git-diff',
      'condense-git-diff-max-hunk-lines',
      'condense-git-diff-max-lines',
      'condense-git-diff-leading-context',
      'condense-sed-window',
      'condense-sed-window-head-lines',
      'condense-sed-window-tail-lines',
      'condense-sed-window-min-lines',
      'condense-raw-dump',
      'condense-raw-dump-head-lines',
      'condense-raw-dump-tail-lines',
      'condense-raw-dump-min-lines',
      'condense-raw-dump-hits',
    ]) {
      expect(ids.some(id => id.includes(field))).toBe(false)
      // 读数面同样不许出现它们：页面只绑定它自己有的那两个开关（`condense` / `condenseByCommand`）。
      expect(Object.keys(face.hooks)).not.toContain(field.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()))
    }
  })
})


describe('票 19：设置页上的两个精简开关与整页文案', () => {
  it('两个开关都在页面上，默认值读得出来：两个都勾着', async () => {
    const { fixture, container } = await renderCard({ privacyGate: false })
    const master = (): HTMLInputElement =>
      container.querySelector('#plugin-config-result-clipper-condense input') as HTMLInputElement
    const byCommand = (): HTMLInputElement | null =>
      container.querySelector('#plugin-config-result-clipper-condense-by-command input') as HTMLInputElement | null

    expect(master().checked).toBe(true)
    expect(byCommand()?.checked).toBe(true)
    // 两个开关各自带一句「按自己的需求该怎么设」。
    expect(container.textContent).toContain(fixture.t('condenseHint'))
    expect(container.textContent).toContain(fixture.t('condenseByCommandHint'))
  })

  it('镜像里没有这两个键时也读 host 半 schema 的默认（两个都开）', async () => {
    const { container } = await renderCard({
      privacyGate: false,
      condense: undefined as unknown as boolean,
      condenseByCommand: undefined as unknown as boolean,
    })
    expect((container.querySelector('#plugin-config-result-clipper-condense input') as HTMLInputElement).checked).toBe(true)
    expect((container.querySelector('#plugin-config-result-clipper-condense-by-command input') as HTMLInputElement).checked).toBe(true)
  })

  it('两个开关都保存即生效：各点一下当场写回一个字段，不经过任何「保存」', async () => {
    const { fixture, container } = await renderCard({ privacyGate: false })
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-condense-by-command input')!)
    await settle()
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-condense input')!)
    await settle()

    expect(fixture.form.mutations).toEqual([
      [{ op: 'set', path: ['condenseByCommand'], value: false }],
      [{ op: 'set', path: ['condense'], value: false }],
    ])
    expect(fixture.form.value).toMatchObject({ condense: false, condenseByCommand: false })
    // 关掉总开关后「按命令语义精简」收起：它只在总开关开着时有意义。
    expect(container.querySelector('#plugin-config-result-clipper-condense-by-command')).toBeNull()

    // 再勾回来：它跟着总开关一起回来，且读回的是已保存的取值。
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-condense input')!)
    await settle()
    expect((container.querySelector('#plugin-config-result-clipper-condense-by-command input') as HTMLInputElement).checked).toBe(false)
  })

  it('Host 拒绝时该开关下面立刻出现 role="alert"，且不装作已生效', async () => {
    const { fixture, container } = await renderCard({ privacyGate: false })
    fixture.form.accepted = false
    await fireEvent.click(container.querySelector('#plugin-config-result-clipper-condense input')!)
    await settle()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(fixture.t('failedHint'))
    expect(fixture.form.value.condense).toBe(true)
    expect((container.querySelector('#plugin-config-result-clipper-condense input') as HTMLInputElement).checked).toBe(true)
  })

  it('整页文案里没有本插件自己的参数名与机制名（机械负向检查）', () => {
    // 名字清单来自 host 半的 schema，不是手抄：新增一个精简字段这里自动跟上。
    const schemaFields = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict)
    const condenseFields = schemaFields.filter(field => field.startsWith('condense'))
    // 阳性对照：清单确实是从 schema 上取到的（21 个精简字段），否则下面的扫描是空转的。
    expect(condenseFields).toContain('condenseByCommand')
    expect(condenseFields.length).toBeGreaterThanOrEqual(21)

    // 机制名、取值名与实现细节。`route` 两本字典都禁，唯一豁免是英文的 `summaryGroupHint`——那句是用户逐字
    // 定死的文案（里面本来就有 "route"），改它就是改定死原文（票 19 备注）。
    const forbidden = [
      ...condenseFields,
      'extract', 'volatile', 'spill', 'baseURL', 'Host', '安全外壳',
      'summary-off', 'rule-summary-off', 'condense-off', 'condense-abstained', 'condense-not-shorter',
      'not-candidate', 'whole-result', 'exact-text', 'read-back', 'not-shorter', 'failed-window', 'passthrough',
    ]
    for (const [locale, dictionary] of [['zh', zh], ['en', en]] as const) {
      for (const [key, text] of Object.entries(dictionary)) {
        const banned = locale === 'en' && key === 'summaryGroupHint' ? forbidden : [...forbidden, 'route']
        for (const name of banned) {
          expect(text, `${locale}.${key} 里出现了内部名字「${name}」`).not.toContain(name)
        }
      }
    }
  })

  it('页面按字段表逐一对照：读数键与控件 id 就是这一批，差一个即红', async () => {
    const { container, face } = await renderCard({ ruleSummary: true, admissionJudge: true })
    expect(Object.keys(face.hooks).sort()).toEqual([
      'admissionJudge', 'admissionModel', 'admissionPrompt', 'admissionProvider', 'admissionReasoningEffort',
      'condense', 'condenseByCommand',
      'debug', 'debugPath', 'dryRun',
      'failurePolicy', 'maxSummarizeTokens', 'minInlineTokens', 'modelCatalog',
      'privacyConfirmedLocal', 'privacyGate', 'privacyModel', 'privacyPrompt', 'privacyProvider',
      'privacyReasoningEffort', 'routeModel', 'routeProvider', 'ruleSummary',
      'summarize', 'summaryPrompt', 'summaryReasoningEffort', 'webFetchPrivacyGate',
    ].sort())

    // 控件 id 是「哪个控件绑哪个字段」的那半边：新加控件必须同时出现在这张表上。
    const ids = new Set([...container.querySelectorAll('[id]')]
      .map(node => node.getAttribute('id') ?? '')
      .filter(id => id.startsWith('plugin-config-result-clipper-')))
    expect([...ids].sort()).toEqual([
      'plugin-config-result-clipper-summarize',
      'plugin-config-result-clipper-summary-mode',
      // 三态分段控件的三个选项各自也带一个 id（原语自己生成的）。
      'plugin-config-result-clipper-summary-mode-off',
      'plugin-config-result-clipper-summary-mode-direct',
      'plugin-config-result-clipper-summary-mode-gated',
      'plugin-config-result-clipper-route-provider',
      'plugin-config-result-clipper-route-model',
      'plugin-config-result-clipper-summary-effort',
      'plugin-config-result-clipper-min-inline',
      'plugin-config-result-clipper-max-summarize',
      'plugin-config-result-clipper-summary-prompt',
      'plugin-config-result-clipper-admission-provider',
      'plugin-config-result-clipper-admission-model',
      'plugin-config-result-clipper-admission-effort',
      'plugin-config-result-clipper-admission-prompt',
      'plugin-config-result-clipper-privacy-enabled',
      'plugin-config-result-clipper-privacy-provider',
      'plugin-config-result-clipper-privacy-model',
      'plugin-config-result-clipper-privacy-effort',
      'plugin-config-result-clipper-privacy-confirmed',
      'plugin-config-result-clipper-webfetch-gate',
      // 分段控件的两个选项各自也带一个 id（原语自己生成的）。
      'plugin-config-result-clipper-failure-policy',
      'plugin-config-result-clipper-failure-policy-passthrough',
      'plugin-config-result-clipper-failure-policy-block',
      'plugin-config-result-clipper-privacy-prompt',
      'plugin-config-result-clipper-debug',
      'plugin-config-result-clipper-dry-run',
      'plugin-config-result-clipper-debug-path',
      'plugin-config-result-clipper-condense',
      'plugin-config-result-clipper-condense-by-command',
    ].sort())
  })
})
