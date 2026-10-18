/**
 * 票 15 判据 6：无损变换幂等——在**真实语料**上逐调用断言，并顺带导出供原型比对的数据。
 *
 * **语料在场就一定跑。** 语料根取 `DSH_CONDENSE_CORPUS`，没设时落到 `extract_calls.py` 自己的 `--out` 默认值
 * `/tmp/dsh-condense`；那里没有语料才整文件 `describe.skipIf` 跳过（语料是票 14 的一次性快照，`/tmp` 下可能消失，
 * 机器上没有它时跳过、不失败）。**只在显式设环境变量时才跑是不够的**：判据 6 要的是「真实语料上逐条断言的
 * **常驻**断言」，而那样写等于常规门禁里从不运行它。格式沿用 `docs/dsh-condense-measure/extract_calls.py` 的输出：
 * `$CORPUS/sessions/<dirkey>.jsonl`，每行一个调用，字段至少含 `callId` / `name` / `text`。
 *
 * 一次流式扫描同时做三件事：
 *
 * 1. **常驻断言**：五条规则各自 `f(f(x)) == f(x)`、整链 `chain(chain(x)) == chain(x)`，违反数必须为 0，
 *    违反时打 `callId`（判据 6；票 14 已在 177,546 次调用上手工测过，本文件把它变成可一键重跑的断言）。
 * 2. **计数**：调用数 / 有正文数 / 低于尺寸下限数 / 每条规则改动过的调用数 / `condenseText` 四个判定
 *    （`condensed` / `unchanged` / `abstained` / `not-shorter`）的计数。
 * 3. **导出**：每个「会被本层替换」（`kind === 'condensed'`）的调用写成一行 JSONL，字段为 `callId` /
 *    `name` / 估算单位前后值 / 判定 / `lossy` / 命中规则 / 精简后正文的 `sha256` 与 `chars`。
 *    **不导出正文**：比对脚本（`docs/dsh-condense-measure/condense_ts_verify.py`）从语料重跑原型，
 *    用 sha256 逐条钉死等价性，不必把 769 MB 语料再抄一份。路径由 `DSH_CONDENSE_TS_DUMP` 指定，
 *    默认 `/tmp/dsh-condense-ts/ts-condense.jsonl`，每次运行先清空再流式追加。
 *
 * 估算单位用 token-meter 的固定密度 `ceil(字符数/4) + 4`，与 `tests/condense.spec.ts` 一样独立算出来。
 * 有损替换的「闸门口径」把回退入口预留（`CONDENSE_DEFAULTS.entryReserveChars`）算进后一侧，所以
 * `afterUnits` 对 `lossy` 的调用包含预留——这是判定真正用的那个数。
 *
 * 复现（语料在的时候，常规 `pnpm test` 也会跑到这一条）：
 *
 *     DSH_CONDENSE_CORPUS=/tmp/dsh-condense PATH=/tmp/pm-shim:$PATH \
 *       pnpm vitest run tests/condense-corpus.spec.ts
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
  CONDENSE_TOOLS,
  condenseText,
  generalRules,
  isCondenseTool,
  type GeneralRuleId,
  type CondenseVerdict,
} from '../src/condense.ts'

/** `extract_calls.py` 的 `--out` 默认值；语料在本机就该跑，不在本机就跳过。 */
const DEFAULT_CORPUS = '/tmp/dsh-condense'

/** 语料根：环境变量优先，其次本机默认路径；两处都没有时整个文件跳过。 */
const corpusRoot = process.env.DSH_CONDENSE_CORPUS
  ?? (existsSync(DEFAULT_CORPUS) ? DEFAULT_CORPUS : undefined)

/** 导出路径；默认与文档里给 `condense_ts_verify.py` 的 `--dump` 一致。 */
const dumpPath = process.env.DSH_CONDENSE_TS_DUMP ?? '/tmp/dsh-condense-ts/ts-condense.jsonl'

/** 语料扫描的明确超时：769 MB 的顺序扫描，实测约 6 秒。 */
const SCAN_TIMEOUT_MS = 1_800_000

/** 语料 JSONL 的一行：只声明本文件用到的三个字段，其余原样忽略。 */
interface CorpusRow {
  readonly callId?: unknown
  readonly name?: unknown
  readonly text?: unknown
}

