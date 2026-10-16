/**
 * 票 17 判据 2/3 的纯函数接缝：`sedWindowLines` 的窗口判定与两个 apply 的收窄形态。
 *
 * 期望值是按票 14 原型 `docs/dsh-condense-measure/transforms_sed_dump.py` 手算的字面量，不用实现自身推导；
 * 正文都是真实命令会产出的形态（`ls -la` 清单、`sed -n` 区间打印）。窗口判定的阴性面（替换文本里的范围、
 * `-i` 就地编辑、`2d`）是相对原型的有意修正，见 `src/glance.ts` 的模块注释。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  RAW_DUMP_DEFAULTS,
  SED_WINDOW_DEFAULTS,
  compactRawDump,
  compactSedWindow,
  sedWindowLines,
  type RawDumpParams,
  type SedWindowParams,
} from '../src/glance.ts'

/** 默认参数上改一两个值；「守卫边界」那些用例靠这里把 minLines 压到正文之下。 */
const sed = (over: Partial<SedWindowParams> = {}): SedWindowParams => ({ ...SED_WINDOW_DEFAULTS, ...over })
const dump = (over: Partial<RawDumpParams> = {}): RawDumpParams => ({ ...RAW_DUMP_DEFAULTS, ...over })

/**
 * n 行互不相同的正文，末尾不带换行（末尾换行那条用例自己加）。
 * @param n - 行数。
 * @param make - 第 index 行（0 起）的正文。
 * @returns 正文。
 */
function body(n: number, make: (index: number) => string = index => `line-${String(index).padStart(3, '0')}`): string {
  return Array.from({ length: n }, (_, index) => make(index)).join('\n')
}

describe('票 17 · 默认参数是票 14 实测的那一档', () => {
  it('两族的头尾预算、尺寸下限与「有意思的行」上限', () => {
    expect(SED_WINDOW_DEFAULTS).toEqual({ headLines: 20, tailLines: 20, minLines: 60 })
    expect(RAW_DUMP_DEFAULTS).toEqual({ headLines: 15, tailLines: 15, minLines: 60, hits: 20 })
  })
})

describe('sedWindowLines · 请求的窗口行数', () => {
  it('`-n` + `1,101p`：区间两端的闭区间行数', () => {
    expect(sedWindowLines("sed -n '1,101p' f")).toBe(101)
  })

  it('`--quiet` 与 `--silent` 与 `-n` 等价', () => {
    expect(sedWindowLines("sed --quiet '20,120p' f")).toBe(101)
    expect(sedWindowLines("sed --silent '1,200p' f")).toBe(200)
  })

  it('`-e` 后面那个操作数是脚本，不是文件名', () => {
    expect(sedWindowLines("sed -n -e '1,101p' f")).toBe(101)
    expect(sedWindowLines("sed --quiet -e '5,200p' f")).toBe(196)
  })

  it('多段求和：`;` 分开的两段窗口行数相加', () => {
    expect(sedWindowLines("sed -n '1,50p;60,120p' f")).toBe(111)
  })

  it('引号里的空格不切碎脚本：`1, 101p` 照数 101 行', () => {
    expect(sedWindowLines("sed -n '1, 101p' f")).toBe(101)
  })

  it('`$` 是无限大（整文件窗口），不按数字算', () => {
    expect(sedWindowLines("sed -n '1,$p' f")).toBeGreaterThanOrEqual(101)
  })

  it('没有 `-n` / `--quiet` / `--silent` 就不是窗口打印', () => {
    expect(sedWindowLines("sed '1,101p' f")).toBeUndefined()
    expect(sedWindowLines("sed -i '1,101p' f")).toBeUndefined()
  })

  it('删除命令（`2d`）不是窗口打印', () => {
    expect(sedWindowLines("sed -n '2d' f")).toBeUndefined()
  })

  it('范围只出现在替换文本里不算：`s/x/1,200p/p` 不是 200 行窗口', () => {
    expect(sedWindowLines("sed -n 's/x/1,200p/p' f")).toBeUndefined()
  })

  it('非 sed 命令即使带 `-n` 与范围也不是', () => {
    expect(sedWindowLines("grep -n '1,101p' f")).toBeUndefined()
    expect(sedWindowLines("awk 'NR==1,101p' f")).toBeUndefined()
  })
})

