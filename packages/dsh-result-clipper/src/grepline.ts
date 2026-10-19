/**
 * 命中长行的「围绕命中裁剪」：bash 的 `grep` 结果里，命中行偶尔会很长（sourcemap 的 `mappings`、内联源码
 * 字符串、JSONL 记录），模型要的是命中片段而不是整条记录。本模块把超长命中行裁到命中 ±{@link GREP_LONG_LINE_WINDOW}
 * 字符，其余标 `…[省略 N 字符]…`。
 *
 * 依据（票 26，`docs/dsh-sed-grep-cost.md` 第五节）：语料里 5,292 条 >300 字的命中行，86% 能按命令里的
 * pattern 定位到命中；整条变换在 5.84M token 的样本上省 0.59M（10.2%），折算到全部 grep token 约 6.9%。
 * 定位不到的行**原样保留**（不省也不破坏）。
 *
 * 三条边界：
 *
 * 1. **只认 grep 自己的输出形状**：`path:行号:正文` 或 `行号:正文`（分隔符是 `-` 的单文件上下文行也认；
 *    多文件 `-A/-B` 的 `path-行号-正文` 是上下文行、不是命中行，不裁；已分组输出里的组员 `行号-正文` 同样
 *    不裁——分组把前者改写成这个形状，第二遍再裁会与第一遍不同）。
 * 2. **只认命令位的 grep**：分段的首个命令才是命令位；`xargs` / `env` / `sudo` / `time` / `nice` / `nohup` /
 *    `command` 这些包装连同它们自己的选项与取值可以出现在前面（`xargs -0 grep`、`sudo -u root grep`）。引号
 *    里的 `grep`、`printf` 的参数、`git log --grep` 都不算。
 * 3. **幂等**：已经带省略标记、或已被 `tail-cap` 单行截断的行跳过——整链第二遍施加时这条规则不改变任何行。
 *    规则是**有损**的，靠调用方的回退入口兜底。
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
 * 开头的空白单独留下：`grep … | sed 's/^/  /'` 这类管道会给每行加前缀，裁剪要把前缀原样写回。`group-paths`
 * 也先剥掉行首空白再判「路径候选是否含空白」，两边同一套排除；行首缩进不算路径的一部分，不剥就会把带前缀的
 * 多文件输出当成「路径含空白」，永远不分组（第二轮复审抓到）。
 */
const PATH_ROW = /^(\s*)(.+?):(\d+)([:-])(.*)$/

/**
 * 把一行拆成 `{ lead, path?, line, sep, content }`；不是 grep 输出形状时 `undefined`。
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
      // 双引号里的反斜杠能转义引号（`\"`），下一个字符不能当引号结束；单引号里反斜杠没有这个作用。
      // 切分只需要判断引号何时结束，真正把转义解成字符在 `tokenize` 里（票 26 第五轮复审）。
      if (quote === '"' && char === '\\' && index + 1 < command.length) {
        current += command[index + 1] as string
        index++
        continue
      }
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

/** 把一个段切成 token：去引号、引号外的反斜杠按 shell 规则解掉、引号内的空白不切。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | undefined
  // 当前位置是否已经在 token 里。引号开合本身也算：`-e ''` 的空参数是 shell 的一个真实取值，不能丢
  // （丢了以后 `-e` 会拿下一个参数当 pattern，通常是文件名——票 26 第五轮复审）。
  let started = false
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] as string
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        continue
      }
      // 双引号里的反斜杠只对 `$` `` ` `` `"` `\` 与换行有转义作用（shell 规则），其余原样保留；单引号里
      // 反斜杠没有转义作用，连引号结束都只认 `'`（票 26 第五轮复审，双引号内 `\\` 曾被原样保留）。
      if (quote === '"' && char === '\\' && index + 1 < segment.length) {
        const next = segment[index + 1] as string
        if (next === '\n') {
          index++
          continue
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          index++
          continue
        }
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    // 引号外的反斜杠是 shell 自己的转义：`grep -n a\+b` 里的 `\+` 到 grep 手里已经是 `+`。不剥掉的话
    // BRE 会把它当「一个或多个」编译，真实命中 `a+b` 反而丢掉、假命中 `aaab` 被留下（第二轮复审抓到）。
    if (char === '\\' && index + 1 < segment.length) {
      current += segment[index + 1] as string
      started = true
      index++
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 允许出现在 `grep` 前面的包装命令，以及它们自己**带取值**的选项（`sudo -u root grep`、`xargs -n 1 grep`）。
 * 只列「取值需要一起跨过」的选项；其他选项按单个 token 跳过。
 */
