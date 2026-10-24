/**
 * 票 16 判据 12：把**发布实现**（分派 + `compactDiff`）在真实语料上的每次判定与替换导出成 JSONL，交给
 * `docs/dsh-condense-measure/verify_dispatch_diff.py` 按票 14 的 harness 口径对账门槛。
 *
 * **为什么不直接跑 harness**：`harness.py:183-184` 会自己拼一条回退说明（`fallback_notice`），而发布实现的口径
 * 是 `ENTRY_RESERVE = 256` 字符的**预留上界**；两者不是同一份东西，发布门槛必须用发布实现自己的数。所以走票 15
 * 已经走通的那条路——发布实现导出 JSONL，离线脚本按 harness 的口径重算。
 *
 * **语料在场就一定跑**（与票 15 的 `condense-corpus.spec.ts` 同一条规矩）：`DSH_CONDENSE_CORPUS` 优先，否则
 * `/tmp/dsh-condense`；那里没有语料才整文件跳过。
 *
 * **这份语料缺两列事实**：会话日志的 `tool/result` 不带 `value`（`packages/core/tools/src/index.ts:575` 明写
 * 「deliberately omitted from durable events」），所以 `exitCode` 与 `stdout.truncated` 都拿不到——`compactDiff`
 * 的截断守卫在离线读数里**恒不触发**；退出码已不再挡族（票 20），只在运行期经 `facts` 观察。这份读数因此
 * **等于原型口径、不等价于生产口径**（dump 里这两个字段恒为 null 是同一事实的镜像，`facts` 里也照实缺这两项）。
 *
 * 除导出外，本文件还常驻一条**判据 8 的不变量断言**：族收窄后正文里每个文件的 `  +N -M`，必须等于该文件在输入里
 * 真实的增删行数（含被明细封顶与整体截断略过的那些），且明细里出现的每一行都逐字来自输入。期望值由本文件
 * **自己**按一个更笨的扫描器数出来（只认 hunk 内的标记列），不调用被测实现。
 *
 * 复现（语料在的时候，常规 `pnpm test` 也会跑到这一条）：
 *
 *     DSH_CONDENSE_CORPUS=/tmp/dsh-condense PATH=/tmp/pm-shim:$PATH \
 *       pnpm vitest run tests/condense-corpus-diff.spec.ts
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { RAW_DUMP_DEFAULTS, SED_WINDOW_DEFAULTS } from '../src/glance.ts'
import { readCorpusLines } from './helpers/corpus-lines.ts'

/** `extract_calls.py` 的 `--out` 默认值；语料在本机就该跑，不在本机就跳过。 */
const DEFAULT_CORPUS = '/tmp/dsh-condense'

/** 语料根：环境变量优先，其次本机默认路径；两处都没有时整个文件跳过。 */
const corpusRoot = process.env.DSH_CONDENSE_CORPUS
  ?? (existsSync(DEFAULT_CORPUS) ? DEFAULT_CORPUS : undefined)

/** 导出路径；默认与 `verify_dispatch_diff.py` 的 `--dump` 一致。 */
const dumpPath = process.env.DSH_CONDENSE_TS_DIFF_DUMP ?? '/tmp/dsh-condense-ts/ts-dispatch-diff.jsonl'

/** 语料扫描的明确超时：764 MB 顺序扫描 + 逐行判定，本机实测一分钟以内。 */
const SCAN_TIMEOUT_MS = 1_800_000

/** 这一族在语料上求值时的工具名集合：`all` 分母就是这两个工具的快照行。 */
const SHELL_TOOLS = ['bash', 'pwsh']

/** 逐文件聚合量的形态（族收窄后才有）；带 `g` 的那一份只用于 `matchAll`。 */
const AGGREGATE = /^ {2}\+\d+ -\d+$/
const AGGREGATE_CAPTURE = /^ {2}\+(\d+) -(\d+)$/gm

