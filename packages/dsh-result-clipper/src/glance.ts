/**
 * 两族「glance 兜底」handler：`sed` 大窗口（`sedWindow`）与原始转储（`rawDump`）。
 *
 * 形态与参数照票 14 的测量原型 `docs/dsh-condense-measure/transforms_sed_dump.py`（省幅读数就是它测出来的，所以
 * 形状不自创）：`_keep_head_tail` 的头尾预算 + 中段省略标记 + 2000 字符单行封顶；转储族另加最多 `hits` 条
 * 「有意思的行」。默认值即票 14 实测的那一档（设计文档「票 17 再加两族」）；换一档，门槛读数就不可比。
 *
 * 两处与原型的有意差异：
 *
 * 1. 窗口只在 `sed` 脚本的**地址部分**取 —— 原型 `_RANGE`（`transforms_sed_dump.py:97`）扫的是整段命令串，
 *    于是 `sed -n 's/x/1,200p/p' f` 这种把范围写在**替换文本**里的调用会被误判成大窗口。
 * 2. 行按 `\n` 切（与 `gitdiff.ts` 同口径）；原型用 `str.splitlines()`，它还在 `\r`、`\v` 等处切。
 *
 * 守卫放弃（正文没兑现、低于尺寸下限）一律交回 `undefined`，调用方据此落回通用链；抛出不在这一层兜——安全层
 * `condenseText` 已经把异常归到「守卫放弃」（计划 §4.1 #8）。
 *
 * @module
 */

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

/** 定位在**命令开头**的打印地址：`1,101p` 或 `1,$p`；不在开头的（替换文本里的）不算。 */
const LEADING_RANGE = /^\s*(\d+)\s*,\s*(\d+|\$)\s*p/

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
 * @param tokens - {@link shellTokens} 切出的操作数（第一个是命令名）。
 * @returns 脚本操作数，按出现顺序。
 */
function sedScripts(tokens: readonly string[]): string[] {
  const scripts: string[] = []
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
    if (token.startsWith('-')) continue
    // 首个非选项操作数：还没收集到 `-e` 时它就是脚本；它之后的操作数是输入文件。
    if (scripts.length === 0) scripts.push(token)
    break
  }
  return scripts
}

/**
 * 这次 `sed` 调用**请求**打印的行数；不是区间打印时交回 `undefined`。
 *
 * 要求脚本段里有独立的 `-n` / `--quiet` / `--silent`（原型同样要求它前后有空白），并在脚本的每条命令**开头**
 * 累加 `\d+,\d+p` / `\d+,\$p` 的行数；`$` 按无限大算。非 sed 命令、非打印脚本、没有这种地址、或范围只写在
 * 替换文本里都交回 `undefined`。
 * @param command - **首个实质命令**段（`dispatch.ts` 已剥掉脚手架、管道右侧与标题回显）。
 * @returns 请求的窗口行数；不是窗口打印时为 `undefined`。
 */
export function sedWindowLines(command: string): number | undefined {
  const tokens = shellTokens(command)
  // 命令名就是 `sed`——与 `SED_WINDOW_COMMAND` 的门禁同域（`/usr/bin/sed` 不在此列）。
  if (tokens[0] !== 'sed') return undefined
  if (!tokens.some(token => token === '-n' || token === '--quiet' || token === '--silent')) return undefined

  let total = 0
  let unbounded = false
  for (const script of sedScripts(tokens)) {
    // 按脚本的命令边界（`;`、换行）逐条看：只有**命令开头**的地址才是窗口。
    for (const piece of script.split(/[;\n]/)) {
      const range = LEADING_RANGE.exec(piece)
      if (range === null) continue
      const low = Number(range[1])
      if (range[2] === '$') unbounded = true
      else if (Number(range[2]) >= low) total += Number(range[2]) - low + 1
    }
  }
  if (unbounded) return UNBOUNDED_WINDOW
  return total === 0 ? undefined : total
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
 * @param lines - 输入各行。
 * @param head - 头行数。
 * @param tail - 尾行数。
 * @returns 收窄后的行；头尾预算装得下整份正文（没有可省略的中段）时为 `undefined`。
 */
function keepHeadTail(lines: readonly string[], head: number, tail: number): string[] | undefined {
  if (head + tail >= lines.length) return undefined
  const cut = lines.map(
    line => line.length <= LINE_CAP ? line : line.slice(0, LINE_CAP) + LINE_TRUNCATED,
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