const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['command', new Set()],
  ['env', new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['sudo', new Set(['-u', '-g', '-p', '-U', '-r', '-t', '-T', '-h', '-D', '-C', '--user', '--group', '--prompt', '--other-user', '--role', '--type', '--command-timeout', '--host', '--chdir', '--close-from'])],
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['xargs', new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'])],
])

/** 段首的变量赋值（`FOO=1 grep …`）也算前缀，不改变「grep 是命令位」这一判断。 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** 带一个取值的短选项（`-A 3` / `-m 5`；`-e` / `-f` 在 {@link patternsOf} 里单独处理）。 */
const VALUE_FLAGS = new Set([
  '-A', '-B', '-C', '-m',
  '--include', '--exclude', '--exclude-dir',
  '--max-count', '--after-context', '--before-context', '--context',
])

/** 纯字母短选项簇（`-rnwiE`）；带 `e` / `f` 的簇单独处理，因为它们可能把下一个 token 当取值。 */
const SHORT_FLAGS = /^-[A-Za-z]+$/

/** 带语义的长写选项与短写字母：`--fixed-strings` 与 `-F` 必须同样处理，否则会按错误方言裁。 */
const LONG_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--extended-regexp', 'E'],
  ['--fixed-strings', 'F'],
  ['--ignore-case', 'i'],
  ['--perl-regexp', 'P'],
  ['--word-regexp', 'w'],
])

/**
 * 段首真正被执行的那条命令的下标：跳过变量赋值与包装命令，连同包装自己的选项和取值。
 *
 * 只看 `grep` 前一个 token 不够（第二轮复审抓到）：`printf '%s\n' env grep …` 里的 `env` 只是 printf 的
 * 参数，却被当成「grep 在 env 之后」而误裁；反过来 `xargs -0 grep`、`sudo -u root grep` 又因为中间隔着
 * 选项而认不出、白白漏裁。这里从段首顺着包装链走到命令，只有命令本身是 grep 才算命令位。
 * @param tokens - 一个段的 token。
 * @returns 命令 token 的下标；段里只有赋值或包装时 `undefined`。
 */
function commandIndexOf(tokens: readonly string[]): number | undefined {
  let index = 0
  while (index < tokens.length) {
    while (index < tokens.length && ASSIGNMENT.test(tokens[index] as string)) index++
    if (index >= tokens.length) return undefined
    const values = WRAPPER_VALUE_FLAGS.get(tokens[index] as string)
    if (values === undefined) return index
    index++
    while (index < tokens.length && (tokens[index] as string).startsWith('-')) {
      index += values.has(tokens[index] as string) ? 2 : 1
    }
  }
  return undefined
}

/**
 * 拆一个短选项簇：`-e PAT`、`-nf PATTERNS`、`-nePAT` 都能认。
 * @param token - 以 `-` 开头的 token。
 * @returns 选项字母、`e`/`f` 的种类与可能附在簇尾的取值；不是这种形状时 `undefined`。
 */
function shortCluster(token: string): { flags: string; kind: 'e' | 'f'; attached: string } | undefined {
  const match = /^-([A-Za-z]*?)([ef])(.*)$/.exec(token)
  if (match === null) return undefined
  return { flags: match[1] as string, kind: match[2] as 'e' | 'f', attached: match[3] as string }
}

/**
 * 从一个段里收集 `grep` 的 pattern 与短选项。
 *
 * 只有命令位是 `grep` 时才解析（见 {@link commandIndexOf}）：段里其他位置的同名 token（`echo grep …`、
 * `printf '%s\n' grep …`）不算。`-f`（模式来自文件）的调用不表态。
 * @param tokens - 一个段的 token。
 * @returns 每个 `grep` 调用声明的 pattern 与选项。
 */
