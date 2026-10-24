// @vitest-environment jsdom
/**
 * 票据 06：通道页。
 *
 * 观察面分两层：注册层断言页签的键与两个命名空间常量（写回用本行的 patch 行 id、只读用接入层那一行的 id），
 * 控件层把注册面注入的业务面按渲染机的形状绑到组件上，断言「选条目／切档位／开阈值都写回自己的命名空间」
 * 「跨命名空间只有读」「阈值关闭时数值控件禁用」。
 *
 * 命名空间是判据的一部分：写入替身按命名空间记账，所以「不存在写另一个命名空间的调用」是一条直接观察，
 * 而不是「代码里没写」的推断。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { name as accessLayerName } from '@dsh-clipclop/dsh-system-one'
import { name as channelName } from '../src/index.ts'
import { ENTRIES_NAMESPACE, inject as pageInject, PREFERENCE_NAMESPACE } from '../src/client/index.ts'
import { ChannelPage, type ChannelPageInjected, type ChannelPageProps } from '../src/client/page.tsx'
import { zh, en } from '../src/client/locales.ts'
import { mountClient, type ClientFixture, type StubWrite } from './support/client.ts'

const open: ClientFixture[] = []

afterEach(async () => {
  cleanup()
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

/**
 * 装一份夹具并记进清理队列。
 * @returns 装好的夹具。
 */
async function mounted(): Promise<ClientFixture> {
  const fixture = await mountClient()
  open.push(fixture)
  return fixture
}

/**
 * 按渲染机的形状把 `hooks.<key>` 绑成 `use<Key>`：选择器从 `ObservableSnapshot` 投影当前值，并订阅它的
 * `subscribe`，所以宿主写回后控件会重新渲染。
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
 * 按页签的形状渲染一次：写进两个命名空间的初始值、取注册面、绑定注入面、渲染组件。断言一律走 DOM 与写入
 * 记账，所以不需要返回值。
 * @param fixture - 已装好的浏览器半夹具。
 * @param initial - 两个命名空间的初始值（`undefined` 表示快照还没到）。
 */
function renderPage(
  fixture: ClientFixture,
  initial: { settings?: Record<string, unknown>, entries?: readonly Record<string, unknown>[] },
): void {
  fixture.forms.update(PREFERENCE_NAMESPACE, initial.settings)
  fixture.forms.update(ENTRIES_NAMESPACE, { entries: initial.entries })
  const entry = fixture.entries('settings.plugins.tab')[0]
  if (entry === undefined) throw new Error('fixture: the channel page is not registered')
  const face = entry.options.inject!() as ChannelPageInjected
  const props = { view: 'page', t: fixture.t, ...boundHooks(face.hooks), save: face.save }
  render(<ChannelPage {...(props as unknown as ChannelPageProps)} />)
}

/** 页面上「当前应用的决策模型」那张下拉。标签里还带着下面那行说明，所以按前缀匹配。 */
function targetSelect(): HTMLSelectElement {
  return screen.getAllByLabelText(new RegExp(`^${zh.target}`))[0] as HTMLSelectElement
}

/** 页面上门槛的数值框。 */
function thresholdInput(): HTMLInputElement {
  return screen.getAllByLabelText(new RegExp(`^${zh.thresholdValue}`))[0] as HTMLInputElement
}

/** 最近一次写入。 */
function lastWrite(fixture: ClientFixture): StubWrite {
  const write = fixture.forms.writes.at(-1)
  if (write === undefined) throw new Error('fixture: no write happened')
  return write
}

/** 两条同名、不同 id 的条目：显示文本要能区分。 */
const SAME_LABEL: readonly Record<string, unknown>[] = [
  { id: 'sglang_local_a1b2', label: '本地 SGLang' },
  { id: 'sglang_other_9f3c', label: '本地 SGLang' },
  { id: 'remote_1', label: '远端' },
]

describe('通道页：注册面', () => {
  it('页签注册在 settings.plugins.tab；写回与只读各用一个写死的命名空间', async () => {
    const fixture = await mounted()
    const [entry] = fixture.entries('settings.plugins.tab')

    expect(entry?.options.name).toBe('settings.plugins.tab')
    expect(entry?.options.id).toBe('decision-channel')
    expect(entry?.options.locale).toBe('systemOneChannel')
    expect((entry?.options.label as () => string)()).toBe(zh.tab)
    // 写回命名空间 = 本行 patch 的 id（也是宿主半的入口 name）。
    expect(PREFERENCE_NAMESPACE).toBe(channelName)
    expect(PREFERENCE_NAMESPACE).toBe('dsh-system-one-channel')
    // 只读命名空间 = 接入层那一行的 id。接入层自己的包装测试钉着「它的 patch 行 id 等于它的入口 name」，
    // 所以这里跟 name 比就够，不必跨包读那份 patch 文件。
    expect(ENTRIES_NAMESPACE).toBe(accessLayerName)
    expect(ENTRIES_NAMESPACE).toBe('dsh-system-one')
    // 页面只跟自己的命名空间走：接入层没装时页照常在，只是选项为空。
    expect(fixture.served).toEqual([[PREFERENCE_NAMESPACE]])
    expect(pageInject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('快照还没到时按 schema 默认值显示：没选条目、第一档、门槛关着', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: undefined, entries: undefined })

    expect(targetSelect().value).toBe('')
    expect(targetSelect().options[0]?.textContent).toBe(zh.unset)
    expect((screen.getByLabelText(zh.guidanceTool) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(zh.thresholdOn) as HTMLInputElement).checked).toBe(false)
    expect(thresholdInput().disabled).toBe(true)
  })
})

