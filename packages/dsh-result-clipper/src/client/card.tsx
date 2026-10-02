/**
 * `plugins.item` 的插件详情卡片：摘要参数（主 route、两个阈值、「关闭推理」开关、提示词规则正文）与
 * debug 日志路径。
 *
 * 卡片与页签分座是设计文档「配置面与设置座位」的座位约定——开关在插件页签、参数在插件详情卡片。写入走
 * `configForms` 的立即写：这些字段在 schema 上都是 `volatile`，失焦即写、保存即生效。失败形态与页签同源
 * ——`set` 在 Host 拒绝时 resolve `false`，所以失败态在 await 之后核验返回值才置位。
 *
 * 「恢复默认」清掉提示词的用户覆盖（`unset`），保存后回落到底层默认（内置规则正文）。安全外壳与输出格式
 * 由 host 半写死，这里只能编辑规则正文。
 *
 * @module
 */

import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 卡片的可写字段，与 host 半 `Config` 的字段同名（也是 settings section 里的键）。 */
export type ResultClipperCardField =
  | 'routeProvider'
  | 'routeModel'
  | 'minInlineTokens'
  | 'maxSummarizeTokens'
  | 'summaryDisableReasoning'
  | 'summaryPrompt'
  | 'debugPath'

/** 注册者自己的业务面：逐字段读数与写入，加上提示词的清空。 */
export interface ResultClipperCardInjected {
  hooks: {
    /** 主 route 的 provider。 */
    routeProvider: ObservableSnapshot<string>
    /** 主 route 的 model id。 */
    routeModel: ObservableSnapshot<string>
    /** 摘要候选下限（估算器单位）。 */
    minInlineTokens: ObservableSnapshot<number>
    /** `bash` / `web_fetch` 的摘要上限。 */
    maxSummarizeTokens: ObservableSnapshot<number>
    /** 摘要请求是否关闭推理。 */
    summaryDisableReasoning: ObservableSnapshot<boolean>
    /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
    summaryPrompt: ObservableSnapshot<string>
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
}

/** 渲染机为本卡片合成的 props：槽位运行面（含 `view`）、本插件的文案命名空间、注入的业务面。 */
export type ResultClipperCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'resultClipper'>
  & InjectFace<ResultClipperCardInjected>

/** 控件行的排版。 */
const ROW_STYLE = { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 0' } as const

/** 字段标题的排版。 */
const TITLE_STYLE = { fontSize: 14, lineHeight: '20px' } as const

/** 说明与失败提示共用的排版。 */
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

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
 * 提示词规则正文：失焦即写；「恢复默认」清掉覆盖，控件随 Host 的值重新播种。
 * @param props - 行文案、提示、当前值、写入与清空动作。
 * @returns 一行文本域加一个恢复默认按钮。
 */
function PromptRow(props: {
  readonly label: string
  readonly hint: string
  readonly failedHint: string
  readonly resetLabel: string
  readonly value: string
  readonly write: (value: string) => Promise<boolean>
  readonly reset: () => Promise<boolean>
}) {
  const [draft, setDraft] = useState(props.value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(props.value) }, [props.value])

  const settle = (action: Promise<boolean>): void => {
    setFailed(false)
    setBusy(true)
    void action
      .then((accepted) => { if (!accepted) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  const commit = (): void => {
    if (draft === props.value) return
    settle(props.write(draft))
  }

  return <section style={ROW_STYLE}>
    <label htmlFor="plugin-config-result-clipper-summary-prompt" style={TITLE_STYLE}>{props.label}</label>
    <textarea
      id="plugin-config-result-clipper-summary-prompt"
      style={{ ...INPUT_STYLE, minHeight: 80, resize: 'vertical' }}
      value={draft}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={commit}
    />
    <div style={HINT_STYLE}>{props.hint}</div>
    <div>
      <button type="button" disabled={busy} onClick={() => { settle(props.reset()) }}>{props.resetLabel}</button>
    </div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.failedHint}</div>}
  </section>
}

/**
 * 渲染这张卡片。
 * @param props - 被请求的视图、注入的读数与写入路径、页面文案。
 * @returns `summary` 视图下的一行简介，或 `page` 视图下参数控件。
 */
export function ResultClipperCard(props: ResultClipperCardProps) {
  const routeProvider = props.useRouteProvider(value => value)
  const routeModel = props.useRouteModel(value => value)
  const minInlineTokens = props.useMinInlineTokens(value => value)
  const maxSummarizeTokens = props.useMaxSummarizeTokens(value => value)
  const summaryDisableReasoning = props.useSummaryDisableReasoning(value => value)
  const summaryPrompt = props.useSummaryPrompt(value => value)
  const debugPath = props.useDebugPath(value => value)

  if (props.view === 'summary') return props.t('description')

  const write = (field: ResultClipperCardField) => (value: string | number | boolean) => props.setField(field, value)

  return <div>
    <p style={{ ...HINT_STYLE, padding: '4px 0' }}>{props.t('flowWarning')}</p>
    <TextRow id="plugin-config-result-clipper-route-provider" label={props.t('routeProvider')}
      hint={props.t('routeProviderHint')} failedHint={props.t('failedHint')}
      value={routeProvider} write={write('routeProvider')} />
    <TextRow id="plugin-config-result-clipper-route-model" label={props.t('routeModel')}
      hint={props.t('routeModelHint')} failedHint={props.t('failedHint')}
      value={routeModel} write={write('routeModel')} />
    <NumberRow id="plugin-config-result-clipper-min-inline" label={props.t('minInlineTokens')}
      hint={props.t('minInlineTokensHint')} failedHint={props.t('failedHint')}
      value={minInlineTokens} write={write('minInlineTokens')} />
    <NumberRow id="plugin-config-result-clipper-max-summarize" label={props.t('maxSummarizeTokens')}
      hint={props.t('maxSummarizeTokensHint')} failedHint={props.t('failedHint')}
      value={maxSummarizeTokens} write={write('maxSummarizeTokens')} />
    <SwitchRow label={props.t('summaryDisableReasoning')} hint={props.t('summaryDisableReasoningHint')}
      failedHint={props.t('failedHint')} checked={summaryDisableReasoning}
      onChange={write('summaryDisableReasoning') as (next: boolean) => Promise<boolean>} />
    <PromptRow label={props.t('summaryPrompt')} hint={props.t('summaryPromptHint')}
      failedHint={props.t('failedHint')} resetLabel={props.t('resetPrompt')}
      value={summaryPrompt} write={write('summaryPrompt')} reset={props.resetSummaryPrompt} />
    <TextRow id="plugin-config-result-clipper-debug-path" label={props.t('debugPath')}
      hint={props.t('debugPathHint')} failedHint={props.t('failedHint')}
      value={debugPath} write={write('debugPath')} />
  </div>
}
