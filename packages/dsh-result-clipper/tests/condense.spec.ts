/**
 * 票 15 的精简核心：`condenseText` 的取舍判定与通用形状变换链。
 *
 * 这些用例只走模块的公开面（`condenseText` / `generalRules` / `isCondenseTool` / `composeEntry`），断言的是
 * 「这份正文进去、那份正文出来」以及判定的取值，不碰内部实现。每一条判据都配了阴性或阳性对照：
 * 只做其中一项的实现、以原始投影为基准的实现、把入口开销漏掉的实现都会在这些对照上变红。
 *
 * 估算单位为 token-meter 的固定密度 `ceil(字符数/4) + 4`（一张文本块），用例里用同一个式子独立算出来，
 * 不引用实现内部的换算。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  CONDENSE_DEFAULTS,
  CONDENSE_TOOLS,
  condenseText,
  generalRules,
  isCondenseTool,
  type CondenseParams,
  type CondenseRule,
} from '../src/condense.ts'
import { composeEntry } from '../src/entry.ts'

/** 默认参数下的一次精简判定。 */
const at = (over: Partial<CondenseParams> = {}): CondenseParams => ({ ...CONDENSE_DEFAULTS, ...over })

/** 估算单位：`ceil(字符数/4) + 4`，与 token-meter 的文本块密度同式（独立算出来，不用实现里的换算）。 */
const units = (text: string): number => Math.ceil(text.length / 4) + 4

/** 造 n 行互不相同、每行约 `width` 字符的正文。 */
const block = (n: number, width = 8): string =>
  Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, 'y')).join('\n')

const ANSI_OPEN = '\u001b[31m'
const ANSI_CLOSE = '\u001b[0m'

/** 造 n 行每行都带一对 ANSI 序列、且互不相同的正文。 */
const ansiBlock = (n: number, width = 30): string =>
  Array.from({ length: n }, (_, i) => `${ANSI_OPEN}${`${i}`.padEnd(width, 'y')}${ANSI_CLOSE}`).join('\n')

describe('票 15 · 精简范围', () => {
  it('范围内的工具是两个 shell 与 native grep', () => {
    expect([...CONDENSE_TOOLS]).toEqual(['bash', 'grep', 'pwsh'])
    expect(isCondenseTool('bash')).toBe(true)
    expect(isCondenseTool('pwsh')).toBe(true)
    expect(isCondenseTool('grep')).toBe(true)
  })

  it.each(['read', 'web_fetch', 'glob', 'edit'])('%s 不在精简范围内，正文逐字未判', (toolName) => {
    expect(isCondenseTool(toolName)).toBe(false)
    expect(condenseText(toolName, ansiBlock(60), at())).toEqual({ kind: 'unchanged' })
  })

  it('空正文与只有空白的结果不动', () => {
    expect(condenseText('bash', '', at())).toEqual({ kind: 'unchanged' })
  })
})

