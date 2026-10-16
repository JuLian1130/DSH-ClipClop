/**
 * 票 17 判据 4：把**发布实现**（分派 + `sedWindow` / `rawDump` 两族）在真实语料上的每次判定与替换导出成
 * JSONL，交给 `docs/dsh-condense-measure/verify_sed_dump.py` 按票 14 的 harness 口径对账门槛。
 *
 * **为什么不直接跑 harness**：`harness.py:183-184` 会自己拼一条回退说明（`fallback_notice`），而发布实现的口径
 * 是 `ENTRY_RESERVE = 256` 字符的**预留上界**；两者不是同一份东西，发布门槛必须用发布实现自己的数。所以走票 15 /
 * 16 已经走通的那条路——发布实现导出 JSONL，离线脚本按 harness 的口径重算。
 *
 * **语料在场就一定跑**（与票 15 的 `condense-corpus.spec.ts` 同一条规矩）：`DSH_CONDENSE_CORPUS` 优先，否则
 * `/tmp/dsh-condense`；那里没有语料才整文件跳过。导出路径默认 `/tmp/dsh-condense-ts/ts-dispatch-glance.jsonl`
 * （`DSH_CONDENSE_TS_GLANCE_DUMP` 可覆盖），与 `verify_sed_dump.py` 的 `--dump` 一致。
 *
 * **这份语料缺两列事实**：会话日志的 `tool/result` 不带 `value`（`packages/core/tools/src/index.ts:575` 明写
 * 「deliberately omitted from durable events」），所以 `exitCode` 与 `stdout.truncated` 都拿不到——两条守卫在
 * 离线读数里**恒不触发**，这份读数因此**等于原型口径、不等价于生产口径**（dump 里这两个字段恒为 null 是同一
 * 事实的镜像）。
 *
 * 除导出外，本文件还常驻**两条判据 4 的不变量断言**（本体是这两族的收窄形态，不是实现细节）：
 *
 * 1. 省略标记里的行数逐条等于 `输入行数 - headLines - tailLines`（`N` 按**整份输入**数出，不是按保留数）；
 * 2. 输出里除**四种已声明形态**之外没有别的行。四种逐行归类、逐类计数：
 *    ① 逐字原行（在输入行集合里）、② 省略标记、③ `rawDump` 的 `序号: 原行`（去前缀后逐字在输入里）、
 *    ④ 超长行截断——去掉尾部 `LINE_TRUNCATED` 后必须**恰好等于某条输入行的前 `LINE_CAP` 字符**，
 *    且那条输入行真的比 `LINE_CAP` 长（`LINE_CAP` / `LINE_TRUNCATED` 从 `../src/glance.ts` 取，
 *    不在本文件抄常数）。剩下的**无解释行**才报红。
 *    头尾段的行数不超过预算（`rawDump` 还要加上插入的命中行）。
 *
 * 期望值由本文件**自己**数（输入行集合、标记里那个数、超长行的前缀），不调用被测实现的计数。
 *
 * 复现（语料在的时候，常规 `pnpm test` 也会跑到这一条）：
 *
 *     DSH_CONDENSE_CORPUS=/tmp/dsh-condense PATH=/tmp/pm-shim:$PATH \
 *       pnpm vitest run tests/condense-corpus-glance.spec.ts
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import {
  CONDENSE_DEFAULTS,
  condenseText,
  estimateUnits,
  type CondenseVerdict,
} from '../src/condense.ts'
import { builtinRules, compileRules, condenseRuleOf, dispatchFacts, selectFamily } from '../src/dispatch.ts'
import { ENTRY_RESERVE } from '../src/entry.ts'
import { GIT_DIFF_DEFAULTS } from '../src/gitdiff.ts'
import {
  LINE_CAP,
  LINE_TRUNCATED,
  RAW_DUMP_DEFAULTS,
  SED_WINDOW_DEFAULTS,
} from '../src/glance.ts'

/** `extract_calls.py` 的 `--out` 默认值；语料在本机就该跑，不在本机就跳过。 */
const DEFAULT_CORPUS = '/tmp/dsh-condense'

