/**
 * 两族「glance 兜底」handler：`sed` 大窗口（`sedWindow`）与原始转储（`rawDump`）。
 *
 * 形态与参数照票 14 的测量原型 `docs/dsh-condense-measure/transforms_sed_dump.py`（省幅读数就是它测出来的，所以
 * 形状不自创）：`_keep_head_tail` 的头尾预算 + 中段省略标记 + 2000 字符单行封顶（上游说明行不封，票 20 复审）；
 * 转储族另加最多 `hits` 条
 * 「有意思的行」。默认值即票 14 实测的那一档（设计文档「票 17 再加两族」）；换一档，门槛读数就不可比。
 *
 * 两处与原型的有意差异：
 *
 * 1. 窗口只在 `sed` 脚本的**地址部分**取 —— 原型 `_RANGE`（`transforms_sed_dump.py:97`）扫的是整段命令串，
 *    于是 `sed -n 's/x/1,200p/p' f` 这种把范围写在**替换文本**里的调用会被误判成大窗口。落地办法是最小命令
 *    走查器（{@link walkScript}）：认地址、认命令字母；`s` / `y` 按定界符跳过两段参数，注释与 `a`/`i`/`c`/`r`/`w`
 *    跳到行尾，其余命令整条跳到下一个边界——替换文本与命令自由文本里的 `N,Mp` 因此都不是地址
 *    （`sed -n 's/x/;1,200p/p' f` 与 `sed -n '1,100p # 1,200p' f` 都不是大窗口）。`-f` / `--file` 把脚本放在
 *    文件里：**只有它、没有 `-e` 时**命令行上根本没有脚本可看，这一族不表态（`sed -n -f '1,200p' f` 里的
 *    `1,200p` 是脚本**文件名**）；同一行里另有 `-e` 时 `-e` 的脚本照常算，与两者先后无关。
 * 2. 行按 `\n` 切（与 `gitdiff.ts` 同口径）；原型用 `str.splitlines()`，它还在 `\r`、`\v` 等处切。
 *
 * 守卫放弃（正文没兑现、低于尺寸下限）一律交回 `undefined`，调用方据此落回通用链；抛出不在这一层兜——安全层
 * `condenseText` 已经把异常归到「守卫放弃」（计划 §4.1 #8）。
 *
 * @module
 */

import { isUpstreamNoticeLine } from './notice.ts'

/** `sed` 大窗口族的参数。 */
export interface SedWindowParams {
  /** 保留的头行数。 */
  readonly headLines: number
  /** 保留的尾行数。 */
  readonly tailLines: number
  /** 应用期尺寸下限（行数）：正文不足它就是 glance 尺寸，不值得为它付一次回退入口的写入。 */
  readonly minLines: number
}

/** 原始转储族的参数：在窗口预算之外再加「有意思的行」的上限。 */
export interface RawDumpParams extends SedWindowParams {
  /** 最多保留多少条命中 {@link INTERESTING} 的中段行；`0` 表示不插。 */
  readonly hits: number
}

/** `sed` 大窗口的发布参数（票 14 实测那一档）。 */
export const SED_WINDOW_DEFAULTS: SedWindowParams = { headLines: 20, tailLines: 20, minLines: 60 }

/** 原始转储的发布参数（票 14 实测那一档）。 */
export const RAW_DUMP_DEFAULTS: RawDumpParams = { headLines: 15, tailLines: 15, minLines: 60, hits: 20 }

/** 命中 `sedWindow` 族所需的**请求**窗口行数；与应用期守卫 `minLines` 是两个量（设计文档「票 17 再加两族」）。 */
export const SED_WINDOW_MIN_WINDOW_LINES = 101

/** `sedWindow` 族的命令门禁；真正的「窗口 ≥101 行」由 {@link sedWindowLines} 判定。 */
export const SED_WINDOW_COMMAND = '^sed(?:\\s|$)'

/** `rawDump` 族的命令门禁：族名只作为参数或文件名出现（`grep cat f`）不算。 */
export const RAW_DUMP_COMMAND = '^(?:cat|ls|head|tail|nl)(?:\\s|$)'

/** `$` 地址（整文件窗口）的窗口行数；原型对它是 `10 ** 9`。 */
const UNBOUNDED_WINDOW = 10 ** 9

