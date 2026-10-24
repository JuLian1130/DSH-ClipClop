// @vitest-environment jsdom
/**
 * 票据 04：接入层的条目页。
 *
 * 观察面分两层：注册层断言页签的键（`settings.plugins.tab` 的 id、文案命名空间、`whileServed` 的命名空间等于
 * patch 行 id），控件层把注册面注入的业务面按渲染机的形状绑到组件上，断言「点新增得到一个自动生成的 id」「已有
 * 条目默认折叠、点编辑才展开」「保存是一次整份 `entries` 的原子写入」「密钥进凭据域、配置里只留引用名」。
 *
 * 写入路径与字段名都是判据的一部分：`{ op: 'set', path: ['entries'] }` 的 `entries` 是本包唯一的可写字段，
 * 也是唯一标了 volatile 的字段——非 volatile 的写入会被宿主直接拒绝，所以页面不该产生这类调用。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Entry } from '../src/config.ts'
import { inject as pageInject, PREFERENCE_NAMESPACE } from '../src/client/index.ts'
import { EntriesPage, newEntryId, type EntriesPageInjected, type EntriesPageProps } from '../src/client/page.tsx'
import { zh } from '../src/client/locales.ts'
import { mountClient, type ClientFixture } from './support/client.ts'

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
 * 按页签的形状渲染一次：取注册面、绑定注入面、渲染组件。
 * @param fixture - 已装好的浏览器半夹具。
 * @param initial - 渲染前先写进 settings 替身的条目。
 * @returns 渲染结果与注入面。
 */
function renderPage(
  fixture: ClientFixture,
  initial: readonly Entry[] = [],
): { container: HTMLElement, face: EntriesPageInjected } {
  fixture.form.entries = initial
  const entry = fixture.entries('settings.plugins.tab')[0]
  if (entry === undefined) throw new Error('fixture: the entries page is not registered')
  const face = entry.options.inject!() as EntriesPageInjected
  const props = { view: 'page', t: fixture.t, ...boundHooks(face.hooks), saveRows: face.saveRows }
  const { container } = render(<EntriesPage {...(props as unknown as EntriesPageProps)} />)
  return { container, face }
}

/**
 * 按字段名找控件：标签包着输入框，标签的文字里还带着下面那行说明，所以按前缀匹配；多行时取**最后一行的**
 * 那个（用例都在最后一行上操作）。
 * @param label - 字段名。
 * @returns 该字段的控件。
 */
function field(label: string): HTMLElement {
  return screen.getAllByLabelText(new RegExp(`^${label}`)).at(-1)!
}

/** 卡片头上那行 id 的值：`条目 id: <值>`。 */
function idTexts(container: HTMLElement): readonly string[] {
  const prefix = `${zh.id}: `
  return [...container.querySelectorAll('span')]
    .map(span => span.textContent ?? '')
    .filter(text => text.startsWith(prefix))
    .map(text => text.slice(prefix.length))
}

/** 页面上的协议下拉。 */
function kindSelects(container: HTMLElement): readonly HTMLSelectElement[] {
  return [...container.querySelectorAll<HTMLSelectElement>('select')]
}

/** 一次保存写回的那份 `entries`。 */
function savedEntries(fixture: ClientFixture): readonly Record<string, string>[] {
  const ops = fixture.form.mutations.at(-1)
  const op = ops?.[0]
  if (op === undefined) throw new Error('fixture: no write happened')
  return op.value as readonly Record<string, string>[]
}

/**
 * 点「新增条目」，把这一行填成一条完整条目。
 * @param fields - 要填的字段（名称、模型、API 地址、密钥）。
 */
function fillRow(fields: { label?: string, model?: string, baseUrl?: string, key?: string }): void {
  if (fields.label !== undefined) fireEvent.change(field(zh.label), { target: { value: fields.label } })
  if (fields.model !== undefined) fireEvent.change(field(zh.model), { target: { value: fields.model } })
  if (fields.baseUrl !== undefined) fireEvent.change(field(zh.baseUrl), { target: { value: fields.baseUrl } })
  if (fields.key !== undefined) fireEvent.change(field(zh.key), { target: { value: fields.key } })
}