/** 语料根：环境变量优先，其次本机默认路径；两处都没有时整个文件跳过。 */
const corpusRoot = process.env.DSH_CONDENSE_CORPUS
  ?? (existsSync(DEFAULT_CORPUS) ? DEFAULT_CORPUS : undefined)

/** 导出路径；默认与 `verify_sed_dump.py` 的 `--dump` 一致。 */
const dumpPath = process.env.DSH_CONDENSE_TS_GLANCE_DUMP ?? '/tmp/dsh-condense-ts/ts-dispatch-glance.jsonl'

/** 语料扫描的明确超时：764 MB 顺序扫描 + 逐行判定，本机实测几分钟以内。 */
const SCAN_TIMEOUT_MS = 1_800_000

/** `all` 分母就是这两个工具的快照行。 */
const SHELL_TOOLS = ['bash', 'pwsh']

/** 本票两族；`compactDiff` 的行照常进 dump，只是不在本文件的常驻不变量里。 */
const GLANCE_FAMILIES = ['sedWindow', 'rawDump'] as const
type GlanceFamily = (typeof GLANCE_FAMILIES)[number]

/** 省略标记里的行数；形态见设计文档（`…[中段省略 N 行]…`），只认「省略 N 行」这几个字。 */
const MARKER = /省略\s*(\d+)\s*行/

/** `rawDump` 的命中行：`序号: 原行`，序号从 1 数起。 */
const HIT_LINE = /^(\d+): ([\s\S]*)$/

/** 语料 JSONL 的一行：只声明本文件用到的字段，其余原样忽略。 */
interface CorpusRow {
  readonly callId?: unknown
  readonly name?: unknown
  readonly text?: unknown
  readonly command?: unknown
}

/** 一条族规则的收窄预算：常驻不变量用它们算期望值（取自 `glance.ts` 的默认参数）。 */
interface Budget {
  readonly headLines: number
  readonly tailLines: number
  /** `rawDump` 额外的「有意思的行」上限；`sedWindow` 为 0。 */
  readonly hits: number
}

/** 一次扫描的账本。 */
interface Tally {
  calls: number
  shellCalls: number
  emptyBodies: number
  belowFloor: number
  familyMiss: number
  familyHits: number
  verdicts: Record<string, number>
  /** 每族的判定分布（命中后的 outcome）。 */
  perFamily: Record<string, Record<string, number>>
  dumped: number
  /** 四种已声明形态的逐类计数（逐字原行 / 省略标记 / 转储命中行 / 超长行截断）。 */
  shapes: { verbatim: number; markers: number; hits: number; truncations: number }
  /** 不变量①：标记个数不是 1（缺失或出现多个）。 */
  markerCountViolations: string[]
  /** 不变量①：标记里的行数不等于 `输入行数 - headLines - tailLines`。 */
  markerNumberMismatches: string[]
  /** 不变量②：不属于四种已声明形态的**无解释行**。 */
  unexplainedLines: string[]
  /** 不变量②：头段或尾段超出预算。 */
  budgetViolations: string[]
  /** 诊断（不算违反）：`rawDump` 命中行的序号与输入里的位置对不上。 */
  hitIndexMismatches: number
}

/**
 * 正文的逻辑行：按 `\n` 切，丢掉末尾那一个空串（正文以换行结尾时不算多一行）。
 * @param text - 任意正文。
 * @returns 逻辑行数组。
 */
function logicalLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 核对一条族收窄后的正文是否守住两条常驻不变量。
 *
 * 判定方式与实现无关：逐行归进四种已声明形态之一（逐字原行 / 省略标记 / `rawDump` 的 `序号: 原行` /
 * 超长行截断），归不进去的就是**无解释行**。超长行截断这一类不能只计数——它要求该行去掉尾部
 * `LINE_TRUNCATED` 后恰好是某条**比 `LINE_CAP` 长**的输入行的前 `LINE_CAP` 字符。
 * @param family - 命中的族。
 * @param body - 输入正文。
 * @param out - 收窄后的正文。
 * @param budget - 该族的头尾预算与命中行上限。
 * @param label - 出错时写进清单的标识（callId + 文件）。
 * @param tally - 账本。
 */
