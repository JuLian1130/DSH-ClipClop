/**
 * 差分回放：真实 `grep -o` 的每个命中片段，必须完整出现在 `trimGrepLongLines` 的裁后正文里。
 *
 * oracle 是真实 grep：先用 shim 采集语料命令里每次 grep 调用的 argv（分词交给 bash），再用同一份 argv 对
 * 结果正文跑 `grep -o`，命中片段逐个回查。插件自己的分词器与解析器不参与 oracle——否则是在用被测实现
 * 验证自己（参见 `tests/helpers/grep-replay.ts` 的说明）。
 *
 * 语料不存在时语料部分跳过；fixture 部分总是跑（CI 里没有语料也能回归）。
 * 收敛计划阶段 0：`DSH_GREP_DIFF=1` 打开语料回放，`DSH_GREP_DIFF_MAX` 限制评估行数（0 = 全量），
 * `DSH_GREP_DIFF_STRICT=1` 才把失败判红（现有实现预期会红，先出清单）；阶段 1 收尾时改默认。
 * `DSH_GREP_DIFF_EXPORT=<path>` 把通过的语料样本导成 fixture。
 *
 * 安全：语料里的命令是真实会话命令，不直接放进当前 shell 跑。shim 目录是唯一的 PATH，外部命令（`rm`、
 * `curl`、`git`……）一律找不到；`cd` 被重定义成空操作；带重定向、命令替换、heredoc 的命令整条跳过并计数。
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { trimGrepLongLines } from '../src/grepline.ts'
import { replayArgsOf } from './helpers/grep-replay.ts'

/** 语料根：环境变量优先，其次本机默认路径（与 `tests/condense-corpus.spec.ts` 同一口径）。 */
const CORPUS_ROOT =
  process.env.DSH_CONDENSE_CORPUS ?? (existsSync('/tmp/dsh-condense') ? '/tmp/dsh-condense' : undefined)

/** 语料回放开关（阶段 0 默认关，避免现有实现的红挡住常规门禁）。 */
const DIFF_ENABLED = process.env.DSH_GREP_DIFF === '1'

/** 严格模式：失败即判红（阶段 1 收尾时改用）。 */
const STRICT = process.env.DSH_GREP_DIFF_STRICT === '1'

/** 评估行数上限；0 表示全量。 */
const MAX_ROWS = Number(process.env.DSH_GREP_DIFF_MAX ?? 500)

/** 导出 fixture 的路径。 */
const EXPORT_PATH = process.env.DSH_GREP_DIFF_EXPORT

/** fixture：语料样本 + 已知反例，CI 里没有语料也能回归。 */
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'grep-differential.jsonl')

/** 长行裁剪的省略标记：比较前整段删掉，避免标记自带的括号等字符掩盖片段。 */
const MARKER = /…\[省略 \d+ 字符\]…/g

/** shim 的可执行体：只记 argv，然后成功退出（真实 grep 由测试侧另跑）。 */
const SHIM = `#!${process.execPath}
require('node:fs').appendFileSync(process.env.DSH_DIFF_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`

type CorpusRow = { callId: string; command: string; text: string }
type FixtureRow = CorpusRow & { argvs?: string[][]; knownRed?: boolean }

type Outcome = { argvs: string[][]; failures: string[]; skips: string[]; calls: number; fragments: number }

/** `\w` 与非 ASCII 组合的已知反例：真实 grep 有命中、当前实现会删；阶段 1 的闸门裁决后才能进白名单或删标记。 */
const KNOWN_RED: FixtureRow = {
  callId: 'known-red/w-non-ascii',
  command: "grep -n -e '\\wé' -e MATCH f",
  text: `1:${'x'.repeat(900)} " ééé " ${'y'.repeat(900)} MATCH ${'z'.repeat(900)}`,
  argvs: [['-n', '-e', '\\wé', '-e', 'MATCH', 'f']],
  knownRed: true,
}