/** 明细截断提示的形态（族自己生成的，不是输入里的行）。 */
const TRUNCATION_NOTE = /^ {2}\.\.\. \(/

/** 语料 JSONL 的一行：只声明本文件用到的字段，其余原样忽略。 */
interface CorpusRow {
  readonly callId?: unknown
  readonly name?: unknown
  readonly text?: unknown
  readonly command?: unknown
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
  dumped: number
  /** 判据 8：聚合量与真实增删数对不上的调用。 */
  countMismatches: string[]
  /** 判据 8：明细里出现、却在输入里找不到原行的调用。 */
  fabricatedLines: string[]
  /** 抽样的对账清单（前若干条），只在失败时打印，避免刷屏。 */
  firstMismatchDetail: string[]
}

/**
 * 数出正文里**每个文件**真实的增删行数。
 *
 * 一个更笨的扫描器：文件边界是 `diff --`，行是否算变更只看它在 hunk 内（`@@` 之后、下一个文件头之前）且标记列是
 * `+` / `-`——`+++` / `---` 是文件头不是变更行。用它当期望值的独立来源，而不是调用被测实现的计数。
 * @param text - 输入正文。
 * @returns 逐文件的 `[增, 删]`，按出现顺序，只含真正有变更的文件。
 */
function trueCountsPerFile(text: string): Array<[number, number]> {
  const counts: Array<[number, number]> = []
  let current: [number, number] | undefined
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --')) {
      if (current !== undefined && (current[0] > 0 || current[1] > 0)) counts.push(current)
      current = [0, 0]
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (current === undefined || !inHunk) continue
    if (line.startsWith('+++') || line.startsWith('---')) {
      inHunk = false
      continue
    }
    if (line.startsWith('+')) current[0] += 1
    else if (line.startsWith('-')) current[1] += 1
  }
  if (current !== undefined && (current[0] > 0 || current[1] > 0)) counts.push(current)
  return counts
}

/**
 * 流式读一个语料 JSONL 的每一行。
 * @param file - JSONL 路径。
 * @param onRow - 每行的回调。
 * @returns 读完后 resolve。
 */
async function eachRow(file: string, onRow: (row: CorpusRow) => void): Promise<void> {
  for await (const line of readCorpusLines(file)) {
    if (line === '') continue
    onRow(JSON.parse(line) as CorpusRow)
  }
}