function checkInvariants(
  family: GlanceFamily,
  body: string,
  out: string,
  budget: Budget,
  label: string,
  tally: Tally,
): void {
  const inputLines = logicalLines(body)
  const inputSet = new Set(inputLines)
  const outLines = logicalLines(out)
  let longPrefixes: Set<string> | undefined

  const markers: number[] = []
  let markerIndex = -1
  for (let index = 0; index < outLines.length; index++) {
    const line = outLines[index] as string
    // ① 逐字原行。
    if (inputSet.has(line)) {
      tally.shapes.verbatim++
      continue
    }
    // ② 省略标记。
    const marker = MARKER.exec(line)
    if (marker !== null) {
      tally.shapes.markers++
      markers.push(Number(marker[1]))
      if (markerIndex === -1) markerIndex = index
      continue
    }
    // ③ `rawDump` 的 `序号: 原行`；序号与输入位置对不上只作诊断（不算违反）。
    if (family === 'rawDump') {
      const hit = HIT_LINE.exec(line)
      if (hit !== null && inputSet.has(hit[2] as string)) {
        tally.shapes.hits++
        if (inputLines[Number(hit[1]) - 1] !== hit[2]) tally.hitIndexMismatches++
        continue
      }
    }
    // ④ 超长行截断：去掉尾部标记后恰好是某条长输入行的前 LINE_CAP 字符。
    if (line.endsWith(LINE_TRUNCATED)) {
      const prefix = line.slice(0, line.length - LINE_TRUNCATED.length)
      if (prefix.length === LINE_CAP) {
        longPrefixes ??= new Set(
          inputLines.filter(text => text.length > LINE_CAP).map(text => text.slice(0, LINE_CAP)),
        )
        if (longPrefixes.has(prefix)) {
          tally.shapes.truncations++
          continue
        }
      }
    }
    tally.unexplainedLines.push(`${label}: ${line.slice(0, 60)}`)
  }

  if (markers.length !== 1) {
    tally.markerCountViolations.push(`${label}: ${markers.length} 个标记`)
    return
  }
  const expected = inputLines.length - budget.headLines - budget.tailLines
  if (markers[0] !== expected) {
    tally.markerNumberMismatches.push(
      `${label}: 标记 ${markers[0]} vs 输入 ${inputLines.length} 行 - 头 ${budget.headLines} - 尾 ${budget.tailLines} = ${expected}`,
    )
  }

  const head = outLines.slice(0, markerIndex)
  const tail = outLines.slice(markerIndex + 1)
  const headBudget = budget.headLines + budget.hits
  if (head.length > headBudget || tail.length > budget.tailLines) {
    tally.budgetViolations.push(
      `${label}: 头 ${head.length}/${headBudget} 尾 ${tail.length}/${budget.tailLines}`,
    )
  }
}

/**
 * 流式读一个语料 JSONL 的每一行。
 * @param file - JSONL 路径。
 * @param onRow - 每行的回调。
 * @returns 读完后 resolve。
 */
async function eachRow(file: string, onRow: (row: CorpusRow) => void): Promise<void> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line === '') continue
    onRow(JSON.parse(line) as CorpusRow)
  }
}

/** 两族的常驻不变量预算（从发布默认参数读回，不写死常数）。 */
const BUDGETS: Record<GlanceFamily, Budget> = {
  sedWindow: {
    headLines: SED_WINDOW_DEFAULTS.headLines,
    tailLines: SED_WINDOW_DEFAULTS.tailLines,
    hits: 0,
  },
  rawDump: {
    headLines: RAW_DUMP_DEFAULTS.headLines,
    tailLines: RAW_DUMP_DEFAULTS.tailLines,
    hits: RAW_DUMP_DEFAULTS.hits,
  },
}

