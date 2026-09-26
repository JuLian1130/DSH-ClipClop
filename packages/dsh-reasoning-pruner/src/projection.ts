/**
 * 承载类型上的消息投影：把耐久 payload 声明的历史步骤换成裁剪版副本。
 *
 * 机制与取舍见设计文档「裁剪的表达：message projection，不是 surface replace」与「耐久记录的形状」。
 * 三点是硬约束：
 *
 * - **投影只依赖传入的 `context`**（纯函数）：运行期增量折叠与重载全量折叠都会调它，两侧结果必须
 *   一致；绝不能去读会话对象、历史事件序列或任何外部状态。
 * - **判别规则写死**：payload 顶层出现 `clipclop` 键就是我们的事件，严格校验、违规当场抛；没有该键
 *   就是宿主自己的事件，返回空 Map、不抛错。不得改用宿主 payload 的字段（`endpoint`/`apiVersion`/
 *   `body`）判别——那样宿主改字段就会让我们对宿主事件抛错，而投影一抛错那条日志就再也读不出来。
 * - **校验先于产出**：要么整体成功，要么整体失败；坏 payload 让 append 当场失败，不留半份替换。
 *
 * @module
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
// 类型专用：把宿主包对 SessionEventMap 的模块增强拉进类型图，使 `web/deepseek-search-llm-request`
// 成为 SessionEventType 的一个键（`append` 与 `SessionMessageProjection` 都收在这个约束里）。运行期
// 不需要宿主包在场——类型导入在产物里被擦除，所以它只是 devDependency。
import type {} from '@deepseek-ai/dsh-web-search-deepseek'
import { isReasoningPrunable, pruneReasoning, replayEnvelopeAlignsWithContent } from './replay.ts'
import { CARRIER_EVENT_TYPE } from './types.ts'

/** 一个 JSON 对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一个规范的会话事件序号（非负安全整数，且不是 `-0`）。 */
function isEventSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * 本插件的消息投影。注册后，承载类型的**每一个**事件在每次折叠时都会先走它，所以我们自己的事件与
 * 宿主自己的事件必须在这一个函数里分清。
 */
export const reasoningPrunerProjection: SessionMessageProjection<typeof CARRIER_EVENT_TYPE> = {
  type: CARRIER_EVENT_TYPE,
  project(event, context): ReadonlyMap<SessionSeq, Message> {
    const data: unknown = event.data
    // 宿主分支：没有 `clipclop` 键（含 data 不是对象）一律安全穿过。
    if (!isRecord(data) || !Object.hasOwn(data, 'clipclop')) return new Map()
    // `clipclop` 已在，且顶层只有 1 个键 ⇒ 顶层键集合恰为 `{clipclop}`（这就是「键集合相等」）。
    if (Object.keys(data).length !== 1) {
      throw new Error(
        `${CARRIER_EVENT_TYPE}: a clipclop payload must carry exactly the one clipclop key`,
      )
    }
    const envelope = data['clipclop']
    if (!isRecord(envelope)) {
      throw new Error(`${CARRIER_EVENT_TYPE}: clipclop must be an object with a targets array`)
    }
    const targets = envelope['targets']
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error(`${CARRIER_EVENT_TYPE}: clipclop.targets must be a nonempty array`)
    }
    // 同上：`targets` 已在，且内层只有 1 个键 ⇒ 内层键集合恰为 `{targets}`（客户端时间线坐标
    // `turn`/`step` 因此不可能出现在任何一层）。
    if (Object.keys(envelope).length !== 1) {
      throw new Error(`${CARRIER_EVENT_TYPE}: clipclop must carry exactly the targets key`)
    }
    const nodes = new Set<SessionSeq>(context.nodes)
    const seen = new Set<SessionSeq>()
    const projected = new Map<SessionSeq, Message>()
    for (const target of targets as unknown[]) {
      if (!isEventSeq(target)) {
        throw new Error(`${CARRIER_EVENT_TYPE}: each target must be a non-negative safe integer seq`)
      }
      if (seen.has(target)) throw new Error(`${CARRIER_EVENT_TYPE}: duplicate target seq ${target}`)
      seen.add(target)
      if (!nodes.has(target)) {
        throw new Error(`${CARRIER_EVENT_TYPE}: target seq ${target} is not a current surface node`)
      }
      const source = context.events[target - context.baseSeq]
      if (source?.type !== 'assistant/message') {
        throw new Error(`${CARRIER_EVENT_TYPE}: target seq ${target} must be an assistant/message`)
      }
      // 规范写法：投影前的消息以 `context.messages` 优先，`deriveEventMessage` 自己先读它；缺省时再按
      // 事件派生。不读会话方法，否则重载全量折叠路径上没有会话对象可用。
      const message = deriveEventMessage(source, context.messages)
      // 资格不成立的步骤原样保留：不产出改动，也不报错（服务端按 replay 信封强制，不是调用方的责任）。
      if (message === null || message.role !== 'assistant' || !isReasoningPrunable(message)) continue
      // 信封不可用（缺 `blocks` / 块数不符 / 逐位不同类型）同样原样保留：投影**不得**抛「信息不足」类
      // 错误（一抛那条日志就再也读不出来），而裁剪算子对这样的信封无可裁剪——留着不动就是现状。
      if (!replayEnvelopeAlignsWithContent(message)) continue
      const pruned = pruneReasoning(message)
      if (pruned !== message) projected.set(target, pruned)
    }
    return projected
  },
}