/**
 * 单行字符上限：超过它的单行截到 {@link LINE_CAP} 字符、标记接在**它之后**（原型 `_keep_head_tail` 同此）。
 *
 * 导出是给判据 4 的对账探针（`tests/condense-corpus-glance.spec.ts`）用的：那条不变量要拿这个数与标记去核
 * 「截断行的前缀恰好是某条输入行的前 N 字符」，两边各写一份就会各自漂。
 */
export const LINE_CAP = 2000

/** 超长单行的截断标记，逐字照原型；导出理由同上。 */
export const LINE_TRUNCATED = '…[行已截断]'

/** 「有意思的行」的词表，逐字照原型 `INTERESTING`，忽略大小写。 */
const INTERESTING = /error|exception|traceback|fail|fatal|warn|denied|refused|timeout|not found|✗|✘|✖/i

/**
 * 按 shell 的引号规则把一条命令切成操作数：引号内的空白不是分隔符，引号本身不进入操作数。
 *
 * `sed` 的脚本操作数几乎总是引号包着的，而且里面可能有空格（`sed -n '1, 20p' f`）——按空白裸切会把脚本切碎，
 * 地址就读不出来。只处理引号与反斜杠，不做变量展开、重定向、子命令等解析。
 * @param command - 命令串。
 * @returns 切出的操作数。
 */
function shellTokens(command: string): string[] {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: string | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else token += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      token += command[index + 1]
      started = true
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (started) tokens.push(token)
  return tokens
}

/**
 * 一条 `sed` 命令里的脚本操作数：每个 `-e` / `--expression=` 的值；没有 `-e` 时是**首个非选项操作数**。
 *
 * 多个 `-e` 各自是脚本、地址部分逐条累加——原型扫整段命令串时把它们都算了进去。
 *
 * `-f` / `--file` 的脚本在**文件**里、不在命令行上：它的操作数是文件名而不是脚本，所以没有 `-e` 时这一族
 * 不表态（否则「脚本名叫 `1,200p`」这种文件名会被读成 200 行窗口）。同一条命令里另有 `-e` 时，`-e` 的脚本
 * 照常算——命令行上确实有一个真脚本，与 `-e` 在 `-f` 之前还是之后无关。
 * @param tokens - {@link shellTokens} 切出的操作数（第一个是命令名）。
 * @returns 脚本操作数，按出现顺序；脚本**只在**文件里（没有 `-e`）时为 `undefined`。
 */
function sedScripts(tokens: readonly string[]): string[] | undefined {
  const scripts: string[] = []
  // `-f` / `--file` 出现过：脚本在文件里，命令行上只剩 `-e` 一种脚本来源。**扫完再判**——`-e` 可能在它后面。
  let scriptInFile = false
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] as string
    if (token === '-e' || token === '--expression') {
      const value = tokens[index + 1]
      if (value !== undefined) {
        scripts.push(value)
        index += 1
      }
      continue
    }
    if (token.startsWith('--expression=')) {
      scripts.push(token.slice('--expression='.length))
      continue
    }
    if (token.startsWith('--file=')) {
      // 操作数与选项在同一个 token 里：再跳一个会吞掉下一个 `-e`。
      scriptInFile = true
      continue
    }
    if (token === '-f' || token === '--file') {
      scriptInFile = true
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    // 首个非选项操作数：没有 `-f` 时它就是脚本；有 `-f` 时它是输入文件。它之后的操作数也是输入文件。
    if (scripts.length === 0 && !scriptInFile) scripts.push(token)
    break
  }
  return scriptInFile && scripts.length === 0 ? undefined : scripts
}

/** 一次走查的窗口累计：`\d+,\d+` 的行数，以及有没有出现 `$`（无限大）。 */
interface WindowTally {
  total: number
  unbounded: boolean
}

/** 一个 sed 地址：行号、最后一行（`$`）或正则（`/re/`）。 */
interface SedAddress {
  /** 地址之后的位置。 */
  readonly end: number
  readonly kind: 'line' | 'last' | 'regex'
  /** 行号地址的行数；其余形态为 0。 */
  readonly line: number
}