describe('票 15 · 通用形状变换（按内容判定，链式施加）', () => {
  it('剥掉 CSI / OSC / 两字符转义，正文其余部分逐字保留', () => {
    const body = `${ansiBlock(20, 30)}\n\u001b]0;title\u0007\u001b(Beaten`
    const out = condenseText('bash', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.text).not.toContain('\u001b')
    expect(out.text).toContain('\neaten')
    expect(out.text.split('\n').slice(0, 20)).toEqual(ansiBlock(20, 30).split('\n').map(line => line.slice(5, -4)))
  })

  it('去掉 `\\r` 覆盖行：每行只保留最后一个 `\\r` 之后的内容', () => {
    const progress = Array.from(
      { length: 20 },
      (_, i) => `row ${i} ${'x'.repeat(20)}\rrow ${i} ${'y'.repeat(30)}`,
    ).join('\n')
    const body = `${block(20, 40)}\n${progress}`
    const out = condenseText('bash', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.text).not.toContain('\r')
    expect(out.text.endsWith(`\nrow 19 ${'y'.repeat(30)}`)).toBe(true)
  })

  it('相邻游程去重：>=3 行相同才压成一行 + `[xN]`，仅相邻、空行游程豁免', () => {
    const body = `${block(20, 40)}\n${Array.from({ length: 20 }, () => 's'.repeat(30)).join('\n')}\nother\n\n\n\n`
    const out = condenseText('bash', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.text).toContain(`\n${'s'.repeat(30)}\n[x20]\nother`)
    // 空行游程豁免：三条空行原样留着，没有被压成 `[xN]`
    expect(out.text.endsWith('other\n\n\n\n')).toBe(true)
  })

  it('两行相同不构成游程（MIN_RUN = 3）', () => {
    const body = `${block(20, 40)}\nsame\nsame`
    expect(condenseText('bash', body, at())).toEqual({ kind: 'unchanged' })
  })

  it('剥掉格式控制序列之后仍会做相邻游程折叠（阴性对照：只做其中一项的实现会漏掉）', () => {
    const colored = `${ANSI_OPEN}${'z'.repeat(30)}${ANSI_CLOSE}`
    const body = `${block(20, 40)}\n${Array.from({ length: 12 }, () => colored).join('\n')}`
    const out = condenseText('bash', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    // 十二行剥完是同一行 → 折叠成一行 + `[x12]`
    expect(out.text.endsWith(`\n${'z'.repeat(30)}\n[x12]`)).toBe(true)
    expect(out.rules).toEqual(expect.arrayContaining(['strip-ansi', 'dedup-adjacent']))
  })
})

describe('票 15 · 尾部偏置封顶的触发读法', () => {
  it('>300 行触发，裁后保留头 50 + 尾 200，丢掉的行数写在正文里', () => {
    const body = block(301)
    const out = condenseText('bash', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(true)
    expect(out.rules).toContain('tail-cap')
    const outLines = out.text.split('\n')
    expect(outLines.slice(0, 50)).toEqual(body.split('\n').slice(0, 50))
    expect(outLines[50]).toBe('…[省略 51 行]')
    expect(outLines.slice(51)).toEqual(body.split('\n').slice(-200))
  })

  it('恰好 300 行不触发（300 是触发阈值，不是保留量）', () => {
    expect(condenseText('bash', block(300), at())).toEqual({ kind: 'unchanged' })
  })

  it('超过 2000 字符的单行被截断，标记算进 2000 字符预算', () => {
    const out = condenseText('bash', 'a'.repeat(2500), at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(true)
    expect(out.text).toHaveLength(2000)
    expect(out.text.endsWith('…[单行截断 +500]')).toBe(true)
  })

  it('封顶参数按传入值生效（配置里改值就改行为）', () => {
    const body = block(11, 60)
    const out = condenseText('bash', body, at({ maxLines: 10, headLines: 2, tailLines: 3 }))
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.text).toBe(
      [...body.split('\n').slice(0, 2), '…[省略 6 行]', ...body.split('\n').slice(-3)].join('\n'),
    )
  })
})

describe('票 15 · 尺寸下限与净收益闸门', () => {
  it('低于尺寸下限（128 估算单位）的调用一个都不触发，也不写回退入口', () => {
    const short = ansiBlock(4, 30)
    expect(units(short)).toBeLessThan(128)
    expect(condenseText('bash', short, at())).toEqual({ kind: 'unchanged' })
  })

  it('同一份正文长过下限就触发（阳性对照）', () => {
    const long = ansiBlock(20, 30)
    expect(units(long)).toBeGreaterThanOrEqual(128)
    const out = condenseText('bash', long, at())
    expect(out.kind).toBe('condensed')
  })

  it('省不到净收益阈值（24 估算单位）就交回下游正文', () => {
    // 整份正文里只剥掉一个 ANSI 序列：省 9 字符 ≈ 3 单位 < 24
    const body = `${block(20, 40)}\n${ANSI_OPEN}only one${ANSI_CLOSE}`
    expect(units(body)).toBeGreaterThanOrEqual(128)
    expect(condenseText('bash', body, at())).toEqual({ kind: 'not-shorter', rules: ['strip-ansi'] })
  })

  it('变换一处都没改动时不算触发，也不报没变短', () => {
    expect(condenseText('bash', block(20, 40), at())).toEqual({ kind: 'unchanged' })
  })

  it('比较基准是下游正文：同一份原文在「未被 spill 压过」与「已被压过」两种状态下取舍不同', () => {
    const original = block(4000, 40)
    const lines = original.split('\n')
    // spill 压过之后的下游正文：头尾各留一段，中间夹一个三行的相邻游程（去重只省几单位）。
    const downstream = [...lines.slice(0, 20), 'REPEAT', 'REPEAT', 'REPEAT', ...lines.slice(-20)].join('\n')

    // 未被压过：封顶收益巨大 → 替换。
    expect(condenseText('bash', original, at()).kind).toBe('condensed')
    // 已被压过：以**下游正文**为基准就省不到阈值 → 交回下游正文。
    expect(condenseText('bash', downstream, at())).toEqual({ kind: 'not-shorter', rules: ['dedup-adjacent'] })
    // 阴性对照的量化：拿**原始投影**当基准的实现会在这里看见一千多单位的「省幅」，于是错误地替换这份已经压过的正文。
    expect(units(original) - units(downstream)).toBeGreaterThan(1000)
  })

  it('「不严格更短就交回」不由配置决定：把净收益阈值配成 0 也换不掉等长的正文', () => {
    // 一整份正文里只去掉一个 `\\r`：省 1 个字符，估算单位**没变**（499 与 500 字符同价）。
    const body = `\r${block(20, 25)}`
    expect(units(body)).toBe(units(body.replace('\r', '')))
    expect(condenseText('bash', body, at())).toEqual({ kind: 'not-shorter', rules: ['strip-cr'] })
    expect(condenseText('bash', body, at({ minNetGainUnits: 0 })))
      .toEqual({ kind: 'not-shorter', rules: ['strip-cr'] })
  })

  it('有损替换把回退入口的开销算进被比较的那一侧', () => {
    const body = block(301)
    // 下限为零时封顶的收益远超过阈值；把入口预留抬到 4096 字符（1024 单位）后同一份正文就不该再被替换。
    expect(condenseText('bash', body, at({ minUnits: 0 })).kind).toBe('condensed')
    expect(condenseText('bash', body, at({ minUnits: 0, entryReserveChars: 4096 })))
      .toEqual({ kind: 'not-shorter', rules: ['tail-cap'] })
  })
})

describe('票 20 · 上游入口与尾部标记', () => {
  const notice = '\n\n(Full grep result stored at: /tmp/grep-results.txt. Use read with offset/limit to inspect.)'

  it('下游正文已带位置说明时继续精简，并原样保留上游入口', () => {
    const body = `${block(301)}${notice}`
    const out = condenseText('grep', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(true)
    expect(out.entry).toBe('upstream')
    expect(out.text.endsWith(notice)).toBe(true)
    // 上游那一条已经指向完整结果：不再追加本层入口。
    expect(out.text).not.toContain('精简版')
  })

  it('同一份正文没有位置说明时照常精简（阳性对照）', () => {
    const out = condenseText('grep', block(301), at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(true)
    expect(out.entry).toBe('own')
  })

  it('上游入口已经存在时不把本层入口的预留算进闸门', () => {
    const body = `${block(301)}${notice}`
    // 把本层入口预留抬到 1024 单位（4096 字符）：没有上游入口时过不了闸门；上游入口不算这条预留。
    expect(condenseText('grep', body, at({ minUnits: 0, entryReserveChars: 4096 })).kind).toBe('condensed')
    expect(condenseText('grep', block(301), at({ minUnits: 0, entryReserveChars: 4096 })))
      .toEqual({ kind: 'not-shorter', rules: ['tail-cap'] })
  })

  it('不触发封顶时上游说明不影响无损变换（没有丢内容，也就不需要入口）', () => {
    const body = `${ansiBlock(20, 30)}${notice}`
    const out = condenseText('grep', body, at())
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(out.lossy).toBe(false)
    expect(out.entry).toBeUndefined()
    expect(out.text.endsWith(notice)).toBe(true)
  })

  it('带路径的截断说明视为上游入口；`(unavailable)` 不算', () => {
    const withPath = `${block(301)}\n[output truncated; full output: /tmp/full.txt]`
    const kept = condenseText('bash', withPath, at())
    expect(kept.kind).toBe('condensed')
    if (kept.kind !== 'condensed') return
    expect(kept.entry).toBe('upstream')
    expect(kept.text.endsWith('[output truncated; full output: /tmp/full.txt]')).toBe(true)

    const unavailable = `${block(301)}\n[output truncated; full output: (unavailable)]`
    const own = condenseText('bash', unavailable, at())
    expect(own.kind).toBe('condensed')
    if (own.kind !== 'condensed') return
    expect(own.entry).toBe('own')
  })

  it('compactDiff 先剥下退出标记、替换后原样回贴', () => {
    const seen: string[] = []
    const rule: CondenseRule = {
      id: 'compactDiff',
      lossy: true,
      apply: (text: string): string => {
        seen.push(text)
        return `${text.split('\n').slice(0, 50).join('\n')}\n…[族收窄]`
      },
    }
    const body = `${block(301)}\n[exit code: 1]`
    const out = condenseText('bash', body, at(), [rule])
    expect(out.kind).toBe('condensed')
    if (out.kind !== 'condensed') return
    expect(seen[0]).not.toContain('[exit code: 1]')
    expect(out.text.endsWith('[exit code: 1]')).toBe(true)
    expect(out.entry).toBe('own')
  })

  it('规则抛异常时整体放弃、交回下游正文（不与「没变短」混同）', () => {
    const throwing: CondenseRule = {
      id: 'strip-ansi',
      lossy: false,
      apply: (): string => { throw new Error('boom') },
    }
    expect(condenseText('bash', ansiBlock(20, 30), at(), [throwing])).toEqual({ kind: 'abstained' })
  })

  it('按内容判定：同一份正文在 bash 与 pwsh 上得到同一结果', () => {
    const body = `${ansiBlock(20, 30)}\nsame\nsame\nsame`
    expect(condenseText('pwsh', body, at())).toEqual(condenseText('bash', body, at()))
  })

  it('无损规则幂等：同一输入跑两遍 == 跑一遍', () => {
    const fixtures = [
      ansiBlock(20, 30),
      `${block(20, 40)}\nprogress 10%\rprogress 100%`,
      `${block(20, 40)}\nsame\nsame\nsame\nother`,
      `${ansiBlock(4, 4)}\n\n\n\n${block(20, 40)}`,
      'a'.repeat(2500),
    ]
    for (const rule of generalRules(at())) {
      for (const fixture of fixtures) {
        const once = rule.apply(fixture)
        // 这些固定用例都不该让守卫放弃；先钉住这一点，再断言跑两遍等于跑一遍。
        if (once === undefined) throw new Error(`${rule.id} 在这条固定用例上放弃了守卫`)
        expect(`${rule.id}:${rule.apply(once)}`).toBe(`${rule.id}:${once}`)
      }
    }
  })
})

describe('票 15 · 回退入口说明', () => {
  it('精简版入口说明用「精简」措辞，并带上 locator 与取回方法', () => {
    const entry = composeEntry({ locator: '/tmp/original.txt', retrievalHint: 'Use read with offset/limit.' }, 'bash', 'condense')
    expect(entry).toContain('/tmp/original.txt')
    expect(entry).toContain('Use read with offset/limit.')
    expect(entry).toContain('精简')
    expect(entry).not.toContain('摘要')
    expect(entry.length).toBeLessThanOrEqual(CONDENSE_DEFAULTS.entryReserveChars)
  })

  it('摘要那条路的说明文字逐字未变', () => {
    expect(composeEntry({ locator: '/tmp/original.txt', retrievalHint: 'Use read.' }, 'bash'))
      .toBe('\n\n（以上为本次 bash 结果的摘要，够用就不必再读；需要逐字核对时原文在此：/tmp/original.txt。Use read.）')
  })
})
