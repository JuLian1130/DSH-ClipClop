/**
 * 命中长行的「围绕命中裁剪」：bash 的 `grep` 结果里，命中行偶尔会很长（sourcemap 的 `mappings`、内联源码
 * 字符串、JSONL 记录），模型要的是命中片段而不是整条记录。本模块把超长命中行裁到命中 ±{@link GREP_LONG_LINE_WINDOW}
 * 字符，其余标 `…[省略 N 字符]…`。
 *
 * 依据（票 26，`docs/dsh-sed-grep-cost.md` 第五节）：语料里 5,292 条 >300 字的命中行，86% 能按命令里的
 * pattern 定位到命中；整条变换在 5.84M token 的样本上省 0.59M（10.2%），折算到全部 grep token 约 6.9%。
 * 定位不到的行**原样保留**（不省也不破坏）。
 *
 * 两条边界：
 *
 * 1. **只认 grep 自己的输出形状**：`path:行号:正文` 或 `行号:正文`（`-` 分隔的 `-A/-B` 上下文行同样处理）。
 *    命令里认不出 grep（`git log --grep`、`echo grep`、`grep -f 模式文件`）就不动。
 * 2. **幂等**：已经带省略标记、或已被 `tail-cap` 单行截断的行跳过——整链第二遍施加时这条规则不改变
 *    任何行。规则是**有损**的，靠调用方的回退入口兜底。
 *
 * @module
 */

import { SINGLE_LINE_TRUNCATION } from './notice.ts'

/** 命中行正文多长才值得裁（字符）。语料按 300 字分档：1,501–5,000 token 的 grep 结果里 41% 的字符在 >300 字的行上。 */
export const GREP_LONG_LINE_MIN_CHARS = 300

/** 命中前后各保留多少字符。实测 ±200 省 10.2%，±100 省 14.6%、±400 省 5.5%，200 是增益与保真的折中。 */
export const GREP_LONG_LINE_WINDOW = 200

/** 省略标记的前缀；幂等判据也靠它（带标记的行不再处理）。 */
export const LONG_LINE_MARK = '…[省略 '

/**
 * 行首是 `行号:正文` / `行号-正文` 的单文件输出。
 *
 * 必须先认这一种：`13:- [x] ...` 这种「行号 + 正文本身带冒号数字」的行，若走路径正则，可选的路径部分会一路
 * 吃到正文里的 `catalog.ts:32-37`，把真正文切掉——第二遍施加时分组已去掉路径，就会得到与第一遍不同的结果
 * （整链幂等断掉，票 26 语料扫描抓到过）。
 */
const BARE_ROW = /^(\s*)(\d+)([:-])(.*)$/

/**
 * `path:行号:正文`（`-` 为上下文行）；路径取到**第一个**「冒号 + 数字 + 分隔符」为止。
 *
 * 开头的空白要留住：`grep … | sed 's/^/  /'` 这类管道会给每行加前缀，`group-paths` 认这种行（它的路径
 * 正则把前缀算进路径）。两边认法不一致就会出「第一遍没裁、分组后第二遍才裁」的幂等违反（票 26 语料扫描
 * 抓到过一次）。
 */
const PATH_ROW = /^(\s*)(.+?):(\d+)([:-])(.*)$/

/**
 * 把一行拆成 `{ path?, line, sep, content }`；不是 grep 输出形状时 `undefined`。
 * @param line - 结果里的一行。
 */
function parseRow(line: string): { lead: string; path?: string; line: string; sep: string; content: string } | undefined {
  // 先试路径行，但路径必须是「像路径」的一段：不含空白、长度有限。`13:- [x] … catalog.ts:32-37` 这种
  // 「行号 + 正文里的冒号数字」靠这条排掉（否则可选的路径会一路吃到正文里，把真正文切走）。
  const path = PATH_ROW.exec(line)
  if (path !== null) {
    const candidate = path[2] as string
    if (candidate.length <= 300 && !/\s/.test(candidate)) {
      return {
        lead: path[1] as string,
        path: candidate,
        line: path[3] as string,
        sep: path[4] as string,
        content: path[5] as string,
      }
    }
  }
  const bare = BARE_ROW.exec(line)
  if (bare !== null) {
    return { lead: bare[1] as string, line: bare[2] as string, sep: bare[3] as string, content: bare[4] as string }
  }
  return undefined
}

