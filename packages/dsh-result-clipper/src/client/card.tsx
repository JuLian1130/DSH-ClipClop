/**
 * `plugins.bundle.config` 的包详情页配置区：摘要参数（主 route、两个阈值、「关闭推理」开关、提示词规则正文）、
 * 准入参数（准入 route、「关闭推理」开关、提示词规则正文）、隐私参数（主 route 确认位、失败策略、隐私
 * 「关闭推理」开关、隐私提示词规则正文）与 debug 日志路径。
 *
 * 配置区与页签分座是设计文档「配置面与设置座位」的座位约定——开关在插件页签、参数在包自己的详情页；写入走
 * `configForms` 的立即写：这些字段在 schema 上都是 `volatile`，写入即生效、不需要整页保存。参数行的失焦即写，
 * 提示词行例外——它的文本域是草稿，点该行的「保存」才写回（没保存就离开设置不会留下改动）。失败形态与页签
 * 同源——`set` 在 Host 拒绝时 resolve `false`，所以失败态在 await 之后核验返回值才置位。
 *
 * 隐私闸门开启而主 route 未确认为本地时，卡片顶部显示常驻警告——它只反映这一静态配置状态，不反映运行期
 * 失效（运行期失效的可见面是会话提醒）；确认后或关闭隐私开关后警告消失。
 *
 * 「恢复默认」清掉提示词的用户覆盖（`unset`），保存后回落到底层默认（内置规则正文）。安全外壳与输出格式
 * 由 host 半写死，这里只能编辑规则正文。
 *
 * @module
 */

