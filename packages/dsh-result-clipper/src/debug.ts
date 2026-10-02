/**
 * debug 记录管道：把一条工具结果的处理去向写成一行 metadata JSONL。
 *
 * 记录**不含**原文、摘要正文、完整提示词与凭据（规格「契约 · debug JSONL 字段」），所以这里的字段只有
 * 元数据。`结果取值` 是封闭的两段式（动作 + 未改动原因），本票唯一引入的取值是 `summary-off`——摘要能力
 * 关闭时每条结果都落它；其余取值由引入对应机制的票各自加入（`not-candidate` 自 03 起）。
 *
 * @module
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 一条记录的「结果取值」：动作取闭集之一，`unmodified` 时必须附原因。 */
export interface DebugOutcome {
  /** 结果的去向。本票只产出 `unmodified`（插件不改变内容）。 */
  action: 'unmodified'
  /** 未改动的原因。本票只引入 `summary-off`（摘要能力关闭）。 */
  reason: 'summary-off'
}

/** 一行 debug JSONL。 */
export interface DebugRecord extends DebugOutcome {
  /** 工具名。 */
  toolName: string
  /** 结果大小：文本块的 UTF-8 字节数（图片等非文本块不计入）。 */
  resultBytes: number
  /** 调用耗时：本监听器从拿到结果到最终决策的毫秒数。 */
  durationMs: number
}

/**
 * 结果大小：文本块的 UTF-8 字节数。
 * @param content - 工具结果的渲染投影。
 * @returns 文本块合计字节数；没有文本块时为 0。
 */
export function measureContent(content: readonly ContentBlock[]): number {
  let bytes = 0
  for (const block of content) {
    if (block.type === 'text') bytes += Buffer.byteLength(block.text, 'utf8')
  }
  return bytes
}

/**
 * 以追加方式写一行记录，父目录不存在时先创建。
 * @param path - 用户配置的日志路径。
 * @param record - 要写入的记录。
 */
export async function appendDebugRecord(path: string, record: DebugRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}
