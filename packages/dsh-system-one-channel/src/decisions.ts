/**
 * 可信度门槛：阈值开着时，给每道题一个 `act`／`abstain` 标记。
 *
 * 确定性是**我们**给的语义，不是 provider 的：是非题用 `|probability − 0.5| × 2`（与 0.5 的距离，
 * 越接近 0 或 1 越确定）；choice/score 用 provider 自报的 `confidence`。低于阈值标 `abstain`，
 * **答案与概率仍原样交回**——这一层只加标记，不改答案。
 *
 * 算不出确定性时同样标 `abstain` 并写明原因：「判不出来」不等于「放行」。三种算不出：该题在
 * `answers` 里缺席（provider 没答）、choice/score 没有 `confidence`、以及将来新增的题型。
 *
 * @module
 */

import type { Answer, Question } from '@dsh-clipclop/dsh-system-one'

/** 一道题的标记。`reason` 是给模型看的：`abstain` 表示低于门槛，不是答案错了。 */
export interface Decision {
  verdict: 'act' | 'abstain'
  reason?: string
}

/** 一道题的确定性；算不出来时为空。 */
function certaintyOf(answer: Answer): number | undefined {
  return answer.type === 'boolean' ? Math.abs(answer.probability - 0.5) * 2 : answer.confidence
}

/**
 * 给每道题算标记。
 * @param questions - 这次问出去的题面（标记按它的 id 出）。
 * @param answers - provider 交回的答案；缺席的题照常出标记。
 * @param threshold - 当前门槛，0–1。
 * @returns 题 id → 标记，覆盖这次问的每一道题。
 */
export function decide(
  questions: Readonly<Record<string, Question>>,
  answers: Readonly<Record<string, Answer>>,
  threshold: number,
): Record<string, Decision> {
  // 无原型：题 id 是模型给的，`__proto__` 这类键在普通对象上会改掉原型，该题的标记就被静默吞掉。
  const decisions = Object.create(null) as Record<string, Decision>
  for (const id of Object.keys(questions)) {
    // 用自有键判缺席：`answers` 是 provider 交回的对象，`constructor`／`toString` 这类 id 会读到继承来的值，
    // 把「没答」误报成「没报 confidence」。
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined
    if (answer === undefined) {
      decisions[id] = { verdict: 'abstain', reason: 'the decision model returned no answer for this question' }
      continue
    }
    const certainty = certaintyOf(answer)
    if (certainty === undefined) {
      decisions[id] = { verdict: 'abstain', reason: 'the decision model reported no confidence for this question' }
      continue
    }
    decisions[id] = certainty < threshold
      ? { verdict: 'abstain', reason: `its certainty (${certainty.toFixed(2)}) is below the threshold (${threshold})` }
      : { verdict: 'act' }
  }
  return decisions
}
