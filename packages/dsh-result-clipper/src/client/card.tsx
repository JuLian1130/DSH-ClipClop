/**
 * `plugins.bundle.config` 的包详情页配置区：摘要、摘要准入判断、隐私闸门三个角色各自成一组，每组把该角色的
 * route（provider 与 model）、推理档位与提示词规则正文放在一起；摘要组另带两个阈值，最后是诊断组的 debug
 * 日志路径。三个模型组之间用一条横线隔开。
 *
 * **每组是「草稿 + 保存」**：控件只改本地草稿，不点该组的「保存」什么都不落盘；「保存」把该组所有改动作为
 * **一次原子写入**提交（`configForms.mutate` 的多个 op 共用一个 revision 栅栏与一次 Host 校验），任一条被
 * 拒绝就整组不生效并显示 `role="alert"`。「恢复默认」按字段分两种语义：推理档位、两个阈值与三份提示词规则
 * 正文回到**内置默认**（提示词回到内置正文，保存时以 `unset` 清掉覆盖、不写一条逐字相同的覆盖）；provider、
 * model、隐私确认位、失败策略与 debug 路径回到**上一次保存的值**（即丢掉未保存的改动）。草稿在 Host 侧取值
 * 变化时（保存被接受，或别处写入）整体重新播种。
 *
 * 座位约定见设计文档「配置面与设置座位」——开关在插件页签、参数在包自己的详情页。
 *
 * **端点与凭据不在这里**：DSH 的请求形状只带 `provider` 与 `model`，endpoint、协议与 API key 归 LLM 适配器
 * 按 route 持有（`GenerateOptions` 没有 baseURL / apiKey 字段）。所以卡片顶部与三个 provider 行都把用户指到
 * 「设置 → 模型 → 自定义提供方」：route 与它的 baseURL / API key 在那里建，这里只按角色选 route。
 *
 * 隐私闸门开启而隐私 route 未确认为本地时，卡片顶部显示常驻警告——它只反映这一静态配置状态，不反映运行期
 * 失效（运行期失效的可见面是会话提醒）；确认后或关闭隐私开关后警告消失。安全外壳与输出格式由 host 半写死，
 * 这里只能编辑规则正文。
 *
 * @module
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { REASONING_EFFORT_IDS } from '../reasoning.ts'
import type { ReasoningEffort } from '../reasoning.ts'
// 无依赖的共享模块：host 半拼装请求用的是同一份文字，所以框里显示的默认与真正发出的正文不会漂移。
import { DEFAULT_ADMISSION_RULE, DEFAULT_PRIVACY_RULE, DEFAULT_SUMMARY_RULE } from '../rules.ts'
import type { ModelCatalogProvider } from './catalog.ts'
import type { ResultClipperLocaleKey } from './locales.ts'

/** 卡片的可写字段，与 host 半 `Config` 的字段同名（也是 settings section 里的键）。 */
export type ResultClipperCardField =
  | 'routeProvider'
  | 'routeModel'
  | 'admissionJudge'
  | 'privacyProvider'
  | 'privacyModel'
  | 'privacyConfirmedLocal'
  | 'failurePolicy'
  | 'admissionProvider'
  | 'admissionModel'
  | 'minInlineTokens'
  | 'maxSummarizeTokens'
  | 'summaryReasoningEffort'
  | 'admissionReasoningEffort'
  | 'privacyReasoningEffort'
  | 'summaryPrompt'
  | 'admissionPrompt'
  | 'privacyPrompt'
  | 'debugPath'

/**
 * 一次原子写入里的一个字段操作，形状与 settings 的 `SettingsPathOpView` 逐字段一致。
 *
 * 那份类型在 `@deepseek-ai/dsh-api-remotes/client` 里，而浏览器半的依赖面只列到平台模块（`react` 与
 * `dsh-client-ui-primitives`），为它多挂一个包不值得；形状在此就地声明，由 `form.mutate` 的入参类型兜住。
 */
export type ResultClipperSettingOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: string | number | boolean }
  | { readonly op: 'unset'; readonly path: string[] }

