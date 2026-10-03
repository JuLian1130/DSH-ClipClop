/**
 * `shell.overlay` 的一条提示：本会话的推理裁剪已被端点拒收、因此停用。
 *
 * 这一条自己画全部内部（文案、关闭按钮、布局都归注册者）。槽位是 `scope: 'root'`、**不按会话分区**，所以
 * 「只对当前显示的会话渲染」这件事在状态侧做完（见 `notice.ts`）——本组件只渲染拿到的布尔。
 *
 * 产物没有 CSS 管线（`scripts/build-client.mjs` 只把 React 与 `dsh-client-ui-primitives` 列为 external），
 * 所以布局用内联样式 + 主题变量。浮层整体是 click-through 的，条目要自己 opt in 指针事件。
 *
 * @module
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// 类型专用：`shell.overlay` 槽位的声明由 ui-layout 持有。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 注册者自己的业务面：一个读数加一个关闭动作。 */
export interface RejectionNoticeInjected {
  hooks: {
    /** 当前显示的会话已停用裁剪、且本次页面生命周期还没展示过时为 `true`。 */
    visible: ObservableSnapshot<boolean>
  }
  /** 用户关掉这一条。 */
  dismiss(): void
}

/** 渲染机为本条合成的 props：槽位运行面、本插件的文案命名空间、注入的业务面。 */
export type RejectionNoticeProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'reasoning-pruner'>
  & InjectFace<RejectionNoticeInjected>

/** 提示卡片：浮层里 opt in 指针事件，靠底部居中。 */
const CARD_STYLE = {
  position: 'fixed',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  maxWidth: 520,
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-secondary)',
  background: 'var(--dsw-alias-bg-elevated)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '18px',
  pointerEvents: 'auto',
} as const

/** 关闭按钮：与文案同一行的纯文本按钮。 */
const DISMISS_STYLE = {
  flex: 'none',
  border: 'none',
  background: 'none',
  color: 'var(--dsw-alias-text-accent)',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
} as const

/**
 * 渲染这一条提示。
 * @param props - 注入的读数、关闭动作与文案。
 * @returns 可见时是一张卡片，否则什么都不渲染。
 */
export function ReasoningPrunerNotice({ useVisible, dismiss, t }: RejectionNoticeProps) {
  const visible = useVisible(value => value)
  if (!visible) return null
  return <div role="status" style={CARD_STYLE}>
    <span style={{ flex: 1 }}>{t('notice')}</span>
    <button type="button" style={DISMISS_STYLE} aria-label={t('dismiss')} onClick={dismiss}>{t('dismiss')}</button>
  </div>
}
