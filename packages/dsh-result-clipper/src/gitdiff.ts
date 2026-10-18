/**
 * `git diff` 命令族 handler：`compact_diff` 的发布实现。
 *
 * 形态与参数见计划 §4.4 第 1 行；算法基线是票 14 的测量原型
 * `docs/dsh-condense-measure/transforms_gitdiff.py` 的 `compact_diff`（省幅读数就是它测出来的，所以形状不
 * 自创）。每文件累计 `+N -M`，保留完整 `@@` 头，每 hunk 明细与整体行数各有封顶，前导上下文不计入后者。
 *
 * 「不丢任何 `+`/`-` 行」按**不丢账**执行：明细按封顶少显示（`maxHunkLines` 管每 hunk、`maxLines` 管整体，
 * 这一族的省幅正来自它们），但每个文件的 `  +N -M` 覆盖**整份输入**里真实的增删行数——整体预算用尽后仍继续
 * 扫完输入、只计数不再输出明细；明细里出现的每一行都逐字来自输入，不合并、不重排、不篡改。
 *
 * 内部异常一律归到 `undefined`：调用方拿 `undefined` 回退通用链，handler 抛出会把整条管道带崩。
 *
 * @module
 */

export interface GitDiffParams {
  /** 每 hunk 明细（首个变更行起）的封顶行数。 */
  readonly maxHunkLines: number
  /** 整体正文行数上限；前导上下文不计入。 */
  readonly maxLines: number
  /** 每个 hunk 里首个变更行之前最多保留的上下文行数。 */
  readonly leadingContext: number
}

/** 票 14 实测的那一档（计划 §4.4 第 1 行）：换一档，省幅读数就不可比。 */
export const GIT_DIFF_DEFAULTS: GitDiffParams = { maxHunkLines: 100, maxLines: 200, leadingContext: 3 }

/** 文件级元信息行：是合法 diff 结构、不是 hunk 内容（照票 14 原型的识别集合，不动）。 */
const META_PREFIXES = [
  'index ', 'new file mode ', 'deleted file mode ', 'old mode ', 'new mode ',
  'similarity index ', 'dissimilarity index ', 'rename from ', 'rename to ',
  'copy from ', 'copy to ', 'Binary files ', 'GIT binary patch', 'literal ', 'delta ',
]

/**
 * 其中「文件发生了什么变化」的那些行。没有 hunk 的文件（纯权限变更、重命名/复制、二进制、新建空文件）里，
 * 这些是它唯一的观察面——全丢掉就只剩一个文件名，读者看不出它到底怎么了。
 */
const CHANGE_PREFIXES = [
  'new file mode ', 'deleted file mode ', 'old mode ', 'new mode ',
  'similarity index ', 'dissimilarity index ', 'rename from ', 'rename to ',
  'copy from ', 'copy to ', 'Binary files ',
]

function isFileMeta(line: string): boolean {
  return line === '---' || line === '+++'
    || line.startsWith('--- ') || line.startsWith('+++ ')
    || META_PREFIXES.some((prefix) => line.startsWith(prefix))
}

function isChangeLine(line: string): boolean {
  return CHANGE_PREFIXES.some((prefix) => line.startsWith(prefix))
}

/** 守卫放弃的内部信号；只用于把控制流从嵌套分支里带出来，落到公开接缝上仍是 `undefined`。 */
class Abstain extends Error {}

/**
 * `@@ -a,b -c,d +e,f @@` 的解析结果。
 *
 * `parents` 按标记列顺序（`-` 侧），`remainingNew` 是 `+` 侧的剩余行数；两边的计数都递减到 0 时 hunk 才算
 * 耗尽。`width` 是标记列数：`@@` 头是 1，`@@@`（`--cc` / `--combined`）是 2。
 */
class Hunk {
  readonly width: number
  private readonly parents: number[]
  private remainingNew: number

