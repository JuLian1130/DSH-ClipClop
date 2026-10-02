/**
 * 假 spill 后端：票 04 的观察面是**它收到的 `saveText` 入参**与**调用次数**（规格「测试决定 · 原结果入口」
 * 允许断言替换前调用存储并带完整正文），而真实后端（`@deepseek-ai/dsh-spill-local`）不在本包依赖里。
 *
 * `fail` 臂复现「写入失败 → 透传且不留入口」；返回的 `locator` / `retrievalHint` 用本机后端的形状
 * （绝对路径 + 固定提示句），因为读回识别与入口说明都按这两个值比对。
 *
 * @module
 */

import type { EntryRef, SaveEntryInput } from '../../src/entry.ts'

/** 本机后端的取回提示原文（`dsh-spill-local` 固定文案）。 */
export const RETRIEVAL_HINT = 'Use read with offset/limit, or grep this path to search within it.'

/** 记录入参的假存储后端。 */
export class FakeSpill {
  /** 每次 `saveText` 的入参，按顺序；失败的那次不记录（真实后端同样不产出入口）。 */
  readonly saves: SaveEntryInput[] = []

  /** 与 {@link saves} 一一对应的返回值，供断言入口说明的拼法。 */
  readonly refs: EntryRef[] = []

  /** 置真时 `saveText` 抛错，复现存储写入失败。 */
  fail = false

  /**
   * 记下入参并返回可读回的入口。
   * @param input - 实现发来的写入请求。
   * @returns 定位符与取回方法。
   */
  async saveText(input: SaveEntryInput): Promise<EntryRef> {
    if (this.fail) throw new Error('spill backend failed')
    const ref: EntryRef = { locator: `/spill/${input.suggestedName}`, retrievalHint: RETRIEVAL_HINT }
    this.saves.push(input)
    this.refs.push(ref)
    return ref
  }
}
