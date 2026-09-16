/**
 * 触发点算术。全部是纯函数，状态由插件按会话持有。
 *
 * 规格里的两条规则：
 *
 * - 同一个自主执行区间内：下一次触发点 = 上一次触发点 + `triggerEverySteps`。到点时若已有复核
 *   在跑就跳过这一次，但**不重新计时、不顺延、也不补打**，所以节奏始终是「触发点 + 间隔」。
 * - 重新观察一个会话（插件刚加载、会话被重开）时不能沿用内存里的上一次触发点，必须按三项取最大
 *   再加一个间隔重新推导；第三项保证重载时不会立刻补打已经错过的触发点。
 *
 * @module
 */

/** 重新观察一个会话时推导下一次触发点的输入。 */
export interface ObservationInput {
  /** 最后一条复核记录里的触发步骤；没有记录时为 null。 */
  readonly lastReviewStep: number | null
  /** 锚点：最后一条真实用户消息记入会话日志时的已完成步数；没有真实用户消息时为 null。 */
  readonly anchorStep: number | null
  /** 当前计数口径下的已完成步数。 */
  readonly currentSteps: number
  /** 间隔，必须 ≥ 1。 */
  readonly everySteps: number
}

/**
 * 重新观察一个会话时的下一次触发点 = max(三项) + 间隔。
 * @param input - 三项候选与间隔。
 * @returns 下一次触发点的已完成步数。
 */
export function deriveNextTriggerStep(input: ObservationInput): number {
  const intervalFloor = Math.floor(input.currentSteps / input.everySteps) * input.everySteps
  return Math.max(
    input.lastReviewStep ?? 0,
    input.anchorStep ?? 0,
    intervalFloor,
  ) + input.everySteps
}

/**
 * 新的自主执行区间开始时的下一次触发点 = 锚点 + 间隔。
 * @param anchorStep - 那条真实用户消息记入会话日志时的已完成步数。
 * @param everySteps - 间隔。
 * @returns 下一次触发点的已完成步数。
 */
export function resetTriggerStepAtUserMessage(anchorStep: number, everySteps: number): number {
  return anchorStep + everySteps
}

/**
 * 一次触发之后的下一次触发点。既有复核在跑而跳过这一次时也用它——节奏只按「触发点 + 间隔」推进。
 * @param triggerStep - 刚到的触发点。
 * @param everySteps - 间隔。
 * @returns 下一次触发点的已完成步数。
 */
export function advanceTriggerStep(triggerStep: number, everySteps: number): number {
  return triggerStep + everySteps
}
