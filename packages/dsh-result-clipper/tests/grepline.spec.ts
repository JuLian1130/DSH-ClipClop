/**
 * 票 26 的「命中长行裁剪」（`grep-long-line`）：bash 的 grep 结果里超长命中行按命中 ±200 字符裁剪。
 *
 * 断言的是行为：只认 grep 自己的输出形状、只裁命中行、命中一定活下来（先于单行封顶）、整链幂等、
 * 「按命令语义精简」关着时不动。都走模块公开面（`grepPatterns` / `condenseText` / `generalRules`），
 * 不碰内部实现。
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CONDENSE_DEFAULTS, condenseText, type CondenseContext, type CondenseParams } from '../src/condense.ts'
import {
  GREP_LONG_LINE_MIN_CHARS,
  GREP_LONG_LINE_WINDOW,
  grepPatterns,
  LONG_LINE_MARK,
  trimAroundMatches,
  trimGrepLongLines,
} from '../src/grepline.ts'

/** 本机有没有真的 `grep`（对拍用例在无 grep 的平台上跳过）。 */
const grepAvailable = (() => {
  try {
    execFileSync('grep', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** 用真实 `grep` 跑一遍 pattern，取 `-o` 输出的每个命中片段；没有命中或命令失败时为空数组。 */
function realGrepMatches(args: readonly string[], input: string): string[] {
  try {
    return execFileSync('grep', args, { input: `${input}\n`, encoding: 'utf8' })
      .split('\n')
      .filter(match => match !== '')
  } catch {
    return []
  }
}

/** 本机 grep 是否把 `ſ` 与 `S` 当同一字符（UTF-8 locale 才成立；C locale 下这条差异本就不存在）。 */
const foldsLongS = (() => {
  try {
    return execFileSync('grep', ['-o', '-i', 'ſ'], { input: 'S\n', encoding: 'utf8' }) === 'S\n'
  } catch {
    return false
  }
})()

/** 本机 grep 的 ERE 是否支持 `\<`（词首断言）：BSD 与 GNU 都支持，其余实现可能当字面量。 */
const ereWordBoundary = (() => {
  try {
    return execFileSync('grep', ['-oE', '\\<foo'], { input: ' foo\n', encoding: 'utf8' }) === 'foo\n'
  } catch {
    return false
  }
})()

/** 默认参数下的一次精简判定。 */
const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

/** 长正文：前后各 `pad` 个字符，中间夹一个只出现一次的标记。 */
const longContent = (mark: string, pad = 1000): string => `${'x'.repeat(pad)}${mark}${'y'.repeat(pad)}`

/** 一次 grep 调用的上下文（命令 + 「按命令语义精简」打开）。 */
const ctx = (command: string): CondenseContext => ({ command, condenseByCommand: true })

describe('票 26 · grep 长行裁剪', () => {
  it('command 里的 pattern 能解析出正则（含 -e / -F / -E / -i）', () => {
    expect(grepPatterns('grep -n "alpha" f.ts')).toHaveLength(1)
    expect(grepPatterns('cd x && grep -rnwiE "alpha" src | head')).toHaveLength(1)
    expect(grepPatterns('grep -e alpha -e beta f.ts')).toHaveLength(2)
    expect(grepPatterns('grep -F "a.b" f.ts')[0]?.test('a.b')).toBe(true)
    expect(grepPatterns('grep -i "alpha" f.ts')[0]?.test('ALPHA')).toBe(true)
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
      undefined, ctx('grep -e ONE -e TWO f.ts'))
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
    // 每条断言重新取正则：`grepPatterns` 返回带 `g` 的正则，复用同一实例时 `.test()` 会推进 `lastIndex`，
    // 阴性断言会假绿（收敛计划阶段 0 的测试卫生）。
    expect(grepPatterns("grep 'a+b' f")[0]?.test('a+b')).toBe(true)
    expect(grepPatterns("grep 'a+b' f")[0]?.test('aaab')).toBe(false)
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
    expect(grepPatterns("grep -P -e 'a|b' -e MATCH f")).toEqual([])
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

describe('票 26 · 第二轮复审落修', () => {
  it('-w 按 grep 的邻接语义匹配：标点 pattern 不把 a@b 当命中', () => {
    expect(grepPatterns("grep -nw '@'")[0]?.test(' @ ')).toBe(true)
    expect(grepPatterns("grep -nw '@'")[0]?.test('a@b')).toBe(false)
  })

  it('-w 认以非词字符收尾的 pattern（TODO: 是整词）', () => {
    expect(grepPatterns("grep -nw 'TODO:'")[0]?.test('see TODO: fix')).toBe(true)
  })

  it('长写选项与短写同义：--fixed-strings / --perl-regexp / --word-regexp', () => {
    expect(grepPatterns("grep --fixed-strings 'a.b' f")[0]?.test('axb')).toBe(false)
    expect(grepPatterns("grep --fixed-strings 'a.b' f")[0]?.test('a.b')).toBe(true)
    expect(grepPatterns("grep --perl-regexp 'a\\d' f")).toEqual([])
    expect(grepPatterns("grep --word-regexp 'x' f")[0]?.test('a x b')).toBe(true)
    expect(grepPatterns("grep --word-regexp 'x' f")[0]?.test('axb')).toBe(false)
  })

  it('--file=… 与 -f / --file 同样不表态，不把文件名当 pattern', () => {
    expect(grepPatterns('grep --file=pats.txt long.txt')).toEqual([])
    expect(grepPatterns('grep --file pats.txt long.txt')).toEqual([])
  })

  it('引号外的反斜杠按 shell 解掉：grep -n a\\+b 搜的是字面量 a+b', () => {
    expect(grepPatterns('grep -n a\\+b f')[0]?.test('a+b')).toBe(true)
    expect(grepPatterns('grep -n a\\+b f')[0]?.test('aaab')).toBe(false)
  })

  it('命令位从段首解析：包装词当参数不算，包装带选项仍算', () => {
    expect(grepPatterns("printf '%s\\n' env grep -n MATCH")).toEqual([])
    expect(grepPatterns('find . | xargs -0 grep -n foo f')).toHaveLength(1)
    expect(grepPatterns('sudo -u root grep -n foo f')).toHaveLength(1)
    expect(grepPatterns('env FOO=1 grep -n foo f')).toHaveLength(1)
    expect(grepPatterns('time -p grep -n foo f')).toHaveLength(1)
  })

  it('非词字符 pattern 的裁剪围绕真实命中，不围绕假命中', () => {
    const text = `1:${'x'.repeat(900)} a@b ${'y'.repeat(900)} @ ${'z'.repeat(900)}`
    const trimmed = trimGrepLongLines(text, "grep -nw '@'")
    expect(trimmed).toContain(' @ ')
    expect(trimmed).not.toContain('a@b')
  })
})

describe('票 26 · 第三轮复审落修', () => {
  it('空格形 --regexp 与 -e 同义，多个 pattern 全部收集', () => {
    expect(grepPatterns('grep -n --regexp ALPHA --regexp OMEGA')).toHaveLength(2)
    expect(grepPatterns('grep -e ALPHA --regexp OMEGA')).toHaveLength(2)
  })

  it('两个 --regexp 命中在同一长行时都活下来', () => {
    const text = `1:${'x'.repeat(900)}ALPHA${'y'.repeat(900)}OMEGA${'z'.repeat(900)}`
    const trimmed = trimGrepLongLines(text, 'grep -n --regexp ALPHA --regexp OMEGA')
    expect(trimmed).toContain('ALPHA')
    expect(trimmed).toContain('OMEGA')
  })

  it('pattern 之后的选项照样生效（grep -n MATCH -i）', () => {
    expect(grepPatterns('grep -n MATCH -i')[0]?.test('match')).toBe(true)
    const text = `1:${'x'.repeat(900)}MATCH${'y'.repeat(900)}match${'z'.repeat(900)}`
    const trimmed = trimGrepLongLines(text, 'grep -n MATCH -i')
    expect(trimmed).toContain('MATCH')
    expect(trimmed).toContain('match')
  })

  it('POSIX 字符类不猜方言：默认与 -E 都不表态，-F 按字面量照常', () => {
    expect(grepPatterns("grep -n '[[:digit:]]' f")).toEqual([])
    expect(grepPatterns("grep -nE '[[:alpha:]]+' f")).toEqual([])
    expect(grepPatterns("grep -nF '[[:digit:]]' f")[0]?.test('[[:digit:]]')).toBe(true)
  })

  it('一次调用里混进 POSIX 字符类时整条不表态（其余 pattern 也不裁）', () => {
    const command = "grep -n -e MATCH -e '[[:digit:]]' f"
    expect(grepPatterns(command)).toEqual([])
    const text = `1:${'x'.repeat(300)}MATCH${'y'.repeat(600)}7${'z'.repeat(300)}`
    expect(trimGrepLongLines(text, command)).toBe(text)
  })
})

describe('票 26 · 第五轮复审落修', () => {
  it('双引号里的 \\ 按 shell 解成单反斜杠：-F 搜的是字面量 a\\b', () => {
    // 同上：每次断言重新取正则，避免复用实例推进 `lastIndex`。
    expect(grepPatterns('grep -nF "a\\\\b" f')[0]?.test('a\\b')).toBe(true)
    expect(grepPatterns('grep -nF "a\\\\b" f')[0]?.test('a\\\\b')).toBe(false)
  })

  it('双引号里的转义引号不提前结束字符串：引号里的 grep 不当命令位', () => {
    const command = String.raw`printf '%s\n' "fake\"; grep -n MATCH f; tail" 'f.ts:1:x'`
    expect(grepPatterns(command)).toEqual([])
    const text = `f.ts:1:${'x'.repeat(400)}MATCH${'y'.repeat(400)}`
    expect(trimGrepLongLines(text, command)).toBe(text)
  })

  it('空 pattern（-e \'\' / \'\'）整次调用不表态，不把文件名当 pattern', () => {
    expect(grepPatterns("grep -n -e '' f")).toEqual([])
    expect(grepPatterns("grep -n '' f")).toEqual([])
    expect(grepPatterns("grep -n -e '' -e MATCH f")).toEqual([])
    const text = `f.ts:1:${'x'.repeat(400)}f${'y'.repeat(400)}`
    expect(trimGrepLongLines(text, "grep -n -e '' f")).toBe(text)
  })

  it('方括号里的 |、-F 字面量与 ERE 的转义 | 不算交替，照常编译', () => {
    // 每条断言都重新取一次正则：`grepPatterns` 返回带 `g` 的正则，复用同一实例时 `.test()` 会推进 `lastIndex`，
    // 阴性断言会假绿（第 6 次联合复审删掉 `escapeRegExp` 的 `|` 后用例仍全过）。
    expect(grepPatterns('grep -nF "a|b" f')[0]?.test('a|b')).toBe(true)
    expect(grepPatterns('grep -nF "a|b" f')[0]?.test('a')).toBe(false)
    // `|` 是字面量：只有 `a` 的长行不能按 `a` 定位裁。
    const noBar = `f.ts:1:${'x'.repeat(400)}a${'y'.repeat(400)}`
    expect(trimGrepLongLines(noBar, 'grep -nF "a|b" f')).toBe(noBar)
    expect(grepPatterns('grep -nF "(a|b)" f')[0]?.test('(a|b)')).toBe(true)
    expect(grepPatterns('grep -nF "(a|b)" f')[0]?.test('a')).toBe(false)
    expect(grepPatterns('grep -nF "(a|b)" f')[0]?.test('a|b')).toBe(false)
    const noParen = `f.ts:1:${'x'.repeat(400)}a${'y'.repeat(400)}`
    expect(trimGrepLongLines(noParen, 'grep -nF "(a|b)" f')).toBe(noParen)
    expect(grepPatterns('grep -nE "[a|b]" f')[0]?.test('|')).toBe(true)
    expect(grepPatterns('grep -nE "a\\|b" f')[0]?.test('a|b')).toBe(true)
  })

  it('含反向引用的交替整次不表态（分支独立编译会改变捕获组编号）', () => {
    const ere = String.raw`grep -nE '(foo)|(Bz+E)\2' f`
    const bre = String.raw`grep -n '\(foo\)\|\(Bz\+E\)\2' f`
    expect(grepPatterns(ere)).toEqual([])
    expect(grepPatterns(bre)).toEqual([])
    const content = `${'x'.repeat(300)}foo${'y'.repeat(300)}B${'z'.repeat(300)}EB${'z'.repeat(300)}E${'w'.repeat(300)}`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, ere)).toBe(text)
  })

  it('已分组的多文件上下文行第二遍不再裁（整链幂等）', () => {
    const file = 'very-long-directory-name/'.repeat(5) + 'f.ts'
    const content = `foo${'a'.repeat(700)}${'x'.repeat(700)}`
    const raw = [`${file}:1:bar`, `${file}-2-${content}`, `${file}:3:baz`].join('\n')
    const context = ctx(`grep -vnH --label=${file} -A1 foo`)
    const first = condenseText('bash', raw, at(), undefined, context)
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(first.lossy).toBe(false)
    expect(first.rules).toContain('group-paths')
    expect(first.text.startsWith(`${file}\n`)).toBe(true)
    expect(condenseText('bash', first.text, at(), undefined, context)).toEqual({ kind: 'unchanged' })
  })

  it('没有组头的单文件上下文行照常裁', () => {
    const text = `1:bar\n2-${'x'.repeat(400)}MATCH${'y'.repeat(400)}`
    const trimmed = trimGrepLongLines(text, 'grep -n -A1 MATCH f.ts')
    expect(trimmed).not.toBe(text)
    expect(trimmed).toContain('MATCH')
  })
})

describe('票 27 · 交替分支按顶层拆分', () => {
  it('ERE 顶层交替：拆成独立分支定位，BEGIN 与 END 两侧都留下（真实最长命中完整）', () => {
    const content = `${'x'.repeat(900)}BEGIN${'y'.repeat(900)}END${'z'.repeat(900)}`
    const command = "grep -nE 'BEGIN|BEGIN.*END' f"
    const first = condenseText('bash', `f.ts:1:${content}`, at(), undefined, ctx(command))
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(first.rules).toContain('grep-long-line')
    // POSIX 的最长匹配是 BEGIN…END 整段：命中终点之后的内容也按窗口保留，不会被当成命中之前的省略。
    expect(first.text).toContain(`BEGIN${'y'.repeat(900)}END`)
    expect(first.text.length).toBeLessThan(content.length / 2)
    expect(condenseText('bash', first.text, at(), undefined, ctx(command))).toEqual({ kind: 'unchanged' })
  })

  it('BRE 顶层交替（\\|）与 ERE 同样拆分并留下整段最长命中', () => {
    const content = `${'x'.repeat(900)}BEGIN${'y'.repeat(900)}END${'z'.repeat(900)}`
    const command = String.raw`grep -n 'BEGIN\|BEGIN.*END' f`
    const first = condenseText('bash', `f.ts:1:${content}`, at(), undefined, ctx(command))
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(first.text).toContain(`BEGIN${'y'.repeat(900)}END`)
    expect(condenseText('bash', first.text, at(), undefined, ctx(command))).toEqual({ kind: 'unchanged' })
  })

  it('拆分后的分支仍按原方言编译：BRE 的 \\+ 在分支里仍是量词', () => {
    const command = String.raw`grep -n 'a\+b\|c\+d' f`
    expect(grepPatterns(command)).toHaveLength(2)
    expect(grepPatterns(command).some(rx => rx.test('aaab'))).toBe(true)
    expect(grepPatterns(command).some(rx => rx.test('cccd'))).toBe(true)
  })

  it('ERE 的转义括号是字面量、不记层级：顶层 | 照样拆开', () => {
    const command = 'grep -nE "\\(a|b\\)" f'
    expect(grepPatterns(command)).toHaveLength(2)
    expect(grepPatterns(command).some(rx => rx.test('(a'))).toBe(true)
    expect(grepPatterns(command).some(rx => rx.test('b)'))).toBe(true)
  })

  it('空分支（ERE 的 a| / BRE 的 a\\| / 嵌套 (a|)）与空 pattern 一样整次不表态', () => {
    expect(grepPatterns("grep -nE 'a|' f")).toEqual([])
    expect(grepPatterns(String.raw`grep -n 'a\|' f`)).toEqual([])
    expect(grepPatterns("grep -nE -e 'a|' -e MATCH f")).toEqual([])
    expect(grepPatterns("grep -nE '(a|)' f")).toEqual([])
    expect(grepPatterns("grep -nwE 'a|' f")).toEqual([])
    expect(grepPatterns("grep -nF '' f")).toEqual([])
    const text = `f.ts:1:${'x'.repeat(400)}a${'y'.repeat(400)}`
    expect(trimGrepLongLines(text, "grep -nE 'a|' f")).toBe(text)
  })

  it('转义反斜杠后的数字是字面量、不算反向引用（顶层交替照常拆）', () => {
    const command = String.raw`grep -nE 'foo|\\1' f`
    const patterns = grepPatterns(command)
    expect(patterns).toHaveLength(2)
    expect(patterns.some(rx => rx.test('\\1'))).toBe(true)
    const content = `${'x'.repeat(400)}foo${'y'.repeat(400)}\\1${'z'.repeat(400)}`
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, command)
    expect(trimmed).not.toBe(text)
    expect(trimmed).toContain('\\1')
  })

  it('嵌套交替走保守窗口：只裁最早命中起点以前，命中及其后原样保留（ERE/BRE × -w）', () => {
    const content = `${'x'.repeat(900)} abc ${'y'.repeat(900)}`
    const commands = [
      "grep -nE '(a|ab)c' f",
      String.raw`grep -n '\(a\|ab\)c' f`,
      "grep -nwE '(a|ab)c' f",
      String.raw`grep -nw '\(a\|ab\)c' f`,
      // 顶层能拆、但拆出的分支里还有交替：整次调用同样退回保守窗口。
      "grep -nE 'zzz|(a|ab)c' f",
    ]
    const trimmed = `f.ts:1:${LONG_LINE_MARK}701 字符]…${content.slice(701)}`
    for (const command of commands) {
      // 最早命中起点是 `abc` 的 a（下标 901）：只裁掉它以前、200 字符窗口之前的 701 字符；
      // 命中及其后整段原样保留——真实命中终点不可知的交替分支不会被删掉后半截。
      expect(trimGrepLongLines(`f.ts:1:${content}`, command), command).toBe(trimmed)
      expect(trimGrepLongLines(trimmed, command), command).toBe(trimmed)
    }
  })

  it('保守窗口在最早命中贴着行首时不裁（没有可省的字符）', () => {
    const content = `${'x'.repeat(50)} abc ${'y'.repeat(900)}`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, "grep -nE '(a|ab)c' f")).toBe(text)
  })

  it.skipIf(!grepAvailable)('真实 grep 对拍：grep -o 的每个命中片段都完整包含在裁后内容里', () => {
    const content = `${'x'.repeat(900)}BEGIN${'y'.repeat(900)}END${'z'.repeat(900)}`
    const spaced = `${'x'.repeat(900)} foo ${'y'.repeat(900)} bar ${'z'.repeat(900)}`
    const cases = [
      { command: "grep -nE 'BEGIN|BEGIN.*END' f", content, options: ['-o', '-E', 'BEGIN|BEGIN.*END'] },
      { command: String.raw`grep -n 'BEGIN\|BEGIN.*END' f`, content, options: ['-o', 'BEGIN\\|BEGIN.*END'] },
      { command: "grep -nE '(BEGIN|BEGIN.*END)' f", content, options: ['-o', '-E', '(BEGIN|BEGIN.*END)'] },
      { command: "grep -nwE 'foo|bar' f", content: spaced, options: ['-o', '-w', '-E', 'foo|bar'] },
    ]
    for (const { command, content: line, options } of cases) {
      const matches = realGrepMatches(options, line)
      expect(matches.length, command).toBeGreaterThan(0)
      const raw = `f.ts:1:${line}`
      const trimmed = trimGrepLongLines(raw, command)
      expect(trimmed, command).not.toBe(raw)
      for (const match of matches) expect(trimmed, `${command} 的命中 ${match}`).toContain(match)
    }
  })
})

describe('票 26/27 · 联合复审落修（2026-10-19）', () => {
  it('引号外的反斜杠续行按 shell 删掉：两个 pattern 的命中都留下', () => {
    const command = 'grep -n -e MATCH -e \\\nSECOND'
    expect(grepPatterns(command)).toHaveLength(2)
    expect(grepPatterns(command).some(rx => rx.test('SECOND'))).toBe(true)
    const content = `${'x'.repeat(900)}MATCH${'y'.repeat(900)}SECOND${'z'.repeat(900)}`
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, command)
    expect(trimmed).not.toBe(text)
    expect(trimmed).toContain('MATCH')
    expect(trimmed).toContain('SECOND')
  })

  it('pattern 里的真换行是 grep 的 pattern 列表：整次调用不表态，真实命中不被删', () => {
    const command = "grep -nF -e 'ALPHA\nOMEGA' -e MATCH"
    expect(grepPatterns(command)).toEqual([])
    const content = `${'x'.repeat(900)}ALPHA${'y'.repeat(900)}MATCH${'z'.repeat(900)}OMEGA`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, command)).toBe(text)
  })

  it.skipIf(!grepAvailable)('两个及以上重复算子走保守窗口：非交替的真实最长命中完整保留', () => {
    const content = `${'x'.repeat(900)}aab${'b'.repeat(900)}${'z'.repeat(900)}`
    const command = "grep -nE 'a+(ab+)?' f"
    const matches = realGrepMatches(['-o', '-E', 'a+(ab+)?'], content)
    expect(matches.length).toBeGreaterThan(0)
    const trimmed = trimGrepLongLines(`f.ts:1:${content}`, command)
    for (const match of matches) expect(trimmed, `命中 ${match}`).toContain(match)
    expect(trimGrepLongLines(trimmed, command)).toBe(trimmed)
  })

  it.skipIf(!grepAvailable)('顶层交替里含两个重复算子的分支同样走保守窗口（真实最长命中完整保留）', () => {
    const content = `${'x'.repeat(900)}foo${'y'.repeat(900)}aab${'b'.repeat(900)}${'z'.repeat(900)}`
    const command = "grep -nE 'foo|a+(ab+)?' f"
    const matches = realGrepMatches(['-o', '-E', 'foo|a+(ab+)?'], content)
    expect(matches.length).toBeGreaterThan(0)
    const trimmed = trimGrepLongLines(`f.ts:1:${content}`, command)
    for (const match of matches) expect(trimmed, `命中 ${match}`).toContain(match)
  })

  it('-w × 顶层交替：lookaround 逐分支生效，a@b 里的 @ 不算命中', () => {
    const content = `${'p'.repeat(400)}x@y${'q'.repeat(400)} TODO: fix${'r'.repeat(400)}`
    const trimmed = trimGrepLongLines(`f.ts:1:${content}`, "grep -nwE 'TODO:|@' f")
    expect(trimmed).toContain('TODO:')
    expect(trimmed).not.toContain('x@y')
  })
})

