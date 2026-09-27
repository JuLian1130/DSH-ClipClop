/**
 * 本插件的配置契约与耐久 payload 形状。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * 承载本插件耐久决策的**已知**事件类型。
 *
 * 借用宿主自己也在写、且全仓没有 payload 读取者的 `web/deepseek-search-llm-request`：自建的新类型不在
 * `KNOWN_SESSION_EVENT_TYPES` 里，写入会静默成功而重载被整段拒绝，所以只能借用一个已在本仓声明的
 * 已知类型。它是 log-only（不带 `surfaceOp`），改动只由本插件的投影兑现。取舍与普查结论见设计文档
 * 「耐久记录的形状」。
 */
export const CARRIER_EVENT_TYPE = 'web/deepseek-search-llm-request'

/**
 * 写在承载类型上的自有命名空间信封。
 *
 * **顶层只有 `clipclop` 一个键**：客户端时间线索引对每一个事件都读 `data.turn`/`data.step` 并用它重指
 * 游标（不看类型），单个命名空间键让时间线坐标在结构上不可能出现。`clipclop` 里只有 `targets`，
 * 两层的键集合相等由投影校验。
 *
 * 这个接口**只作包内类型**，不并入 `SessionEventMap`：宿主已经为同名键声明了
 * `DeepSeekSearchLlmRequest`，再声明一次是接口合并的重复属性错误（实测 TS2717）。写入侧因此只能
 * cast，见 `projection.ts`。
 */
export interface ReasoningPrunePayload {
  clipclop: {
    /** 要裁剪的历史步骤，按各自的 `assistant/message` seq 列出。 */
    targets: SessionSeq[]
  }
}

/**
 * 本插件的配置。两个参数都取保守默认（偏大＝少干活、少伤质量），实测后收紧。
 *
 * **默认值必须保持 `everySteps ≥ keepRecentSteps + 2`**：第 `M` 步的 pre-step 上只有 `M - 1` 条已记录
 * 步骤，减掉保留窗口 `K` 必须为正，否则每次到点都是空批量、而写入侧禁止落一条 `targets` 为空的事件
 * （07 回填 `M`/`K` 时必须保持这条不变式；规格闸门 D 的「冲突时 `K` 取更大值」正会踩到它）。
 */
export interface Config {
  /** 每完成多少个步骤允许推进一次裁剪；由闸门 B（成本摊薄）背书。 */
  everySteps?: number
  /** 最近多少个步骤原样保留、不裁；由闸门 D（任务质量）背书。 */
  keepRecentSteps?: number
}

/** 配置 schema：字段全部可选并在装载时解析成默认值，非法值在装载阶段大声失败。 */
export const Config: z<Config, Required<Config>> = z.object({
  everySteps: z.number().step(1).min(1).default(50),
  keepRecentSteps: z.number().step(1).min(0).default(10),
})