describe('通道页：当前条目', () => {
  it('选项值等于接入层 entries 的 id，显示文本是 label', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { target: 'remote_1' }, entries: SAME_LABEL })

    const select = targetSelect()
    expect([...select.options].map(option => option.value)).toEqual([
      'sglang_local_a1b2', 'sglang_other_9f3c', 'remote_1',
    ])
    expect(select.value).toBe('remote_1')
  })

  it('同名条目在显示文本里追加 id 的后四位，不同名的照旧只显示 label', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { target: 'remote_1' }, entries: SAME_LABEL })

    expect([...targetSelect().options].map(option => option.textContent)).toEqual([
      '本地 SGLang（a1b2）', '本地 SGLang（9f3c）', '远端',
    ])
  })

  it('没有可选条目时给出「去条目页登记」的提示，当前值仍显示出来', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { target: 'gone_1' }, entries: [] })

    // 下拉不能是空白的：当前配的是哪个要看得见（这里它已经不在条目列表里）。
    expect([...targetSelect().options].map(option => option.value)).toEqual(['gone_1'])
    expect(screen.getByText(zh.noEntries)).toBeTruthy()
    // 这个局面下点保存不能把当前条目写空——那是使用者没碰过的设置。
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(fixture.forms.writes).toHaveLength(0)
  })

  it('条目被删掉、只改引导：保存只写引导，不动当前条目', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { target: 'gone_1', guidance: 'tool' }, entries: [] })

    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    // 只提交改过的那一项：整份回写会把 `target` 改成空值（下拉里没有能匹配它的选项）。
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['guidance'], value: 'context' }])
  })

  it('快照还没到时只改引导：保存也只写引导，不把默认值写进配置', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: undefined, entries: undefined })

    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    // 这一页的草稿从默认值起步；整份回写会拿默认值盖掉真实配置（条目、档位、门槛三样一起）。
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['guidance'], value: 'context' }])
  })

  it('选一个条目后保存：只写 target 一项，落在自己的命名空间', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { target: 'remote_1' }, entries: SAME_LABEL })

    fireEvent.change(targetSelect(), { target: { value: 'sglang_other_9f3c' } })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(lastWrite(fixture).namespace).toBe(PREFERENCE_NAMESPACE)
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['target'], value: 'sglang_other_9f3c' }])
  })
})

describe('通道页：引导档位', () => {
  it('两个选项，切到第二档后写回档位值', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { guidance: 'tool' } })

    expect((screen.getByLabelText(zh.guidanceTool) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['guidance'], value: 'context' }])
  })
})

describe('通道页：可信度门槛', () => {
  it('关闭时数值控件禁用；开启并设值后开关与数值一次写回', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { threshold: { enabled: false, value: 0.5 } } })

    expect(thresholdInput().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(zh.thresholdOn))
    expect(thresholdInput().disabled).toBe(false)
    expect(thresholdInput().value).toBe('0.5')
    fireEvent.change(thresholdInput(), { target: { value: '0.8' } })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    // 开关与数值是同一个字段：只写其中一个会留下「开着但拿旧数值算」的状态。
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['threshold'], value: { enabled: true, value: 0.8 } }])
  })

  it('只开开关不动数值：按原来的数值一起写回', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { threshold: { enabled: false, value: 0.35 } } })

    fireEvent.click(screen.getByLabelText(zh.thresholdOn))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['threshold'], value: { enabled: true, value: 0.35 } }])
  })

  it('门槛已开着、只改数值：新数值照样写回', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { threshold: { enabled: true, value: 0.5 } } })

    fireEvent.change(thresholdInput(), { target: { value: '0.7' } })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(lastWrite(fixture).ops).toEqual([{ op: 'set', path: ['threshold'], value: { enabled: true, value: 0.7 } }])
  })

  it('保存期间三组控件与按钮都禁用：在途写入返回前，页面上看到的与配置一致', async () => {
    const fixture = await mounted()
    let release = (): void => {}
    fixture.forms.hold = new Promise<void>((resolve) => { release = () => { resolve() } })
    renderPage(fixture, {
      settings: { target: 'remote_1', guidance: 'tool', threshold: { enabled: true, value: 0.5 } },
      entries: SAME_LABEL,
    })

    // 门槛开着，所以数值框此时是可用的：下面它变灰只可能是「保存期间整组禁用」。
    expect(thresholdInput().disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))
    // 按钮换成「保存中」，三组控件整组禁用（`fieldset[disabled]`）。
    await waitFor(() => { expect(screen.getByText(zh.saving)).toBeTruthy() })
    expect(targetSelect().disabled).toBe(true)
    expect((screen.getByLabelText(zh.guidanceTool) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(zh.thresholdOn) as HTMLInputElement).disabled).toBe(true)
    expect(thresholdInput().disabled).toBe(true)

    release()
    await waitFor(() => { expect(screen.getByText(zh.save)).toBeTruthy() })
    expect(targetSelect().disabled).toBe(false)
    expect(thresholdInput().disabled).toBe(false)
    expect(fixture.forms.writes).toHaveLength(1)
  })

  it('数值越界或为空：报一句话，一条都不写', async () => {
    const fixture = await mounted()
    renderPage(fixture, { settings: { threshold: { enabled: true, value: 0.5 } } })

    for (const bad of ['1.5', '', 'abc', '-0.1']) {
      fireEvent.change(thresholdInput(), { target: { value: bad } })
      fireEvent.click(screen.getByText(zh.save))
      await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.thresholdInvalid) })
    }
    expect(fixture.forms.writes).toHaveLength(0)
  })

  it('门槛关着时那个数值不参与判定：开着填了越界值再关掉，改别的项照样能保存', async () => {
    const fixture = await mounted()
    renderPage(fixture, {
      settings: { target: 'remote_1', guidance: 'tool', threshold: { enabled: true, value: 0.5 } },
      entries: SAME_LABEL,
    })

    // 开着时填了个越界值，随后把门槛关掉：控件这时是禁用的，没法就地改。保存别的项不该被它卡死。
    fireEvent.change(thresholdInput(), { target: { value: '1.5' } })
    fireEvent.click(screen.getByLabelText(zh.thresholdOn))
    fireEvent.change(targetSelect(), { target: { value: 'sglang_other_9f3c' } })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(screen.queryByRole('alert')).toBeNull()
    // 关掉不等于把数值丢掉：按配置里原来的数值写回。
    expect(lastWrite(fixture).ops).toEqual([
      { op: 'set', path: ['target'], value: 'sglang_other_9f3c' },
      { op: 'set', path: ['threshold'], value: { enabled: false, value: 0.5 } },
    ])
  })
})

