/**
 * 票 26 的「命中长行裁剪」（`grep-long-line`）：bash 的 grep 结果里超长命中行按命中 ±200 字符裁剪。
 *
 * 断言的是行为：只认 grep 自己的输出形状、只裁命中行、命中一定活下来（先于单行封顶）、整链幂等、
 * 「按命令语义精简」关着时不动。都走模块公开面（`grepPatterns` / `condenseText` / `generalRules`），
 * 不碰内部实现。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CONDENSE_DEFAULTS, condenseText, type CondenseContext, type CondenseParams } from '../src/condense.ts'
import { GREP_LONG_LINE_MIN_CHARS, GREP_LONG_LINE_WINDOW, grepPatterns, trimGrepLongLines } from '../src/grepline.ts'

/** 默认参数下的一次精简判定。 */
const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

/** 长正文：前后各 `pad` 个字符，中间夹一个只出现一次的标记。 */
const longContent = (mark: string, pad = 1000): string => `${'x'.repeat(pad)}${mark}${'y'.repeat(pad)}`

/** 一次 grep 调用的上下文（命令 + 「按命令语义精简」打开）。 */
const ctx = (command: string): CondenseContext => ({ command, grepLongLine: true })

describe('票 26 · grep 长行裁剪', () => {
  it('command 里的 pattern 能解析出正则（含 -e / -F / -E / -i / BRE 或）', () => {
    expect(grepPatterns('grep -n "alpha" f.ts')).toHaveLength(1)
    expect(grepPatterns('cd x && grep -rnwiE "alpha|beta" src | head')).toHaveLength(1)
    expect(grepPatterns('grep -e alpha -e beta f.ts')).toHaveLength(2)
    expect(grepPatterns('grep -F "a.b" f.ts')[0]?.test('a.b')).toBe(true)
    expect(grepPatterns('grep -i "alpha" f.ts')[0]?.test('ALPHA')).toBe(true)
    expect(grepPatterns('grep -n "alpha\\|beta" f.ts')[0]?.test('beta')).toBe(true)
    expect(grepPatterns('grep -n "alpha" f.ts && echo "grep -n beta"')[0]?.test('beta')).toBe(false)
  })

  it('认不出 grep 的命令不表态（--grep 选项、-f 模式文件）', () => {
    expect(grepPatterns('git log --grep alpha')).toEqual([])
    expect(grepPatterns('grep -f patterns.txt f.ts')).toEqual([])
    expect(grepPatterns('ls -la')).toEqual([])
  })

  it('超长命中行裁到命中 ±200，保留路径与行号，交回有损判定', () => {
    const content = longContent('MATCH')
    const verdict = condenseText('bash', `big.txt:42:${content}`, at(), undefined, ctx('grep -n "MATCH" big.txt'))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.lossy).toBe(true)
    if (!verdict.lossy) return
    expect(verdict.entry).toBe('own')
    expect(verdict.rules).toContain('grep-long-line')
    expect(verdict.text.startsWith('big.txt:42:')).toBe(true)
    expect(verdict.text).toContain('MATCH')
    expect(verdict.text).toContain('…[省略 800 字符]…')
    expect(verdict.text.length).toBeLessThan(500)
  })

  it('行首没有路径的单文件输出同样裁（行号保留）', () => {
    const verdict = condenseText('bash', `42:${longContent('MATCH')}`, at(), undefined, ctx('grep -n MATCH f.ts'))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text.startsWith('42:')).toBe(true)
    expect(verdict.text).toContain('MATCH')
  })

  it('没命中的长行原样保留（交给后续封顶，不由这条规则裁）', () => {
    const text = `f.ts:1:${'z'.repeat(GREP_LONG_LINE_MIN_CHARS + 500)}`
    expect(condenseText('bash', text, at(), undefined, ctx('grep -n MATCH f.ts'))).toEqual({ kind: 'unchanged' })
  })

  it('短于 300 字的行不裁', () => {
    const text = `f.ts:1:${longContent('MATCH', 100)}`
    expect(text.split(':').at(-1)?.length).toBeLessThanOrEqual(GREP_LONG_LINE_MIN_CHARS)
    expect(trimGrepLongLines(text, 'grep -n MATCH f.ts')).toBe(text)
  })

  it('先于单行封顶：命中在后半截也活下来（封顶只留头部 2000 字）', () => {
    const content = `${'p'.repeat(4000)}MATCH${'q'.repeat(1000)}`
    expect(content.length).toBeGreaterThan(2000)
    const verdict = condenseText('bash', `f.ts:9:${content}`, at(), undefined, ctx('grep -n MATCH f.ts'))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text).toContain('MATCH')
    expect(verdict.text).not.toContain('单行截断')
  })

  it('已经是裁剪结果时不再动手（第二次施加 unchanged）', () => {
    const context = ctx('grep -n MATCH big.txt')
    const first = condenseText('bash', `big.txt:42:${longContent('MATCH')}`, at(), undefined, context)
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(condenseText('bash', first.text, at(), undefined, context)).toEqual({ kind: 'unchanged' })
  })

  it('「按命令语义精简」关着、没有命令、或命令里没有 grep 时不动', () => {
    const text = `big.txt:42:${longContent('MATCH', 700)}`
    expect(condenseText('bash', text, at(), undefined, { command: 'grep -n MATCH big.txt', grepLongLine: false }))
      .toEqual({ kind: 'unchanged' })
    expect(condenseText('bash', text, at(), undefined, { grepLongLine: true })).toEqual({ kind: 'unchanged' })
    expect(condenseText('bash', text, at(), undefined, ctx('ls -la'))).toEqual({ kind: 'unchanged' })
  })

  it('裁剪后仍按文件分组：同文件多行只写一次路径', () => {
    const text = [
      `a.ts:1:${longContent('MATCH')}`,
      `a.ts:2:${longContent('MATCH')}`,
      `b.ts:1:${longContent('MATCH')}`,
    ].join('\n')
    const verdict = condenseText('bash', text, at(), undefined, ctx('grep -n MATCH a.ts b.ts'))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    const lines = verdict.text.split('\n')
    expect(lines[0]).toBe('a.ts')
    expect(lines[1]?.startsWith('1:')).toBe(true)
    expect(lines[2]?.startsWith('2:')).toBe(true)
    expect(verdict.text).toContain('b.ts:1:')
    expect(verdict.rules).toEqual(expect.arrayContaining(['grep-long-line', 'group-paths']))
  })

  it('窗口两侧都留：多处命中时窗口可合并', () => {
    const content = `${'a'.repeat(500)}ONE${'b'.repeat(300)}TWO${'c'.repeat(500)}`
    const verdict = condenseText('bash', `f.ts:1:${content}`, at({ minUnits: 0 }),
      undefined, ctx('grep -E "ONE|TWO" f.ts'))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text).toContain('ONE')
    expect(verdict.text).toContain('TWO')
    // 两处窗口之间的 300 字符间隔小于窗口宽度，合并后不应出现中间省略标记。
    expect(verdict.text.match(/…\[省略/g)?.length ?? 0).toBeLessThanOrEqual(2)
  })

  it('默认窗口是 200 字符', () => {
    expect(GREP_LONG_LINE_WINDOW).toBe(200)
  })
})
