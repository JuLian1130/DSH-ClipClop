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
import {
  GREP_LONG_LINE_MIN_CHARS,
  GREP_LONG_LINE_WINDOW,
  grepPatterns,
  trimAroundMatches,
  trimGrepLongLines,
} from '../src/grepline.ts'

/** 默认参数下的一次精简判定。 */
const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

/** 长正文：前后各 `pad` 个字符，中间夹一个只出现一次的标记。 */
const longContent = (mark: string, pad = 1000): string => `${'x'.repeat(pad)}${mark}${'y'.repeat(pad)}`

/** 一次 grep 调用的上下文（命令 + 「按命令语义精简」打开）。 */
const ctx = (command: string): CondenseContext => ({ command, condenseByCommand: true })

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
    expect(condenseText('bash', text, at(), undefined, { command: 'grep -n MATCH big.txt', condenseByCommand: false }))
      .toEqual({ kind: 'unchanged' })
    expect(condenseText('bash', text, at(), undefined, { condenseByCommand: true })).toEqual({ kind: 'unchanged' })
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

describe('票 26 复审落修', () => {
  it('BRE 里 + ? ( ) | 是字面量：a+b 只命中 a+b，不把 + 当量词', () => {
    const rx = grepPatterns("grep 'a+b' f")[0]
    expect(rx?.test('a+b')).toBe(true)
    expect(rx?.test('aaab')).toBe(false)
  })

  it('-nie 组合簇保留其余选项（i 仍生效）', () => {
    expect(grepPatterns('grep -nie alpha f.ts')[0]?.test('ALPHA')).toBe(true)
  })

  it('-nfpatterns.txt 视为 -f 模式文件，不把 f 当 pattern', () => {
    expect(grepPatterns('grep -nfpatterns.txt f.ts')).toEqual([])
  })

  it('引号里、printf 参数里的 grep 不算命令位', () => {
    expect(grepPatterns("printf '%s\\n' 'grep' MATCH f")).toEqual([])
    expect(grepPatterns('echo grep -n MATCH f')).toEqual([])
    expect(grepPatterns('git log --grep alpha')).toEqual([])
  })

  it('-P（PCRE）不按 JS 正则猜着裁', () => {
    expect(grepPatterns('grep -P "a\\d" f')).toEqual([])
  })

  it('首尾命中、中间空档：中间要标省略，不能整行返回', () => {
    const content = `MATCH${'x'.repeat(3000)}MATCH`
    const trimmed = trimAroundMatches(content, grepPatterns('grep -n MATCH f'), GREP_LONG_LINE_WINDOW)
    expect(trimmed).toContain('…[省略 2600 字符]…')
    expect(trimmed.startsWith('MATCH')).toBe(true)
    expect(trimmed.endsWith('MATCH')).toBe(true)
  })

  it('多处分散命中的裁剪结果超过单行封顶时，封顶不再截它（命中全部保留且幂等）', () => {
    const content = Array.from({ length: 6 }, () => `MATCH${'y'.repeat(800)}`).join('')
    const context = ctx('grep -n MATCH f.ts')
    const verdict = condenseText('bash', `f.ts:1:${content}`, at(), undefined, context)
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text.match(/MATCH/g)?.length).toBe(6)
    expect(verdict.text.length).toBeGreaterThan(2000)
    expect(condenseText('bash', verdict.text, at(), undefined, context)).toEqual({ kind: 'unchanged' })
  })

  it('含空格的路径：裁剪与分组都不动，第二遍也不动（幂等）', () => {
    const line = `a b.ts:1:${'x'.repeat(900)}MATCH${'y'.repeat(900)}`
    const text = [line, line.replace(':1:', ':2:')].join('\n')
    const context = ctx('grep -n MATCH "a b.ts"')
    expect(condenseText('bash', text, at(), undefined, context)).toEqual({ kind: 'unchanged' })
  })

  it('行号 + 正文里的冒号数字（13:- [x] … catalog.ts:32-37）按行号行解析且幂等', () => {
    const text = `13:- [x] ${'p'.repeat(400)}catalog.ts:32-37${'q'.repeat(400)}`
    const command = 'grep -n "32-37" f.ts'
    const first = trimGrepLongLines(text, command)
    expect(first.startsWith('13:')).toBe(true)
    expect(first).toContain('32-37')
    expect(first).toContain('…[省略 ')
    expect(trimGrepLongLines(first, command)).toBe(first)
  })

  it('已带单行截断标记的行不再参与裁剪', () => {
    const text = `f.ts:1:${'a'.repeat(400)}MATCH${'b'.repeat(400)}…[单行截断 +500]`
    expect(trimGrepLongLines(text, 'grep -n MATCH f.ts')).toBe(text)
  })

  it('管道前缀（sed 加空格）仍能被裁剪并保留前缀', () => {
    const text = `  a.ts:1:${'x'.repeat(900)}MATCH${'y'.repeat(900)}`
    const verdict = condenseText('bash', text, at(), undefined, ctx("grep -n MATCH a.ts | sed 's/^/  /'"))
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text.startsWith('  a.ts:1:')).toBe(true)
    expect(verdict.text).toContain('…[省略 ')
    expect(condenseText('bash', verdict.text, at(), undefined, ctx("grep -n MATCH a.ts | sed 's/^/  /'")))
      .toEqual({ kind: 'unchanged' })
  })
})
