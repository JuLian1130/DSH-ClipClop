/**
 * `settings.general.item` 上的一行：④ 手动入口的可用性开关。
 *
 * 这一行自己画全部内部（文案、当前值、写入路径都归注册者——该槽位的 owner 不收到任何 props）。失败形态照
 * 框架先例 `DeveloperToolsRow`：行内自带 `busy` / `failed` 两态、失败渲染 `role="alert"`。**业务拒绝捕不到
 * `.catch()`**：`ConfigForm.set` 在 Host 拒绝时 resolve `false`（不是 reject），所以 `failed` 必须在 await
 * 之后核验返回值才能置位。
 *
 * 置灰时不派发写入：`disabled` 既落在控件上，也在处理器里挡一次——控件被灰掉只是表现，这条判据要的是
 * 「灰了就不写」。
 *
 * @module
 */

import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 行的文案（本行自持，不经 locale 字典）。 */
const TITLE = 'Prune historical reasoning'
const DISABLED_HINT = 'The current model route cannot benefit from reasoning pruning.'
const FAILED_HINT = 'The reasoning pruning preference was not saved.'

/** 注册者自己的业务面：两个读数加一条写入。 */
export interface ReasoningPrunerRowInjected {
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

/**
 * 渲染这一行。
 * @param props - 注入的读数、写入路径与开关状态文案。
 * @returns 通用设置里的一行偏好。
 */
export function ReasoningPrunerRow({ useEnabled, useDisabled, setEnabled }:
  PropsRuntime<'settings.general.item'> & InjectFace<ReasoningPrunerRowInjected>) {
  const enabled = useEnabled(value => value)
  const disabled = useDisabled(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div>
    <div>{TITLE}</div>
    <Switch
      checked={enabled}
      disabled={disabled || busy}
      label={TITLE}
      {...disabled ? { title: DISABLED_HINT } : {}}
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
    {failed && <div role="alert">{FAILED_HINT}</div>}
    {disabled && <div>{DISABLED_HINT}</div>}
  </div>
}
