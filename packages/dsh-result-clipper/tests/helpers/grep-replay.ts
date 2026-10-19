/**
 * 差分回放的 argv 解释：把一次真实 `grep` 调用的 argv 变成可重放的参数。
 *
 * 为什么单独写一份：oracle 不能依赖被测实现。argv 由 bash 切分（命令怎么分词以真实 shell 为准），
 * 这里只按 grep 自己的参数文法解释；解释不了就返回 skip（跳过并计数），不猜。
 *
 * @module
 */

/** 重放参数，或跳过原因。 */
export type Replay = { readonly args: readonly string[] } | { readonly skip: string }

/** 需要取一个值的短选项（`-e` 取 pattern，`-f` 记下整次跳过，其余取值后丢弃）。 */
const SHORT_VALUE = new Set(['e', 'f', 'A', 'B', 'C', 'm', 'D', 'd'])

/** 影响匹配结果的短选项：原样带给重放。 */
const SHORT_MATCH: Record<string, string> = { i: '-i', w: '-w', F: '-F', E: '-E', G: '-G', x: '-x' }

/** 只影响输出形状的短选项：丢弃（重放统一加 `-o`）。 */
const SHORT_DROP = new Set(['n', 'b', 'H', 'h', 'Z', 'o', 'c', 'l', 'L', 'q', 's'])

/** 影响匹配结果的长选项 → 等价短写。 */
const LONG_MATCH: Record<string, string> = {
  '--ignore-case': '-i',
  '--word-regexp': '-w',
  '--fixed-strings': '-F',
  '--extended-regexp': '-E',
  '--basic-regexp': '-G',
  '--line-regexp': '-x',
}

/** 需要取一个值的长选项（`--regexp` 是 pattern，`--file` 记下整次跳过，其余丢弃）。 */
const LONG_VALUE = new Set([
  '--regexp',
  '--file',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--max-count',
  '--after-context',
  '--before-context',
  '--context',
  '--label',
  '--binary-files',
  '--directories',
])

/** 只影响输出形状的长选项：丢弃。`--color` 的可选值只认 `=` 形式。 */
const LONG_DROP = new Set([
  '--line-number',
  '--byte-offset',
  '--with-filename',
  '--no-filename',
  '--null',
  '--only-matching',
  '--count',
  '--files-with-matches',
  '--files-without-match',
  '--quiet',
  '--silent',
  '--line-buffered',
  '--no-messages',
  '--text',
  '--initial-tab',
  '--color',
  '--colour',
  '--unix-byte-offsets',
])

/**
 * 解释一次 grep 调用的 argv。
 *
 * 返回 `{ args }` 时，`args` 是可直接跑 `grep -o` 的参数（文件操作数已剔除，正文走 stdin）；
 * 返回 `{ skip }` 表示这条调用不参与回放（例如 `-f` 模式文件、`-P`、`-r`、未知选项）。
 */
export function replayArgsOf(argv: readonly string[]): Replay {
  const patterns: string[] = []
  const matching: string[] = []
  let patternFile = false
  let sawPatternOption = false
  let stopOptions = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (!stopOptions && token === '--') {
      stopOptions = true
      continue
    }
    if (stopOptions || !token.startsWith('-') || token === '-') {
      // `--` 之后全是操作数；`-` 也是操作数。没有 `-e` / `-f` 时第一个操作数是 pattern，其余是文件（忽略）。
      if (!sawPatternOption && patterns.length === 0) patterns.push(token)
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token : token.slice(0, equals)
      const inline = equals === -1 ? undefined : token.slice(equals + 1)
      const match = LONG_MATCH[name]
      if (match !== undefined) {
        matching.push(match)
        continue
      }
      if (LONG_DROP.has(name)) continue
      if (LONG_VALUE.has(name)) {
        let value = inline
        if (value === undefined) {
          value = argv[index + 1] as string | undefined
          if (value === undefined) return { skip: 'missing-value' }
          index += 1
        }
        if (name === '--regexp') {
          patterns.push(value)
          sawPatternOption = true
        } else if (name === '--file') {
          patternFile = true
        }
        continue
      }
      return { skip: `unknown-option:${name}` }
    }
    const body = token.slice(1)
    for (let offset = 0; offset < body.length; offset += 1) {
      const flag = body[offset] as string
      const match = SHORT_MATCH[flag]
      if (match !== undefined) {
        matching.push(match)
        continue
      }
      if (SHORT_DROP.has(flag)) continue
      if (SHORT_VALUE.has(flag)) {
        const rest = body.slice(offset + 1)
        let value: string | undefined = rest === '' ? undefined : rest
        if (value === undefined) {
          value = argv[index + 1] as string | undefined
          if (value === undefined) return { skip: 'missing-value' }
          index += 1
        }
        if (flag === 'e') {
          patterns.push(value)
          sawPatternOption = true
        } else if (flag === 'f') {
          patternFile = true
        }
        break
      }
      return { skip: `unknown-flag:-${flag}` }
    }
  }

  if (patternFile) return { skip: 'pattern-file' }
  if (patterns.length === 0) return { skip: 'no-pattern' }
  return { args: ['-o', ...matching, ...patterns.flatMap((pattern) => ['-e', pattern])] }
}
