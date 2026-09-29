/**
 * `settings.plugins.tab` 的一页：④ 手动入口的可用性开关。
 *
 * 这一页自己画全部内部（文案、当前值、写入路径都归注册者——该槽位的 owner 不收到任何 props）。失败形态照
 * 框架先例 `DeveloperToolsRow`：页内自带 `busy` / `failed` 两态、失败渲染 `role="alert"`。**业务拒绝捕不到
 * `.catch()`**：`ConfigForm.set` 在 Host 拒绝时 resolve `false`（不是 reject），所以 `failed` 必须在 await
 * 之后核验返回值才能置位。
 *
 * 置灰时不派发写入：`disabled` 既落在控件上，也在处理器里挡一次——控件被灰掉只是表现，这条判据要的是
 * 「灰了就不写」。
 *
 * 本产物只把 React 与 `dsh-client-ui-primitives` 列为 external（`scripts/build-client.mjs`），没有 CSS 管线，
 * 所以页内布局用内联样式 + 主题变量，而不是 DSH 客户端惯用的 CSS module。
 *
 * @module
 */

import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 注册者自己的业务面：两个读数加一条写入。 */
export interface ReasoningPrunerTabInjected {
  hooks: {
    /** Host 半 `Config.manualPrune` 的当前值。 */
    enabled: ObservableSnapshot<boolean>
    /** 当前路由不可能受益（判不准也算）时为 `true`；置灰只是提前告知。 */
    disabled: ObservableSnapshot<boolean>
  }
  /**
   * 写回这一个字段。
   * @param value - 用户要的新取值。
   * @returns Host 是否接受；被拒绝时 resolve `false`。
   */
  setEnabled(value: boolean): Promise<boolean>
}

/** 渲染机为本页合成的 props：槽位运行面、本插件的文案命名空间、注入的业务面。 */
export type ReasoningPrunerTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'reasoning-pruner'>
  & InjectFace<ReasoningPrunerTabInjected>

/** 次要说明文字（描述、置灰原因）共用的排版。 */
const HINT_STYLE = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } as const

/**
 * 渲染这一页。
 * @param props - 注入的读数、写入路径与页面文案。
 * @returns 内置插件里的一个页签内容。
 */
export function ReasoningPrunerTab({ useEnabled, useDisabled, setEnabled, t }: ReasoningPrunerTabProps) {
  const enabled = useEnabled(value => value)
  const disabled = useDisabled(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <section style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
    <div>
      <div style={{ fontSize: 14, lineHeight: '20px' }}>{t('title')}</div>
      <div style={HINT_STYLE}>{t('description')}</div>
      {failed && <div role="alert" style={HINT_STYLE}>{t('failedHint')}</div>}
      {disabled && <div style={HINT_STYLE}>{t('disabledHint')}</div>}
    </div>
    <Switch
      checked={enabled}
      disabled={disabled || busy}
      label={t('title')}
      {...disabled ? { title: t('disabledHint') } : {}}
      onChange={(next) => {
        if (disabled) return
        setFailed(false)
        setBusy(true)
        void setEnabled(next)
          .then((accepted) => { if (!accepted) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }}
    />
  </section>
}