/** 带一个取值的短选项（`-A 3` / `-m 5` / `-f 模式文件`）。 */
const VALUE_FLAGS = new Set([
  '-A', '-B', '-C', '-m', '-f',
  '--include', '--exclude', '--exclude-dir', '--include-dir',
  '--max-count', '--after-context', '--before-context', '--context',
])

/** 纯字母短选项簇（`-rnwiE`）；单独处理带 `e` / `f` 的簇，因为它们要把下一个 token 当取值。 */
const SHORT_FLAGS = /^-[A-Za-z]+$/

/**
 * 把命令串按顶层分隔符切开：`&&` / `||` / `;` / `|` / 换行。
 * 引号内与反斜杠转义后的分隔符不算（`grep "a\|b" f` 里的 `\|` 是 BRE 的「或」）。
 */
function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + (command[index + 1] as string)
      index++
      continue
    }
    if (char === '\n' || char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if ((char === '|' || char === '&') && command[index + 1] === char) {
      segments.push(current)
      current = ''
      index++
      continue
    }
    if (char === '|' || char === '&') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/** 把一个段切成 token：去引号、保留反斜杠转义、引号内的空白不切。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] as string
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (char === '\\' && index + 1 < segment.length) {
        current += char + (segment[index + 1] as string)
        index++
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** 从一个段里收集 `grep` 的 pattern 与短选项。`-f`（模式来自文件）的调用不表态。 */
function patternsOf(tokens: readonly string[]): ReadonlyArray<{ readonly source: string; readonly flags: ReadonlySet<string> }> {
  const patterns: Array<{ readonly source: string; readonly flags: ReadonlySet<string> }> = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string
    if (token !== 'grep' && !token.endsWith('/grep')) continue
    const flags = new Set<string>()
    const explicit: string[] = []
    let pattern: string | undefined
    let fromFile = false
    let cursor = index + 1
    while (cursor < tokens.length) {
      const next = tokens[cursor] as string
      if (next === '-e' || next === '--regexp') {
        const value = tokens[cursor + 1]
        if (value !== undefined) explicit.push(value)
        cursor += 2
        continue
      }
      if (next.startsWith('--regexp=')) {
        explicit.push(next.slice('--regexp='.length))
        cursor++
        continue
      }
      if (next === '-f' || next === '--file') {
        fromFile = true
        cursor += 2
        continue
      }
      if (/^-[A-Za-z]*e$/.test(next)) {
        const value = tokens[cursor + 1]
        if (value !== undefined) explicit.push(value)
        cursor += 2
        continue
      }
      if (/^-[A-Za-z]*f$/.test(next)) {
        fromFile = true
        cursor += 2
        continue
      }
      if (VALUE_FLAGS.has(next)) {
        cursor += 2
        continue
      }
      if (SHORT_FLAGS.test(next)) {
        for (const flag of next.slice(1)) flags.add(flag)
        cursor++
        continue
      }
      if (next.startsWith('-')) {
        cursor++
        continue
      }
      // 显式 `-e` 给过 pattern 时，第一个非选项 token 是文件/目录，不是 pattern。
      if (pattern === undefined && explicit.length === 0) pattern = next
      break
    }
    if (fromFile) continue
    if (pattern !== undefined) explicit.push(pattern)
    for (const source of explicit) patterns.push({ source, flags })
  }
  return patterns
}

