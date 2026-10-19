/**
 * 票 25 的路径前缀分组（`group-paths`）：相邻同文件命中只写一次路径，行内保留 `行号:正文`。
 *
 * 断言的是行为：无损（三元组逐行还原）、幂等、单文件输出原样、净收益不足不动、放在封顶之后不产生没有
 * 组头的行。都走模块公开面（`condenseText` / `generalRules`），不碰内部实现。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CONDENSE_DEFAULTS, condenseText, generalRules, type CondenseParams } from '../src/condense.ts'

/** 默认参数下的一次精简判定。 */
const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

const CONTENT = 'const value = computeSomething(1)'
const A = 'packages/alpha/src/index.ts'
const B = 'packages/beta/src/index.ts'
const C = 'packages/gamma/src/index.ts'

/** 把一组 `[路径, 行号]` 拼成 grep 的原始输出（正文固定）。 */
const rows = (spec: ReadonlyArray<readonly [string, number]>, content = CONTENT): string =>
  spec.map(([path, line]) => `${path}:${line}:${content}`).join('\n')

/** 把分组输出还原成原始行（组头补回路径），用于逐行断言内容没少。 */
const expand = (text: string): string => {
  const out: string[] = []
  let path: string | null = null
  for (const line of text.split('\n')) {
    const row = /^(\d+)([:-])(.*)$/.exec(line)
    if (row !== null && path !== null) {
      out.push(`${path}${row[2] === '-' ? '-' : ':'}${row[1]}${row[2]}${row[3]}`)
      continue
    }
    path = line
  }
  return out.join('\n')
}

