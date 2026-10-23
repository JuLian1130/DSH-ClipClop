// @vitest-environment jsdom
/**
 * 票据 04：接入层的条目页。
 *
 * 观察面分两层：注册层断言页签的键（`settings.plugins.tab` 的 id、文案命名空间、`whileServed` 的命名空间等于
 * patch 行 id），控件层把注册面注入的业务面按渲染机的形状绑到组件上，断言「点新增得到一个只读 id」「保存是
 * 一次整份 `entries` 的原子写入」「密钥进凭据域、配置里只留引用名」。
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
import { PREFERENCE_NAMESPACE } from '../src/client/index.ts'
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

/** 页面上只读的 id 输入框。 */
function idInputs(container: HTMLElement): readonly HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[readonly]')]
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
  })

  it('空配置时页面说「还没有条目」，并给出新增入口', async () => {
    const fixture = await mounted()
    renderPage(fixture)

    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.getByText(zh.add)).toBeTruthy()
    expect(idInputs(document.body)).toHaveLength(0)
  })
})

describe('条目页：增删改', () => {
  it('新增：id 立刻生成且只读，保存把整份数组一次写回', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    const [idInput] = idInputs(container)
    expect(idInput?.readOnly).toBe(true)
    expect(idInput?.value).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    fillRow({ label: '本地小模型', model: 'qwen3-4b', baseUrl: 'http://127.0.0.1:8000' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const ops = fixture.form.mutations[0]!
    expect(ops).toHaveLength(1)
    expect(ops[0]!.op).toBe('set')
    expect(ops[0]!.path).toEqual(['entries'])
    expect(savedEntries(fixture)).toEqual([{
      id: idInput!.value,
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
    const [first, second] = idInputs(container)
    expect(first!.value).not.toBe(second!.value)
    for (const input of screen.getAllByLabelText(new RegExp(`^${zh.label}`))) {
      fireEvent.change(input, { target: { value: '本地 SGLang' } })
    }
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const saved = savedEntries(fixture)
    expect(saved.map(entry => entry.label)).toEqual(['本地 SGLang', '本地 SGLang'])
    expect(saved.map(entry => entry.id)).toEqual([first!.value, second!.value])
  })

  it('新增行填名称后换成可读 id；保存之后改名不再动摇它', async () => {
    const fixture = await mounted()
    const { container } = renderPage(fixture)

    fireEvent.click(screen.getByText(zh.add))
    fillRow({ label: 'Local SGLang' })
    expect(idInputs(container)[0]!.value).toMatch(/^local_sglang_[0-9a-f]{4}$/)
    fillRow({ model: 'm', baseUrl: 'http://127.0.0.1:1' })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    const savedId = savedEntries(fixture)[0]!.id

    fireEvent.change(field(zh.label), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText(zh.save))
    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(2) })
    expect(savedEntries(fixture)[0]!.id).toBe(savedId)
  })

  it('删除与修改：保存写回的是剩下的条目与改过的字段', async () => {
    const fixture = await mounted()
    const initial: readonly Entry[] = [
      { id: 'keep', label: '留着的', kind: 'openai', baseUrl: 'http://127.0.0.1:1111', model: 'm1' },
      { id: 'drop', label: '要删的', kind: 'systemone', baseUrl: 'http://127.0.0.1:2222', model: 'm2' },
    ]
    const { container } = renderPage(fixture, initial)

    expect(idInputs(container).map(input => input.value)).toEqual(['keep', 'drop'])
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

  it('协议下拉只有两个选项，取值是 kind 枚举的两个值', async () => {    const fixture = await mounted()
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
    const [idInput] = idInputs(container)
    fillRow({ label: '带密钥的', model: 'qwen3-4b', baseUrl: 'http://127.0.0.1:8000', key: 'sk-secret-1' })
    fireEvent.click(screen.getByText(zh.save))

    await waitFor(() => { expect(fixture.form.mutations).toHaveLength(1) })
    expect(fixture.credentials.writes).toEqual([{ ref: idInput!.value, value: 'sk-secret-1' }])
    const saved = savedEntries(fixture)
    expect(saved[0]?.apiKeyEnv).toBe(idInput!.value)
    // 负向断言：写回的配置里不出现密钥本身，只有引用名。
    expect(JSON.stringify(saved)).not.toContain('sk-secret-1')
    // 保存成功后密钥输入框清空：值只存在凭据域里，页面上读不回来。
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
    expect(first).toMatch(/^local_sglang_[0-9a-f]{4}$/)
    expect(newEntryId('Local SGLang', [first])).not.toBe(first)
    expect(newEntryId('', [])).toMatch(/^entry_[0-9a-f]{4}$/)
  })
})