/**
 * 读一个 sed 地址：`\d+` / `$` / `/re/`（正则里 `\` 转义不算收尾的 `/`）。
 * @param script - 脚本原文。
 * @param start - 地址起始位置。
 * @returns 地址与它之后的位置；这里不是地址时为 `undefined`。
 */
function readAddress(script: string, start: number): SedAddress | undefined {
  const char = script[start]
  if (char === '$') return { end: start + 1, kind: 'last', line: 0 }
  if (char === '/') {
    let index = start + 1
    while (index < script.length) {
      if (script[index] === '\\') {
        index += 2
        continue
      }
      if (script[index] === '/') return { end: index + 1, kind: 'regex', line: 0 }
      index += 1
    }
    return undefined
  }
  const digits = /^\d+/.exec(script.slice(start))
  if (digits === null) return undefined
  return { end: start + digits[0].length, kind: 'line', line: Number(digits[0]) }
}

/** 跳过空白（sed 允许地址与命令字母之间有空格 / 制表符，但不跨行）。 */
function skipBlanks(script: string, start: number): number {
  let index = start
  while (script[index] === ' ' || script[index] === '\t') index += 1
  return index
}

/**
 * 读命令开头的地址部分（一到两个 `\d+` / `$` / `/re/`，逗号分隔），并算出这条命令要计的行数。
 *
 * 只有 `\d+,\d+` 与 `\d+,\$` 构成窗口：单地址、正则地址对（`/start/,/end/p`）、倒序区间都不算。
 * @param script - 脚本原文。
 * @param start - 命令起始位置。
 * @returns 地址部分之后的位置与窗口行数（`'unbounded'` 表示 `$`）。
 */
function readWindow(script: string, start: number): { end: number; window: number | 'unbounded' | undefined } {
  const first = readAddress(script, start)
  if (first === undefined) return { end: start, window: undefined }

  let end = first.end
  let second: SedAddress | undefined
  const comma = skipBlanks(script, end)
  if (script[comma] === ',') {
    second = readAddress(script, skipBlanks(script, comma + 1))
    if (second !== undefined) end = second.end
  }

  let window: number | 'unbounded' | undefined
  if (first.kind === 'line' && second !== undefined) {
    if (second.kind === 'last') window = 'unbounded'
    else if (second.kind === 'line' && second.line >= first.line) window = second.line - first.line + 1
  }
  return { end, window }
}

/**
 * 从 `start` 起跳过一段定界文本，交回收尾定界符之后的位置；没有收尾时吃到串尾（`\` 转义不算定界符）。
 * @param script - 脚本原文。
 * @param start - 文本起点。
 * @param delimiter - 定界符。
 * @returns 收尾定界符之后的位置。
 */
function skipDelimited(script: string, start: number, delimiter: string): number {
  let index = start
  while (index < script.length) {
    if (script[index] === '\\') {
      index += 2
      continue
    }
    if (script[index] === delimiter) return index + 1
    index += 1
  }
  return index
}

/**
 * 跳到下一个命令边界（`;` / 换行 / `}` / 串尾）。
 *
 * 命令的**自由文本**（`p` 后面跟着的东西、`s` 的 flags、文件名……）里可能有 `N,Mp` 这种看着像地址的文本，
 * 把整条命令一次跳过去，循环就不会在自由文本里重新读地址。
 * @param script - 脚本原文。
 * @param start - 起点。
 * @returns 边界位置。
 */
function skipToBoundary(script: string, start: number): number {
  let index = start
  while (index < script.length && script[index] !== ';' && script[index] !== '\n' && script[index] !== '}') index += 1
  return index
}

/**
 * 跳到行尾（`\n` / 串尾）。
 * @param script - 脚本原文。
 * @param start - 起点。
 * @returns 行尾位置。
 */
function lineEnd(script: string, start: number): number {
  const newline = script.indexOf('\n', start)
  return newline < 0 ? script.length : newline
}

/**
 * 整行都是自由文本的命令字母：`#`（注释）与 `a` / `i` / `c`（追加 / 插入 / 替换文本）、`r` / `w`（文件名）。
 *
 * 它们在 sed 里的参数一直吃到行尾——BSD sed 实测 `sed -n 'w /tmp/f;1,2p'` 的文件名就是 `f;1,2p`（`;1,2p` 不是
 * 命令），GNU sed 把 `a text` / `p # …` 当合法的文本 / 注释。所以这些字母之后整行都不再读地址。
 */
