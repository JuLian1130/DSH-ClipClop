/**
 * 设置页里的「决策模型」页签：管理 `entries` 的增、删、改。
 *
 * 用户填五项（名称、模型、API 地址、协议、API 密钥）；`id` 由页面生成，卡片头上一行次要文本显示（可选中
 * 复制），不提供编辑。
 * 密钥不落配置：保存时先写进凭据域，配置里只写引用名 `apiKeyEnv`（默认等于该条目的 `id`）——所以页面上
 * 的密钥输入框是一份「这次要写的值」，保存成功即清空，读不回来也不显示。
 *
 * 页面自己不落盘：写入统一交给注册面注入的 `saveRows`（一次原子写回整份 `entries`），失败只回一个结果码。
 * 这样「密钥不进配置」「只写 volatile 路径」两条判据都在单测里直接观察得到。
 *
 * 本产物只把 React 与 `dsh-client-ui-primitives` 列为 external（`scripts/build-client.mjs`），没有 CSS
 * 管线，所以排版用内联样式 + 主题变量；输入框的尺寸照抄「设置 → 模型」那一页的 `.input`，与它看起来像
 * 同一套控件。
 *
 * @module
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Entry, Kind } from '../config.ts'

/**
 * 协议的两个取值：`Record<Kind, …>` 让 tsc 兜住枚举的增删——`Kind` 多一个值，这里就缺一项，编译期报错；
 * 普通数组 + `satisfies readonly Kind[]` 做不到这件事（少一项也是合法赋值）。
 */
const KIND_OPTIONS: Record<Kind, Kind> = { systemone: 'systemone', openai: 'openai' }

/**
 * 空列表的**稳定引用**：选择器的返回值会被 `useSyncExternalStore` 反复比较，每次 new 一个空数组会被判成
 * 「快照变了」，进而无限重渲染。
 */
const NO_ENTRIES: readonly Entry[] = []

/** 页面上的一行：配置里的五个字段，加两份不落盘的草稿（密钥与「还没保存过的行」）。 */
export interface EntryDraft {
  /** 内部标识：新增时由 {@link newEntryId} 生成，保存后不再变；页面只显示、不提供编辑。 */
  readonly id: string
  readonly label: string
  readonly kind: Kind
  readonly baseUrl: string
  readonly model: string
  /** 配置里的引用名；空串＝这个条目不使用密钥。 */
  readonly apiKeyEnv: string
  /** 这次要写进凭据的密钥；空串＝不改。它**不进配置**。 */
  readonly key: string
  /** 还没保存过的行：名称一变就重算 `id`（保存之后才固定，与票面「保存后固定」一致）。 */
  readonly fresh: boolean
}

/**
 * 一条草稿的凭据引用名：有引用名就照写的用，否则用这个条目的 `id`。
 *
 * 写配置与写凭据两处必须用同一个名字，否则密钥存在一个引用名下、请求去另一个引用名下找。
 * @param row - 页面上的一行。
 * @returns 引用名。
 */
export function refOf(row: EntryDraft): string {
  return row.apiKeyEnv !== '' ? row.apiKeyEnv : row.id
}

/** 保存一次的结果；失败不抛错，页面按结果码显示对应的一句话。 */
export type SaveOutcome = 'saved' | 'credential' | 'refused'

/** 注册面注入的业务面：当前条目与唯一一条写入路径。 */
export interface EntriesPageInjected {
  hooks: { entries: ObservableSnapshot<{ entries?: readonly Entry[] } | undefined> }
  /** 保存整份条目：先写凭据，再把数组写回配置。 */
  saveRows: (rows: readonly EntryDraft[]) => Promise<SaveOutcome>
}

/** 渲染机为本页合成的 props：槽位运行面、本插件的文案命名空间与注入的业务面。 */
export type EntriesPageProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'systemOne'>
  & InjectFace<EntriesPageInjected>