/** 估算单位：`ceil(字符数/4) + 4`（token-meter 的一张文本块密度，独立算出来，不用实现内部的换算）。 */
function units(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** 一次扫描的账本。 */
interface ScanTally {
  calls: number
  withText: number
  targetCalls: number
  targetWithText: number
  belowFloor: number
  changed: Record<GeneralRuleId, number>
  abstainedPerRule: Partial<Record<GeneralRuleId, number>>
  chainChanged: number
  chainAbstained: number
  verdicts: Record<CondenseVerdict['kind'], number>
  violations: string[]
}

/** 判定取值的全表，用于初始化计数（新增取值时这里会因类型不完整而编译失败，不会静默漏计）。 */
const VERDICT_KINDS: readonly CondenseVerdict['kind'][] = ['condensed', 'unchanged', 'abstained', 'not-shorter']

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

describe.skipIf(!corpusRoot)('票 15 判据 6：真实语料上的幂等与判定计数', () => {
  it(
    '五条规则与整链逐调用幂等，并导出「会被替换」的调用清单',
    async () => {
      const root = corpusRoot as string
      const sessionsDir = join(root, 'sessions')
      const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl')).sort()
      const rules = generalRules(CONDENSE_DEFAULTS)

      const tally: ScanTally = {
        calls: 0,
        withText: 0,
        targetCalls: 0,
        targetWithText: 0,
        belowFloor: 0,
        changed: { 'strip-ansi': 0, 'strip-cr': 0, 'dedup-adjacent': 0, 'tail-cap': 0, 'group-paths': 0 },
        abstainedPerRule: {},
        chainChanged: 0,
        chainAbstained: 0,
        verdicts: { condensed: 0, unchanged: 0, abstained: 0, 'not-shorter': 0 },
        violations: [],
      }

      mkdirSync(dirname(dumpPath), { recursive: true })
      const dump = createWriteStream(dumpPath, { flags: 'w' })
      const dumpLine = (line: string): void => {
        dump.write(`${line}\n`)
      }

      for (const file of files) {
        await eachRow(join(sessionsDir, file), (row) => {
          tally.calls++
          const text = typeof row.text === 'string' ? row.text : ''
          if (text !== '') tally.withText++
          const name = typeof row.name === 'string' ? row.name : ''
          if (!isCondenseTool(name)) return
          tally.targetCalls++
          if (text === '') return
          tally.targetWithText++
          const callId = typeof row.callId === 'string' ? row.callId : '(无 callId)'

          // 判据 6：单条规则 f(f(x)) == f(x)。守卫放弃（undefined）不算违反，单独计数。
          for (const rule of rules) {
            const once = rule.apply(text)
            if (once === undefined) {
              tally.abstainedPerRule[rule.id] = (tally.abstainedPerRule[rule.id] ?? 0) + 1
              continue
            }
            if (once !== text) tally.changed[rule.id]++
            const twice = rule.apply(once)
            if (twice !== once) {
              tally.violations.push(`${rule.id} @ ${callId} @ ${file}`)
            }
          }

          // 判据 6：整链 chain(chain(x)) == chain(x)。链上任一步放弃即整层放弃，不再复核。
          let chained: string | undefined = text
          for (const rule of rules) {
            const next = rule.apply(chained)
            if (next === undefined) {
              chained = undefined
              break
            }
            chained = next
          }
          if (chained === undefined) {
            tally.chainAbstained++
          } else {
            if (chained !== text) tally.chainChanged++
            let again: string | undefined = chained
            for (const rule of rules) {
              const next = rule.apply(again)
              if (next === undefined) {
                again = undefined
                break
              }
              again = next
            }
            if (again !== chained) {
              tally.violations.push(`chain @ ${callId} @ ${file}`)
            }
          }

          const bodyUnits = units(text)
          if (bodyUnits < CONDENSE_DEFAULTS.minUnits) tally.belowFloor++

          const verdict = condenseText(name, text, CONDENSE_DEFAULTS)
          tally.verdicts[verdict.kind]++
          if (verdict.kind !== 'condensed') return
          const after = verdict.lossy && verdict.entry !== 'upstream'
            ? units(verdict.text + 'x'.repeat(CONDENSE_DEFAULTS.entryReserveChars))
            : units(verdict.text)
          dumpLine(JSON.stringify({
            callId,
            name,
            beforeUnits: bodyUnits,
            afterUnits: after,
            lossy: verdict.lossy,
            rules: verdict.rules,
            sha256: createHash('sha256').update(verdict.text, 'utf8').digest('hex'),
            chars: verdict.text.length,
          }))
        })
      }

      await new Promise<void>((resolve, reject) => {
        dump.on('error', reject)
        dump.end(resolve)
      })

      const lines: string[] = [
        '',
        `=== 语料扫描（${root}）===`,
        `JSONL 文件=${files.length}  调用=${tally.calls}  有正文=${tally.withText}`,
        `目标工具（${CONDENSE_TOOLS.join(' / ')}）调用=${tally.targetCalls}  其中有正文=${tally.targetWithText}`
          + `  低于尺寸下限（${CONDENSE_DEFAULTS.minUnits} 估算单位）=${tally.belowFloor}`,
        '每条规则改动过的调用数：'
          + rules.map(rule => `${rule.id}=${tally.changed[rule.id]}`).join('  '),
        '每条规则守卫放弃数：'
          + rules.map(rule => `${rule.id}=${tally.abstainedPerRule[rule.id] ?? 0}`).join('  '),
        `整链改动过的调用数=${tally.chainChanged}  整链守卫放弃=${tally.chainAbstained}`,
        'condenseText 判定计数：'
          + VERDICT_KINDS.map(kind => `${kind}=${tally.verdicts[kind]}`).join('  '),
        `幂等违反=${tally.violations.length}`,
        `导出「会被替换」的调用=${tally.verdicts.condensed} 行 → ${dumpPath}`,
        '',
      ]
      console.log(lines.join('\n'))
      for (const violation of tally.violations.slice(0, 20)) {
        console.log(`  违反：${violation}`)
      }

      expect(tally.violations).toEqual([])
      expect(tally.targetWithText).toBeGreaterThan(0)
    },
    SCAN_TIMEOUT_MS,
  )
})