describe('compactSedWindow · 形态', () => {
  it('头 20 行 + 省略标记 + 尾 20 行；标记里的 N 按整份输入数（101 - 40 = 61）', () => {
    const lines = body(101).split('\n')
    expect(compactSedWindow(body(101), SED_WINDOW_DEFAULTS)).toBe([
      ...lines.slice(0, 20),
      '…[中段省略 61 行]…',
      ...lines.slice(-20),
    ].join('\n'))
  })

  it('超长单行截到 2000 字符、标记接在它之后（原型同此，不占 2000 的额度）', () => {
    const out = compactSedWindow(body(101, index => index === 0 ? 'x'.repeat(2500) : `line-${index}`), SED_WINDOW_DEFAULTS)
    expect(out?.split('\n')[0]).toBe(`${'x'.repeat(2000)}…[行已截断]`)
    expect(out?.split('\n')[0]?.length).toBe(2007)
  })

  it('末尾换行照原样保留：带换行的那次只多一个换行，其余逐字相同', () => {
    const plain = compactSedWindow(body(101), SED_WINDOW_DEFAULTS)
    const withNewline = compactSedWindow(`${body(101)}\n`, SED_WINDOW_DEFAULTS)
    expect(withNewline?.endsWith('\n')).toBe(true)
    expect(withNewline?.slice(0, -1)).toBe(plain)
    expect(plain?.endsWith('\n')).toBe(false)
  })

  it('正文不足尺寸下限（< 60 行）时守卫放弃', () => {
    expect(compactSedWindow(body(59), SED_WINDOW_DEFAULTS)).toBeUndefined()
  })

  it('头尾预算装得下整份正文（head + tail >= 行数）时没有可省略的中段，守卫放弃', () => {
    expect(compactSedWindow(body(40), sed({ minLines: 10 }))).toBeUndefined()
    expect(compactSedWindow(body(41), sed({ minLines: 10 }))).toBeDefined()
  })

  it('尺寸下限恰好相等时不算不足：60 行仍收窄', () => {
    expect(compactSedWindow(body(60), SED_WINDOW_DEFAULTS)).toBeDefined()
  })
})

describe('compactRawDump · 形态', () => {
  /** 一份 100 行的清单：头段（0–14）与尾段（85–99）里各放一条命中行，证明它们不参与挑选。 */
  const DUMP_LINES = Array.from({ length: 100 }, (_, index) => `entry-${String(index).padStart(3, '0')}`)
  DUMP_LINES[14] = 'error: in head'
  DUMP_LINES[24] = 'error: boom'
  DUMP_LINES[25] = 'error: boom'
  DUMP_LINES[39] = 'Warning: disk 90%'
  DUMP_LINES[90] = 'error: in tail'
  const DUMP_BODY = DUMP_LINES.join('\n')

  it('头 15 行 + 有意思的行 + 省略标记 + 尾 15 行；序号从 1 数起、按内容去重、只从头尾之外挑', () => {
    expect(compactRawDump(DUMP_BODY, RAW_DUMP_DEFAULTS)).toBe([
      ...DUMP_LINES.slice(0, 15),
      '25: error: boom',
      '40: Warning: disk 90%',
      '…[中段省略 70 行]…',
      ...DUMP_LINES.slice(-15),
    ].join('\n'))
  })

  it('`hits` 是「有意思的行」的上限：超出的命中直接不插，不是换成注记', () => {
    const out = compactRawDump(DUMP_BODY, dump({ hits: 1 }))!
    expect(out.split('\n')[15]).toBe('25: error: boom')
    expect(out.split('\n')[16]).toBe('…[中段省略 70 行]…')
    expect(out).not.toContain('40: Warning')
  })

  it('`hits: 0` 表示一条都不插：标记紧接头段', () => {
    const out = compactRawDump(DUMP_BODY, dump({ hits: 0 }))!
    expect(out.split('\n')[15]).toBe('…[中段省略 70 行]…')
  })

  it('没有任何有意思的行时与 sed 族同形（头 + 标记 + 尾）', () => {
    const plain = body(120)
    expect(compactRawDump(plain, RAW_DUMP_DEFAULTS)).toBe([
      ...plain.split('\n').slice(0, 15),
      '…[中段省略 90 行]…',
      ...plain.split('\n').slice(-15),
    ].join('\n'))
  })

  it('正文不足尺寸下限（< 60 行）时守卫放弃', () => {
    expect(compactRawDump(body(59), RAW_DUMP_DEFAULTS)).toBeUndefined()
  })

  it('头尾预算装得下整份正文时守卫放弃', () => {
    expect(compactRawDump(body(30), dump({ minLines: 10 }))).toBeUndefined()
    expect(compactRawDump(body(31), dump({ minLines: 10 }))).toBeDefined()
  })
})
