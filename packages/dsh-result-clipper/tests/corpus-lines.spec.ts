/**
 * 票 32：语料行只按 `\n` 切。
 *
 * 护栏不依赖 `/tmp` 语料是否在场：临时文件里放一行含 `U+2028` 的合法 JSON，`readline` 会把它切成两截，
 * 本读取器必须整行返回且能 `JSON.parse`；超过读块的长行要跨块拼接；无结尾换行的末行也要返回。
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCorpusLines } from './helpers/corpus-lines.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 写入一份临时语料，返回路径。 */
function corpusFile(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-corpus-lines-'))
  roots.push(root)
  const file = join(root, 'corpus.jsonl')
  writeFileSync(file, content)
  return file
}

/** 收齐整份语料的行。 */
async function collect(file: string): Promise<string[]> {
  const lines: string[] = []
  for await (const line of readCorpusLines(file)) lines.push(line)
  return lines
}

describe('readCorpusLines', () => {
  it('JSON 字符串里的 U+2028 不切行，整行可解析', async () => {
    const row = JSON.stringify({ callId: 'x', text: '前\u2028后' })
    const lines = await collect(corpusFile(`${row}\n`))
    expect(lines).toEqual([row])
    expect(JSON.parse(lines[0] as string)).toEqual({ callId: 'x', text: '前\u2028后' })
  })

  it('超过一个读块的长行整行返回（跨块残段拼接）', async () => {
    // 读块 64 KiB；语料最长行 139,420 字节，跨块拼接是真实路径，不能只测块内的小行。
    const row = JSON.stringify({ callId: 'long', text: 'x'.repeat(200_000) })
    const lines = await collect(corpusFile(`${row}\n`))
    expect(lines).toEqual([row])
    expect(JSON.parse(lines[0] as string)).toEqual({ callId: 'long', text: 'x'.repeat(200_000) })
  })

  it('没有结尾换行的末行照常返回', async () => {
    const first = JSON.stringify({ callId: 'a' })
    const last = JSON.stringify({ callId: 'b' })
    expect(await collect(corpusFile(`${first}\n${last}`))).toEqual([first, last])
  })
})
