/**
 * 票 08 第 16 条：**A2 的 DSH 侧断言**——对裁剪后再发一次真实请求，断言被提供方计费的输入确实下降
 * （`闸门 A` 判据第 6 条后半，规格明写「接受度通过而计费未降 = 不通过」）。
 *
 * 装置是本票自建的 `tests/support/gate-a-two-arms.ts`，走来源①（真实路由 + 真实凭据）。**带 key 才跑**：
 * `PROBE_BASE_URL` 与 `DEEPSEEK_API_KEY` 缺任一项时整组跳过（票面 :25 的端点由使用者提供、:16 的「不得
 * 默认装置已在场」——缺了它这条判据只能记「未测」，而「未测」按 :18 即停下回报，不得按任一方向记入）。
 *
 * 两次计数与端点未回报 `usage` 的两种情形都由装置自己抛错，不在本文件里折算成任一方向的结论。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { runGateATwoArms } from './support/gate-a-two-arms.ts'

const ENABLED = (process.env['PROBE_BASE_URL'] ?? '').length > 0 && (process.env['DEEPSEEK_API_KEY'] ?? '').length > 0

describe.skipIf(!ENABLED)('票 08 第 16 条：A2（DSH 侧）——裁剪后被计费的输入确实下降', () => {
  it('两臂 resume 同一份已落盘历史，各发一次真实请求：裁剪臂的被计费输入更小', async () => {
    const observation = await runGateATwoArms()

    // 先确认装置没空转：裁剪真的落盘了，且裁剪臂的**模型可见历史**里种子那一步的推理确实不见了。
    // 比的是种子那些块：两臂 resume 之后各自还要跑一个新 turn，那个 turn 自己也会产生推理块，所以不能断
    // 「裁剪臂可见推理为空」。逐块比对（不是拼接后比对），种子里有多块时也不会误判。
    expect(observation.carrierTargets.length).toBeGreaterThan(0)
    expect(observation.seedReasoningTexts.length).toBeGreaterThan(0)
    for (const block of observation.seedReasoningTexts) {
      expect(observation.control.reasoningTexts).toContain(block)
      expect(observation.pruned.reasoningTexts).not.toContain(block)
    }

    // 被计费的输入 = 三次计数之和（互斥，不得只看 inputTokens 单值）。
    expect(observation.pruned.billedInput).toBeLessThan(observation.control.billedInput)
  }, 300_000)
})