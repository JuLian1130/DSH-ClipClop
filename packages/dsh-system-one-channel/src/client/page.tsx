/**
 * 设置页里的「决策通道」页签：选当前条目、切引导档位、开/设可信度门槛，三项都写回本插件自己那一行。
 *
 * 「当前条目」的选项来自接入层那一行（跨命名空间**只读**，见 `index.ts`）：页面只消费它的 `id` 与 `label`。
 *
 * 草稿与写回：控件改的是本地草稿，按「保存」时只把**改过的那几个**字段合成一次原子写回。只写改过的字段是
 * 为了不覆盖页面不知道的东西——最要紧的一种：条目被删掉之后，下拉里没有能匹配当前值的选项，此时若照草稿
 * 回写就会把一项使用者没碰过的设置清空。
 *
 * 门槛的数值在草稿里留**原始文本**：按 `Number()` 收值的话，敲下 `0.` 这一瞬会被当成 `0` 写回控件，小数点
 * 就再也打不进去（数字输入框对这类中间态报空串，React 只在值与目标不等时才改 DOM——按数字收值一定会改，
 * 按文本收值不会）。合法性与范围在**门槛开着时**一次判定（报一句话、一条都不写）；关着时那个数值不参与判定，
 * 按配置里原来的数值写回。
 *
 * @module
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Guidance, Threshold } from '../config.ts'

/** 页面眼里的一条条目：只用到跨命名空间读来的两个字段。 */
export interface EntryOption {
  readonly id: string
  readonly label: string
}

/** 接入层那一行的形状（本页只读 `entries`）。 */
export interface EntriesSection {
  readonly entries?: readonly EntryOption[]
}

/** 本插件自己那一行里页面读写的三项。`enabled` 不是 volatile，不会出现在这里。 */
export interface ChannelSettings {
  readonly target?: string
  readonly guidance?: Guidance
  readonly threshold?: Threshold
}

/** 这次要写回的字段：只含草稿与当前配置不同的项。 */
export interface ChannelPatch {
  target?: string
  guidance?: Guidance
  threshold?: Threshold
}

/** 注册面注入的业务面：两项读数与唯一一条写入路径。 */
export interface ChannelPageInjected {
  hooks: {
    settings: ObservableSnapshot<ChannelSettings | undefined>
    entries: ObservableSnapshot<EntriesSection | undefined>
  }
  save: (patch: ChannelPatch) => Promise<boolean>
}

/** 渲染机为本页合成的 props：槽位运行面、本插件的文案命名空间与注入的业务面。 */
export type ChannelPageProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'systemOneChannel'>
  & InjectFace<ChannelPageInjected>

/** 空列表的**稳定引用**：选择器的返回值会被 `useSyncExternalStore` 反复比较，每次 new 一个空数组会被判成
 * 「快照变了」，进而无限重渲染。 */
const NO_ENTRIES: readonly EntryOption[] = []

/** schema 里的默认值；只在宿主快照还没到时兜底。 */
const DEFAULT_THRESHOLD: Threshold = { enabled: false, value: 0.5 }

/**
 * 页面上的一份草稿。
 *
 * 门槛的数值按原始文本存（理由见模块注释），保存时才解析。
 */
interface Draft {
  readonly target: string
  readonly guidance: Guidance
  readonly threshold: { readonly enabled: boolean, readonly valueText: string }
}

/**
 * 配置里的三项 → 页面上的一份草稿；缺席的项按 schema 默认值。
 * @param settings - 本插件那一行的当前值；快照还没到时是 `undefined`。
 * @returns 页面用的草稿。
 */
function toDraft(settings: ChannelSettings | undefined): Draft {
  const threshold = settings?.threshold ?? DEFAULT_THRESHOLD
  return {
    target: settings?.target ?? '',
    guidance: settings?.guidance ?? 'tool',
    threshold: { enabled: threshold.enabled, valueText: String(threshold.value) },
  }
}

/**
 * 条目 → 下拉的一项。
 *
 * `label` 可以不唯一，所以重名的显示文本追加 `id` 的后四位区分（「本地 SGLang（3f9c）」）；值始终是 `id`。
 * @param entries - 接入层那一份条目。
 * @returns 下拉的选项，顺序照 `entries`。
 */
function toOptions(entries: readonly EntryOption[]): readonly { readonly value: string, readonly text: string }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1)
  return entries.map(entry => ({
    value: entry.id,
    text: (counts.get(entry.label) ?? 0) > 1 ? `${entry.label}（${entry.id.slice(-4)}）` : entry.label,
  }))
}

/** 页面标题。 */
const TITLE_STYLE = { margin: '0 0 8px', fontSize: 16, fontWeight: 600, lineHeight: '24px' } as const

/** 说明与失败提示共用的排版。 */
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

/** 三组设置之间横线分隔（与设置页其它分组同一档）。 */
const GROUP_STYLE = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '16px 0',
} as const

/** 一个字段：标题在上、控件在下。 */
const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: 4 } as const

/** 字段标题。 */
const LABEL_STYLE = { fontSize: 14, lineHeight: '20px' } as const

/** 一行控件：勾选框或数值框加它右边那句话。 */
const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '20px', cursor: 'pointer' } as const

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

/** 下拉：同一套描边，去掉原生外观后自己画箭头。 */
const SELECT_STYLE = {
  ...INPUT_STYLE,
  appearance: 'none',
  paddingRight: 32,
  maxWidth: 320,
  cursor: 'pointer',
} as const

/** 门槛数值：窄框，够放 `0.00`。 */
const NUMBER_STYLE = { ...INPUT_STYLE, width: 96 } as const