  constructor(parents: number[], remainingNew: number, width: number) {
    this.parents = parents
    this.remainingNew = remainingNew
    this.width = width
  }

  exhausted(): boolean {
    return this.remainingNew === 0 && this.parents.every((count) => count === 0)
  }

  consume(markers: string): void {
    const isAdd = markers.includes('+')
    const isDel = markers.includes('-')
    this.parents.forEach((remaining, index) => {
      const column = index < markers.length ? markers[index] : ''
      // 删行只消耗 `-` 列；其余行消耗非 `+` 列（`+` 行不该减父侧计数）。短于前缀的行读作 context。
      const present = isDel ? column === '-' : column !== '+'
      if (present) this.parents[index] = Math.max(remaining - 1, 0)
    })
    if (isAdd || !isDel) this.remainingNew = Math.max(this.remainingNew - 1, 0)
  }
}

/**
 * `@@` 头解析；`undefined` 表示这行不是 hunk 头。
 *
 * 计数缺省是 1（`@@ -1 +1 @@`），列数由 `@` 的个数决定——列数说了算，缺的 parent 记为「永不耗尽」，
 * 与 RTK / 票 14 原型一致：`@@@` 的宽度是 2，只认第一个 `-` 组会把两列合并 diff 读错。
 */
function parseHunkHeader(line: string): Hunk | undefined {
  let atRun = 0
  while (atRun < line.length && line[atRun] === '@') atRun += 1
  if (atRun < 2) return undefined

  const body = line.slice(atRun).split('@')[0] ?? ''
  const parents: number[] = []
  let newCount: number | undefined
  for (const group of body.split(/\s+/)) {
    if (group === '' || (group[0] !== '-' && group[0] !== '+')) continue
    const rest = group.slice(1)
    const comma = rest.indexOf(',')
    let count = 1
    if (comma >= 0) {
      const digits = rest.slice(comma + 1)
      if (!/^\d+$/.test(digits)) return undefined
      count = Number(digits)
    }
    if (group[0] === '-') parents.push(count)
    else newCount = count
  }

  const width = atRun - 1
  if (parents.length !== width) {
    const padded = parents.slice(0, width)
    while (padded.length < width) padded.push(Number.MAX_SAFE_INTEGER)
    parents.length = 0
    parents.push(...padded)
  }
  return new Hunk(parents, newCount ?? 0, width)
}

const GIT_DIFF_HEADER = 'diff --git '

/** C-style 简单转义表；Git 的 `quote_c_style` 只产出这几个加八进制字节。 */
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }

/**
 * 从 `source[start]` 的 `"` 起按 C 语义反转义，返回路径与收尾引号之后的位置。
 *
 * Git 用八进制写非 ASCII 字节（`\344`），所以这里按字节收集、最后整体按 UTF-8 解码；收不到引号、转义不认识
 * 或解出来不是合法 UTF-8 就返回 `undefined`——猜一个文件名不如让调用方退回原文件头。
 */
function unquotePath(source: string, start: number): { value: string; end: number } | undefined {
  const bytes: number[] = []
  let index = start + 1
  while (index < source.length) {
    const char = source[index]!
    if (char === '"') {
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
        return { value, end: index + 1 }
      } catch {
        return undefined
      }
    }
    if (char !== '\\') {
      const code = char.codePointAt(0)!
      if (code < 0x80) bytes.push(code)
      else bytes.push(...new TextEncoder().encode(char))
      index += code > 0xffff ? 2 : 1
      continue
    }
    const escape = source[index + 1]
    if (escape === undefined) return undefined
    if (escape in C_ESCAPES) {
      bytes.push(C_ESCAPES[escape]!)
      index += 2
      continue
    }
    if (escape >= '0' && escape <= '7') {
      let digits = ''
      let cursor = index + 1
      while (cursor < source.length && digits.length < 3 && source[cursor]! >= '0' && source[cursor]! <= '7') {
        digits += source[cursor]
        cursor += 1
      }
      bytes.push(Number.parseInt(digits, 8))
      index = cursor
      continue
    }
    return undefined
  }
  return undefined
}

