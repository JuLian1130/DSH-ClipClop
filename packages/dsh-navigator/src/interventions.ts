/**
 * 等待模式的干预动作：复核建议（`adjust`）与停止说明的正文、消息形态，以及停止动作。
 *
 * 两种消息是同一种**干预上下文**：带 `form: 'notice'` 与可读 `summary` 的 user 消息。客户端把
 * notice 渲染成默认折叠的「上下文注入」行，折叠行上只看得到 `summary`，所以触发步骤写在正文开头，
 * `summary` 取正文按上限的截断——正文与 summary 只在这里合成一次（机制见设计文档「注入与停止机制」）。
 *
 * 停止动作的原因文本是**参数**：本票传结论的 `reason`，09 传「复核失败」，11 传取消原因。
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Cordis 插件名。也是本插件写入的用户消息上的 `source.plugin` 标记——08 按它过滤待投递的建议，
 * 夹具按它判别一条请求是不是本插件的复核请求。
 */
export const name = 'dsh-navigator'

/**
 * 复核建议的正文：触发步骤写在开头。
 * @param triggerStep - 这次复核的触发步骤。
 * @param recommendation - 结论里的建议内容。
 * @returns 正文。
 */
export function composeAdjustNotice(triggerStep: number, recommendation: string): string {
  return `第 ${triggerStep} 步的导航复核建议：${recommendation}`
}

/**
 * 停止说明的正文：触发步骤写在开头，正文写明停止原因。
 * @param triggerStep - 这次复核的触发步骤。
 * @param reason - 停止原因，非空。
 * @returns 正文。
 */
function composeStopNotice(triggerStep: number, reason: string): string {
  return `第 ${triggerStep} 步的导航复核停止：${reason}`
}

/**
 * 构造一条干预消息。`summary` 由同一处正文截断得出，不接受调用方另给一份。
 * @param text - 正文，以触发步骤开头。
 * @returns `source.kind === 'plugin'` 的 user 消息。
 */
export function noticeMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(text) },
  })
}

/**
 * 停止当前 turn：先把停止说明追加进会话，再以 hook 原因取消。说明已落盘就不再回退——重载 / 卸载
 * 不得中断这个流程。
 * @param agent - 本步的 agent。
 * @param triggerStep - 这次复核的触发步骤。
 * @param reason - 停止原因，非空；同时是 `turn/end` 里记下的 hook 原因。
 */
export function stopWithNotice(agent: Agent, triggerStep: number, reason: string): void {
  const notice = noticeMessage(composeStopNotice(triggerStep, reason))
  // `surfaceOp` 是字符串 `'append'`：写成 `{ op: 'append' }` 会在 append 时直接抛错。
  agent.session.append('user/message', notice, { surfaceOp: 'append' })
  agent.cancel({ kind: 'hook', reason })
}