describe.skipIf(!corpusRoot)('票 17 判据 4：两族的语料门槛导出口与收窄形态不变量', () => {
  it(
    '导出两族的判定与替换清单，并断言两条收窄形态不变量',
    async () => {
      const root = corpusRoot as string
      const sessionsDir = join(root, 'sessions')
      const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl')).sort()
      // 规则表是**发布实现**那一张（三族）；命中即只跑那一族，族守卫放弃落通用链——与 `index.ts` 一字不差。
      const rules = compileRules(builtinRules({
        gitDiff: () => GIT_DIFF_DEFAULTS,
        sedWindow: () => SED_WINDOW_DEFAULTS,
        rawDump: () => RAW_DUMP_DEFAULTS,
      })).rules

      const tally: Tally = {
        calls: 0,
        shellCalls: 0,
        emptyBodies: 0,
        belowFloor: 0,
        familyMiss: 0,
        familyHits: 0,
        verdicts: {},
        perFamily: {},
        dumped: 0,
        shapes: { verbatim: 0, markers: 0, hits: 0, truncations: 0 },
        markerCountViolations: [],
        markerNumberMismatches: [],
        unexplainedLines: [],
        budgetViolations: [],
        hitIndexMismatches: 0,
      }

      mkdirSync(dirname(dumpPath), { recursive: true })
      const dump = createWriteStream(dumpPath, { flags: 'w' })
      const dumpLine = (line: string): void => {
        dump.write(`${line}\n`)
      }

      for (const file of files) {
        await eachRow(join(sessionsDir, file), (row) => {
          tally.calls++
          const name = typeof row.name === 'string' ? row.name : ''
          if (!SHELL_TOOLS.includes(name)) return
          tally.shellCalls++
          const body = typeof row.text === 'string' ? row.text : ''
          if (body === '') {
            tally.emptyBodies++
            return
          }
          const callId = typeof row.callId === 'string' ? row.callId : '(无 callId)'
          const command = typeof row.command === 'string' ? row.command : ''
          const beforeUnits = estimateUnits(body)

          // 事实 map 走**生产那一个** `dispatchFacts`（两边的尺子不会各自漂）：命令串取自调用参数；
          // `exitCode` 在语料里拿不到（durable 事件不带 `value`），因此**不进 map**；`truncated` 与生产
          // 同源：形状读不到就当没有（`false`）。
          const facts = dispatchFacts({ command, exitCode: undefined, truncated: false, body }, estimateUnits)

          let outcome: string
          let family: string | null = null
          let verdict: CondenseVerdict | undefined
          if (beforeUnits < CONDENSE_DEFAULTS.minUnits) {
            outcome = 'below-floor'
            tally.belowFloor++
          } else {
            const hit = selectFamily(name, facts, rules)
            if (hit === undefined) {
              outcome = 'family-miss'
              tally.familyMiss++
              verdict = condenseText(name, body, CONDENSE_DEFAULTS)
            } else {
              family = hit.family
              tally.familyHits++
              const familyVerdict = condenseText(name, body, CONDENSE_DEFAULTS, [condenseRuleOf(hit)])
              if (familyVerdict.kind === 'abstained') {
                outcome = 'abstained'
                verdict = undefined
              } else {
                outcome = familyVerdict.kind
                verdict = familyVerdict
              }
            }
            tally.verdicts[outcome] = (tally.verdicts[outcome] ?? 0) + 1
            if (family !== null) {
              const counts = tally.perFamily[family] ?? {}
              counts[outcome] = (counts[outcome] ?? 0) + 1
              tally.perFamily[family] = counts
            }
          }

          const replaced = verdict?.kind === 'condensed' ? verdict : undefined
          const afterUnits = replaced === undefined
            ? beforeUnits
            : estimateUnits(replaced.text + 'x'.repeat(replaced.lossy ? ENTRY_RESERVE : 0))

          // 常驻不变量：只对本票两族的收窄结果成立（`compactDiff` 的形态由票 16 的用例钉）。
          if (family !== null && replaced !== undefined && (GLANCE_FAMILIES as readonly string[]).includes(family)) {
            const label = `${callId} @ ${file}`
            checkInvariants(family as GlanceFamily, body, replaced.text, BUDGETS[family as GlanceFamily], label, tally)
          }

          dumpLine(JSON.stringify({
            callId,
            name,
            command,
            beforeUnits,
            outcome,
            family,
            afterUnits,
            entryChars: replaced?.lossy === true ? ENTRY_RESERVE : 0,
            sha256: replaced === undefined ? null : createHash('sha256').update(replaced.text, 'utf8').digest('hex'),
            chars: replaced === undefined ? 0 : replaced.text.length,
            // 语料没有这两列事实：恒 null 是「两条守卫在离线读数里不触发」的镜像。
            exitCode: null,
            truncated: null,
          }))
          tally.dumped++
        })
      }

      await new Promise<void>((resolve, reject) => {
        dump.on('error', reject)
        dump.end(resolve)
      })

      const violations = tally.markerCountViolations.length
        + tally.markerNumberMismatches.length
        + tally.unexplainedLines.length
        + tally.budgetViolations.length
      const lines: string[] = [
        '',
        `=== 票 17 语料扫描（${root}）===`,
        `JSONL 文件=${files.length}  调用=${tally.calls}  shell（${SHELL_TOOLS.join(' / ')}）调用=${tally.shellCalls}`
          + `  空正文=${tally.emptyBodies}`,
        `低于尺寸下限（${CONDENSE_DEFAULTS.minUnits} 估算单位）=${tally.belowFloor}`
          + `  族未命中=${tally.familyMiss}  族命中=${tally.familyHits}`,
        '判定计数：'
          + Object.entries(tally.verdicts).map(([kind, count]) => `${kind}=${count}`).join('  '),
        '每族判定分布：'
          + Object.entries(tally.perFamily).map(([id, counts]) =>
            `${id} {${Object.entries(counts).map(([kind, count]) => `${kind}=${count}`).join(' ')}}`).join('  '),
        `常驻不变量违反数=${violations}（标记缺失/重复 ${tally.markerCountViolations.length}`
          + `  标记行数不符 ${tally.markerNumberMismatches.length}`
          + `  无解释行 ${tally.unexplainedLines.length}`
          + `  头尾超预算 ${tally.budgetViolations.length}）`,
        `收窄形态逐类计数（收窄行合计 ${tally.shapes.verbatim + tally.shapes.markers + tally.shapes.hits + tally.shapes.truncations} 行）：`
          + `逐字原行=${tally.shapes.verbatim}  省略标记=${tally.shapes.markers}`
          + `  转储命中行=${tally.shapes.hits}  超长行截断=${tally.shapes.truncations}`,
        `诊断（不算违反）：rawDump 命中行的序号与输入位置对不上=${tally.hitIndexMismatches}`,
        `导出=${tally.dumped} 行 → ${dumpPath}`,
        '',
      ]
      console.log(lines.join('\n'))
      for (const detail of tally.markerCountViolations.slice(0, 5)) console.log(`  标记数：${detail}`)
      for (const detail of tally.markerNumberMismatches.slice(0, 5)) console.log(`  标记行数：${detail}`)
      for (const detail of tally.unexplainedLines.slice(0, 5)) console.log(`  无解释行：${detail}`)
      for (const detail of tally.budgetViolations.slice(0, 5)) console.log(`  超预算：${detail}`)

      expect(tally.markerCountViolations).toEqual([])
      expect(tally.markerNumberMismatches).toEqual([])
      expect(tally.unexplainedLines).toEqual([])
      expect(tally.budgetViolations).toEqual([])
      expect(tally.dumped).toBeGreaterThan(0)
    },
    SCAN_TIMEOUT_MS,
  )
})