/** 底部按钮行。 */
const ACTIONS_STYLE = { display: 'flex', gap: 8, padding: '16px 0 0' } as const

/** 失败提示。 */
const ALERT_STYLE = { ...HINT_STYLE, color: 'var(--dsw-alias-state-warn-label)', padding: '8px 0' } as const

/** 页面的外边距。 */
const PAGE_STYLE = { padding: '8px 0 24px' } as const

/**
 * 渲染这一页。
 * @param props - 文案、两项读数与写入路径。
 * @returns 三组设置、保存按钮与保存结果。
 */
export function ChannelPage({ t, useSettings, useEntries, save }: ChannelPageProps) {
  const settings = useSettings(section => section)
  const entries = useEntries(section => section?.entries ?? NO_ENTRIES)
  // `draft` 为 null 表示「没动过」：这时照配置里的值显示，所以宿主晚到的快照与保存后的新值都能直接看见。
  const [draft, setDraft] = useState<Draft | null>(null)
  const [failure, setFailure] = useState<'refused' | 'range' | null>(null)
  const current = draft ?? toDraft(settings)
  const options = toOptions(entries)
  // 当前值不在选项里（还没选、条目被删、接入层没装）时补一项把它显示出来：否则下拉是空白的，使用者看不出
  // 现在配的是哪个。
  const unlisted = !options.some(option => option.value === current.target)

  /**
   * 改草稿里的一项；下一次保存只写与当前配置不同的字段。
   * @param patch - 要改的项。
   */
  const edit = (patch: Partial<Draft>): void => {
    setFailure(null)
    setDraft({ ...current, ...patch })
  }

  /**
   * 保存：门槛开着时先判定数值，再把改过的字段合成一次原子写回。
   *
   * 与当前配置逐项比对而不是无条件写回——见模块注释。基准取自**快照**，不取草稿。
   *
   * 门槛关着时不读那个数值：控件是禁用的，里面可能留着上一次敲进去的越界文本；拿它拦保存会把无关的改动
   * 一起卡死，而控件禁用又没法就地改。这时按配置里原来的数值写回，数值不丢。
   */
  const saveDraft = async (): Promise<void> => {
    const base = toDraft(settings)
    const enabled = current.threshold.enabled
    const baseValue = Number(base.threshold.valueText)
    let value = baseValue
    if (enabled) {
      const text = current.threshold.valueText.trim()
      const parsed = Number(text)
      if (text === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        setFailure('range')
        return
      }
      value = parsed
    }
    const patch: ChannelPatch = {}
    if (current.target !== base.target) patch.target = current.target
    if (current.guidance !== base.guidance) patch.guidance = current.guidance
    if (enabled !== base.threshold.enabled || (enabled && value !== baseValue)) {
      patch.threshold = { enabled, value }
    }
    setFailure(null)
    if (patch.target === undefined && patch.guidance === undefined && patch.threshold === undefined) return
    // 写入面把「宿主拒绝」与「传输层失败」都收成一个 `false`：两种都不抛错、都报同一句话。
    if (!await save(patch)) setFailure('refused')
  }

  return (
    <div style={PAGE_STYLE}>
      <h2 style={TITLE_STYLE}>{t('title')}</h2>
      <p style={HINT_STYLE}>{t('intro')}</p>
      <p style={HINT_STYLE}>{t('live')}</p>
      <p style={HINT_STYLE}>{t('switch')}</p>
      <section style={GROUP_STYLE}>
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>{t('target')}</span>
          <select
            value={current.target}
            style={SELECT_STYLE}
            onChange={(event) => { edit({ target: event.target.value }) }}
          >
            {unlisted && <option value={current.target}>{current.target === '' ? t('unset') : current.target}</option>}
            {options.map(option => <option key={option.value} value={option.value}>{option.text}</option>)}
          </select>
          <span style={HINT_STYLE}>{t(options.length === 0 ? 'noEntries' : 'targetHint')}</span>
        </label>
      </section>
      <section style={GROUP_STYLE}>
        <span style={LABEL_STYLE}>{t('guidance')}</span>
        <label style={ROW_STYLE}>
          <input
            type="radio"
            name="systemone-channel-guidance"
            checked={current.guidance === 'tool'}
            onChange={() => { edit({ guidance: 'tool' }) }}
          />
          {t('guidanceTool')}
        </label>
        <label style={ROW_STYLE}>
          <input
            type="radio"
            name="systemone-channel-guidance"
            checked={current.guidance === 'context'}
            onChange={() => { edit({ guidance: 'context' }) }}
          />
          {t('guidanceContext')}
        </label>
      </section>
      <section style={GROUP_STYLE}>
        <span style={LABEL_STYLE}>{t('threshold')}</span>
        <label style={ROW_STYLE}>
          <input
            type="checkbox"
            checked={current.threshold.enabled}
            onChange={(event) => { edit({ threshold: { ...current.threshold, enabled: event.target.checked } }) }}
          />
          {t('thresholdOn')}
        </label>
        <label style={ROW_STYLE}>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={current.threshold.valueText}
            disabled={!current.threshold.enabled}
            style={NUMBER_STYLE}
            onChange={(event) => { edit({ threshold: { ...current.threshold, valueText: event.target.value } }) }}
          />
          {t('thresholdValue')}
        </label>
        <span style={HINT_STYLE}>{t('thresholdHint')}</span>
      </section>
      <div style={ACTIONS_STYLE}>
        <Button variant="primary" onClick={() => { void saveDraft() }}>{t('save')}</Button>
      </div>
      {failure !== null && (
        <div role="alert" style={ALERT_STYLE}>{failure === 'range' ? t('thresholdInvalid') : t('saveFailed')}</div>
      )}
    </div>
  )
}