describe('票 26/27 · 复审落修 · 方括号首成员 ]（2026-10-19）', () => {
  it('方括号表达式以 ] 开头：POSIX 与 JS 语义不同，整次调用不表态', () => {
    // `[]a]` 在 POSIX 里是「] 或 a」；JS 读成空字符类 + 字面 `a]`，永不命中。
    expect(grepPatterns("grep -nE '[]a]|MATCH' f")).toEqual([])
    expect(grepPatterns(String.raw`grep -n '[]a]\|MATCH' f`)).toEqual([])
    // `[^]` 在 JS 里是「任意字符」，同样改义。
    expect(grepPatterns("grep -nE '[^]a]|MATCH' f")).toEqual([])
    // `-F` 下整串是字面量，方括号没有表达式语义，照常编译。
    expect(grepPatterns("grep -nF '[]a]' f")).toHaveLength(1)
    expect(grepPatterns("grep -nF '[]a]' f")[0]?.test('[]a]')).toBe(true)
    // 普通方括号表达式不在此列，照常拆分与裁剪。
    expect(grepPatterns("grep -nE '[ab]|MATCH' f")).toHaveLength(2)
  })

  it('转义的 \\[ 不算方括号表达式', () => {
    expect(grepPatterns(String.raw`grep -nE '\[a]|MATCH' f`)).toHaveLength(2)
  })

  it('不表态时正文原样返回（真实命中不删）', () => {
    const content = `${'x'.repeat(900)}MATCH${'y'.repeat(900)}]${'z'.repeat(900)}`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, "grep -nE '[]a]|MATCH' f")).toBe(text)
  })

  it.skipIf(!grepAvailable)('真实 grep 对拍：] 是真实命中，裁后会话整次不表态、命中完整保留', () => {
    const content = `${'x'.repeat(900)}MATCH${'y'.repeat(900)}]${'z'.repeat(900)}`
    const matches = realGrepMatches(['-o', '-E', '[]a]|MATCH'], content)
    expect(matches).toContain(']')
    expect(matches).toContain('MATCH')
    const text = `f.ts:1:${content}`
    // 不管走哪条路，真实命中都必须完整出现；本实现选择整次不表态。
    const trimmed = trimGrepLongLines(text, "grep -nE '[]a]|MATCH' f")
    expect(trimmed).toBe(text)
    for (const match of matches) expect(trimmed).toContain(match)
  })
})