import { useEffect, useState } from 'react'
import { Checkbox, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 无依赖的共享模块：host 半拼装请求用的是同一份文字，所以框里显示的默认与真正发出的正文不会漂移。
import { DEFAULT_ADMISSION_RULE, DEFAULT_PRIVACY_RULE, DEFAULT_SUMMARY_RULE } from '../rules.ts'

/** 卡片的可写字段，与 host 半 `Config` 的字段同名（也是 settings section 里的键）。 */
export type ResultClipperCardField =
  | 'routeProvider'
  | 'routeModel'
  | 'routeConfirmedLocal'
  | 'failurePolicy'
  | 'admissionProvider'
  | 'admissionModel'
  | 'minInlineTokens'
  | 'maxSummarizeTokens'
  | 'summaryDisableReasoning'
  | 'admissionDisableReasoning'
  | 'privacyDisableReasoning'
  | 'summaryPrompt'
  | 'admissionPrompt'
  | 'privacyPrompt'
  | 'debugPath'

/** 注册者自己的业务面：逐字段读数与写入，加上三份提示词的清空。 */
export interface ResultClipperCardInjected {
  hooks: {
    /** 隐私闸门开关的当前值；常驻警告按它与确认位一起显示。 */
    privacyGate: ObservableSnapshot<boolean>
    /** 「主 route 已确认为本地」确认位的当前值。 */
    routeConfirmedLocal: ObservableSnapshot<boolean>
    /** 隐私失效的处理策略：`passthrough` 放行原文，`block` 给出拒绝结果。 */
    failurePolicy: ObservableSnapshot<'passthrough' | 'block'>
    /** 主 route 的 provider。 */
    routeProvider: ObservableSnapshot<string>
    /** 主 route 的 model id。 */
    routeModel: ObservableSnapshot<string>
    /** 准入 route 的 provider；空串表示跟随主 route。 */
    admissionProvider: ObservableSnapshot<string>
    /** 准入 route 的 model id；空串表示跟随主 route。 */
    admissionModel: ObservableSnapshot<string>
    /** 摘要候选下限（估算器单位）。 */
    minInlineTokens: ObservableSnapshot<number>
    /** `bash` / `web_fetch` 的摘要上限。 */
    maxSummarizeTokens: ObservableSnapshot<number>
    /** 摘要请求是否关闭推理。 */
    summaryDisableReasoning: ObservableSnapshot<boolean>
    /** 准入请求是否关闭推理。 */
    admissionDisableReasoning: ObservableSnapshot<boolean>
    /** 隐私请求是否关闭推理。 */
    privacyDisableReasoning: ObservableSnapshot<boolean>
    /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
    summaryPrompt: ObservableSnapshot<string>
    /** 准入提示词的规则正文覆盖；空串表示用内置默认。 */
    admissionPrompt: ObservableSnapshot<string>
    /** 隐私提示词的规则正文覆盖；空串表示用内置默认。 */
    privacyPrompt: ObservableSnapshot<string>
    /** debug JSONL 路径；未配置时为空串。 */
    debugPath: ObservableSnapshot<string>
  }
  /**
   * 写回一个字段。
   * @param field - 要写的字段。
   * @param value - 用户给出的新取值。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  setField(field: ResultClipperCardField, value: string | number | boolean): Promise<boolean>
  /**
   * 清掉摘要提示词的覆盖，让它回落到底层默认。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  resetSummaryPrompt(): Promise<boolean>
  /**
   * 清掉准入提示词的覆盖，让它回落到底层默认。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  resetAdmissionPrompt(): Promise<boolean>
  /**
   * 清掉隐私提示词的覆盖，让它回落到底层默认。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  resetPrivacyPrompt(): Promise<boolean>
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

/** 主 route 未确认为本地时的常驻警告排版。 */
const WARNING_STYLE = {
  color: 'var(--dsw-alias-state-warn-label)',
  fontSize: 12,
  lineHeight: '18px',
  padding: '8px 0',
} as const

/** 输入框与文本域的排版；没有 CSS 管线，所以只用内联样式与主题变量。 */
const INPUT_STYLE = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
} as const

/**
 * 一行文本参数：失焦或回车即写。
 * @param props - 行文案、提示、当前值与写入动作。
 * @returns 一行文本控件。
 */
function TextRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly value: string
  readonly write: (value: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(props.value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // Host 侧的值变了（别处写入、或写入被接受）就重新播种草稿，使控件显示的是当前生效值。
  useEffect(() => { setDraft(props.value) }, [props.value])

  const commit = (): void => {
    if (draft === props.value) return
    setFailed(false)
    setBusy(true)
    void props.write(draft)
      .then((accepted) => { if (!accepted) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <input
      id={props.id}
      type="text"
      style={INPUT_STYLE}
      value={draft}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/**
 * 一行数字参数：失焦或回车即写，非数字草稿交给 Host 拒绝。
 * @param props - 行文案、提示、当前值与写入动作。
 * @returns 一行数字控件。
 */
function NumberRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly value: number
  readonly write: (value: number) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(String(props.value))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(String(props.value)) }, [props.value])

  const commit = (): void => {
    if (draft === String(props.value)) return
    setFailed(false)
    setBusy(true)
    void props.write(Number(draft))
      .then((accepted) => { if (!accepted) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <input
      id={props.id}
      type="number"
      style={INPUT_STYLE}
      value={draft}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/** 一行开关自己持有的写入状态。 */
function SwitchRow(props: {
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <section style={{ ...ROW_STYLE, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
    <div>
      <div style={TITLE_STYLE}>{props.label}</div>
      <div style={HINT_STYLE}>{props.hint}</div>
      {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
    </div>
    <Switch
      checked={props.checked}
      disabled={busy}
      label={props.label}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void props.onChange(next)
          .then((accepted) => { if (!accepted) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }}
    />
  </section>
}

/**
 * 一行二选一参数：两个分段按钮，选中即写。隐私失败策略用它，避免与「关闭推理」开关混在一排开关里。
 * @param props - 控件 id 与行文案、当前值、两个选项与写入动作。
 * @returns 一行分段控件。
 */
function ChoiceRow<Value extends string>(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly write: (value: Value) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <section id={props.id} style={ROW_STYLE}>
    <div style={TITLE_STYLE}>{props.label}</div>
    <SegmentedControl
      id={props.id}
      value={props.value}
      options={props.options}
      label={props.label}
      disabled={busy}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void props.write(next)
          .then((accepted) => { if (!accepted) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/** 一行复选框参数：勾选即写（主 route 确认位用它）。 */
function CheckRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <section id={props.id} style={ROW_STYLE}>
    <Checkbox
      checked={props.checked}
      disabled={busy}
      label={props.label}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void props.onChange(next)
          .then((accepted) => { if (!accepted) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/**
 * 提示词规则正文：框里显示**当前生效的正文**（有覆盖用覆盖，否则用内置默认）；编辑是草稿，点「保存」才写回
 * （失焦不写，所以没保存就离开设置不会留下改动）；「恢复默认」清掉覆盖、控件回落到内置默认。
 * @param props - 控件 id、行文案、提示、覆盖值、内置默认正文、按钮文案、写入与清空动作。
 * @returns 一行文本域加「保存」与「恢复默认」两个按钮。
 */
function PromptRow(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly saveLabel: string
  readonly resetLabel: string
  /** 用户写下的覆盖；空串表示没有覆盖。 */
  readonly value: string
  /** 内置规则正文；没有覆盖时，框里显示的和请求实际拼装用的都是它。 */
  readonly builtinRule: string
  readonly write: (value: string) => Promise<boolean>
  readonly reset: () => Promise<boolean>
}) {
  const effective = props.value === '' ? props.builtinRule : props.value
  const [draft, setDraft] = useState(effective)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(effective) }, [effective])

  const settle = (action: Promise<boolean>): void => {
    setFailed(false)
    setBusy(true)
    void action
      .then((accepted) => { if (!accepted) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  // 草稿与生效正文一致时没有可保存的东西；改回内置正文本身则清掉覆盖，不留下逐字相同的冗余覆盖。
  const dirty = draft !== effective
  const save = (): void => {
    if (!dirty) return
    settle(draft === props.builtinRule ? props.reset() : props.write(draft))
  }

  return <section style={ROW_STYLE}>
    <label htmlFor={props.id} style={TITLE_STYLE}>{props.label}</label>
    <textarea
      id={props.id}
      style={{ ...INPUT_STYLE, minHeight: 80, resize: 'vertical' }}
      value={draft}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value) }}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    <div style={{ display: 'flex', gap: 8 }}>
      <button type="button" disabled={busy || !dirty} onClick={save}>{props.saveLabel}</button>
      <button type="button" disabled={busy} onClick={() => { settle(props.reset()) }}>{props.resetLabel}</button>
    </div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/**
 * 渲染这个配置区。
 * @param props - 注入的读数与写入路径、页面文案。
 * @returns 参数控件。
 */
export function ResultClipperCard(props: ResultClipperCardProps) {
  const privacyGate = props.usePrivacyGate(value => value)
  const routeConfirmedLocal = props.useRouteConfirmedLocal(value => value)
  const failurePolicy = props.useFailurePolicy(value => value)
  const routeProvider = props.useRouteProvider(value => value)
  const routeModel = props.useRouteModel(value => value)
  const admissionProvider = props.useAdmissionProvider(value => value)
  const admissionModel = props.useAdmissionModel(value => value)
  const minInlineTokens = props.useMinInlineTokens(value => value)
  const maxSummarizeTokens = props.useMaxSummarizeTokens(value => value)
  const summaryDisableReasoning = props.useSummaryDisableReasoning(value => value)
  const admissionDisableReasoning = props.useAdmissionDisableReasoning(value => value)
  const privacyDisableReasoning = props.usePrivacyDisableReasoning(value => value)
  const summaryPrompt = props.useSummaryPrompt(value => value)
  const admissionPrompt = props.useAdmissionPrompt(value => value)
  const privacyPrompt = props.usePrivacyPrompt(value => value)
  const debugPath = props.useDebugPath(value => value)

  const write = (field: ResultClipperCardField) => (value: string | number | boolean) => props.setField(field, value)

  return <div>
    <p style={{ ...HINT_STYLE, padding: '4px 0' }}>{props.t('flowWarning')}</p>
    {privacyGate && !routeConfirmedLocal
      && <div role="alert" style={WARNING_STYLE}>{props.t('routeUnconfirmedWarning')}</div>}
    <TextRow id="plugin-config-result-clipper-route-provider" label={props.t('routeProvider')}
      hint={props.t('routeProviderHint')} failedHint={props.t('failedHint')}
      value={routeProvider} write={write('routeProvider')} />
    <TextRow id="plugin-config-result-clipper-route-model" label={props.t('routeModel')}
      hint={props.t('routeModelHint')} failedHint={props.t('failedHint')}
      value={routeModel} write={write('routeModel')} />
    <CheckRow id="plugin-config-result-clipper-route-confirmed" label={props.t('routeConfirmedLocal')}
      hint={props.t('routeConfirmedLocalHint')} failedHint={props.t('failedHint')}
      checked={routeConfirmedLocal}
      onChange={write('routeConfirmedLocal') as (next: boolean) => Promise<boolean>} />
    <ChoiceRow id="plugin-config-result-clipper-failure-policy" label={props.t('failurePolicy')}
      hint={props.t('failurePolicyHint')} failedHint={props.t('failedHint')}
      value={failurePolicy} options={[
        { value: 'passthrough' as const, label: props.t('failurePolicyPassthrough') },
        { value: 'block' as const, label: props.t('failurePolicyBlock') },
      ]} write={write('failurePolicy') as (next: 'passthrough' | 'block') => Promise<boolean>} />
    <TextRow id="plugin-config-result-clipper-admission-provider" label={props.t('admissionProvider')}
      hint={props.t('admissionProviderHint')} failedHint={props.t('failedHint')}
      value={admissionProvider} write={write('admissionProvider')} />
    <TextRow id="plugin-config-result-clipper-admission-model" label={props.t('admissionModel')}
      hint={props.t('admissionModelHint')} failedHint={props.t('failedHint')}
      value={admissionModel} write={write('admissionModel')} />
    <NumberRow id="plugin-config-result-clipper-min-inline" label={props.t('minInlineTokens')}
      hint={props.t('minInlineTokensHint')} failedHint={props.t('failedHint')}
      value={minInlineTokens} write={write('minInlineTokens')} />
    <NumberRow id="plugin-config-result-clipper-max-summarize" label={props.t('maxSummarizeTokens')}
      hint={props.t('maxSummarizeTokensHint')} failedHint={props.t('failedHint')}
      value={maxSummarizeTokens} write={write('maxSummarizeTokens')} />
    <SwitchRow label={props.t('summaryDisableReasoning')} hint={props.t('summaryDisableReasoningHint')}
      failedHint={props.t('failedHint')} checked={summaryDisableReasoning}
      onChange={write('summaryDisableReasoning') as (next: boolean) => Promise<boolean>} />
    <SwitchRow label={props.t('admissionDisableReasoning')} hint={props.t('admissionDisableReasoningHint')}
      failedHint={props.t('failedHint')} checked={admissionDisableReasoning}
      onChange={write('admissionDisableReasoning') as (next: boolean) => Promise<boolean>} />
    <SwitchRow label={props.t('privacyDisableReasoning')} hint={props.t('privacyDisableReasoningHint')}
      failedHint={props.t('failedHint')} checked={privacyDisableReasoning}
      onChange={write('privacyDisableReasoning') as (next: boolean) => Promise<boolean>} />
    <PromptRow id="plugin-config-result-clipper-summary-prompt" label={props.t('summaryPrompt')}
      hint={props.t('promptHint')} failedHint={props.t('failedHint')}
      saveLabel={props.t('savePrompt')} resetLabel={props.t('resetPrompt')}
      value={summaryPrompt} builtinRule={DEFAULT_SUMMARY_RULE} write={write('summaryPrompt')} reset={props.resetSummaryPrompt} />
    <PromptRow id="plugin-config-result-clipper-admission-prompt" label={props.t('admissionPrompt')}
      hint={props.t('promptHint')} failedHint={props.t('failedHint')}
      saveLabel={props.t('savePrompt')} resetLabel={props.t('resetPrompt')}
      value={admissionPrompt} builtinRule={DEFAULT_ADMISSION_RULE} write={write('admissionPrompt')} reset={props.resetAdmissionPrompt} />
    <PromptRow id="plugin-config-result-clipper-privacy-prompt" label={props.t('privacyPrompt')}
      hint={props.t('promptHint')} failedHint={props.t('failedHint')}
      saveLabel={props.t('savePrompt')} resetLabel={props.t('resetPrompt')}
      value={privacyPrompt} builtinRule={DEFAULT_PRIVACY_RULE} write={write('privacyPrompt')} reset={props.resetPrivacyPrompt} />
    <TextRow id="plugin-config-result-clipper-debug-path" label={props.t('debugPath')}
      hint={props.t('debugPathHint')} failedHint={props.t('failedHint')}
      value={debugPath} write={write('debugPath')} />
  </div>
}
