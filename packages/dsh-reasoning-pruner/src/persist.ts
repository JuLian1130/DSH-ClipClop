/**
 * 耐久落盘通路：把一次裁剪决策追加成承载类型事件。
 *
 * 这是本插件唯一的写入点。写出去的 payload **只有 seq 数组**（顶层是单个 `clipclop` 键），所以
 * `session-log-deepseek` 那类把 `data` 原样上传的消费者拿不到任何会话内容。形状校验不在写入侧——它由
 * `reasoningPrunerProjection` 在落盘**之前**执行（`planSurfaceEvent` 由 `surfaceManager.validateNext`
 * 调用、在 `log.push` 之前），所以非法 payload 会让 `append` 本身抛出、日志不留坏记录。
 *
 * ⚠️ 本文件是全插件唯一读**同步历史**（`snapshotEvents()`，带 `@deprecated`、Agent Note 明写 new calls
 * are prohibited）的生产代码，理由见 `recordedAssistantMessages`。除此之外生产源码一个被禁读取器都不碰，
 * 也不留任何事件引用。
 *
 * @module
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session'
import { isReasoningPrunable } from './replay.ts'
import { CARRIER_EVENT_TYPE } from './types.ts'
import type { ReasoningPrunePayload } from './types.ts'

/** 一条已记录的 `assistant/message` 的 seq 与消息，按 seq 增序。 */
function recordedAssistantMessages(session: Session): Map<SessionSeq, AssistantMessage> {
  const recorded = new Map<SessionSeq, AssistantMessage>()
  // 破例读同步历史的两条理由，缺一条都不成立：
  // 1. 资格判定读的必须是**已提交**的消息，不是模型可见历史——后者可能已被本插件的投影改过，拿裁剪版去
  //    判资格是循环论证。
  // 2. 写入路径上没有任何非 deprecated 的「已提交消息」读取面：`SessionMessageProjectionContext` 只存在
  //    于折叠期。agent-loop 的 `appendUnstoredSuffix` 出于同型理由破同一条例。
  // 范围压到最小（只读类型与 seq，不留事件引用）；存储方向变化时这一处是唯一要改的地方。
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue
    recorded.set(event.seq, event.data.message)
  }
  return recorded
}

/**
 * 裁剪资格成立的子集，按传入顺序，且**逐步骤**判定。
 *
 * 同一会话中途换模型会混用传输，所以这里不按会话整体判定，也不接受「会话有资格」这种整体结论。资格读的
 * 是每条消息自己的耐久 replay 信封（见 `isReasoningPrunable`）。
 * @param session - 有已记录历史的活跃会话。
 * @param targets - 候选 seq。
 * @returns 资格成立的 seq；不是已记录的 `assistant/message`、或信封判不出资格的，一律丢弃。
 */
function eligiblePruneTargets(session: Session, targets: readonly SessionSeq[]): SessionSeq[] {
  const recorded = recordedAssistantMessages(session)
  const eligible: SessionSeq[] = []
  for (const target of targets) {
    const message = recorded.get(target)
    if (message !== undefined && isReasoningPrunable(message)) eligible.push(target)
  }
  return eligible
}

/**
 * 追加一条耐久裁剪决策。
 *
 * 承载类型的 payload 类型由宿主声明，而本插件的形状只能作包内接口（同名键再声明一次是接口合并的重复
 * 属性错误，实测 TS2717），所以写入侧只能 cast——这是「不修改 DSH 核心源码」在本设计里唯一要付的类型
 * 绕过。运行期的形状闸门是投影自己的校验，见模块头注释。
 *
 * **资格判定落在本函数里而不是调用方的自觉上**：候选先过 {@link eligiblePruneTargets}，资格不成立时
 * 一个事件都不写。这是内外两个约束的同一端——投影校验要求 `targets` 非空，所以「无资格」不能落一条空
 * 记录；空记录会污染日志，并让闸门 C 的降级判据难以判断。
 * @param session - 活跃会话。
 * @param targets - 候选历史步骤，按各自的 `assistant/message` seq 列出。
 * @returns 落盘的事件序号；没有资格成立的候选时**不写任何东西**并返回 `undefined`。
 * @throws 投影校验不通过时（非法形状、非当前表面节点、不是 `assistant/message`、重复 seq）。
 */
export function persistReasoningPrune(
  session: Session,
  targets: readonly SessionSeq[],
): SessionSeq | undefined {
  const eligible = eligiblePruneTargets(session, targets)
  if (eligible.length === 0) return undefined
  const payload: ReasoningPrunePayload = { clipclop: { targets: eligible } }
  return session.append(
    CARRIER_EVENT_TYPE,
    payload as unknown as SessionEventMap[typeof CARRIER_EVENT_TYPE],
  ).seq
}