/**
 * 从 `diff --git` 头的第二段起取出目标侧的真实路径（已去 `b/` 前缀）；切不开时 `undefined`。
 *
 * 三种形态分开处理，因为 `b/` 前缀在哪一侧被吃掉不一样：两侧都引号时前缀在解出来的字符串里；只有目标侧
 * 引号时前缀也在里面；两侧都不引号时 ` b/` 这个切分点本身就把前缀吃掉了，剩下的就是裸路径（文件名真的
 * 以 `b/` 开头时不能再剥一次）。
 */
function resolveHeaderTarget(rest: string): string | undefined {
  if (rest.startsWith('"')) {
    const first = unquotePath(rest, 0)
    if (first === undefined || rest[first.end] !== ' ') return undefined
    const second = rest.slice(first.end + 1)
    if (second === '') return undefined
    const raw = second.startsWith('"')
      ? unquotePath(second, 0)
      : (second.includes('"') ? undefined : { value: second, end: second.length })
    if (raw === undefined || raw.end !== second.length) return undefined
    return stripTargetPrefix(raw.value)
  }

  const quote = rest.indexOf('"')
  if (quote >= 0) {
    // 目标侧带引号、源侧不带（重命名到非 ASCII 路径就是这一形态）：切分点由那个引号定。
    if (quote === 0 || rest[quote - 1] !== ' ') return undefined
    const quoted = unquotePath(rest, quote)
    if (quoted === undefined || quoted.end !== rest.length) return undefined
    return stripTargetPrefix(quoted.value)
  }

  // 两侧都不带引号：` b/` 每次出现都是一个候选切分点，只有唯一候选才算无歧义。引号路径不可能含引号，
  // 所以上面的分支已经覆盖了「切分点由引号定」的形态。
  const candidates: number[] = []
  for (let index = rest.indexOf(' b/'); index >= 0; index = rest.indexOf(' b/', index + 1)) {
    if (rest.slice(0, index).startsWith('a/')) candidates.push(index)
  }
  if (candidates.length !== 1) return undefined
  return rest.slice(candidates[0]! + ' b/'.length)
}

function stripTargetPrefix(path: string): string {
  return path.startsWith('b/') ? path.slice('b/'.length) : path
}

/**
 * `diff --git a/x b/x` → `x`；`diff --cc x` → `x`。
 *
 * 无法无歧义还原时返回整行原文件头：读者看到的是原始头，而不是被挂到别的文件名下的增减量。
 */
function diffHeaderPath(line: string): string {
  const firstSpace = line.indexOf(' ')
  const secondSpace = firstSpace < 0 ? -1 : line.indexOf(' ', firstSpace + 1)
  if (secondSpace < 0) return 'unknown'
  const rest = line.slice(secondSpace + 1)
  // `diff --cc x` 之类只有一个路径，没有切分问题。
  if (!line.startsWith(GIT_DIFF_HEADER)) return rest
  return resolveHeaderTarget(rest) ?? line
}

/**
 * 被明细封顶丢掉的行按侧汇总成一句注记；两侧都没丢就不是注记。
 *
 * 注记带上被丢掉那一整段在**原文**里的行号（票 23）：拿入口路径 + 这组行号就能只读被省掉的明细，不必把整份
 * diff 读回来。`from` / `to` 是 1 基原文行号；`from` 为 0 表示没有行号可报。
 */
function truncationNote(deletions: number, additions: number, from: number, to: number): string | undefined {
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  if (deletions === 0 && additions === 0) return undefined
  const range = from > 0 && to >= from ? `: 原文第 ${lineRange(from, to)} 行；先读这段，不够再 grep` : ''
  if (deletions === 0) return `  ... (${count(additions, 'addition')} truncated${range})`
  if (additions === 0) return `  ... (${count(deletions, 'deletion')} truncated${range})`
  return `  ... (${count(deletions, 'deletion')}, ${count(additions, 'addition')} truncated${range})`
}