/** 把 BRE 的转义写法翻成 JS 正则认识的写法（只翻「或 / 分组 / 量词」，其余交给 `new RegExp` 报错）。 */
function translateBre(source: string): string {
  return source
    .replace(/\\\|/g, '|')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\+/g, '+')
    .replace(/\\\?/g, '?')
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compilePattern(source: string, flags: ReadonlySet<string>): RegExp | undefined {
  const fixed = flags.has('F')
  let body = fixed ? escapeRegExp(source) : flags.has('E') || flags.has('P') ? source : translateBre(source)
  if (flags.has('w')) body = `\\b(?:${body})\\b`
  try {
    return new RegExp(body, flags.has('i') ? 'gi' : 'g')
  } catch {
    return undefined
  }
}

/**
 * 从命令串里取出所有可用的 grep 正则。
 * @param command - bash 命令全文（可以是 `cd X && grep ... | head` 这种多段）。
 * @returns 编译好的正则；解析不出 pattern 时为空数组。
 */
export function grepPatterns(command: string): RegExp[] {
  const patterns: RegExp[] = []
  for (const segment of splitSegments(command)) {
    for (const { source, flags } of patternsOf(tokenize(segment))) {
      const compiled = compilePattern(source, flags)
      if (compiled !== undefined) patterns.push(compiled)
    }
  }
  return patterns
}

/** 命中在正文里的位置（`RegExp` 带 `g`，每次用前重置 `lastIndex`）。 */
function matchSpans(content: string, patterns: readonly RegExp[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      if (match[0].length > 0) spans.push({ start: match.index, end: match.index + match[0].length })
      if (match.index === pattern.lastIndex) pattern.lastIndex++
    }
  }
  spans.sort((left, right) => left.start - right.start)
  return spans
}

/**
 * 把一条超长正文裁到命中 ± 窗口，返回裁剪后的正文；命中覆盖整段时原样返回（没有可省的字符）。
 * @param content - 命中行的正文（不含 `path:行号:` 前缀）。
 * @param patterns - {@link grepPatterns} 的结果。
 * @param window - 命中两侧各留多少字符。
 */
export function trimAroundMatches(content: string, patterns: readonly RegExp[], window: number): string {
  const spans = matchSpans(content, patterns)
  if (spans.length === 0) return content
  const windows: Array<[number, number]> = []
  for (const span of spans) {
    const start = Math.max(0, span.start - window)
    const end = Math.min(content.length, span.end + window)
    const last = windows[windows.length - 1]
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else windows.push([start, end])
  }
  const first = windows[0] as [number, number]
  const lastWindow = windows[windows.length - 1] as [number, number]
  if (first[0] === 0 && lastWindow[1] === content.length) return content
  let trimmed = ''
  let position = 0
  for (const [start, end] of windows) {
    if (start > position) trimmed += `${LONG_LINE_MARK}${start - position} 字符]…`
    trimmed += content.slice(start, end)
    position = end
  }
  if (position < content.length) trimmed += `${LONG_LINE_MARK}${content.length - position} 字符]…`
  return trimmed
}

/**
 * 按命令里的 grep pattern 裁剪超长命中行；没有裁剪时返回原文（调用方据此不算「施加过」）。
 * @param text - 下游正文。
 * @param command - bash 命令全文；缺省时不处理。
 */
export function trimGrepLongLines(text: string, command: string | undefined): string {
  if (command === undefined || command === '') return text
  const patterns = grepPatterns(command)
  if (patterns.length === 0) return text
  let changed = false
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    if (line.includes(LONG_LINE_MARK) || line.includes(SINGLE_LINE_TRUNCATION)) continue
    const row = parseRow(line)
    if (row === undefined) continue
    if (row.content.length <= GREP_LONG_LINE_MIN_CHARS) continue
    const trimmed = trimAroundMatches(row.content, patterns, GREP_LONG_LINE_WINDOW)
    if (trimmed === row.content) continue
    lines[index] = row.path === undefined
      ? `${row.lead}${row.line}${row.sep}${trimmed}`
      : `${row.lead}${row.path}:${row.line}${row.sep}${trimmed}`
    changed = true
  }
  return changed ? lines.join('\n') : text
}