describe('票 26/27 · 第 3 次复审落修（BRE 锚点 / 方括号 POSIX 构造）', () => {
  it('BRE 非锚点位置的 ^ / $ 是字面量：整次调用不表态', () => {
    expect(grepPatterns("grep -n -e MATCH -e 'foo^bar' f")).toEqual([])
    expect(grepPatterns("grep -n -e MATCH -e 'foo$bar' f")).toEqual([])
    // `$` 紧挨 `\|` 时 BSD 当字面量、GNU 当锚点：方言不猜。
    expect(grepPatterns("grep -n 'b$\\|d$' f")).toEqual([])
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}foo^bar${'z'.repeat(400)}`
    expect(trimGrepLongLines(`f.ts:1:${content}`, "grep -n -e MATCH -e 'foo^bar' f")).toBe(`f.ts:1:${content}`)
  })

  it('BRE 锚点的合法位置（开头 / 结尾 / \\( 之后 / \\) 之前 / \\| 之后）照常编译', () => {
    expect(grepPatterns("grep -n '^foo' f")[0]?.test('foo')).toBe(true)
    expect(grepPatterns("grep -n '^foo' f")[0]?.test('xfoo')).toBe(false)
    expect(grepPatterns("grep -n 'foo$' f")[0]?.test('foo')).toBe(true)
    expect(grepPatterns("grep -n 'foo$' f")[0]?.test('foox')).toBe(false)
    const command = "grep -n '^a\\|^b' f"
    expect(grepPatterns(command)).toHaveLength(2)
    expect(grepPatterns(command)[0]?.test('abc')).toBe(true)
    expect(grepPatterns(command)[1]?.test('bcd')).toBe(true)
    expect(grepPatterns(command)[0]?.test('xabc')).toBe(false)
    expect(grepPatterns("grep -n '\\(^a\\)b' f")[0]?.test('ab')).toBe(true)
    expect(grepPatterns("grep -n 'a\\(b$\\)' f")[0]?.test('ab')).toBe(true)
    expect(grepPatterns("grep -n 'a\\(b$\\)' f")[0]?.test('abc')).toBe(false)
    expect(grepPatterns("grep -n '[^abc]' f")[0]?.test('d')).toBe(true)
    expect(grepPatterns("grep -n '[^abc]' f")[0]?.test('a')).toBe(false)
    expect(grepPatterns("grep -nE 'foo^bar' f")).toHaveLength(1)
    expect(grepPatterns("grep -nF 'foo^bar' f")).toHaveLength(1)
  })

  it('方括号内反斜杠 / 排序元素 / 等价类：整次调用不表态', () => {
    expect(grepPatterns(String.raw`grep -nE '[\b]|MATCH' f`)).toEqual([])
    expect(grepPatterns(String.raw`grep -nE '[\d]|MATCH' f`)).toEqual([])
    expect(grepPatterns("grep -nE '[[.a.]]|MATCH' f")).toEqual([])
    expect(grepPatterns("grep -nE '[[=a=]]|MATCH' f")).toEqual([])
    expect(grepPatterns("grep -nE '[a[.b.]c]|MATCH' f")).toEqual([])
  })

  it('普通方括号与字面 [ 不再误判：照常拆分与裁剪', () => {
    expect(grepPatterns("grep -nE 'a[[]b' f")[0]?.test('a[b')).toBe(true)
    expect(grepPatterns("grep -nE '[.a.]|MATCH' f")).toHaveLength(2)
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}`
    const trimmed = trimGrepLongLines(`f.ts:1:${content}`, "grep -nE 'a[[]b|MATCH' f")
    expect(trimmed).toContain('MATCH')
    expect(trimmed).not.toBe(`f.ts:1:${content}`)
  })

  it.skipIf(!grepAvailable)('真实 grep 对拍：方括号 POSIX 构造的真实命中完整保留（整次不表态）', () => {
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}b${'z'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-E', '[\\b]|MATCH'], content)
    expect(matches).toContain('b')
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, String.raw`grep -nE '[\b]|MATCH' f`)
    expect(trimmed).toBe(text)
    for (const match of matches) expect(trimmed).toContain(match)
  })

  it.skipIf(!grepAvailable)('真实 grep 对拍：排序元素的真实命中完整保留（整次不表态）', () => {
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}a${'z'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-E', '[[.a.]]|MATCH'], content)
    expect(matches).toContain('a')
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, "grep -nE '[[.a.]]|MATCH' f")
    expect(trimmed).toBe(text)
    for (const match of matches) expect(trimmed).toContain(match)
  })
})