describe.skipIf(!corpusRoot)('票 16 判据 8/12：真实语料上的「计数不假」与门槛导出口', () => {
  it(
    '逐调用断言族收窄后的聚合量等于真实增删数，并导出判定与替换清单',
    async () => {
      const root = corpusRoot as string
      const sessionsDir = join(root, 'sessions')
      const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl')).sort()
      // 规则表是票 17 的三族表；本文件只对账 `compactDiff` 一族（另外两族的门槛读数有各自的导出口）。
      const rules = compileRules(builtinRules({
        gitDiff: () => GIT_DIFF_DEFAULTS,
        sedWindow: () => SED_WINDOW_DEFAULTS,
        rawDump: () => RAW_DUMP_DEFAULTS,
      })).rules.filter(rule => rule.family === 'compactDiff')

      const tally: Tally = {
        calls: 0,
        shellCalls: 0,
        emptyBodies: 0,
        belowFloor: 0,
        familyMiss: 0,
        familyHits: 0,
        verdicts: {},
        dumped: 0,
        countMismatches: [],
        fabricatedLines: [],
        firstMismatchDetail: [],
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

          // 事实 map 走**生产那一个** `dispatchFacts`（两边的尺子不会各自漂）：命令串取自调用参数；`exitCode` 在
          // 语料里拿不到（durable 事件不带 `value`），因此**不进 map**——与生产在那份语料上会摊出的 map 只差这一个
          // 读不到的键。`truncated` 与生产同源：形状读不到就当没有（`false`）。
          const facts = dispatchFacts({ command, exitCode: undefined, truncated: false, body }, estimateUnits)

          let outcome: string
          let family: string | null = null
          let verdict: CondenseVerdict | undefined
          if (beforeUnits < CONDENSE_DEFAULTS.minUnits) {
            outcome = 'below-floor'
            tally.belowFloor++
          } else {
            // 族先试：命中就只跑那一族，族守卫放弃才落通用链——与 `index.ts` 的层序一字不差。
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
          }

          const replaced = verdict?.kind === 'condensed' ? verdict : undefined
          // 上游入口已经存在时不写本层入口，预留不参与比较（票 20）。
          const entryChars = replaced?.lossy === true && replaced.entry !== 'upstream' ? ENTRY_RESERVE : 0
          const afterUnits = replaced === undefined
            ? beforeUnits
            : estimateUnits(replaced.text + 'x'.repeat(entryChars))

          // 判据 8 的常驻不变量：聚合量必须等于该文件真实的增删行数，明细必须是输入里的原行。
          if (family !== null && replaced !== undefined) {
            const expected = trueCountsPerFile(body)
            const observed = [...replaced.text.matchAll(AGGREGATE_CAPTURE)]
              .map(match => [Number(match[1]), Number(match[2])] as [number, number])
            const differs = expected.length !== observed.length
              || observed.some((pair, index) => pair[0] !== expected[index]?.[0] || pair[1] !== expected[index]?.[1])
            if (differs) {
              tally.countMismatches.push(`${callId} @ ${file}`)
              if (tally.firstMismatchDetail.length < 5) {
                tally.firstMismatchDetail.push(
                  `${callId}：真实 ${JSON.stringify(expected)} vs 输出 ${JSON.stringify(observed)}`,
                )
              }
            }
            const inputLines = new Set(body.split('\n'))
            for (const line of replaced.text.split('\n')) {
              if (line === '' || AGGREGATE.test(line) || TRUNCATION_NOTE.test(line)) continue
              if (line === '... (more changes truncated)') continue
              const marker = line[0] ?? ''
              if (marker !== '+' && marker !== '-' && marker !== ' ') continue
              if (!inputLines.has(line)) {
                tally.fabricatedLines.push(`${callId} @ ${file}: ${line.slice(0, 60)}`)
                break
              }
            }
          }

          dumpLine(JSON.stringify({
            callId,
            name,
            command,
            beforeUnits,
            outcome,
            family,
            afterUnits,
            entryChars,
            sha256: replaced === undefined ? null : createHash('sha256').update(replaced.text, 'utf8').digest('hex'),
            chars: replaced === undefined ? 0 : replaced.text.length,
            // 语料没有这两列事实：恒 null 是「截断守卫在离线读数里不触发、退出码不再挡族」的镜像。
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

      const lines: string[] = [
        '',
        `=== 票 16 语料扫描（${root}）===`,
        `JSONL 文件=${files.length}  调用=${tally.calls}  shell（${SHELL_TOOLS.join(' / ')}）调用=${tally.shellCalls}`
          + `  空正文=${tally.emptyBodies}`,
        `低于尺寸下限（${CONDENSE_DEFAULTS.minUnits} 估算单位）=${tally.belowFloor}`
          + `  族未命中=${tally.familyMiss}  族命中=${tally.familyHits}`,
        '判定计数：'
          + Object.entries(tally.verdicts).map(([kind, count]) => `${kind}=${count}`).join('  '),
        `判据 8 聚合量与真实增删数不符=${tally.countMismatches.length}`
          + `  明细里出现输入里没有的行=${tally.fabricatedLines.length}`,
        `导出=${tally.dumped} 行 → ${dumpPath}`,
        '',
      ]
      console.log(lines.join('\n'))
      for (const detail of tally.firstMismatchDetail) console.log(`  计数不符：${detail}`)
      for (const detail of tally.fabricatedLines.slice(0, 5)) console.log(`  伪造明细：${detail}`)

      expect(tally.countMismatches).toEqual([])
      expect(tally.fabricatedLines).toEqual([])
      expect(tally.dumped).toBeGreaterThan(0)
    },
    SCAN_TIMEOUT_MS,
  )
})
