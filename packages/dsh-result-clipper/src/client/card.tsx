/**
 * `plugins.item` 的插件详情卡片：当前是 debug 日志路径这一个参数。
 *
 * 卡片与页签分座是设计文档「配置面与设置座位」的座位约定——开关在插件页签、参数在插件详情卡片；本卡片
 * 按 `view` 分别给出一行简介（`summary`）与参数控件（`page`），照 `ui-settings-web-search` 的先例。
 *
 * 写入走 `configForms` 的立即写：路径字段在 schema 上是 `volatile`，失焦即写、保存即生效。失败形态与页签
 * 同源——`set` 在 Host 拒绝时 resolve `false`，所以失败态在 await 之后核验返回值才置位。
 *
 * @module
 */

import { useEffect, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 注册者自己的业务面：一个读数加一条写入。 */
export interface ResultClipperCardInjected {
  hooks: {
    /** `Config.debugPath` 的当前值；未配置时为空串。 */
    debugPath: ObservableSnapshot<string>
  }
  /**
   * 写回日志路径。
   * @param value - 用户输入的路径；空串等于清除配置。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  setDebugPath(value: string): Promise<boolean>
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

/** 输入框的排版；没有 CSS 管线，所以只用内联样式与主题变量。 */
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
 * 渲染这张卡片。
 * @param props - 被请求的视图、注入的读数与写入路径、页面文案。
 * @returns `summary` 视图下的一行简介，或 `page` 视图下的参数控件。
 */
export function ResultClipperCard(props: ResultClipperCardProps) {
  const saved = props.useDebugPath(value => value)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // Host 侧的值变了（别处写入、或写入被接受）就重新播种草稿，使控件显示的是当前生效值。
  useEffect(() => { setDraft(saved) }, [saved])

  if (props.view === 'summary') return props.t('description')

  const commit = (): void => {
    if (draft === saved) return
    setFailed(false)
    setBusy(true)
    void props.setDebugPath(draft)
      .then((accepted) => { if (!accepted) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  return <section style={ROW_STYLE}>
    <label htmlFor="plugin-config-result-clipper-debug-path" style={TITLE_STYLE}>{props.t('debugPath')}</label>
    <input
      id="plugin-config-result-clipper-debug-path"
      type="text"
      style={INPUT_STYLE}
      value={draft}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
    />
    <div style={HINT_STYLE}>{props.t('debugPathHint')}</div>
    {failed && <div role="alert" style={HINT_STYLE}>{props.t('failedHint')}</div>}
  </section>
}