describe('通道页：写回面', () => {
  it('三项都改过时是一次原子写入，且没有任何一笔写到另一个命名空间', async () => {
    const fixture = await mounted()
    renderPage(fixture, {
      settings: { target: 'remote_1', guidance: 'tool', threshold: { enabled: false, value: 0.5 } },
      entries: SAME_LABEL,
    })

    fireEvent.change(targetSelect(), { target: { value: 'sglang_local_a1b2' } })
    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByLabelText(zh.thresholdOn))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.forms.writes).toHaveLength(1) })
    expect(lastWrite(fixture).ops).toEqual([
      { op: 'set', path: ['target'], value: 'sglang_local_a1b2' },
      { op: 'set', path: ['guidance'], value: 'context' },
      { op: 'set', path: ['threshold'], value: { enabled: true, value: 0.5 } },
    ])
    // 跨命名空间只读：整个装配里没有一笔写入落在接入层那一行上。
    expect(fixture.forms.writes.every(write => write.namespace === PREFERENCE_NAMESPACE)).toBe(true)
  })

  it('什么都没改就点保存：一条都不写', async () => {
    const fixture = await mounted()
    renderPage(fixture, {
      settings: { target: 'remote_1', guidance: 'tool', threshold: { enabled: false, value: 0.5 } },
      entries: SAME_LABEL,
    })

    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(fixture.forms.writes).toHaveLength(0)
  })

  it('宿主拒绝写入：报一句话，改动不生效', async () => {
    const fixture = await mounted()
    fixture.forms.accepted = false
    renderPage(fixture, { settings: { guidance: 'tool' } })

    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.saveFailed) })
    expect(fixture.forms.writes).toHaveLength(1)
  })

  it('传输层失败（mutate reject）同样报一句话，不静默', async () => {
    const fixture = await mounted()
    fixture.forms.throwOnMutate = true
    renderPage(fixture, { settings: { guidance: 'tool' } })

    fireEvent.click(screen.getByLabelText(zh.guidanceContext))
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.saveFailed) })
  })
})

describe('通道页：文案', () => {
  it('不出现参数名、机制名与具体模型名', () => {
    // `guidance` 不在禁词里：英文的标签就叫 "Guidance"，那是日常词与字段名同形的巧合，不是泄漏。
    for (const dictionary of [zh, en]) {
      expect(Object.values(dictionary).join(' '))
        .not.toMatch(/target|threshold|enabled|decisions|systemone|openai|vllm|sglang|deepseek|qwen/i)
    }
  })

  it('阈值那句点名不可跨模型比较；当前条目那句说清只对这一层有效', async () => {
    const fixture = await mounted()
    renderPage(fixture, { entries: SAME_LABEL })

    expect(zh.thresholdHint).toContain('松紧不同')
    expect(zh.thresholdHint).toContain('换一个模型')
    expect(zh.targetHint).toContain('只对决策通道这一层有效')
    expect(zh.targetHint).toContain('不是全局开关')
    // 这几句都要真的在页面上，而不只是字典里有。
    for (const text of [zh.thresholdHint, zh.targetHint, zh.switch]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
  })
})