describe('条目页：注册面', () => {
  it('页签注册在 settings.plugins.tab，命名空间就是 patch 行的 id', async () => {
    const fixture = await mounted()
    const [entry] = fixture.entries('settings.plugins.tab')

    expect(entry?.options.name).toBe('settings.plugins.tab')
    expect(entry?.options.id).toBe('system-one')
    expect(entry?.options.locale).toBe('systemOne')
    expect(typeof entry?.options.label).toBe('function')
    expect((entry?.options.label as () => string)()).toBe(zh.tab)
    // 写回与 `whileServed` 用的是同一个键：patch 行的 id（也是 host 半的入口 name）。
    expect(PREFERENCE_NAMESPACE).toBe('dsh-system-one')
    expect(fixture.served).toEqual([['dsh-system-one']])
    // 注入清单本身就是契约：`remote.credentials` 少一项，凭据域缺席的部署里这一页会照常出现、
    // 而保存密钥永远失败（提示还会说「密钥没写进凭据」，指错原因）。
    expect(pageInject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])
  })

  it('空配置时页面说「还没有条目」，并给出新增入口', async () => {
    const fixture = await mounted()
    renderPage(fixture)

    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.getByText(zh.add)).toBeTruthy()
    expect(idTexts(document.body)).toHaveLength(0)
  })
})

