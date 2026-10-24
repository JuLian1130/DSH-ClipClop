/**
 * 设置页里的「决策通道」页签：选当前条目、切引导档位、开/设可信度门槛，三项都写回本插件自己那一行。
 *
 * 「当前条目」的选项来自接入层那一行（跨命名空间**只读**，见 `index.ts`）：页面只消费它的 `id` 与 `label`。
 *
 * 写回是**改哪项写哪项**、没有保存按钮：每次交互只提交这一项（门槛的开关与数值是同一个字段，一起写），
 * 写入按交互顺序排队，连点时后一次不会先落地。只写改动的那一项也避免了覆盖页面不知道的东西——条目被删掉
 * 之后，下拉里没有能匹配当前值的选项，整份回写会把一项使用者没碰过的设置清空。
 *
 * 门槛关闭时数值设置整组不显示。数值在草稿里留**原始文本**：按 `Number()` 收值的话，敲下 `0.` 这一瞬会被
 * 当成 `0` 写回控件，小数点就再也打不进去（数字输入框对这类中间态报空串，React 只在值与目标不等时才改 DOM）。
 * 文本合法时在停止输入片刻后写回；失焦或回车时判定一次，越界/为空报一句话、不写。
 *
 * @module
 */

import { useEffect, useRef, useState } from 'react'
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

/** 门槛数值停止输入后多久写回；失焦/回车会立刻写，不需要等它。 */
const THRESHOLD_SAVE_DELAY_MS = 400

/**
 * 门槛文本 → 数值；空串、非数字、越界都交回 `null`。
 * @param text - 输入框里的原始文本。
 * @returns 合法的 0–1 数值，或 `null`。
 */
function parseThreshold(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null
}

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

/** 失败提示。 */
const ALERT_STYLE = { ...HINT_STYLE, color: 'var(--dsw-alias-state-warn-label)', padding: '8px 0' } as const

/** 页面的外边距。 */
const PAGE_STYLE = { padding: '8px 0 24px' } as const

/**
 * 渲染这一页。
 * @param props - 文案、两项读数与写入路径。
 * @returns 三组设置与写入失败提示。
 */
export function ChannelPage({ t, useSettings, useEntries, save }: ChannelPageProps) {
  const settings = useSettings(section => section)
  const entries = useEntries(section => section?.entries ?? NO_ENTRIES)
  // `draft` 为 null 表示「没动过」：这时照配置里的值显示，所以宿主晚到的快照与新值都能直接看见。
  const [draft, setDraft] = useState<Draft | null>(null)
  const [failure, setFailure] = useState<'refused' | 'range' | null>(null)
  // 写入按交互顺序排队：连点两下开关时，后一次不能先落地。
  const writes = useRef<Promise<void>>(Promise.resolve())
  const thresholdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const current = draft ?? toDraft(settings)
  const options = toOptions(entries)
  // 当前值不在选项里（还没选、条目被删、接入层没装）时补一项把它显示出来：否则下拉是空白的，使用者看不出
  // 现在配的是哪个。
  const unlisted = !options.some(option => option.value === current.target)
  /** 配置里当前的数值：开关关掉、或草稿文本不合法时用它兜底。 */
  const storedValue = (): number => Number(toDraft(settings).threshold.valueText)

  useEffect(() => () => {
    if (thresholdTimer.current !== null) clearTimeout(thresholdTimer.current)
  }, [])

  /**
   * 提交这一项；失败只报一句话，下一次交互会继续写。
   * @param patch - 这次要写回的那一项。
   */
  const commit = (patch: ChannelPatch): void => {
    writes.current = writes.current.then(async () => {
      if (!await save(patch)) setFailure('refused')
    })
  }

  /**
   * 改草稿里的一项：控件先显示新值，写回在后台排队。
   * @param patch - 要改的项。
   */
  const edit = (patch: Partial<Draft>): void => {
    setFailure(null)
    setDraft({ ...current, ...patch })
  }

  /** 选条目：只写 `target`。 */
  const chooseTarget = (target: string): void => {
    edit({ target })
    commit({ target })
  }

  /** 切引导档位：只写 `guidance`。 */
  const chooseGuidance = (guidance: Guidance): void => {
    edit({ guidance })
    commit({ guidance })
  }

  /** 开关门槛：开关与数值是同一个字段，一起写；关掉时把草稿里的文本收回配置里的数值。 */
  const toggleThreshold = (enabled: boolean): void => {
    const value = parseThreshold(current.threshold.valueText) ?? storedValue()
    edit({ threshold: { enabled, valueText: String(value) } })
    commit({ threshold: { enabled, value } })
  }

  /** 数值改动：先更新文本；合法时在停止输入后写回，非法时等失焦再报错。 */
  const changeThresholdValue = (valueText: string): void => {
    edit({ threshold: { ...current.threshold, valueText } })
    if (thresholdTimer.current !== null) {
      clearTimeout(thresholdTimer.current)
      thresholdTimer.current = null
    }
    const parsed = parseThreshold(valueText)
    if (parsed === null) return
    thresholdTimer.current = setTimeout(() => {
      thresholdTimer.current = null
      commit({ threshold: { enabled: true, value: parsed } })
    }, THRESHOLD_SAVE_DELAY_MS)
  }

  /** 失焦或回车：取消失焦前那次延时写入，按当前文本判定一次。 */
  const commitThresholdValue = (): void => {
    if (thresholdTimer.current !== null) {
      clearTimeout(thresholdTimer.current)
      thresholdTimer.current = null
    }
    const parsed = parseThreshold(current.threshold.valueText)
    if (parsed === null) {
      setFailure('range')
      return
    }
    setFailure(null)
    if (parsed === storedValue()) return
    commit({ threshold: { enabled: true, value: parsed } })
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
              onChange={(event) => { chooseTarget(event.target.value) }}
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
              onChange={() => { chooseGuidance('tool') }}
            />
            {t('guidanceTool')}
          </label>
          <label style={ROW_STYLE}>
            <input
              type="radio"
              name="systemone-channel-guidance"
              checked={current.guidance === 'context'}
              onChange={() => { chooseGuidance('context') }}
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
              onChange={(event) => { toggleThreshold(event.target.checked) }}
            />
            {t('thresholdOn')}
          </label>
          {current.threshold.enabled && (
            <>
              <label style={ROW_STYLE}>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={current.threshold.valueText}
                  style={NUMBER_STYLE}
                  onChange={(event) => { changeThresholdValue(event.target.value) }}
                  onBlur={commitThresholdValue}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                />
                {t('thresholdValue')}
              </label>
              <span style={HINT_STYLE}>{t('thresholdHint')}</span>
            </>
          )}
        </section>
      {failure !== null && (
        <div role="alert" style={ALERT_STYLE}>{failure === 'range' ? t('thresholdInvalid') : t('saveFailed')}</div>
      )}
    </div>
  )
}