const LINE_TEXT_COMMANDS = '#aicrw'

/**
 * 跳过 `s` / `y` 的两段参数（`s` 是 pattern + replacement、`y` 是 source + dest，按定界符读），再把 flags
 * 推到下一个命令边界。
 *
 * 参数里可以有分号与逗号（`s|x|;1,200p|`）——把整条命令跳过去，它们就不会被当成分段地址，这正是「只在地址
 * 部分取窗口」在替换文本上的落点。
 *
 * `s` 的 flags 里出现 `w` 时后面跟一个**文件名**，文件名同样吃到行尾：`sed -n 's/x/y/pw /tmp/out;1,200p' f`
 * 的文件名就是 `/tmp/out;1,200p`（系统 sed 实测退出 0、输出 400 行、建出的文件带这个分号），那句 `;1,200p`
 * 不是命令。
 * @param script - 脚本原文。
 * @param at - 命令字母之后的位置（定界符所在处）。
 * @returns 下一个命令边界的位置（`;` / 换行 / `}` / 串尾）。
 */
function skipSubstitution(script: string, at: number): number {
  const delimiter = script[at]
  if (delimiter === undefined || delimiter === '\\' || delimiter === '\n') return at + 1
  const afterPattern = skipDelimited(script, at + 1, delimiter)
  const afterReplacement = skipDelimited(script, afterPattern, delimiter)
  const flagsEnd = skipToBoundary(script, afterReplacement)
  const write = script.slice(afterReplacement, flagsEnd).indexOf('w')
  return write < 0 ? flagsEnd : lineEnd(script, afterReplacement + write)
}

/**
 * 走查一条 `sed` 脚本，把**命令开头**的 `\d+,\d+p` / `\d+,\$p` 累加进 `tally`。
 *
 * 命令边界不靠裸切 `;`，也不在自由文本里找地址：先读地址部分、再认命令字母；`s` / `y` 按定界符跳过两段参数，
 * {@link LINE_TEXT_COMMANDS} 整行跳过，其余命令跳到下一个边界。
 * @param script - 脚本操作数原文。
 * @param tally - 窗口累计。
 */
function walkScript(script: string, tally: WindowTally): void {
  let index = 0
  while (index < script.length) {
    const char = script[index] as string
    // 命令之间的分隔（`;`、换行、空白、块结束）不承载判断。
    if (char === ';' || char === '\n' || char === ' ' || char === '\t' || char === '}') {
      index += 1
      continue
    }
    const addresses = readWindow(script, index)
    const at = skipBlanks(script, addresses.end)
    const letter = script[at]
    if (letter === undefined) return
    if (letter === 'p' && addresses.window !== undefined) {
      if (addresses.window === 'unbounded') tally.unbounded = true
      else tally.total += addresses.window
    }
    if (letter === 's' || letter === 'y') index = skipSubstitution(script, at + 1)
    else if (LINE_TEXT_COMMANDS.includes(letter)) index = lineEnd(script, at)
    else index = skipToBoundary(script, at + 1)
  }
}

/**
 * 这次 `sed` 调用**请求**打印的行数；不是区间打印时交回 `undefined`。
 *
 * 要求脚本段里有独立的 `-n` / `--quiet` / `--silent`（原型同样要求它前后有空白），并走查脚本：只有**命令开头**
 * 的 `\d+,\d+p` / `\d+,\$p` 才计入，`$` 按无限大算。非 sed 命令、非打印脚本、没有这种地址、或范围只写在
 * 替换文本里都交回 `undefined`。
 * @param command - **首个实质命令**段（`dispatch.ts` 已剥掉脚手架、管道右侧与标题回显）。
 * @returns 请求的窗口行数；不是窗口打印时为 `undefined`。
 */