describe('条目页：增删改', () => {
  it('新增：id 立刻生成并显示，保存把整份数组一次写回', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    const [idText] = idTexts(container)
    expect(idText).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    fillRow({ label: '本地小模型', model: 'qwen3-4b', baseUrl: 'http://127.0.0.1:8000' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const ops = fixture.form.mutations[0]!
    expect(ops).toHaveLength(1)
    expect(ops[0]!.op).toBe('set')
    expect(ops[0]!.path).toEqual(['entries'])
    expect(savedEntries(fixture)).toEqual([{
      id: idText,
      label: '本地小模型',
      kind: 'systemone',
      baseUrl: 'http://127.0.0.1:8000',
      model: 'qwen3-4b',
      apiKeyEnv: '',
    }])
  })

  it('两个条目可以同名：各自 id 不同，保存后并存', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fireEvent.click(screen.getByText(zh.add))
    const initial = idTexts(container)
    expect(initial).toHaveLength(2)
    expect(initial[0]).not.toBe(initial[1])
    for (const input of screen.getAllByLabelText(new RegExp(`^${zh.label}`))) {
      fireEvent.change(input, { target: { value: '本地 SGLang' } })
    }
    const [first, second] = idTexts(container)
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const saved = savedEntries(fixture)
    expect(saved.map(entry => entry.label)).toEqual(['本地 SGLang', '本地 SGLang'])
    expect(saved.map(entry => entry.id)).toEqual([first, second])
    // id 撞车的唯一时机是「两行改成同一个名称之后」，避让靠 `edit` 把其它行已用的 id 传进 `newEntryId`；
    // 上面那两行只比「显示 == 写回」，两行拿到同一个 id 也成立，所以这里单独钉一次。
    expect(saved[0]!.id).not.toBe(saved[1]!.id)
  })

  it('新增行填名称后换成可读 id；保存之后改名不再动摇它', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: 'Local SGLang' })
    expect(idTexts(container)[0]).toMatch(/^local_sglang_[0-9]+$/)
    fillRow({ model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const savedId = savedEntries(fixture)[0]!.id

    // 保存后折叠；改名要先展开。
    fireEvent.click(screen.getByText(zh.edit))
    fireEvent.change(field(zh.label), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(2) })
    expect(savedEntries(fixture)[0]!.id).toBe(savedId)
    fireEvent.click(screen.getByText(zh.edit))
    expect(idTexts(container)).toEqual([savedId])
  })

  it('删除与修改：保存写回的是剩下的条目与改过的字段', async () => {
    const fixture = await mounted()
    const initial: readonly Entry[] = [
      { id: 'keep', label: '留着的', kind: 'openai', baseUrl: 'http://127.0.0.1:1111', model: 'm1' },
      { id: 'drop', label: '要删的', kind: 'systemone', baseUrl: 'http://127.0.0.1:2222', model: 'm2' },
    ]
    const { container } = renderPage(fixture, initial)

    // 已有条目默认折叠：只看到名称与动作，字段要点「编辑」才展开。
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.getByText('留着的')).toBeTruthy()
    expect(screen.getByText('要删的')).toBeTruthy()

    fireEvent.click(screen.getAllByText(zh.edit)[0]!)
    expect(idTexts(container)).toEqual(['keep'])
    fireEvent.change(screen.getByDisplayValue('留着的'), { target: { value: '改过的' } })
    fireEvent.click(screen.getAllByText(zh.delete)[1]!)
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    expect(savedEntries(fixture)).toEqual([{
      id: 'keep',
      label: '改过的',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:1111',
      model: 'm1',
      apiKeyEnv: '',
    }])
  })

  it('已有条目默认折叠成一行：点「编辑」才展开字段，保存后重新收起', async () => {
    const fixture = await mounted()
    const initial: readonly Entry[] = [
      { id: 'e1', label: '本地 SGLang', kind: 'systemone', baseUrl: 'http://127.0.0.1:1', model: 'qwen3-4b' },
    ]
    const { container } = renderPage(fixture, initial)

    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.getByText('本地 SGLang')).toBeTruthy()
    expect(screen.getByText('qwen3-4b · systemone')).toBeTruthy()

    fireEvent.click(screen.getByText(zh.edit))
    expect(idTexts(container)).toEqual(['e1'])
    expect(container.querySelectorAll('input')).toHaveLength(4)
    expect(screen.queryByText(zh.edit)).toBeNull()
    expect(screen.getByText(zh.collapse)).toBeTruthy()

    fireEvent.change(field(zh.label), { target: { value: '改名后的' } })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.getByText('改名后的')).toBeTruthy()
    expect(savedEntries(fixture)[0]?.label).toBe('改名后的')
  })

  it('新增行保存后收起成一行，和已有条目一样点「编辑」再展开', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    expect(screen.queryByText(zh.edit)).toBeNull()
    fillRow({ label: '新的', model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })

    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.getByText('新的')).toBeTruthy()
    fireEvent.click(screen.getByText(zh.edit))
    expect(container.querySelectorAll('input')).toHaveLength(4)
  })

  it('协议下拉只有两个选项，取值是 kind 枚举的两个值', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)
    fireEvent.click(screen.getByText(zh.add))

    const [select] = kindSelects(container)
    expect([...select!.options].map(option => option.value)).toEqual(['systemone', 'openai'])
    expect((field(zh.kind) as HTMLSelectElement).value).toBe('systemone')
    fireEvent.change(field(zh.kind), { target: { value: 'openai' } })
    expect((field(zh.kind) as HTMLSelectElement).value).toBe('openai')
  })

  it('只写 volatile 路径：一整轮增删改之后，每条写入都落在 entries 上', async () => {
    const fixture = await mounted()
    renderPage(fixture, [{ id: 'old', label: '旧的', kind: 'systemone', baseUrl: 'http://127.0.0.1:1', model: 'm' }])

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: '新的', model: 'm2', baseUrl: 'http://127.0.0.1:2' })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    fireEvent.click(screen.getAllByText(zh.delete)[0]!)
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(2) })

    const paths = fixture.form.mutations.flat().map(op => op.path)
    expect(paths.every(path => path.length === 1 && path[0] === 'entries')).toBe(true)
    expect(fixture.form.mutations.flat().every(op => op.op === 'set')).toBe(true)
  })
})