/** 原文行号：单行只写一个行号，多行写 `起–止`。 */
function lineRange(from: number, to: number): string {
  return from === to ? `${from}` : `${from}–${to}`
}

export function compactDiff(text: string, params: GitDiffParams): string | undefined {
  try {
    return compact(text, params)
  } catch {
    return undefined
  }
}

function compact(text: string, params: GitDiffParams): string {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const result: string[] = []
  let currentFile = ''
  let added = 0
  let removed = 0
  let hunk: Hunk | undefined
  let hunkShown = 0
  let skippedAdd = 0
  let skippedDel = 0
  let sawAnyHunk = false
  const leading: string[] = []
  let leadingTotal = 0
  // 整体行数预算用尽后继续扫完整份输入、只计数不再输出明细：聚合量只数到断点就是假事实，而这一族的省幅
  // 96% 来自 maxLines 的截断，所以它是主路径不是边角。
  //
  // **截断之后每个文件仍然输出「文件名 + 聚合量」**（约 2 行/文件），代价是文件数极多时输出会超出 `maxLines`。
  // 取舍依据是实测：本语料里这一族真正会改动的 git diff 调用 **1,009 次**（量法：票 14 原型 `compact_diff` 在过
  // 下限的 `bash` 行上未放弃且正文有变化；发布实现最终替换 698 次，差额由预留口径与截断后行为解释，见设计文档
  // 「验证状态」），文件数中位 2 / p90 6 / p99 12 / **最多 15**，所以越界上限约 30 行（15%）；换来的是**没有
  // 任何文件静默丢掉自己的数字**——而只给断点那个文件收尾会让其余文件在正文里只剩一个文件名、看不出改了多少。
  let cut = false
  // 注记要报的原文行号（1 基）：本段第一个 / 最后一个被明细封顶丢掉的行；`skippedFrom === 0` 表示还没丢。
  let skippedFrom = 0
  let skippedTo = 0
  // 全 diff 的前导上下文按整体行数上限的十分之一封顶；它不进 `maxLines` 的计数，否则前导上下文会跨 hunk
  // 无界增长（票 16 备注的推导）。
  const leadingCap = Math.floor(params.maxLines / 10)

  // 只有变更行真被写出来时，它前面的上下文才有意义——否则先把它们挂在这里。截断之后不再有明细，也就
  // 不再需要这些前导行。
  const flushLeading = (): void => {
    if (cut) {
      leading.length = 0
      return
    }
    const room = Math.max(leadingCap - leadingTotal, 0)
    const keep = Math.min(leading.length, room)
    if (keep > 0) result.push(...leading.slice(leading.length - keep))
    leading.length = 0
    leadingTotal += keep
  }

  // 一个 hunk 没耗尽就换文件 / 换 hunk，说明这份正文不是完整的 unified diff：整次放弃。
  const closeHunk = (reason: string): void => {
    if (hunk !== undefined && !hunk.exhausted()) throw new Abstain(reason)
    hunk = undefined
  }

  // 明细封顶的注记只在还有明细的时候有意义；截断之后由 `... (more changes truncated)` 兜底。
  const flushNote = (): void => {
    if (cut) return
    const note = truncationNote(skippedDel, skippedAdd, skippedFrom, skippedTo)
    if (note === undefined) return
    result.push(note)
    skippedDel = 0
    skippedAdd = 0
    skippedFrom = 0
    skippedTo = 0
  }

  linesLoop: for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] as string
    // diff 正文里的 `\r` 是行内覆盖痕迹，不是内容的一部分。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('diff --')) {
      flushLeading()
      closeHunk('hunk-unterminated-before-file-header')
      flushNote()
      // 截断之后照旧输出文件名与聚合量：计数要能归到文件上，而每个文件的数字都得是整份输入的真实数。
      if (currentFile !== '' && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`)
      currentFile = diffHeaderPath(line)
      result.push(`\n${currentFile}`)
      added = 0
      removed = 0
      hunkShown = 0
    } else {
      const header = parseHunkHeader(line)
      if (header !== undefined) {
        flushLeading()
        closeHunk('hunk-unterminated-before-next-hunk')
        hunk = header
        hunkShown = 0
        sawAnyHunk = true
        flushNote()
        if (!cut) result.push(line)
      } else {
        if (hunk !== undefined) {
          if (line.startsWith('\\')) {
            if (line.length > 1 && !line.startsWith('\\ No newline')) throw new Abstain('bad-no-newline-marker')
            // `\ No newline at end of file` 注解上一行，本身不是行数。
            continue linesLoop
          }
          const markers = line.slice(0, Math.min(hunk.width, line.length))
          if ([...markers].some((marker) => marker !== ' ' && marker !== '+' && marker !== '-')) {
            // 标记列里出现别的东西：不是合法 hunk 行（`--word-diff` 的无标记正文行也落这里）。
            throw new Abstain('bad-marker-column')
          }
          const isAdd = markers.includes('+')
          const isDel = markers.includes('-')
          hunk.consume(markers)
          if (isAdd || isDel) {
            // 计数与明细分开：明细可以少显示，账不能少记。
            if (isAdd) added += 1
            if (isDel) removed += 1
            if (!cut) {
              if (hunkShown < params.maxHunkLines) {
                flushLeading()
                result.push(line)
                hunkShown += 1
              } else {
                if (isDel) skippedDel += 1
                else skippedAdd += 1
                if (skippedFrom === 0) skippedFrom = index + 1
                skippedTo = index + 1
              }
              leading.length = 0
            }
          } else if (!cut && hunkShown > 0) {
            if (hunkShown < params.maxHunkLines) {
              result.push(line)
              hunkShown += 1
            }
          } else if (!cut && leadingTotal < leadingCap) {
            leading.push(line)
            while (leading.length > params.leadingContext) leading.shift()
          }
          if (hunk.exhausted()) {
            hunk = undefined
            flushLeading()
          }
        } else if (line.trim() === '') {
          // 空行是合法的结构空隙。
        } else if (line.startsWith('\\ No newline')) {
          // 上一行耗尽 hunk 时，注记落在 hunk 之外。
        } else if (isFileMeta(line)) {
          // 文件级元信息（`index` / `---` / `+++`）在正文里不承载判断；「变化类型」那一行除外——那是没有
          // hunk 的文件唯一的观察面，截断之后也得留，否则它只剩一个文件名。
          if (isChangeLine(line)) result.push(line)
        } else if (!text.includes('@@')) {
          // `--stat` / `--name-only` / `git show <rev>:<path>`：正文压根不是 unified diff。
          throw new Abstain('not-a-unified-diff')
        } else {
          throw new Abstain('stray-line-outside-hunk')
        }
      }
    }

    if (!cut && result.length - leadingTotal >= params.maxLines) {
      // 断点之前已按明细封顶丢过的行，先把注记写出来再收尾；之后的行只计数、不再产生明细。
      flushNote()
      // 断点之后只剩文件名与聚合量，明细全都省了：把省掉的原文行号写进注记（票 23），
      // 模型据此只读那一段。断在最后一行时没有省掉任何明细，那就只留原来那句话。
      const from = index + 2
      const range = from <= lines.length ? `: 原文第 ${lineRange(from, lines.length)} 行；先读这段，不够再 grep` : ''
      result.push(`\n... (more changes truncated${range})`)
      cut = true
    }
  }

  if (hunk !== undefined) throw new Abstain('hunk-unterminated-at-eof')
  if (!sawAnyHunk && !lines.some((line) => line.startsWith('diff --'))) throw new Abstain('not-a-unified-diff')

  flushLeading()
  flushNote()
  if (currentFile !== '' && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`)
  return result.join('\n')
}