export function sedWindowLines(command: string): number | undefined {
  const tokens = shellTokens(command)
  // 命令名就是 `sed`——与 `SED_WINDOW_COMMAND` 的门禁同域（`/usr/bin/sed` 不在此列）。
  if (tokens[0] !== 'sed') return undefined
  if (!tokens.some(token => token === '-n' || token === '--quiet' || token === '--silent')) return undefined

  const scripts = sedScripts(tokens)
  // 脚本在文件里（`-f` / `--file`）：地址部分看不到，这一族不表态。
  if (scripts === undefined) return undefined
  const tally: WindowTally = { total: 0, unbounded: false }
  for (const script of scripts) walkScript(script, tally)
  if (tally.unbounded) return UNBOUNDED_WINDOW
  return tally.total === 0 ? undefined : tally.total
}

/**
 * 正文按 `\n` 切行；末尾换行不算一行（交回时按原样补上，与原型 `splitlines` + join 的效果一致）。
 * @param text - 正文。
 * @returns 各行。
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 头 `head` 行 + 省略标记 + 尾 `tail` 行；超长单行截断。
 *
 * 上游说明行不参与单行截断：它指向完整输出，切掉路径等于把可回退的入口弄坏（票 20 复审）；判定与通用链共用
 * {@link isUpstreamNoticeLine}。
 * @param lines - 输入各行。
 * @param head - 头行数。
 * @param tail - 尾行数。
 * @returns 收窄后的行；头尾预算装得下整份正文（没有可省略的中段）时为 `undefined`。
 */
function keepHeadTail(lines: readonly string[], head: number, tail: number): string[] | undefined {
  if (head + tail >= lines.length) return undefined
  const cut = lines.map(
    line => line.length <= LINE_CAP || isUpstreamNoticeLine(line)
      ? line
      : line.slice(0, LINE_CAP) + LINE_TRUNCATED,
  )
  const dropped = lines.length - head - tail
  return [...cut.slice(0, head), `…[中段省略 ${dropped} 行]…`, ...cut.slice(cut.length - tail)]
}

/**
 * 收窄后的各行接回正文：末尾换行照原样保留回去（原型 `"\n".join(...) + ("\n" if endswith("\n"))`）。
 * @param lines - 收窄后的各行。
 * @param original - 输入正文。
 * @returns 交回的正文。
 */
function rejoin(lines: readonly string[], original: string): string {
  return lines.join('\n') + (original.endsWith('\n') ? '\n' : '')
}

/**
 * `sed` 大窗口的收窄：头尾预算 + 中段省略标记。
 * @param text - 下游正文。
 * @param params - 这一族当前的参数。
 * @returns 收窄后的正文；低于尺寸下限或没有可省略的中段时为 `undefined`。
 */
export function compactSedWindow(text: string, params: SedWindowParams): string | undefined {
  const lines = splitLines(text)
  if (lines.length < params.minLines) return undefined
  const kept = keepHeadTail(lines, params.headLines, params.tailLines)
  if (kept === undefined) return undefined
  return rejoin(kept, text)
}

/**
 * 原始转储的收窄：头尾预算 + 最多 `hits` 条「有意思的行」+ 中段省略标记。
 *
 * 「有意思的行」逐字取 `序号: 原行`（序号从 1 数起，便于回到输入里定位），只从头尾之外的行里挑、按行内容
 * 去重、**不做**单行截断（原型在挑选那一步用的是未截断的原行）。
 * @param text - 下游正文。
 * @param params - 这一族当前的参数。
 * @returns 收窄后的正文；低于尺寸下限或没有可省略的中段时为 `undefined`。
 */
export function compactRawDump(text: string, params: RawDumpParams): string | undefined {
  const lines = splitLines(text)
  if (lines.length < params.minLines) return undefined
  let kept = keepHeadTail(lines, params.headLines, params.tailLines)
  if (kept === undefined) return undefined

  if (params.hits > 0) {
    const picked: string[] = []
    const seen = new Set<string>()
    for (let index = 0; index < lines.length && picked.length < params.hits; index++) {
      const line = lines[index] as string
      if (index < params.headLines || index >= lines.length - params.tailLines) continue
      if (!INTERESTING.test(line) || seen.has(line)) continue
      seen.add(line)
      picked.push(`${index + 1}: ${line}`)
    }
    if (picked.length > 0) {
      kept = [...kept.slice(0, params.headLines), ...picked, ...kept.slice(params.headLines)]
    }
  }
  return rejoin(kept, text)
}
