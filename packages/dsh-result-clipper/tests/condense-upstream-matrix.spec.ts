/**
 * 票 20 的上游入口不变量矩阵：所有族 × 适用的说明形态 × 哪些配置边界。
 *
 * 判据只有两条，写成矩阵而不是单点例子：① 上游说明逐字留在输出里；② 有上游入口时入口归属是 `upstream`
 * （不写第二条），`(unavailable)` 不算入口。新增一族、一种尾部形态或一个边界，就往这张表里加一行。
 * `compactDiff` 不列截断形态：`truncated` 事实会先把它拦在族外（`facts: { truncated: false }`）。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  CONDENSE_DEFAULTS,
  condenseText,
  type CondenseParams,
  type CondenseRule,
} from '../src/condense.ts'
import { builtinRules, condenseRuleOf } from '../src/dispatch.ts'
import { GIT_DIFF_DEFAULTS } from '../src/gitdiff.ts'
import { RAW_DUMP_DEFAULTS, SED_WINDOW_DEFAULTS } from '../src/glance.ts'
import { GIT_DIFF_BODY } from './support/gitdiff.ts'

const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

/** 造 n 行互不相同、每行约 `width` 字符的正文。 */
const block = (n: number, width = 8): string =>
  Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, 'y')).join('\n')

const POSITION = '\n\n(Full grep result stored at: /tmp/grep-results.txt. Use read with offset/limit to inspect.)'
const LONG_POSITION = `\n\n(Full grep result stored at: /tmp/${'x'.repeat(2100)}.txt)`
const TRUNCATED = '\n[output truncated; full output: /tmp/full.txt]'
const UNAVAILABLE = '\n[output truncated; full output: (unavailable)]'

type Family = 'general' | 'compactDiff' | 'sedWindow' | 'rawDump'

interface Case {
  readonly name: string
  readonly family: Family
  readonly body: string
  readonly params?: Partial<CondenseParams>
  readonly entry: 'own' | 'upstream'
  readonly contains: readonly string[]
}

const withTail = (tail: string): string => `${block(301)}${tail}`

const cases: readonly Case[] = [
  { name: '通用链 · 位置说明', family: 'general', body: withTail(POSITION), entry: 'upstream', contains: [POSITION.trim()] },
  { name: '通用链 · 超长位置说明', family: 'general', body: withTail(LONG_POSITION), params: { maxLineChars: 80 }, entry: 'upstream', contains: [LONG_POSITION.trim()] },
  { name: '通用链 · 尾部只留 1 行', family: 'general', body: withTail(POSITION), params: { tailLines: 1 }, entry: 'upstream', contains: [POSITION.trim()] },
  { name: '通用链 · 带路径截断说明', family: 'general', body: withTail(TRUNCATED), entry: 'upstream', contains: [TRUNCATED.trim()] },
  { name: '通用链 · (unavailable)', family: 'general', body: withTail(UNAVAILABLE), entry: 'own', contains: [UNAVAILABLE.trim()] },
  { name: 'sedWindow · 超长位置说明', family: 'sedWindow', body: withTail(LONG_POSITION), entry: 'upstream', contains: [LONG_POSITION.trim()] },
  { name: 'sedWindow · 带路径截断说明', family: 'sedWindow', body: withTail(TRUNCATED), entry: 'upstream', contains: [TRUNCATED.trim()] },
  { name: 'sedWindow · (unavailable)', family: 'sedWindow', body: withTail(UNAVAILABLE), entry: 'own', contains: [UNAVAILABLE.trim()] },
  { name: 'rawDump · 位置说明', family: 'rawDump', body: withTail(POSITION), entry: 'upstream', contains: [POSITION.trim()] },
  { name: 'rawDump · 带路径截断说明', family: 'rawDump', body: withTail(TRUNCATED), entry: 'upstream', contains: [TRUNCATED.trim()] },
  { name: 'rawDump · (unavailable)', family: 'rawDump', body: withTail(UNAVAILABLE), entry: 'own', contains: [UNAVAILABLE.trim()] },
  { name: 'compactDiff · 说明 + 退出标记', family: 'compactDiff', body: `${GIT_DIFF_BODY}\n[exit code: 1]${POSITION}`, entry: 'upstream', contains: ['[exit code: 1]', POSITION.trim()] },
  { name: 'compactDiff · 超长位置说明', family: 'compactDiff', body: `${GIT_DIFF_BODY}${LONG_POSITION}`, entry: 'upstream', contains: [LONG_POSITION.trim()] },
]

const families = builtinRules({
  gitDiff: () => GIT_DIFF_DEFAULTS,
  sedWindow: () => SED_WINDOW_DEFAULTS,
  rawDump: () => RAW_DUMP_DEFAULTS,
})

const ruleFor = (family: Family): CondenseRule | undefined =>
  family === 'general' ? undefined : condenseRuleOf(families.find(candidate => candidate.family === family)!)

describe('票 20 · 上游入口不变量矩阵', () => {
  it.each(cases)('$name', ({ family, body, params, entry, contains }) => {
    const rule = ruleFor(family)
    const out = condenseText('bash', body, at(params), rule === undefined ? undefined : [rule])

    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(true)
    if (!out.lossy) return
    expect(out.entry).toBe(entry)
    for (const piece of contains) expect(out.text).toContain(piece)
    if (entry === 'upstream') expect(out.text).not.toContain('精简版')
  })
})