function patternsOf(tokens: readonly string[]): ReadonlyArray<{ readonly source: string; readonly flags: ReadonlySet<string> }> {
  const patterns: Array<{ readonly source: string; readonly flags: ReadonlySet<string> }> = []
  const commandIndex = commandIndexOf(tokens)
  if (commandIndex === undefined) return patterns
  const command = tokens[commandIndex] as string
  if (command !== 'grep' && !command.endsWith('/grep')) return patterns
  const flags = new Set<string>()
  const explicit: string[] = []
  let pattern: string | undefined
  let fromFile = false
  let cursor = commandIndex + 1
  while (cursor < tokens.length) {
    const next = tokens[cursor] as string
    const cluster = shortCluster(next)
    if (cluster !== undefined) {
      for (const flag of cluster.flags) flags.add(flag)
      const value = cluster.attached !== '' ? cluster.attached : tokens[cursor + 1]
      if (cluster.kind === 'e') {
        if (value !== undefined) explicit.push(value)
      } else {
        fromFile = true
      }
      cursor += cluster.attached !== '' ? 1 : 2
      continue
    }
    if (next.startsWith('--regexp=')) {
      explicit.push(next.slice('--regexp='.length))
      cursor++
      continue
    }
    if (next === '--regexp') {
      const value = tokens[cursor + 1]
      if (value !== undefined) explicit.push(value)
      cursor += 2
      continue
    }
    if (next.startsWith('--file=')) {
      fromFile = true
      cursor++
      continue
    }
    if (next === '--file') {
      fromFile = true
      cursor += 2
      continue
    }
    const long = LONG_FLAGS.get(next)
    if (long !== undefined) {
      flags.add(long)
      cursor++
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
    // 非选项：还没拿到 pattern 时它就是 pattern，否则是文件/目录。GNU grep 的 getopt 会置换参数，选项写在
    // pattern 之后照样生效（`grep -n MATCH -i f`），所以这里不退出，继续把后面的选项收进来——不然
    // `-i` / `-F` / `-E` 这类会改变匹配的选项被漏掉，真实命中就被裁掉了（第三轮复审抓到）。
    if (pattern === undefined && explicit.length === 0) pattern = next
    cursor++
  }
  if (fromFile) return patterns
  if (pattern !== undefined) explicit.push(pattern)
  // 空 pattern（`-e ''` / `''`）匹配所有行、没有可定位的命中位置；按整次调用不表态。不这样判的话，一旦
  // 分词把空参数丢掉，`-e` 的取值会左移成文件名、按文件名裁行（票 26 第五轮复审）。
  if (explicit.some(source => source === '')) return patterns
  // POSIX 字符类（`[[:digit:]]`）原样丢给 JS 会变成「这些符号的集合」，匹配不到真实字符、把命中裁掉。
  // 方言不猜，且要按**整次 grep 调用**放弃：只丢掉含字符类的那一个 pattern、拿其余 pattern 去裁，同样会把
  // 它的真实命中标成省略（第四轮复审实测 `-e MATCH -e '[[:digit:]]'`）。`-F` 下字符类就是字面量，照常编译。
  if (!flags.has('F') && explicit.some(source => /\[:[a-z]+:\]/.test(source))) return patterns
  // POSIX 是 leftmost-longest、JS 是 leftmost-first：`grep -E 'BEGIN|BEGIN.*END'` 的真实命中以 END 结尾，
  // JS 只认第一个能成立的短分支 BEGIN，按它的窗口裁会把命中后半截删掉。方言不猜，含交替分支的整次调用
  // 不表态（与 `-P`、POSIX 字符类同层；票 26 第五轮复审）。
  if (!flags.has('F') && explicit.some(source => hasAlternation(source, flags.has('E')))) return patterns
  for (const source of explicit) patterns.push({ source, flags })
  return patterns
}

/**
 * 把 BRE（`grep` 默认的正则方言）翻成 JS 正则。
 *
 * BRE 里 `+ ? ( ) { } |` 是**字面量**，要写成 `\+ \? \( \) \{ \} \|` 才是操作符；JS 正好的反过来。只做这个
 * 方向的对换，其余字符原样保留（`* . [ ] ^ $` 两边同义）——不做对换的话 `grep 'a+b'` 会被当成量词、把真实
 * 命中 `a+b` 丢掉（票 26 复审抓到）。
 * @param source - BRE 模式。
 * @returns JS 正则源码。
 */
function translateBre(source: string): string {
  let out = ''
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string
    if (char !== '\\') {
      out += '+?(){}|'.includes(char) ? `\\${char}` : char
      continue
    }
    const next = source[index + 1]
    if (next === undefined) {
      out += '\\\\'
      break
    }
    if ('|()+?{}'.includes(next)) {
      out += next
    } else if (next === '<' || next === '>') {
      out += '\\b'
    } else {
      out += `\\${next}`
    }
    index++
  }
  return out
}

/**
 * 模式里有没有**交替分支**（POSIX 的 leftmost-longest 与 JS 的 leftmost-first 不等价）：方括号表达式里的
 * `|` 是普通字符，`-F` 下整串都是字面量，都不算；转义规则按方言——ERE 是裸 `|`，BRE 是 `\|`。
 * @param source - pattern 原文。
 * @param extended - 是不是 `-E`（ERE）。
 * @returns 有交替分支时为 `true`。
 */