describe('票 25 · 路径前缀分组', () => {
  it('相邻同一文件的命中只写一次路径，判定为无损', () => {
    const text = rows([
      [A, 10], [A, 11], [A, 12], [A, 13], [A, 14],
      [B, 5], [B, 6], [B, 7], [B, 8],
    ])
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.lossy).toBe(false)
    expect(verdict.rules).toContain('group-paths')
    expect(verdict.text).toBe([
      A,
      `10:${CONTENT}`, `11:${CONTENT}`, `12:${CONTENT}`, `13:${CONTENT}`, `14:${CONTENT}`,
      '',
      B,
      `5:${CONTENT}`, `6:${CONTENT}`, `7:${CONTENT}`, `8:${CONTENT}`,
    ].join('\n'))
  })

  it('内容一行不少：路径、行号、正文三元组逐行还原一致', () => {
    const text = rows([
      [A, 1], [A, 2], [A, 3],
      [B, 7], [B, 8], [B, 9],
      [C, 9], [C, 10], [C, 11], [C, 12],
    ])
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(expand(verdict.text)).toBe(text)
  })

  it('单文件输出（行首没有路径）原样保留', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}:${CONTENT}`).join('\n')
    expect(condenseText('bash', text, at())).toEqual({ kind: 'unchanged' })
  })

  it('不相邻的同文件命中各自成组，单行组保持原样', () => {
    const text = rows([
      [A, 1], [A, 2],
      [B, 3],
      [A, 4], [A, 5], [A, 6],
      [B, 7], [B, 8],
    ])
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text).toBe([
      A,
      `1:${CONTENT}`, `2:${CONTENT}`,
      '',
      `${B}:3:${CONTENT}`,
      A,
      `4:${CONTENT}`, `5:${CONTENT}`, `6:${CONTENT}`,
      '',
      B,
      `7:${CONTENT}`, `8:${CONTENT}`,
    ].join('\n'))
  })

  it('真实的 `grep -A/-B` 上下文行（`path-行号-正文`）并入同一组、保留 `-`', () => {
    const text = [
      `${A}:1:${CONTENT}`,
      `${A}-2-${CONTENT}`,
      `${A}-3-${CONTENT}`,
      `${A}:4:${CONTENT}`,
      `${A}-5-${CONTENT}`,
      `${A}-6-${CONTENT}`,
      ...Array.from({ length: 8 }, (_, i) => `${A}:${10 + i}:${CONTENT}`),
      `${A}-20-${CONTENT}`,
      `${A}-21-${CONTENT}`,
    ].join('\n')
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text).toBe([
      A,
      `1:${CONTENT}`,
      `2-${CONTENT}`,
      `3-${CONTENT}`,
      `4:${CONTENT}`,
      `5-${CONTENT}`,
      `6-${CONTENT}`,
      ...Array.from({ length: 8 }, (_, i) => `${10 + i}:${CONTENT}`),
      `20-${CONTENT}`,
      `21-${CONTENT}`,
    ].join('\n'))
    expect(expand(verdict.text)).toBe(text)
  })

  it('上下文正文自带 `:数字:`（时间戳）时仍并入同一组', () => {
    // 真实 `grep -Hn -A1` 的形状：命中行与上下文行交替，上下文正文是带时分秒的日志。
    const STAMP = 'const started = "12:34:56"'
    const text = Array.from({ length: 10 }, (_, i) => [
      `${A}:${2 * i + 1}:${CONTENT}`,
      `${A}-${2 * i + 2}-${STAMP}`,
    ]).flat().join('\n')
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.text).toBe([
      A,
      ...Array.from({ length: 10 }, (_, i) => [`${2 * i + 1}:${CONTENT}`, `${2 * i + 2}-${STAMP}`]).flat(),
    ].join('\n'))
    expect(expand(verdict.text)).toBe(text)
    expect(condenseText('bash', verdict.text, at())).toEqual({ kind: 'unchanged' })
  })

  it('数字后缀的兄弟文件（`path-2:行号:正文`）不会被吞成组员', () => {
    // 上下文行只认 `-` 分隔：`A-2` 是另一个文件，它的第 7 行不能变成 `A` 的第 2 行（否则还原时 `-2:` 变 `:2:`）。
    const sibling = `${A}-2`
    const text = [
      ...Array.from({ length: 20 }, (_, i) => `${A}:${i + 1}:${CONTENT}`),
      `${sibling}:7:sibling content`,
    ].join('\n')
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    const lines = verdict.text.split('\n')
    expect(lines.slice(0, 21)).toEqual([A, ...Array.from({ length: 20 }, (_, i) => `${i + 1}:${CONTENT}`)])
    expect(lines.at(-1)).toBe(`${sibling}:7:sibling content`)
    expect(lines).not.toContain(`2:7:sibling content`)
    expect(condenseText('bash', verdict.text, at())).toEqual({ kind: 'unchanged' })
  })

  it('正文里孤立的「数字:」行不会让整条规则放弃', () => {
    const text = [
      ...Array.from({ length: 20 }, (_, i) => `${A}:${i + 1}:${CONTENT}`),
      'header',
      '2024: revenue',
    ].join('\n')
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.rules).toContain('group-paths')
    expect(verdict.text.startsWith(`${A}\n1:${CONTENT}\n`)).toBe(true)
    expect(verdict.text.endsWith('header\n2024: revenue')).toBe(true)
  })

  it('末尾换行计入行数上限：超限时不分组，第二遍不动', () => {
    const text = [
      ...Array.from({ length: 150 }, (_, i) => `${A}:${i + 1}:${CONTENT}`),
      ...Array.from({ length: 147 }, (_, i) => `${B}:${i + 1}:${CONTENT}`),
    ].join('\n') + '\n'
    const first = condenseText('bash', text, at())
    expect(first).toEqual({ kind: 'unchanged' })
  })

  it('省得太少时过不了净收益闸门，原样交回', () => {
    const lines = [
      `a.ts:1:${CONTENT}`,
      `a.ts:2:${CONTENT}`,
      ...Array.from({ length: 13 }, (_, i) => `note ${i} ${CONTENT}`),
    ]
    expect(condenseText('bash', lines.join('\n'), at())).toEqual({ kind: 'not-shorter', rules: ['group-paths'] })
  })

  it('幂等：分组后的正文再跑一次不动', () => {
    const text = rows([
      [A, 1], [A, 2], [A, 3],
      [B, 4], [B, 5], [B, 6],
      [C, 7], [C, 8], [C, 9],
    ])
    const first = condenseText('bash', text, at())
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(condenseText('bash', first.text, at())).toEqual({ kind: 'unchanged' })
  })

  it('分组排在封顶之后：保留下来的命中行都有组头', () => {
    const text = Array.from({ length: 350 }, (_, i) => `packages/big.ts:${i + 1}:${CONTENT}`).join('\n')
    const verdict = condenseText('bash', text, at())
    expect(verdict.kind).toBe('condensed')
    if (verdict.kind !== 'condensed') return
    expect(verdict.lossy).toBe(true)
    expect(verdict.rules).toEqual(['tail-cap', 'group-paths'])
    let header: string | null = null
    let headers = 0
    for (const line of verdict.text.split('\n')) {
      if (line === '') continue
      if (/^\d+:/.test(line)) {
        expect(header).not.toBeNull()
        continue
      }
      if (line.startsWith('…[')) {
        header = null
        continue
      }
      header = line
      headers++
    }
    expect(headers).toBe(2)
    expect(verdict.text.split('\n').length).toBeLessThanOrEqual(CONDENSE_DEFAULTS.maxLines)
    expect(condenseText('bash', verdict.text, at())).toEqual({ kind: 'unchanged' })
  })

  it('分组会把行数推过上限时不分组，整链保持幂等', () => {
    const text = [
      ...Array.from({ length: 150 }, (_, i) => `${A}:${i + 1}:${CONTENT}`),
      ...Array.from({ length: 149 }, (_, i) => `${B}:${i + 1}:${CONTENT}`),
    ].join('\n')
    expect(condenseText('bash', text, at())).toEqual({ kind: 'unchanged' })
  })

  it('分组结果在上限内时，第二遍不动', () => {
    const text = [
      ...Array.from({ length: 100 }, (_, i) => `${A}:${i + 1}:${CONTENT}`),
      ...Array.from({ length: 100 }, (_, i) => `${B}:${i + 1}:${CONTENT}`),
    ].join('\n')
    const first = condenseText('bash', text, at())
    expect(first.kind).toBe('condensed')
    if (first.kind !== 'condensed') return
    expect(first.text.split('\n').length).toBeLessThanOrEqual(CONDENSE_DEFAULTS.maxLines)
    expect(condenseText('bash', first.text, at())).toEqual({ kind: 'unchanged' })
  })

  it('规则表顺序：命中长行裁剪在封顶之前，封顶在前、分组在后；分组无损、无入口', () => {
    const rules = generalRules(at())
    expect(rules.map(rule => rule.id)).toEqual([
      'strip-ansi',
      'strip-cr',
      'dedup-adjacent',
      'grep-long-line',
      'tail-cap',
      'group-paths',
    ])
    expect(rules.find(rule => rule.id === 'group-paths')?.lossy).toBe(false)
  })
})
