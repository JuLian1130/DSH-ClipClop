/**
 * 推理档位的兜底词表与两条纯函数：`resolveNoReasoning`（"不推理"该发哪个 id）与 `acceptsEffort`（显式值能不能发）。
 *
 * 这一层是纯函数，所以判据直接对着**档位表读数**写：给定 route 声明的档位，期望解析出的 id。重点在"声明的顺序
 * 不是升序时不能取第一个"——那正是设计稿里要求用已知次序表而不是 `efforts[0]` 的原因。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { acceptsEffort, resolveNoReasoning } from '../src/reasoning.ts'

/** 只带 id 的档位表读数。 */
const table = (...ids: string[]): { id: string }[] => ids.map(id => ({ id }))

describe('resolveNoReasoning：按 route 的档位表拼出「不推理」', () => {
  it.each([
    // 两条已知 route 的词汇表各走一支。
    [table('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'), 'none'],
    [table('off', 'low', 'high', 'max'), 'off'],
    // 两支都有时 `off` 优先（同一个含义，取先命中的那支）。
    [table('none', 'off'), 'off'],
    // `off` / `none` 都不在表里 → 已知次序里最低的那一档，**不是**声明的第一个。
    [table('high', 'low'), 'low'],
    [table('max', 'minimal'), 'minimal'],
    [table('xhigh'), 'xhigh'],
    // 未知 id 不参与比较，但已知的可以赢过它。
    [table('standard', 'low'), 'low'],
    // 全是未知 id → 最后一档退路：声明的第一个。
    [table('standard', 'deep'), 'standard'],
    [table(), undefined],
  ])('%j → %s', (efforts, expected) => {
    expect(resolveNoReasoning(efforts)).toBe(expected)
  })

  it('同档位取先出现的那个（结果稳定，不随声明顺序抖动到另一个拼法）', () => {
    expect(resolveNoReasoning(table('none', 'off'))).toBe('off')
    expect(resolveNoReasoning(table('off', 'none'))).toBe('off')
  })
})

describe('acceptsEffort：显式值能不能发', () => {
  it('在表里为真、不在为假、空表为假（空表＝读不到或该模型不提供档位）', () => {
    expect(acceptsEffort(table('none', 'low'), 'low')).toBe(true)
    expect(acceptsEffort(table('none', 'low'), 'off')).toBe(false)
    expect(acceptsEffort(table(), 'off')).toBe(false)
  })
})