/** 只放行不会写文件、不碰网络的命令；危险构造整条跳过并计数（跳过数不是失败）。 */
function unsafeReason(command: string): string | undefined {
  const withoutEscapedAngle = command.replace(/\\>/g, '')
  const withoutSafeRedirects = withoutEscapedAngle
    .replace(/2>&1/g, '')
    .replace(/&>\s*\/dev\/null/g, '')
    .replace(/\d?>\s*\/dev\/null/g, '')
  if (/>/.test(withoutSafeRedirects)) return 'redirect'
  if (/`|\$\(/.test(command)) return 'substitution'
  if (/\/dev\/tcp/.test(command)) return 'dev-tcp'
  if (/<<-?\s*\w/.test(command)) return 'heredoc'
  return undefined
}

/**
 * 用 bash 跑原命令，收集每次 grep 调用的 argv。
 *
 * `cd` 被重定义成空操作（命令里的 `cd /var/...` 不失败）；`PATH` 只含 shim 目录，外部命令一律不可用；
 * 命令本身失败无妨，只要 grep 被调用过，argv 已经记下。
 */
function captureArgvs(command: string): string[][] {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grep-diff-'))
  try {
    for (const name of ['grep', 'egrep', 'fgrep']) {
      const shim = join(dir, name)
      writeFileSync(shim, SHIM)
      chmodSync(shim, 0o755)
    }
    const logPath = join(dir, 'argv.jsonl')
    writeFileSync(logPath, '')
    try {
      // 用绝对路径：`env` 里的 PATH 只有 shim 目录，spawn 按它解析 `bash` 会失败。
      execFileSync('/bin/bash', ['-c', `cd(){ :; }; ${command}`], {
        cwd: dir,
        env: { PATH: dir, HOME: dir, TMPDIR: dir, DSH_DIFF_LOG: logPath },
        timeout: 3_000,
        stdio: 'ignore',
        maxBuffer: 1024 * 1024,
      })
    } catch {
      // 命令失败不影响取证：argv 在 grep 被调用的那一刻就写下了。
    }
    const logged = readFileSync(logPath, 'utf8')
    return logged
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 用重放参数跑真实 `grep -o`，返回命中片段。 */
function fragmentsOf(args: readonly string[], text: string): string[] {
  try {
    const output = execFileSync('grep', [...args], {
      input: `${text}\n`,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    return output.split('\n').filter((fragment) => fragment !== '')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
}

/** 对一行语料跑一次完整回放。 */
function evaluate(command: string, text: string): Outcome {
  const outcome: Outcome = { argvs: [], failures: [], skips: [], calls: 0, fragments: 0 }
  const trimmed = trimGrepLongLines(text, command)
  if (trimmed === text) {
    outcome.skips.push('not-trimmed')
    return outcome
  }
  const body = trimmed.replace(MARKER, '')
  outcome.argvs = captureArgvs(command)
  for (const argv of outcome.argvs) {
    const replay = replayArgsOf(argv)
    if ('skip' in replay) {
      outcome.skips.push(replay.skip)
      continue
    }
    outcome.calls += 1
    for (const fragment of fragmentsOf(replay.args, text)) {
      outcome.fragments += 1
      if (!body.includes(fragment)) outcome.failures.push(fragment)
    }
  }
  return outcome
}

/** 用已采集的 argv 回放（fixture 用：不必再起 bash）。 */
function evaluateWithArgvs(command: string, text: string, argvs: string[][]): Outcome {
  const outcome: Outcome = { argvs, failures: [], skips: [], calls: 0, fragments: 0 }
  const trimmed = trimGrepLongLines(text, command)
  if (trimmed === text) {
    outcome.skips.push('not-trimmed')
    return outcome
  }
  const body = trimmed.replace(MARKER, '')
  for (const argv of argvs) {
    const replay = replayArgsOf(argv)
    if ('skip' in replay) {
      outcome.skips.push(replay.skip)
      continue
    }
    outcome.calls += 1
    for (const fragment of fragmentsOf(replay.args, text)) {
      outcome.fragments += 1
      if (!body.includes(fragment)) outcome.failures.push(fragment)
    }
  }
  return outcome
}

/** 语料里名字为 bash、command 含 grep 的调用。 */
async function* corpusRows(root: string): AsyncGenerator<CorpusRow> {
  const sessions = join(root, 'sessions')
  if (!existsSync(sessions)) return
  for (const file of readdirSync(sessions)) {
    if (!file.endsWith('.jsonl')) continue
    const lines = createInterface({ input: createReadStream(join(sessions, file)), crlfDelay: Infinity })
    for await (const line of lines) {
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const row = parsed as Partial<CorpusRow> & { name?: unknown }
      if (row.name !== 'bash') continue
      if (typeof row.callId !== 'string' || typeof row.command !== 'string' || typeof row.text !== 'string') continue
      if (!row.command.includes('grep')) continue
      yield { callId: row.callId, command: row.command, text: row.text }
    }
  }
}

/** 只留长行与上下各两行，单条压到 20KB 以内；压不下去就放弃这条样本。 */
function compactText(text: string): string | undefined {
  const lines = text.split('\n')
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.length <= 300) return
    for (let offset = -2; offset <= 2; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < lines.length) keep.add(target)
    }
  })
  if (keep.size === 0) return undefined
  const kept = [...keep]
    .sort((left, right) => left - right)
    .map((index) => lines[index] as string)
    .join('\n')
  return kept.length <= 20_000 ? kept : undefined
}

/** 把 fixture 行写成 JSONL。 */
function writeFixture(path: string, rows: readonly FixtureRow[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

/** 汇总每一行判定的耗时与失败详情，便于把红清单抄进收敛计划。 */
function reportFailure(callId: string, command: string, fragment: string): void {
  console.log(`[grep-diff] 命中被删 callId=${callId} fragment=${JSON.stringify(fragment)} command=${command.slice(0, 200)}`)
}

const fixtureRows: FixtureRow[] = existsSync(FIXTURE_PATH)
  ? readFileSync(FIXTURE_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureRow)
  : []

describe('grep 差分回放', () => {
  it('oracle 无命中时返回空片段', () => {
    expect(fragmentsOf(['-o', '-e', 'ABSENT'], 'MATCH')).toEqual([])
  })

  it('oracle 正则执行错误不能当作无命中', () => {
    expect(() => fragmentsOf(['-o', '-e', '['], 'MATCH')).toThrow()
  })

  it('oracle 不存在时 fixture 回放必须失败', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-grep-missing-'))
    try {
      vi.stubEnv('PATH', dir)
      const text = '1:' + 'x'.repeat(900) + 'MATCH' + 'y'.repeat(900)
      expect(() => evaluateWithArgvs('grep -n MATCH f', text, [['-n', 'MATCH', 'f']])).toThrow()
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!DIFF_ENABLED || CORPUS_ROOT === undefined)(
    '语料：真实 grep 的每个命中片段都完整保留',
    { timeout: 1_800_000 },
    async () => {
      const cap = MAX_ROWS > 0 ? MAX_ROWS : Number.POSITIVE_INFINITY
      const failures: { callId: string; command: string; fragment: string }[] = []
      const skips = new Map<string, number>()
      const passing: FixtureRow[] = []
      let scanned = 0
      let evaluated = 0
      let calls = 0
      let fragments = 0

      for await (const row of corpusRows(CORPUS_ROOT as string)) {
        scanned += 1
        if (trimGrepLongLines(row.text, row.command) === row.text) continue
        const unsafe = unsafeReason(row.command)
        if (unsafe !== undefined) {
          skips.set(unsafe, (skips.get(unsafe) ?? 0) + 1)
          continue
        }
        const outcome = evaluate(row.command, row.text)
        for (const skip of outcome.skips) skips.set(skip, (skips.get(skip) ?? 0) + 1)
        calls += outcome.calls
        fragments += outcome.fragments
        evaluated += 1
        for (const fragment of outcome.failures) {
          failures.push({ callId: row.callId, command: row.command, fragment })
        }
        if (outcome.failures.length === 0 && outcome.fragments > 0 && passing.length < 150) {
          const compact = compactText(row.text)
          if (compact !== undefined) {
            passing.push({ callId: row.callId, command: row.command, text: compact, argvs: outcome.argvs })
          }
        }
        if (evaluated >= cap) break
      }

      if (EXPORT_PATH !== undefined) {
        const regressions = fixtureRows.filter(row => row.callId.startsWith('regression/'))
        writeFixture(EXPORT_PATH, [...passing, ...regressions, KNOWN_RED])
      }
      for (const failure of failures.slice(0, 20)) {

        reportFailure(failure.callId, failure.command, failure.fragment)
      }
      const skipText = [...skips]
        .map(([reason, count]) => `${reason}:${count}`)
        .join(', ')
      console.log(
        `[grep-diff] 扫描 ${scanned} 行 / 评估 ${evaluated} 行 / 调用 ${calls} 次 / 片段 ${fragments} 个 / ` +
          `失败 ${failures.length} 条 / 跳过 ${skipText === '' ? '无' : skipText}`,
      )
      if (STRICT) expect(failures).toEqual([])
      expect(evaluated).toBeGreaterThan(0)
    },
  )

  it.skipIf(fixtureRows.length === 0)(
    'fixture：已知样本零删除（knownRed 只报告）',
    { timeout: 300_000 },
    () => {
      for (const row of fixtureRows) {
        if (row.argvs === undefined && unsafeReason(row.command) !== undefined) continue
        const outcome = row.argvs === undefined ? evaluate(row.command, row.text) : evaluateWithArgvs(row.command, row.text, row.argvs)
        if (row.knownRed === true) {
          console.log(`[grep-diff] knownRed ${row.callId}: 失败 ${outcome.failures.length} 条（阶段 1 裁决）`)
          continue
        }
        if (outcome.failures.length > 0) reportFailure(row.callId, row.command, outcome.failures[0] as string)
        expect(outcome.failures).toEqual([])
      }
    },
  )
})