describe('条目页：密钥与失败态', () => {
  it('密钥写进凭据域，配置里只留引用名且默认等于该条目的 id', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    const [idText] = idTexts(container)
    fillRow({ label: '带密钥的', model: 'qwen3-4b', baseUrl: 'http://127.0.0.1:8000', key: 'sk-secret-1' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    expect(fixture.credentials.writes).toEqual([{ ref: idText, value: 'sk-secret-1' }])
    const saved = savedEntries(fixture)
    expect(saved[0]?.apiKeyEnv).toBe(idText)
    // 负向断言：写回的配置里不出现密钥本身，只有引用名。
    expect(JSON.stringify(saved)).not.toContain('sk-secret-1')
    // 保存成功后密钥输入框清空：值只存在凭据域里，页面上读不回来（保存后已折叠，先展开）。
    fireEvent.click(screen.getByText(zh.edit))
    await waitFor(() => { expect((field(zh.key) as HTMLInputElement).value).toBe('') })
  })

  it('已有引用名且这次没填密钥：不写凭据域，引用名原样保留', async () => {
    const fixture = await mounted()
    renderPage(fixture, [{ id: 'e1', label: 'x', kind: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: 'MY_KEY' }])

    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })

    expect(fixture.credentials.writes).toEqual([])
    expect(savedEntries(fixture)[0]?.apiKeyEnv).toBe('MY_KEY')
  })

  it('凭据域拒绝写入：报错且配置一条都没写', async () => {
    const fixture = await mounted()
    fixture.credentials.refuse = true
    renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: 'x', model: 'm', baseUrl: 'http://127.0.0.1:1', key: 'sk-secret-1' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.credentialFailed) })
    expect(fixture.form.mutations).toHaveLength(0)
  })

  it('宿主拒绝写入：报错，改动不生效', async () => {
    const fixture = await mounted()
    fixture.form.accepted = false
    renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: 'x', model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.saveFailed) })
  })

  it('保存期间行内控件全都禁用：写回返回时不会用旧快照覆盖这期间敲进去的字', async () => {
    const fixture = await mounted()
    let release = (): void => {}
    fixture.form.hold = new Promise<void>((resolve) => { release = () => { resolve() } })
    const { container } = renderPage(fixture, [{ id: 'e1', label: '旧名字', kind: 'systemone', baseUrl: 'http://127.0.0.1:1', model: 'm' }])

    fireEvent.click(screen.getByText(zh.edit))

    // 一行里七处手能碰到的地方：名称/地址/模型/密钥四个输入框、协议下拉、「收起」「删除」两个按钮。漏挂一处，
    // 那处敲进去的字照样会被写回返回时的旧快照覆盖。
    const rowControls = (): readonly HTMLInputElement[] =>
      [...container.querySelectorAll<HTMLInputElement>('section input, section select, section button')]
    expect(rowControls()).toHaveLength(7)

    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(rowControls().every(control => control.disabled)).toBe(true) })
    release()
    await waitFor(() => { expect(rowControls().some(control => control.disabled)).toBe(false) })
    expect(savedEntries(fixture)[0]?.label).toBe('旧名字')
  })

  it('快照还没到（entries 缺席）时按空列表显示，也能直接加一行', async () => {
    const fixture = await mounted()
    fixture.form.entries = undefined
    const { container } = renderPage(fixture)
    expect(screen.getByText(zh.empty)).toBeTruthy()

    fireEvent.click(screen.getByText(zh.add))
    expect(idTexts(container)).toHaveLength(1)
  })

  it('写回的传输层失败（mutate reject）同样报错，不静默', async () => {
    const fixture = await mounted()
    fixture.form.throwOnMutate = true
    renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: 'x', model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.saveFailed) })
  })

  it('不带密钥的条目保存两次：第二次也不会写上一个不存在的引用名', async () => {
    const fixture = await mounted()
    renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: '无密钥', model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(2) })

    expect(savedEntries(fixture)[0]?.apiKeyEnv).toBe('')
    expect(fixture.credentials.writes).toEqual([])
  })
})

describe('条目 id 生成', () => {
  it('只用凭据引用名允许的字符：名称可以是中文，id 照样写得进凭据域', () => {
    const grammar = /^[A-Za-z_][A-Za-z0-9_]*$/
    expect(newEntryId('本地小模型', [])).toMatch(grammar)
    expect(newEntryId('Local SGLang', [])).toMatch(grammar)
    expect(newEntryId('', [])).toMatch(grammar)
    expect(newEntryId('3 层代理', [])).toMatch(grammar)
  })

  it('按名称取可读前缀，与已用 id 不同', () => {
    const first = newEntryId('Local SGLang', [])
    expect(first).toMatch(/^local_sglang_[0-9]+$/)
    expect(newEntryId('Local SGLang', [first])).not.toBe(first)
    expect(newEntryId('', [])).toMatch(/^entry_[0-9]+$/)
  })
})