describe('票 26/27 · 第 4 次联合复审落修（编译失败 / 多段不表态，2026-10-19）', () => {
  it('BRE 重复算子位置的字面 * 不因编译失败被静默丢掉：整次调用不表态', () => {
    // POSIX BRE：pattern 开头 / `\(` / `\|` 之后的 `*` 是字面量；JS 却会抛 Nothing to repeat。
    expect(grepPatterns("grep -n -e MATCH -e '*abc' f")).toEqual([])
    expect(grepPatterns(String.raw`grep -n -e MATCH -e '\(*abc\)' f`)).toEqual([])
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}*abc${'z'.repeat(400)}`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, "grep -n -e MATCH -e '*abc' f")).toBe(text)
  })

  it.skipIf(!grepAvailable)('真实 grep 对拍：字面 * 的真实命中完整保留（整次不表态）', () => {
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)}*abc${'z'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-e', 'MATCH', '-e', '*abc'], content)
    expect(matches).toContain('*abc')
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, "grep -n -e MATCH -e '*abc' f")
    expect(trimmed).toBe(text)
    for (const match of matches) expect(trimmed).toContain(match)
  })

  it('同一条命令里任一次 grep 不表态：整条结果不裁（多段输出无法按调用切分）', () => {
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(900)}SECOND${'z'.repeat(400)}`
    const text = `f.ts:1:${content}\nf.ts:2:${content}`
    expect(trimGrepLongLines(text, "grep -nE 'MATCH|SECOND' f; grep -n -e '' f")).toBe(text)
    expect(trimGrepLongLines(text, "grep -nE 'MATCH' f; grep -nP 'SECOND' g")).toBe(text)
    expect(trimGrepLongLines(text, "grep -nE 'MATCH' f; grep -n -f pats.txt g")).toBe(text)
  })

  it('纯并集（每段都解析成功）仍照常裁', () => {
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(900)}SECOND${'z'.repeat(400)}`
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, "grep -nE 'MATCH' f; grep -nE 'SECOND' g")
    expect(trimmed).not.toBe(text)
    expect(trimmed).toContain('MATCH')
    expect(trimmed).toContain('SECOND')
    expect(trimGrepLongLines(trimmed, "grep -nE 'MATCH' f; grep -nE 'SECOND' g")).toBe(trimmed)
  })
})

describe('票 26/27 · 第 5 次联合复审落修（2026-10-19）', () => {
  it.skipIf(!grepAvailable)('含非 BMP 字符的命中行不裁：真实 grep -o 的命中完整保留', () => {
    const content = `${'x'.repeat(900)}A😀B😀C${'y'.repeat(900)}MATCH${'z'.repeat(900)}`
    const matches = realGrepMatches(['-o', '-E', '-e', 'A.{1}B.{1}C', '-e', 'MATCH'], content)
    expect(matches).toContain('A😀B😀C')
    const text = `f.ts:1:${content}`
    // `.` 与量词在 JS 里按 UTF-16 码元匹配，定位不到真实命中；按后面的 MATCH 裁会把 `A😀B😀C` 删掉。
    expect(trimGrepLongLines(text, "grep -nE -e 'A.{1}B.{1}C' -e MATCH f")).toBe(text)
    // 没有重复算子的同形 pattern 同样不裁（缺口不在保守窗口那一层）。
    expect(trimGrepLongLines(text, "grep -n -e 'A.B.C' -e MATCH f")).toBe(text)
  })

  it('方言选项冲突（-F / -E / -G 同现）整次不表态，不按其中一种猜着裁', () => {
    expect(grepPatterns("grep -nF -E 'foo|bar' f")).toEqual([])
    expect(grepPatterns("grep -nE -F 'foo|bar' f")).toEqual([])
    expect(grepPatterns("grep -nE -G 'foo\\|bar' f")).toEqual([])
    expect(grepPatterns("grep -n --basic-regexp --extended-regexp 'foo|bar' f")).toEqual([])
    const content = `${'x'.repeat(400)}foo${'y'.repeat(400)}foo|bar${'z'.repeat(400)}`
    const text = `f.ts:1:${content}`
    expect(trimGrepLongLines(text, "grep -nF -E 'foo|bar' f")).toBe(text)
  })

  it.skipIf(!grepAvailable)('真实 grep 的方言选项是后写者胜：冲突调用不裁才不会删命中', () => {
    expect(realGrepMatches(['-o', '-F', '-E', 'foo|bar'], 'foo')).toEqual(['foo'])
    expect(realGrepMatches(['-o', '-E', '-F', 'foo|bar'], 'foo|bar')).toEqual(['foo|bar'])
  })
})

describe('票 26/27 · 第 6 次联合复审落修（2026-10-19）', () => {
  it.skipIf(!grepAvailable)('pattern 含非 BMP 字符时整次不表态：正文 BMP 的真实命中不被删', () => {
    const content = `${'x'.repeat(400)}AB${'y'.repeat(900)}MATCH${'z'.repeat(400)}`
    const command = "grep -nE -e 'A😀?B' -e MATCH f"
    const matches = realGrepMatches(['-o', '-E', '-e', 'A😀?B', '-e', 'MATCH'], content)
    expect(matches).toContain('AB')
    const text = `f.ts:1:${content}`
    // `?` 绑在低代理码元上，JS 匹配不到 grep 的真实命中 `AB`；整次不表态后正文原样保留。
    expect(grepPatterns(command)).toEqual([])
    expect(trimGrepLongLines(text, command)).toBe(text)
    // `-F` 下 astral 是字面量、按码元逐位匹配与 grep 的字节序列一致，照常编译。
    expect(grepPatterns("grep -nF 'A😀?B' f")).toHaveLength(1)
  })
})

describe('票 26/27 · 第 7 次联合复审落修（2026-10-19）', () => {
  it.skipIf(!grepAvailable)('顶层分支按 grep -o 的推进语义合并：重叠起点不丢真实命中', () => {
    // `B.{255}` 的分支自己先命中位置 450 并推进到 706；真实 grep 先命中 400 的 `A.{100}`、从 501 继续，
    // 第二段命中起点 660——逐分支非重叠扫描会跳过它（第 7 次联合复审实测删掉第二段尾 10 字符）。
    const content = `${'x'.repeat(400)}A${'x'.repeat(49)}B${'y'.repeat(209)}B${'z'.repeat(255)}${'q'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-E', 'A.{100}|B.{255}'], content)
    expect(matches.map(match => match.length)).toEqual([101, 256])
    const text = `f.ts:1:${content}`
    const trimmed = trimGrepLongLines(text, "grep -nE 'A.{100}|B.{255}' f")
    expect(trimmed).not.toBe(text)
    for (const match of matches) expect(trimmed).toContain(match)
  })

  it('pattern 含非 ASCII 字符且 -i：整次不表态（JS 的 i 标志不折叠非 ASCII→ASCII）', () => {
    // `/ſ/i.test('S') === false`，而 UTF-8 locale 的 grep 把 `ſ` 与 `S` 当同一字符；只丢这一条、拿
    // 其余 pattern 裁，会把真实命中 `S` 删掉（第 7 次联合复审实测）。`-F` 的字面量同样按 `i` 折叠。
    expect(grepPatterns("grep -niE 'ſ|MATCH' f")).toEqual([])
    expect(grepPatterns("grep -niF 'ſ' f")).toEqual([])
    expect(grepPatterns('grep -niE "match" f')).toHaveLength(1)
    const text = `f.ts:1:${'x'.repeat(400)}S${'y'.repeat(900)}MATCH${'z'.repeat(400)}`
    expect(trimGrepLongLines(text, "grep -niE 'ſ|MATCH' f")).toBe(text)
  })

  it.skipIf(!foldsLongS)('真实 grep 在 UTF-8 locale 下把 ſ 与 S 当同一字符：整次不表态后命中保留', () => {
    const content = `${'x'.repeat(400)}S${'y'.repeat(900)}MATCH${'z'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-i', '-E', '-e', 'ſ', '-e', 'MATCH'], content)
    expect(matches).toContain('S')
    expect(trimGrepLongLines(`f.ts:1:${content}`, "grep -niE 'ſ|MATCH' f")).toBe(`f.ts:1:${content}`)
  })

  it.skipIf(!ereWordBoundary)('ERE 的 \\< / \\> 翻成词首 / 词尾断言：真实命中不被删', () => {
    // JS 把 `\<` 当字面 `<`；BRE 早已翻成 `\b`，ERE 之前原样透传（第 7 次联合复审实测删掉 `foo`）。
    const content = `${'x'.repeat(400)}MATCH${'y'.repeat(400)} foo${'z'.repeat(400)}`
    const matches = realGrepMatches(['-o', '-E', '-e', 'MATCH', '-e', '\\<foo'], content)
    expect(matches).toContain('foo')
    const command = String.raw`grep -nE -e MATCH -e '\<foo' f`
    expect(grepPatterns(command)[1]?.test(' foo')).toBe(true)
    const trimmed = trimGrepLongLines(`f.ts:1:${content}`, command)
    for (const match of matches) expect(trimmed).toContain(match)
    expect(trimGrepLongLines(trimmed, command)).toBe(trimmed)
  })

  it('方括号里的 | 与 ERE 字面 | 仍照常左右裁（能分辨「不算交替」与「被当成嵌套交替」）', () => {
    // 两种实现的 `grepPatterns` 返回值相同，分叉只在裁剪形态：照常左右裁会留中间省略标记，
    // 被当成嵌套交替走保守窗口则只剩头插标记（第 7 次联合复审的判据空转）。
    const bars = `f.ts:1:${'x'.repeat(400)}|${'y'.repeat(900)}|${'z'.repeat(400)}`
    expect(trimGrepLongLines(bars, 'grep -nE "[a|b]" f').match(/…\[省略 \d+ 字符\]…/g)).toHaveLength(3)
    const literal = `f.ts:1:${'x'.repeat(400)}a|b${'y'.repeat(900)}a|b${'z'.repeat(400)}`
    expect(trimGrepLongLines(literal, String.raw`grep -nE 'a\|b' f`).match(/…\[省略 \d+ 字符\]…/g)).toHaveLength(3)
  })
})
