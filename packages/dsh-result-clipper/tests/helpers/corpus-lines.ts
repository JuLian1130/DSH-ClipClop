/**
 * 语料 JSONL 的行读取。
 *
 * 为什么不用 Node `readline`：它把 `U+2028`（LINE SEPARATOR）也当行尾，合法 JSON 字符串里带这个字符就会被切成
 * 两截，`JSON.parse` 报 `Unterminated string`。语料是票 14 的一次性快照，读取器适配它，只按 `\n` 切。
 *
 * @module
 */

import { createReadStream } from 'node:fs'

/**
 * 按 `\n` 读一个语料 JSONL 的每一行。
 * @param file - JSONL 路径。
 * @yields 每行正文（不含 `\n`）；末行没有换行也返回。
 */
export async function* readCorpusLines(file: string): AsyncGenerator<string> {
  let rest = ''
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    rest += chunk
    let index: number
    while ((index = rest.indexOf('\n')) !== -1) {
      yield rest.slice(0, index)
      rest = rest.slice(index + 1)
    }
  }
  if (rest !== '') yield rest
}