/**
 * 新条目的 id：`<名称的 slug>_<序号>`。
 *
 * 字符集只取 `[A-Za-z0-9_]`：凭据引用名是 POSIX 环境变量名（`[A-Za-z_][A-Za-z0-9_]*`），而引用名的默认
 * 值就是这个 id，带连字符的 slug 写不进凭据域。名称是空的（刚点「新增」时）或名称里没有 ASCII 字母数字时退化成
 * `entry_<序号>`。序号取该前缀下第一个没被用掉的整数——**不用随机数**：随机后缀会在每次改名时变一次（只读框
 * 里的 id 跟着跳），而且 `Math.random().toString(16)` 在极小值上会切出带 `-` 的指数形式。
 * @param label - 当前名称，用来取 slug。
 * @param taken - 已经在用的 id。
 * @returns 一个新 id。
 */
export function newEntryId(label: string, taken: readonly string[]): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const base = slug === '' ? 'entry' : /^[0-9]/.test(slug) ? `entry_${slug}` : slug
  const used = new Set(taken)
  for (let index = 1; ; index += 1) {
    const id = `${base}_${index}`
    if (!used.has(id)) return id
  }
}

/**
 * 配置里的一条 → 页面上的一行；密钥草稿从空开始，且这不是「还没保存过的行」。
 * @param entry - 配置里的条目。
 * @returns 页面用的草稿行。
 */
function toDraft(entry: Entry): EntryDraft {
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKeyEnv: entry.apiKeyEnv ?? '',
    key: '',
    fresh: false,
  }
}

/** 页面标题。 */
const TITLE_STYLE = { margin: '0 0 8px', fontSize: 16, fontWeight: 600, lineHeight: '24px' } as const

/** 说明与失败提示共用的排版。 */
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

/** 一个条目的卡片：卡片之间横线分隔，不用阴影（与设置页其它分组同一档）。 */
const CARD_STYLE = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '16px 0',
} as const

/** 成对的字段并排。 */
const PAIR_STYLE = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as const

/** 一个字段：标题在上、控件在下。 */
const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: 4 } as const

/** 字段标题。 */
const LABEL_STYLE = { fontSize: 14, lineHeight: '20px' } as const

/** 输入类控件的排版，照搬设置页 `.input`：32px 高、0.5px 描边、同一档圆角与底色。 */
const INPUT_STYLE = {
  boxSizing: 'border-box',
  width: '100%',
  height: 32,
  padding: '0 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
} as const

/** 协议下拉：同一套描边，去掉原生外观后自己画箭头。 */
const SELECT_STYLE = {
  ...INPUT_STYLE,
  appearance: 'none',
  paddingRight: 32,
  maxWidth: 240,
  cursor: 'pointer',
} as const

/** 卡片头：id 在左、删除在右。 */
const HEADER_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } as const

/** 底部按钮行。 */
const ACTIONS_STYLE = { display: 'flex', gap: 8, padding: '16px 0 0' } as const

/** 失败提示。 */
const ALERT_STYLE = { ...HINT_STYLE, color: 'var(--dsw-alias-state-warn-label)', padding: '8px 0' } as const

/** 页面的外边距。 */
const PAGE_STYLE = { padding: '8px 0 24px' } as const

/**
 * 渲染这一页。
 * @param props - 文案、当前条目与写入路径。
 * @returns 条目列表、增删改的控件与保存结果。
 */