/** 注册者自己的业务面：逐字段读数，加一条把一组改动原子写回的路径。 */
export interface ResultClipperCardInjected {
  hooks: {
    /** 隐私闸门开关的当前值；常驻警告按它与确认位一起显示。 */
    privacyGate: ObservableSnapshot<boolean>
    /** 「隐私 route 已确认为本地」确认位的当前值。 */
    privacyConfirmedLocal: ObservableSnapshot<boolean>
    /** 隐私失效的处理策略：`passthrough` 放行原文，`block` 给出拒绝结果。 */
    failurePolicy: ObservableSnapshot<'passthrough' | 'block'>
    /** 摘要 route 的 provider。 */
    routeProvider: ObservableSnapshot<string>
    /** 摘要 route 的 model id。 */
    routeModel: ObservableSnapshot<string>
    /** 准入 route 的 provider；空串表示跟随摘要 route。 */
    admissionProvider: ObservableSnapshot<string>
    /** 准入 route 的 model id；空串表示跟随摘要 route。 */
    admissionModel: ObservableSnapshot<string>
    /** 摘要准入判断开关：关闭时准入组整组收起，也就没有这一步。 */
    admissionJudge: ObservableSnapshot<boolean>
    /** 隐私 route 的 provider；空串表示跟随摘要 route。 */
    privacyProvider: ObservableSnapshot<string>
    /** 隐私 route 的 model id；空串表示跟随摘要 route。 */
    privacyModel: ObservableSnapshot<string>
    /** 摘要候选下限（估算器单位）。 */
    minInlineTokens: ObservableSnapshot<number>
    /** `bash` / `web_fetch` 的摘要上限。 */
    maxSummarizeTokens: ObservableSnapshot<number>
    /** 摘要请求的推理档位。 */
    summaryReasoningEffort: ObservableSnapshot<ReasoningEffort>
    /** 准入请求的推理档位。 */
    admissionReasoningEffort: ObservableSnapshot<ReasoningEffort>
    /** 隐私请求的推理档位。 */
    privacyReasoningEffort: ObservableSnapshot<ReasoningEffort>
    /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
    summaryPrompt: ObservableSnapshot<string>
    /** 准入提示词的规则正文覆盖；空串表示用内置默认。 */
    admissionPrompt: ObservableSnapshot<string>
    /** 隐私提示词的规则正文覆盖；空串表示用内置默认。 */
    privacyPrompt: ObservableSnapshot<string>
    /** debug JSONL 路径；未配置时为空串。 */
    debugPath: ObservableSnapshot<string>
    /** DSH 当前可路由的 provider 分组与模型；provider 与 model 的候选来自它。 */
    modelCatalog: ObservableSnapshot<readonly ModelCatalogProvider[]>
  }
  /**
   * 重读一次模型目录：卡片挂载时调用，把刚在「设置 → 模型」里配好的 route 带进候选。
   */
  refreshModelCatalog(): void
  /**
   * 把一组改动作为**一次原子写入**提交：所有 op 共用一个 revision 栅栏与一次 Host 校验，任一条被拒就整组
   * 不生效。
   * @param ops - 按顺序的字段操作。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  saveFields(ops: readonly ResultClipperSettingOp[]): Promise<boolean>
}

/** 渲染机为本配置区合成的 props：槽位运行面（含 `view`）、本插件的文案命名空间、注入的业务面。 */
export type ResultClipperCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'resultClipper'>
  & InjectFace<ResultClipperCardInjected>

/** 控件行的排版。 */
const ROW_STYLE = { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 0' } as const

/** 字段标题的排版。 */
const TITLE_STYLE = { fontSize: 14, lineHeight: '20px' } as const

/** 说明与失败提示共用的排版。 */
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

/** 角色分组的标题排版：三个角色的设置各自成组，标题把该组与其它组分开。 */
const GROUP_STYLE = { margin: '24px 0 0', fontSize: 13, fontWeight: 600, lineHeight: '20px' } as const

/** 分组之间的长横线。 */
const DIVIDER_STYLE = { border: 0, borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '12px 0 0' } as const

/** 一个角色的 route 行：provider、model 与推理档位并排。 */
const ROUTE_STYLE = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 } as const

/** 成对的数字参数（摘要下限与上限）并排。 */
const PAIR_STYLE = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as const

/** 一组底部的「保存 / 恢复默认」按钮行排版。 */
const ACTIONS_STYLE = { display: 'flex', gap: 8, padding: '12px 0 0' } as const

/** 隐私 route 未确认为本地时的常驻警告排版。 */
const WARNING_STYLE = {
  color: 'var(--dsw-alias-state-warn-label)',
  fontSize: 12,
  lineHeight: '18px',
  padding: '8px 0',
} as const

/**
 * 输入类控件的排版，照搬「设置 → 模型 → 提供商」那一页的 `.input`：32px 高、0.5px 描边、同一档圆角与底色。
 * 这是本卡片唯一一处抄外部样式的决定，理由是用户直接点名那一页好看——控件长得像同一套，卡片才不像半成品。
 * 没有 CSS 管线，所以这些值只能内联；伪类（`:focus` / `::placeholder`）内联不了，焦点态留给浏览器的默认焦点圈。
 */
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

/**
 * 下拉箭头：与「设置 → 模型」那一页同一枚 12px 雪佛龙。用背景图把它从右边缘内缩 12px，替掉系统箭头
 * （系统箭头贴着自己的右边缘，整格宽时看着就在格子尽头）；数据 URI 里取不到 CSS 变量，颜色写死 #81858C。
 */
const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

/** 下拉框：输入框加 `appearance: none` 与内缩的雪佛龙，并像那一页一样把宽度封在 240px（枚举值都短）。 */
const SELECT_STYLE = {
  ...INPUT_STYLE,
  appearance: 'none',
  paddingRight: 32,
  maxWidth: 240,
  cursor: 'pointer',
  backgroundImage: CHEVRON,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  backgroundSize: '12px 12px',
} as const

/** 文本域：同一套描边与底色，但要能竖向写多行、能拖高。 */
const TEXTAREA_STYLE = {
  ...INPUT_STYLE,
  height: 'auto',
  padding: '6px 10px',
  minHeight: 80,
  resize: 'vertical',
} as const

/** 下拉框的七个档位与它们的文案键；候选集与 host 半 schema 的取值同一份（`reasoning.ts`）。 */
const EFFORT_LABELS: Record<ReasoningEffort, ResultClipperLocaleKey> = {
  off: 'effortOff',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
}

/** 草稿里一个字段的值：数字在草稿里是字符串，输入框才能原样编辑（含临时清空）。 */
type DraftValue = string | boolean

/** 一个字段的种类，决定草稿怎么播种、怎么比较、保存时怎么转换。 */
type FieldKind = 'text' | 'number' | 'boolean' | 'prompt'

/** 一个分组字段的规格。 */
interface GroupFieldSpec {
  /** settings 键。 */
  readonly field: ResultClipperCardField
  readonly kind: FieldKind
  /**
   * 「恢复默认」回到的内置默认；缺省表示回到**上一次保存的值**（丢掉未保存的改动）。
   * 提示词字段给内置规则正文：草稿等于它时保存走 `unset`，不写一条与内置正文逐字相同的覆盖。
   */
  readonly fallback?: string | number | boolean
}

/** 一个分组的草稿面与它的保存 / 恢复默认动作。 */
interface DraftedGroup {
  /** 一个字段的草稿值。 */
  value(field: ResultClipperCardField): DraftValue
  /** 改一个字段的草稿；只动本地状态。 */
  change(field: ResultClipperCardField, next: DraftValue): void
  /** 该组是否有未保存的改动。 */
  readonly dirty: boolean
  /** 该组是否有写入在途。 */
  readonly busy: boolean
  /** 上一次保存是否被 Host 拒绝。 */
  readonly failed: boolean
  /** 提交该组的全部改动。 */
  save(): void
  /** 「恢复默认」：内置默认字段回到默认，其余回到上一次保存的值。 */
  reset(): void
}

/** 已存值在一组里的读数：字段名到取值。 */
type PersistedValues = Readonly<Record<string, string | number | boolean>>

/** 字段值在草稿里的表示。 */
function draftOf(spec: GroupFieldSpec, value: string | number | boolean): DraftValue {
  return spec.kind === 'number' ? String(value) : value as DraftValue
}

/**
 * 草稿值转成要写回的取值。
 * @param spec - 字段规格。
 * @param draft - 该字段的草稿值。
 * @returns 要写回的取值；数字字段不是数字时交回 `undefined`（该组保存失败，一条都不写）。
 */
function storedOf(spec: GroupFieldSpec, draft: DraftValue): string | number | boolean | undefined {
  if (spec.kind !== 'number') return draft
  const text = String(draft).trim()
  const value = Number(text)
  return text === '' || !Number.isFinite(value) ? undefined : value
}

/**
 * 一组设置的草稿状态：从已存值播种、编辑只改草稿、保存把该组改动作为一次原子写入提交。
 *
 * 重新播种的时机是 **Host 侧取值变化**（保存被接受、或别处写入），不是每次渲染——否则用户刚打的字会被自己
 * 的输入触发的那次渲染冲掉。
 * @param specs - 该组的字段规格。
 * @param persisted - 该组字段的已存值；提示词字段给的是**当前生效正文**（有覆盖用覆盖，否则内置正文）。
 * @param saveFields - 一次原子写入的提交路径。
 * @returns 该组的草稿面与动作。
 */
function useGroupDraft(
  specs: readonly GroupFieldSpec[],
  persisted: PersistedValues,
  saveFields: (ops: readonly ResultClipperSettingOp[]) => Promise<boolean>,
): DraftedGroup {
  const seed = (): Record<string, DraftValue> =>
    Object.fromEntries(specs.map(spec => [spec.field, draftOf(spec, persisted[spec.field]!)]))
  const [draft, setDraft] = useState(seed)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const persistedView = JSON.stringify(specs.map(spec => persisted[spec.field]))
  useEffect(() => { setDraft(seed()) }, [persistedView])

  const changed = specs.filter(spec => draft[spec.field] !== draftOf(spec, persisted[spec.field]!))
  return {
    value: field => draft[field]!,
    change: (field, next) => {
      setFailed(false)
      setDraft(current => ({ ...current, [field]: next }))
    },
    dirty: changed.length > 0,
    busy,
    failed,
    save: () => {
      if (changed.length === 0) return
      const ops: ResultClipperSettingOp[] = []
      for (const spec of changed) {
        const value = storedOf(spec, draft[spec.field]!)
        // 数字框里不是数字：整组不写，避免一半字段生效。
        if (value === undefined) {
          setFailed(true)
          return
        }
        ops.push(spec.kind === 'prompt' && draft[spec.field] === spec.fallback
          // 写回内置正文等于「没有覆盖」：清掉覆盖，不留下逐字相同的冗余覆盖。
          ? { op: 'unset', path: [spec.field] }
          : { op: 'set', path: [spec.field], value })
      }
      setFailed(false)
      setBusy(true)
      void saveFields(ops)
        .then((accepted) => { if (!accepted) setFailed(true) })
        .catch(() => { setFailed(true) })
        .finally(() => { setBusy(false) })
    },
    reset: () => {
      setFailed(false)
      setDraft(Object.fromEntries(specs.map(spec => [
        spec.field,
        draftOf(spec, spec.fallback ?? persisted[spec.field]!),
      ])))
    },
  }
}

/**
 * 一个分组：标题、该角色的控件、底部的「保存 / 恢复默认」与失败提示。
 * @param props - 分组标题与内容、草稿状态与按钮文案。
 * @returns 一组设置。
 */
function Group(props: {
  readonly title: string
  /** 该角色是做什么的：一行简介，放在标题下方。 */
  readonly description: string
  readonly children: ReactNode
  readonly dirty: boolean
  readonly busy: boolean
  readonly failed: boolean
  readonly failedHint: string
  readonly saveLabel: string
  readonly resetLabel: string
  readonly onSave: () => void
  readonly onReset: () => void
}) {
  return <section style={{ padding: '4px 0' }}>
    <h4 style={GROUP_STYLE}>{props.title}</h4>
    <div style={HINT_STYLE}>{props.description}</div>
    {props.children}
    <div style={ACTIONS_STYLE}>
      <button type="button" disabled={props.busy || !props.dirty} onClick={props.onSave}>{props.saveLabel}</button>
      <button type="button" disabled={props.busy} onClick={props.onReset}>{props.resetLabel}</button>
    </div>
    {props.failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/**
 * 一行文本参数；编辑只改草稿，由所在组的「保存」写回。
 * @param props - 行文案、提示、草稿值与改动回调。
 * @returns 一行文本控件。
 */
function TextRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly onChange: (next: string) => void
}) {
  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <input
      id={props.id}
      type="text"
      style={INPUT_STYLE}
      value={props.value}
      onChange={(event) => { props.onChange(event.target.value) }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/** 一行 route 字段（provider 或 model）的 props。 */
interface RouteRowProps {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  /** 目录里的候选；空数组表示目录不可用，此时退回纯文本输入。 */
  readonly options: readonly { readonly value: string; readonly label: string }[]
  /** 空串这一档的说法（`未配置` / `跟随摘要 route`）；给出时空串是一条可选项。 */
  readonly emptyLabel: string
  /** 「自定义…」按钮文案。 */
  readonly customLabel: string
  /** 「从目录里选」按钮文案。 */
  readonly pickLabel: string
  /** 当前值不在目录里时那条选项的后缀。 */
  readonly unknownSuffix: string
  readonly onChange: (next: string) => void
}

/**
 * 一行 route 字段：**下拉框**列出目录里的全部候选，另有一个「自定义…」入口用于目录外的 id。
 *
 * 三种形态：① 有候选时是 `<select>`（当前值不在目录里就把它作为一条带后缀的选项保留，不会丢）；
 * ② 点了「自定义…」（或目录里根本没有候选）时是文本输入，目录可用时给一个「从目录里选」的回退按钮——
 * DSH 的核心路由接受未列出的 model id，纯下拉会把这种部署变成不可配置。
 * @param props - 行文案、草稿值、候选与三处按钮/选项文案。
 * @returns 一行 route 控件。
 */
function RouteRow(props: RouteRowProps) {
  const [typing, setTyping] = useState(false)
  const known = props.options.some(option => option.value === props.value)
  if (typing || props.options.length === 0) {
    return <section style={ROW_STYLE}>
      <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
      <input
        id={props.id}
        type="text"
        style={INPUT_STYLE}
        value={props.value}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
      {props.options.length > 0 && <div>
        <button type="button" onClick={() => { setTyping(false) }}>{props.pickLabel}</button>
      </div>}
      <div style={HINT_STYLE}>{props.hint}</div>
    </section>
  }
  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <select
      id={props.id}
      value={props.value}
      aria-label={props.label}
      style={SELECT_STYLE}
      onChange={(event) => { props.onChange(event.target.value) }}
    >
      <option value="">{props.emptyLabel}</option>
      {!known && props.value !== ''
        && <option value={props.value}>{`${props.value}${props.unknownSuffix}`}</option>}
      {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <div>
      <button type="button" onClick={() => { setTyping(true) }}>{props.customLabel}</button>
    </div>
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/** 一个角色的 route 行：provider、model 与推理档位并排。 */
function RouteLine(props: {
  readonly provider: RouteRowProps
  readonly model: RouteRowProps
  readonly effort: Parameters<typeof EffortRow>[0]
}) {
  return <div style={ROUTE_STYLE}>
    <RouteRow {...props.provider} />
    <RouteRow {...props.model} />
    <EffortRow {...props.effort} />
  </div>
}

/**
 * 一行数字参数；草稿是原始字符串，保存时才转成数字。
 * @param props - 行文案、提示、草稿值与改动回调。
 * @returns 一行数字控件。
 */
function NumberRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly onChange: (next: string) => void
}) {
  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <input
      id={props.id}
      type="number"
      style={INPUT_STYLE}
      value={props.value}
      onChange={(event) => { props.onChange(event.target.value) }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/**
 * 一行推理档位：下拉框。选项是 pi-ai 的规范档位，能不能用由所选 route 的档位表决定。
 * @param props - 控件 id 与行文案、草稿值、选项与改动回调。
 * @returns 一行下拉控件。
 */
function EffortRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: ReasoningEffort
  readonly options: readonly { readonly value: ReasoningEffort; readonly label: string }[]
  readonly onChange: (next: ReasoningEffort) => void
}) {
  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <select
      id={props.id}
      value={props.value}
      aria-label={props.label}
      style={SELECT_STYLE}
      onChange={(event) => { props.onChange(event.target.value as ReasoningEffort) }}
    >
      {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/**
 * 一行二选一参数：两个分段按钮。隐私失败策略用它。
 * @param props - 控件 id 与行文案、草稿值、两个选项与改动回调。
 * @returns 一行分段控件。
 */
function ChoiceRow<Value extends string>(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly onChange: (next: Value) => void
}) {
  return <section id={props.id} style={ROW_STYLE}>
    <div style={TITLE_STYLE}>{props.label}</div>
    <SegmentedControl
      id={props.id}
      value={props.value}
      options={props.options}
      label={props.label}
      onChange={props.onChange}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/**
 * 一行复选框参数（隐私 route 确认位用它）。
 * @param props - 控件 id 与行文案、草稿值与改动回调。
 * @returns 一行复选框控件。
 */
function CheckRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
}) {
  return <section id={props.id} style={ROW_STYLE}>
    <Checkbox checked={props.checked} label={props.label} onChange={props.onChange} />
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/**
 * 提示词规则正文：框里是**当前生效正文的草稿**（有覆盖时从覆盖播种，否则从内置正文），编辑只改草稿；写回
 * 由所在组的「保存」完成，草稿等于内置正文时保存走 `unset`（清掉覆盖）。
 * @param props - 控件 id、行文案、提示、草稿值与改动回调。
 * @returns 一行文本域。
 */
function PromptRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly onChange: (next: string) => void
}) {
  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <textarea
      id={props.id}
      style={TEXTAREA_STYLE}
      value={props.value}
      onChange={(event) => { props.onChange(event.target.value) }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
  </section>
}

/** 摘要组的字段：route、推理档位、两个阈值与提示词。 */
const SUMMARY_FIELDS: readonly GroupFieldSpec[] = [
  { field: 'routeProvider', kind: 'text' },
  { field: 'routeModel', kind: 'text' },
  { field: 'summaryReasoningEffort', kind: 'text', fallback: 'off' },
  { field: 'minInlineTokens', kind: 'number', fallback: 1024 },
  { field: 'maxSummarizeTokens', kind: 'number', fallback: 12500 },
  { field: 'summaryPrompt', kind: 'prompt', fallback: DEFAULT_SUMMARY_RULE },
]

/** 准入组的字段：启用开关、route、推理档位与提示词。 */
const ADMISSION_FIELDS: readonly GroupFieldSpec[] = [
  { field: 'admissionJudge', kind: 'boolean' },
  { field: 'admissionProvider', kind: 'text' },
  { field: 'admissionModel', kind: 'text' },
  { field: 'admissionReasoningEffort', kind: 'text', fallback: 'off' },
  { field: 'admissionPrompt', kind: 'prompt', fallback: DEFAULT_ADMISSION_RULE },
]

/** 隐私组的字段：route、推理档位、确认位、失败策略与提示词。 */
const PRIVACY_FIELDS: readonly GroupFieldSpec[] = [
  { field: 'privacyProvider', kind: 'text' },
  { field: 'privacyModel', kind: 'text' },
  { field: 'privacyReasoningEffort', kind: 'text', fallback: 'off' },
  { field: 'privacyConfirmedLocal', kind: 'boolean' },
  { field: 'failurePolicy', kind: 'text' },
  { field: 'privacyPrompt', kind: 'prompt', fallback: DEFAULT_PRIVACY_RULE },
]

/** 诊断组的字段：debug 日志路径。 */
const DIAGNOSTIC_FIELDS: readonly GroupFieldSpec[] = [{ field: 'debugPath', kind: 'text' }]

/** 一条 route 的两个字段名；`confirm` 只有隐私组有——「已确认为本地」是对这条 route 的声明。 */
interface RouteFields {
  readonly provider: ResultClipperCardField
  readonly model: ResultClipperCardField
  readonly confirm?: ResultClipperCardField
}

/** 三条 route 的字段名：`changeRoute` 与三个角色的 route 行共用一份。 */
const SUMMARY_ROUTE: RouteFields = { provider: 'routeProvider', model: 'routeModel' }
const ADMISSION_ROUTE: RouteFields = { provider: 'admissionProvider', model: 'admissionModel' }
const PRIVACY_ROUTE: RouteFields = {
  provider: 'privacyProvider', model: 'privacyModel', confirm: 'privacyConfirmedLocal',
}

/**
 * 渲染这个配置区。
 * @param props - 注入的读数与原子写入路径、页面文案。
 * @returns 三个角色分组加诊断组的参数控件。
 */
export function ResultClipperCard(props: ResultClipperCardProps) {
  const privacyGate = props.usePrivacyGate(value => value)
  const privacyConfirmedLocal = props.usePrivacyConfirmedLocal(value => value)
  const failurePolicy = props.useFailurePolicy(value => value)
  const routeProvider = props.useRouteProvider(value => value)
  const routeModel = props.useRouteModel(value => value)
  const admissionJudge = props.useAdmissionJudge(value => value)
  const admissionProvider = props.useAdmissionProvider(value => value)
  const admissionModel = props.useAdmissionModel(value => value)
  const privacyProvider = props.usePrivacyProvider(value => value)
  const privacyModel = props.usePrivacyModel(value => value)
  const minInlineTokens = props.useMinInlineTokens(value => value)
  const maxSummarizeTokens = props.useMaxSummarizeTokens(value => value)
  const summaryReasoningEffort = props.useSummaryReasoningEffort(value => value)
  const admissionReasoningEffort = props.useAdmissionReasoningEffort(value => value)
  const privacyReasoningEffort = props.usePrivacyReasoningEffort(value => value)
  const summaryPrompt = props.useSummaryPrompt(value => value)
  const admissionPrompt = props.useAdmissionPrompt(value => value)
  const privacyPrompt = props.usePrivacyPrompt(value => value)
  const debugPath = props.useDebugPath(value => value)
  const catalog = props.useModelCatalog(value => value)
  // 卡片挂载时重读一次目录：用户往往是先去「设置 → 模型」建 route、再回来选它。
  useEffect(() => { props.refreshModelCatalog() }, [])

  const summary = useGroupDraft(SUMMARY_FIELDS, {
    routeProvider, routeModel, summaryReasoningEffort, minInlineTokens, maxSummarizeTokens,
    // 提示词的已存值是**生效正文**：草稿与它相同就没有改动，等于内置正文时保存走 `unset`。
    summaryPrompt: summaryPrompt === '' ? DEFAULT_SUMMARY_RULE : summaryPrompt,
  }, props.saveFields)
  const admission = useGroupDraft(ADMISSION_FIELDS, {
    admissionJudge, admissionProvider, admissionModel, admissionReasoningEffort,
    admissionPrompt: admissionPrompt === '' ? DEFAULT_ADMISSION_RULE : admissionPrompt,
  }, props.saveFields)
  const privacy = useGroupDraft(PRIVACY_FIELDS, {
    privacyProvider, privacyModel, privacyReasoningEffort, privacyConfirmedLocal, failurePolicy,
    privacyPrompt: privacyPrompt === '' ? DEFAULT_PRIVACY_RULE : privacyPrompt,
  }, props.saveFields)
  const diagnostics = useGroupDraft(DIAGNOSTIC_FIELDS, { debugPath }, props.saveFields)

  const failedHint = props.t('failedHint')
  const effortOptions = REASONING_EFFORT_IDS.map(choice => ({ value: choice, label: props.t(EFFORT_LABELS[choice]) }))
  const providerOptions = catalog.map(group => ({ value: group.id, label: group.name }))
  /** 某个 provider 在目录里的模型候选；provider 还不在目录里时为空（「自定义…」仍然可用）。 */
  const modelOptions = (provider: string): readonly { readonly value: string; readonly label: string }[] =>
    catalog.find(group => group.id === provider)?.models.map(model => ({ value: model.id, label: model.name })) ?? []
  /** route 行共用的三处「不在目录里」文案。 */
  const routeText = {
    customLabel: props.t('customValue'),
    pickLabel: props.t('pickFromCatalog'),
    unknownSuffix: props.t('notInCatalog'),
  }
  const saveLabel = props.t('saveGroup')
  const resetLabel = props.t('resetGroup')
  /** 一组底部的按钮与失败提示。 */
  const actions = (group: DraftedGroup) => ({
    dirty: group.dirty, busy: group.busy, failed: group.failed, failedHint,
    saveLabel, resetLabel, onSave: group.save, onReset: group.reset,
  })
  /**
   * 改一条 route 的 provider 或 model。两件事跟着走：
   *
   * - **确认作废**：隐私组的「已确认为本地」是对**具体 route** 的声明（`src/index.ts` 只读那个布尔、不校验它对应
   *   哪条 route），所以 route 任一半变了就清掉草稿里的确认位——否则换一条没确认过的 route 会沿用旧确认继续放行，
   *   把敏感正文发往外部网络。只有隐私组传 `confirm`。
   * - **model 跟着 provider**：换 provider 后当前 model 不是它的候选就清空，不留跨 provider 的残缺配对；provider
   *   被清空时同样清空（摘要组＝不摘要，另两组＝跟随摘要模型）。目录读不到（候选为空）时不猜，保留手填值，
   *   免得手填 provider + model 的部署变成不可配置。
   */
  const changeRoute = (group: DraftedGroup, route: RouteFields, field: 'provider' | 'model', next: string): void => {
    const target = field === 'provider' ? route.provider : route.model
    group.change(target, next)
    // 只有真的换了取值才会走到这里：React 对受控控件的同值事件不再派发 onChange（value tracker）。
    if (route.confirm !== undefined) group.change(route.confirm, false)
    if (field === 'model') return
    const current = group.value(route.model)
    if (typeof current !== 'string' || current === '') return
    const known = modelOptions(next)
    if (next === '' || (known.length > 0 && !known.some(option => option.value === current))) {
      group.change(route.model, '')
    }
  }

  return <div>
    <p style={{ ...HINT_STYLE, padding: '4px 0' }}>{props.t('flowWarning')}</p>
    <p style={{ ...HINT_STYLE, padding: '4px 0' }}>{props.t('modelSourceHint')}</p>
    {privacyGate && !privacyConfirmedLocal
      && <div role="alert" style={WARNING_STYLE}>{props.t('routeUnconfirmedWarning')}</div>}

    <Group title={props.t('summaryGroup')} description={props.t('summaryGroupHint')} {...actions(summary)}>
      <RouteLine
        provider={{
          ...routeText, id: 'plugin-config-result-clipper-route-provider',
          label: props.t('routeProvider'), hint: props.t('routeProviderHint'),
          value: summary.value('routeProvider') as string, options: providerOptions,
          emptyLabel: props.t('routeUnset'),
          onChange: next => { changeRoute(summary, SUMMARY_ROUTE, 'provider', next) },
        }}
        model={{
          ...routeText, id: 'plugin-config-result-clipper-route-model',
          label: props.t('routeModel'), hint: props.t('routeModelHint'),
          value: summary.value('routeModel') as string,
          options: modelOptions(summary.value('routeProvider') as string),
          emptyLabel: props.t('routeUnset'),
          onChange: next => { changeRoute(summary, SUMMARY_ROUTE, 'model', next) },
        }}
        effort={{
          id: 'plugin-config-result-clipper-summary-effort', label: props.t('reasoningEffort'),
          hint: props.t('reasoningEffortHint'), options: effortOptions,
          value: summary.value('summaryReasoningEffort') as ReasoningEffort,
          onChange: next => { summary.change('summaryReasoningEffort', next) },
        }} />
      <div style={PAIR_STYLE}>
        <NumberRow id="plugin-config-result-clipper-min-inline" label={props.t('minInlineTokens')}
          hint={props.t('minInlineTokensHint')} value={summary.value('minInlineTokens') as string}
          onChange={next => { summary.change('minInlineTokens', next) }} />
        <NumberRow id="plugin-config-result-clipper-max-summarize" label={props.t('maxSummarizeTokens')}
          hint={props.t('maxSummarizeTokensHint')} value={summary.value('maxSummarizeTokens') as string}
          onChange={next => { summary.change('maxSummarizeTokens', next) }} />
      </div>
      <PromptRow id="plugin-config-result-clipper-summary-prompt" label={props.t('summaryPrompt')}
        hint={props.t('promptHint')} value={summary.value('summaryPrompt') as string}
        onChange={next => { summary.change('summaryPrompt', next) }} />
    </Group>

    <hr style={DIVIDER_STYLE} />

    <Group title={props.t('admissionGroup')} description={props.t('admissionGroupHint')} {...actions(admission)}>
      {/* 折起来就等于不启用：开关（草稿）决定这一组是否有内容，勾上才出现下面这整组设置。 */}
      <CheckRow id="plugin-config-result-clipper-admission-enabled" label={props.t('admissionJudge')}
        hint={props.t('admissionJudgeHint')}
        checked={admission.value('admissionJudge') as boolean}
        onChange={next => { admission.change('admissionJudge', next) }} />
      {admission.value('admissionJudge') === true && <>
      <RouteLine
        provider={{
          ...routeText, id: 'plugin-config-result-clipper-admission-provider',
          label: props.t('routeProvider'), hint: props.t('routeProviderHint'),
          value: admission.value('admissionProvider') as string, options: providerOptions,
          emptyLabel: props.t('followSummaryRoute'),
          onChange: next => { changeRoute(admission, ADMISSION_ROUTE, 'provider', next) },
        }}
        model={{
          ...routeText, id: 'plugin-config-result-clipper-admission-model',
          label: props.t('routeModel'), hint: props.t('routeModelHint'),
          value: admission.value('admissionModel') as string,
          options: modelOptions(admission.value('admissionProvider') as string),
          emptyLabel: props.t('followSummaryRoute'),
          onChange: next => { changeRoute(admission, ADMISSION_ROUTE, 'model', next) },
        }}
        effort={{
          id: 'plugin-config-result-clipper-admission-effort', label: props.t('reasoningEffort'),
          hint: props.t('reasoningEffortHint'), options: effortOptions,
          value: admission.value('admissionReasoningEffort') as ReasoningEffort,
          onChange: next => { admission.change('admissionReasoningEffort', next) },
        }} />
      <PromptRow id="plugin-config-result-clipper-admission-prompt" label={props.t('admissionPrompt')}
        hint={props.t('promptHint')} value={admission.value('admissionPrompt') as string}
        onChange={next => { admission.change('admissionPrompt', next) }} />
      </>}
    </Group>

    <hr style={DIVIDER_STYLE} />

    <Group title={props.t('privacyGroup')} description={props.t('privacyGroupHint')} {...actions(privacy)}>
      <RouteLine
        provider={{
          ...routeText, id: 'plugin-config-result-clipper-privacy-provider',
          label: props.t('routeProvider'), hint: props.t('routeProviderHint'),
          value: privacy.value('privacyProvider') as string, options: providerOptions,
          emptyLabel: props.t('followSummaryRoute'),
          onChange: next => { changeRoute(privacy, PRIVACY_ROUTE, 'provider', next) },
        }}
        model={{
          ...routeText, id: 'plugin-config-result-clipper-privacy-model',
          label: props.t('routeModel'), hint: props.t('routeModelHint'),
          value: privacy.value('privacyModel') as string,
          options: modelOptions(privacy.value('privacyProvider') as string),
          emptyLabel: props.t('followSummaryRoute'),
          onChange: next => { changeRoute(privacy, PRIVACY_ROUTE, 'model', next) },
        }}
        effort={{
          id: 'plugin-config-result-clipper-privacy-effort', label: props.t('reasoningEffort'),
          hint: props.t('reasoningEffortHint'), options: effortOptions,
          value: privacy.value('privacyReasoningEffort') as ReasoningEffort,
          onChange: next => { privacy.change('privacyReasoningEffort', next) },
        }} />
      <CheckRow id="plugin-config-result-clipper-privacy-confirmed" label={props.t('privacyConfirmedLocal')}
        hint={props.t('privacyConfirmedLocalHint')}
        checked={privacy.value('privacyConfirmedLocal') as boolean}
        onChange={next => { privacy.change('privacyConfirmedLocal', next) }} />
      <ChoiceRow id="plugin-config-result-clipper-failure-policy" label={props.t('failurePolicy')}
        hint={props.t('failurePolicyHint')}
        value={privacy.value('failurePolicy') as 'passthrough' | 'block'} options={[
          { value: 'passthrough' as const, label: props.t('failurePolicyPassthrough') },
          { value: 'block' as const, label: props.t('failurePolicyBlock') },
        ]} onChange={next => { privacy.change('failurePolicy', next) }} />
      <PromptRow id="plugin-config-result-clipper-privacy-prompt" label={props.t('privacyPrompt')}
        hint={props.t('promptHint')} value={privacy.value('privacyPrompt') as string}
        onChange={next => { privacy.change('privacyPrompt', next) }} />
    </Group>

    <hr style={DIVIDER_STYLE} />

    <Group title={props.t('diagnosticsGroup')} description={props.t('diagnosticsGroupHint')} {...actions(diagnostics)}>
      <TextRow id="plugin-config-result-clipper-debug-path" label={props.t('debugPath')}
        hint={props.t('debugPathHint')} value={diagnostics.value('debugPath') as string}
        onChange={next => { diagnostics.change('debugPath', next) }} />
    </Group>
  </div>
}