function hasAlternation(source: string, extended: boolean): boolean {
  let bracketStart = -1
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string
    if (bracketStart >= 0) {
      // `]` 紧跟 `[` / `[^` 时是字面量，其余 `]` 收尾方括号表达式。
      const literalClose = index === bracketStart + 1
        || (index === bracketStart + 2 && source[bracketStart + 1] === '^')
      if (char === ']' && !literalClose) bracketStart = -1
      continue
    }
    if (char === '[') {
      bracketStart = index
      continue
    }
    if (char === '\\' && index + 1 < source.length) {
      if (!extended && source[index + 1] === '|') return true
      index++
      continue
    }
    if (extended && char === '|') return true
  }
  return false
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 编译一个 pattern。
 * @param source - pattern 原文。
 * @param flags - 选项字母。
 * @returns 正则；`-P`（PCRE）与编译失败一律 `undefined`——宁可不动，也不按别的方言猜着裁。
 */
function compilePattern(source: string, flags: ReadonlySet<string>): RegExp | undefined {
  if (flags.has('P')) return undefined
  const fixed = flags.has('F')
  let body = fixed ? escapeRegExp(source) : flags.has('E') ? source : translateBre(source)
  // `-w` 的语义是「命中片段的左右邻接字符都不是词字符」，不是 `\b`：`\b` 要求边界一侧是词字符，
  // 对 `@`、`TODO:` 这种以非词字符收尾的 pattern 恰好反过来——`\b(?:@)\b` 会命中 `a@b` 而漏掉 ` @ `
  // （第二轮复审实测）。用两侧 lookaround 直接表达 grep 的邻接条件。
  if (flags.has('w')) body = `(?<!\\w)(?:${body})(?!\\w)`
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
 *
 * 中间的空档也要标出来：首尾各命中一处、中间隔一大段时，不能因为两端被窗口覆盖就整行返回——那样后面的
 * `tail-cap` 会按行首截断，把末尾的命中丢掉（票 26 复审抓到）。
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
  let trimmed = ''
  let position = 0
  for (const [start, end] of windows) {
    if (start > position) trimmed += `${LONG_LINE_MARK}${start - position} 字符]…`
    trimmed += content.slice(start, end)
    position = end
  }
  if (position < content.length) trimmed += `${LONG_LINE_MARK}${content.length - position} 字符]…`
  return trimmed === content ? content : trimmed
}

/** 已分组输出的组员行前缀（与 `condense.ts` 的 `GROUPED_ROW` 同形：`行号:` / `行号-`）。 */
const GROUPED_MEMBER_ROW = /^\d+[:-]/

/**
 * 这一行像不像 `group-paths` 写出的组头（路径行）：不含空白、长度有限、不是空行或 `--`。
 *
 * 组头只用来判断 `行号-正文` 是不是「已分组多文件输出」的上下文组员：分组把 `path-行号-正文` 改写成
 * 这个形状，第二遍再按单文件上下文行裁就会与第一遍不同（整链幂等，票 26 第五轮复审）。单文件输出没有
 * 组头，连续组员行一直走到正文开头，`undefined` 即不算。
 * @param header - 连续组员行之前的那一行；没有时为 `undefined`。
 * @returns 像组头时为 `true`。
 */
function isGroupedHeader(header: string | undefined): boolean {
  if (header === undefined) return false
  const candidate = header.replace(/^\s+/, '')
  return candidate !== '' && candidate !== '--' && candidate.length <= 300 && !/\s/.test(candidate)
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
  // 连续组员行的起点：已分组输出里组头紧挨在连续组员之前；单文件输出没有组头，下标停在正文开头。
  let runStart = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    if (!GROUPED_MEMBER_ROW.test(line)) runStart = index + 1
    if (line.includes(LONG_LINE_MARK) || line.includes(SINGLE_LINE_TRUNCATION)) continue
    const row = parseRow(line)
    if (row === undefined) continue
    // 已分组多文件输出的上下文组员（`行号-正文`）不裁：分组把 `path-行号-正文` 改写成这个形状，第二遍再按
    // 单文件上下文行裁就会与第一遍不同（整链幂等，票 26 第五轮复审）。
    if (row.path === undefined && row.sep === '-' && isGroupedHeader(runStart > 0 ? lines[runStart - 1] : undefined)) continue
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
