/**
 * 浏览器半的「本会话已停用裁剪」提示状态（激活点 ⑤ 的用户可见提示）。
 *
 * 四条约束写死在这里，实现形态不留给实现自选：
 *
 * - **只 retain 当前显示的会话**：客户端不为后台会话保有事件流——`binding(id)` 对未 retain 的会话返回
 *   `undefined`，只有 `retain()` 才 materialize scope、开历史并给出事件流。给每个后台会话都 retain 会带进
 *   一整套引用/订阅生命周期，首版不做。
 * - **同一页面打开期间最多展示一次**：`shown` 是这个闭包的局部变量，而 `apply` 每次页面装载只跑一次，
 *   所以它天然是「每页面一次」——页面重载后归零，再打开该会话会再展示一次（这正是规格要的行为）。
 * - **只对当前显示的会话渲染**：会话一换，先撤掉提示、再订阅新会话的窗口。
 * - **可关闭**：`dismiss()` 之后本次展示结束，且因为 `shown` 仍为真，不会再冒出来。
 *
 * 判别规则与宿主半**同一条**：承载类型相同、顶层 `clipclop` 键存在、内层有 `restore`。类型与键名都取自
 * `carrier.ts`，两半不可能各写一份。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CARRIER_EVENT_TYPE } from '../carrier.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** 本插件的「裁剪已停用」提示：只为当前显示的会话建引用。 */
    reasoningPruner: unknown
  }
}

/** 提示的业务面：一个只读读数加一个关闭动作。 */
export interface RejectionNoticeFace extends ObservableSnapshot<boolean> {
  /** 用户关掉这一条；不会再为同一个页面生命周期重新展示。 */
  dismiss(): void
}

/**
 * 判断一条事件是不是本插件的「还原 + 停用」决策。
 * @param event - 客户端事件窗口里的一条事件（形状按鸭子类型收窄）。
 * @returns 是停用事件时为 true。
 */
export function isSuspensionEvent(event: { readonly type?: unknown, readonly data?: unknown }): boolean {
  if (event.type !== CARRIER_EVENT_TYPE) return false
  const data = event.data
  if (typeof data !== 'object' || data === null) return false
  const envelope = (data as Record<string, unknown>)['clipclop']
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return false
  return Object.hasOwn(envelope as Record<string, unknown>, 'restore')
}

/**
 * 建这个提示的状态。
 *
 * 只读当前会话的事件窗口：本插件的停用事件是**耐久**的，所以它要么已经落在窗口里、要么落在尚未加载的
 * 前段（`hasMore` 分页，见设计文档「验证状态 · 未验证」——极端长会话上提示可能漏掉，不影响裁剪功能）。
 * @param ctx - 客户端插件 context；`uiSession` 与 `sessions` 已就绪。
 * @returns 提示状态的读数与关闭动作。
 */
export function createRejectionNotice(ctx: Context): RejectionNoticeFace {
  // 这里必须 cast：本包的**宿主半**也在同一个 Context 接口上声明 `sessions`（`@deepseek-ai/dsh-session`
  // 的 `SessionStore`），而浏览器半要的是 session-controller 的 `ISessions`；同一个包的两半都在一份
  // tsconfig 里可见。cast 的两端都由 DSH 自己的类型给出，不是新写的宽松面。
  const sessions = ctx.sessions as unknown as ISessions
  const listeners = new Set<() => void>()
  let visible = false
  /** 本页面生命周期内是否已经展示过（`apply` 每页面只跑一次 ⇒ 页面重载即归零）。 */
  let shown = false
  let watching: SessionId | undefined
  let stopWatching: () => void = () => {}

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const setVisible = (next: boolean): void => {
    if (next === visible) return
    visible = next
    publish()
  }

  /** 当前 main view 那条会话（与置灰读数取同一个来源）。 */
  const currentSessionId = (): SessionId | undefined =>
    ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined

  const watch = (sessionId: SessionId): void => {
    // 未知会话（目录还没到、或已被删除）取不到引用：没有提示面，也不抛。
    let reference
    try {
      reference = sessions.retain(sessionId, { source: 'reasoningPruner' })
    } catch {
      return
    }
    const eventSource = reference.binding.eventSource
    const scan = (): void => {
      if (shown) return
      const hit = eventSource.getSnapshot().entries.some(entry =>
        entry.type === 'event' && isSuspensionEvent(entry.event))
      if (!hit) return
      shown = true
      setVisible(true)
    }
    const off = eventSource.subscribe(scan)
    stopWatching = () => {
      off()
      reference.release()
    }
    scan()
  }

  const sync = (): void => {
    const next = currentSessionId()
    if (next === watching) return
    watching = next
    stopWatching()
    stopWatching = () => {}
    // 会话一换就撤掉提示：它只描述**当前**这条会话；`shown` 仍为真，所以也不会在新会话上重放。
    setVisible(false)
    if (next !== undefined) watch(next)
  }

  ctx.effect(() => {
    const offSelection = ctx.uiSession.adapter.current.subscribe(sync)
    sync()
    return () => {
      offSelection()
      stopWatching()
      stopWatching = () => {}
    }
  }, 'dsh-reasoning-pruner: rejection notice subscription')

  return {
    getSnapshot: () => visible,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dismiss: () => { setVisible(false) },
  }
}
