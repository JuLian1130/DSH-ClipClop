/**
 * `navigatorSteps` 投影单元：把会话日志折叠成航向复核需要的两个数。
 *
 * - `steps`：计数口径下的已完成步数 = **不带 `interrupted` 的 `assistant/message`** 条数。
 *   失败与中止的请求不计数：无内容的中止只写 `assistant/attempt`，有流式内容的中止写带
 *   `interrupted: true` 的 `assistant/message`，两种都被排除。
 * - `anchorStep`：锚点 = 最后一条真实用户消息（`source.kind === 'user'`）记入会话日志时的
 *   `steps`。它由折叠得到，而不是在监听器里现取，所以插件重载、会话重开后的重折叠与运行期
 *   一致；`apply` 由框架在每个已提交事件上驱动。
 *
 * 折叠是纯同步函数，状态是纯 JSON：同一条事件返回同一个引用时框架不产生下游工作。
 *
 * @module
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    navigatorSteps: NavigatorStepsState
  }
}

/** 折叠状态。 */
export interface NavigatorStepsState {
  /** 计数口径下的已完成步数。 */
  readonly steps: number
  /** 最后一条真实用户消息记入会话日志时的已完成步数；还没有真实用户消息时为 null。 */
  readonly anchorStep: number | null
}

const navigatorStepsStateSchema = z.object({
  steps: z.number().int().nonnegative(),
  anchorStep: z.number().int().nonnegative().nullable(),
})

/** 注册进 `ctx.sessionProjections` 的单元。 */
export const navigatorStepsProjection: ProjectionDefinition<'navigatorSteps'> = {
  key: 'navigatorSteps',
  stateVersion: 1,
  stateSchema: navigatorStepsStateSchema,
  init: () => ({ steps: 0, anchorStep: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'assistant/message':
        return event.data.interrupted === true ? state : { ...state, steps: state.steps + 1 }
      case 'user/message':
        // 只有真实用户消息移动锚点。插件自己注入的建议与说明是 `kind: 'plugin'`，
        // 工具结果是 `kind: 'tool'`，都不算（规格的「什么算真实用户消息」）。
        return event.data.source.kind === 'user' ? { ...state, anchorStep: state.steps } : state
      default:
        return state
    }
  },
}