export function EntriesPage({ t, useEntries, saveRows }: EntriesPageProps) {
  const stored = useEntries(section => section?.entries ?? NO_ENTRIES)
  // `draft` 为 null 表示"没动过"：这时照配置里的值显示，所以 Host 侧晚到的快照与保存后的新值都能直接看见。
  const [draft, setDraft] = useState<readonly EntryDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'save' | 'credential' | null>(null)
  const rows = draft ?? stored.map(toDraft)

  /**
   * 改一行里的若干项。
   *
   * 还没保存过的行在名称变化时把 `id` 一起重算——id 要「可读」，而新增那一刻还没有名称可读；保存之后就
   * 固定下来，改名不再动摇它（下游配置里的 `target` 指着它）。
   * @param index - 行的下标。
   * @param patch - 要改的项。
   */
  const edit = (index: number, patch: Partial<EntryDraft>): void => {
    setFailure(null)
    setDraft(rows.map((row, at) => {
      if (at !== index) return row
      if (patch.label === undefined || !row.fresh) return { ...row, ...patch }
      const taken = rows.filter((_other, other) => other !== index).map(other => other.id)
      return { ...row, ...patch, id: newEntryId(patch.label, taken) }
    }))
  }

  /** 在最下面加一行空条目；id 先按空名称生成一个，名称一填就换成可读的那个。 */
  const add = (): void => {
    setFailure(null)
    setDraft([...rows, {
      id: newEntryId('', rows.map(row => row.id)),
      label: '',
      kind: 'systemone',
      baseUrl: '',
      model: '',
      apiKeyEnv: '',
      key: '',
      fresh: true,
    }])
  }

  /**
   * 删掉一行。
   * @param index - 行的下标。
   */
  const remove = (index: number): void => {
    setFailure(null)
    setDraft(rows.filter((_row, at) => at !== index))
  }

  /**
   * 保存：写成功后清空密钥草稿、把这批行标成已保存，并把这次真写进去的引用名显示成保存后的样子。
   *
   * `apiKeyEnv` 只在这次真写了密钥时才补默认引用名：没写密钥的行补上它，下一次保存会把一个**不存在**的
   * 引用名写进配置，那个条目随后会在 `ask` 时报「凭据没配」。
   */
  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      const outcome = await saveRows(rows)
      if (outcome !== 'saved') {
        setFailure(outcome === 'credential' ? 'credential' : 'save')
        return
      }
      setDraft(rows.map(row => ({
        ...row,
        fresh: false,
        apiKeyEnv: row.key !== '' ? refOf(row) : row.apiKeyEnv,
        key: '',
      })))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={PAGE_STYLE}>
      <h2 style={TITLE_STYLE}>{t('title')}</h2>
      <p style={HINT_STYLE}>{t('intro')}</p>
      <p style={HINT_STYLE}>{t('reload')}</p>
      {rows.length === 0 && <p style={HINT_STYLE}>{t('empty')}</p>}
      {rows.map((row, index) => (
        // 按位置而不是按 id 作 key：新行的 id 会随名称改写，按 id 作 key 会在改名时重建整块表单、丢掉焦点。
        <section key={index} style={CARD_STYLE}>
          <div style={HEADER_STYLE}>
            <span style={HINT_STYLE}>{t('id')}: {row.id}</span>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { remove(index) }}>{t('delete')}</Button>
          </div>
          <div style={PAIR_STYLE}>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t('label')}</span>
              <input
                value={row.label}
                disabled={busy}
                style={INPUT_STYLE}
                onChange={(event) => { edit(index, { label: event.target.value }) }}
              />
              <span style={HINT_STYLE}>{t('labelHint')}</span>
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t('kind')}</span>
              <select
                value={row.kind}
                disabled={busy}
                style={SELECT_STYLE}
                onChange={(event) => { edit(index, { kind: event.target.value as Kind }) }}
              >
                {Object.values(KIND_OPTIONS).map(kind => <option key={kind} value={kind}>{kind}</option>)}
              </select>
              <span style={HINT_STYLE}>{t('kindHint')}</span>
            </label>
          </div>
          <div style={PAIR_STYLE}>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t('baseUrl')}</span>
              <input
                value={row.baseUrl}
                disabled={busy}
                style={INPUT_STYLE}
                onChange={(event) => { edit(index, { baseUrl: event.target.value }) }}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t('model')}</span>
              <input
                value={row.model}
                disabled={busy}
                placeholder={t('modelPlaceholder')}
                style={INPUT_STYLE}
                onChange={(event) => { edit(index, { model: event.target.value }) }}
              />
            </label>
          </div>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>{t('key')}</span>
            <input
              type="password"
              value={row.key}
              disabled={busy}
              placeholder={t('keyPlaceholder')}
              style={INPUT_STYLE}
              onChange={(event) => { edit(index, { key: event.target.value }) }}
            />
            <span style={HINT_STYLE}>{t('keyHint')}</span>
          </label>
        </section>
      ))}
      <div style={ACTIONS_STYLE}>
        <Button variant="outline" disabled={busy} onClick={add}>{t('add')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? t('saving') : t('save')}</Button>
      </div>
      {failure !== null && (
        <div role="alert" style={ALERT_STYLE}>{failure === 'credential' ? t('credentialFailed') : t('saveFailed')}</div>
      )}
    </div>
  )
}
