import { describe, expect, it } from 'vitest'
import { parseReviewOutcome } from '../src/verdict.ts'

/** 一份合法的结论。 */
const valid = '{"verdict":"adjust","reason":"偏离目标","recommendation":"回到 A 方案"}'

describe('parseReviewOutcome', () => {
  it('接受恰好一个合法对象', () => {
    expect(parseReviewOutcome(valid)).toEqual({
      verdict: 'adjust',
      reason: '偏离目标',
      recommendation: '回到 A 方案',
    })
  })

  it('去掉首尾空白后仍然接受', () => {
    expect(parseReviewOutcome(`\n  ${valid}\t\n`)?.verdict).toBe('adjust')
  })

  it('对象内部多出契约之外的字段不算失败', () => {
    expect(parseReviewOutcome('{"verdict":"continue","reason":"ok","recommendation":"无","extra":1}')?.verdict)
      .toBe('continue')
  })

  it('三种结论都接受', () => {
    for (const verdict of ['continue', 'adjust', 'stop'] as const) {
      expect(parseReviewOutcome(`{"verdict":"${verdict}","reason":"r","recommendation":"c"}`)?.verdict).toBe(verdict)
    }
  })

  it('代码块围栏算失败', () => {
    expect(parseReviewOutcome(`\`\`\`json\n${valid}\n\`\`\``)).toBeNull()
    expect(parseReviewOutcome(`\`\`\`\n${valid}\n\`\`\``)).toBeNull()
  })

  it('前后夹带文字算失败', () => {
    expect(parseReviewOutcome(`结论如下：${valid}`)).toBeNull()
    expect(parseReviewOutcome(`${valid}\n以上。`)).toBeNull()
  })

  it('出现第二个顶层 JSON 值算失败', () => {
    expect(parseReviewOutcome(`${valid}{"verdict":"stop","reason":"r","recommendation":"c"}`)).toBeNull()
  })

  it('不是对象、枚举非法、字段缺失或为空都算失败', () => {
    expect(parseReviewOutcome('42')).toBeNull()
    expect(parseReviewOutcome('"continue"')).toBeNull()
    expect(parseReviewOutcome('[{"verdict":"continue"}]')).toBeNull()
    expect(parseReviewOutcome('{}')).toBeNull()
    expect(parseReviewOutcome('{"verdict":"hold","reason":"r","recommendation":"c"}')).toBeNull()
    expect(parseReviewOutcome('{"verdict":"continue","reason":"","recommendation":"c"}')).toBeNull()
    expect(parseReviewOutcome('{"verdict":"continue","reason":"r","recommendation":""}')).toBeNull()
    expect(parseReviewOutcome('{"verdict":"continue","reason":1,"recommendation":"c"}')).toBeNull()
    expect(parseReviewOutcome('   ')).toBeNull()
  })
})
