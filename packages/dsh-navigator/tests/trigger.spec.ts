import { describe, expect, it } from 'vitest'
import {
  advanceTriggerStep,
  deriveNextTriggerStep,
  resetTriggerStepAtUserMessage,
  type ObservationInput,
} from '../src/trigger.ts'

/** 默认间隔与一个「什么都没发生过」的会话。 */
const base: ObservationInput = {
  lastReviewStep: null,
  anchorStep: null,
  currentSteps: 0,
  everySteps: 50,
}

describe('deriveNextTriggerStep', () => {
  it('全新会话退化为当前步数的下一个间隔倍数', () => {
    expect(deriveNextTriggerStep(base)).toBe(50)
    expect(deriveNextTriggerStep({ ...base, currentSteps: 130 })).toBe(150)
  })

  it('在间隔的整数倍处重新观察，不会立刻多打一次', () => {
    // 当前步数正好落在整数倍上时，第三项等于当前步数，结果必然大于当前步数。
    expect(deriveNextTriggerStep({ ...base, currentSteps: 100 })).toBe(150)
    expect(deriveNextTriggerStep({ ...base, currentSteps: 50 })).toBe(100)
  })

  it('真实用户消息带来的重置优先于最后一条复核记录', () => {
    // 规格的验收场景：第 50 步触发过、第 70 步来了真实用户消息、第 80 步重载 → 120。
    const reloaded = deriveNextTriggerStep({
      lastReviewStep: 50,
      anchorStep: 70,
      currentSteps: 80,
      everySteps: 50,
    })
    expect(reloaded).toBe(120)
    // 只按最后一条复核记录算会得到 100，重置会丢。
    expect(deriveNextTriggerStep({ lastReviewStep: 50, anchorStep: null, currentSteps: 80, everySteps: 50 })).toBe(100)
  })

  it('第三项保证不会算出已经过去的触发点', () => {
    const next = deriveNextTriggerStep({ lastReviewStep: null, anchorStep: null, currentSteps: 199, everySteps: 50 })
    expect(next).toBe(200)
    expect(next).toBeGreaterThan(199)
  })
})

describe('resetTriggerStepAtUserMessage', () => {
  it('新自主执行区间 = 锚点 + 一个间隔', () => {
    expect(resetTriggerStepAtUserMessage(70, 50)).toBe(120)
    expect(resetTriggerStepAtUserMessage(0, 50)).toBe(50)
  })
})

describe('advanceTriggerStep', () => {
  it('到点之后（含因已有复核在跑而跳过）节奏只按触发点 + 间隔推进', () => {
    expect(advanceTriggerStep(50, 50)).toBe(100)
    expect(advanceTriggerStep(150, 50)).toBe(200)
  })
})
