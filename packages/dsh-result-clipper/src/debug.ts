/**
 * debug 记录管道：把一条工具结果的处理去向写成一行 metadata JSONL。
 *
 * 记录**不含**原文、摘要正文、完整提示词与凭据（规格「契约 · debug JSONL 字段」），所以这里的字段只有
 * 元数据。`结果取值` 是封闭的两段式（动作 + 未改动原因）：`summary-off` 自 02，`not-candidate`、`kept`、
 * `not-shorter`、`failed` 自 03，`read-back` 自 04，`admission-no` 与「准入结论」字段自 06；其余取值由引入
 * 对应机制的票各自加入（`uncertain` / `failed-window` / `rejected` 自 07）。
 *
 * @module
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** `unmodified` 的透传原因。新增取值随引入它的机制一起加到这里。 */
export type UnmodifiedReason =
  | 'summary-off'
  | 'not-candidate'
  | 'admission-no'
  | 'kept'
  | 'not-shorter'
  | 'read-back'
  | 'failed'

/**
 * 准入结论：这次结果有没有先过准入判断、判断说了什么。`not-applicable` 覆盖所有没发准入请求的情形
 * （开关关闭、隐私模式、摘要关闭、未进候选、按入口读回、memo 命中）；`failed` 是判断没做成——按契约仍然
 * 继续摘要，所以它只出现在这条字段里，与最终的结果取值分开。
 */
export type AdmissionVerdict = 'yes' | 'no' | 'failed' | 'not-applicable'

/** 一条记录的「结果取值」：动作取闭集之一，`unmodified` 时必须附原因。 */
export type DebugOutcome =
  | { readonly action: 'summarized' }
  | { readonly action: 'unmodified'; readonly reason: UnmodifiedReason }

/** 一行 debug JSONL。 */
export type DebugRecord = DebugOutcome & {
  /** 工具名。 */
  toolName: string
  /** 结果大小：文本块的 UTF-8 字节数（图片等非文本块不计入）。 */
  resultBytes: number
  /** 准入结论；没发准入请求时是 `not-applicable`。 */
  admission: AdmissionVerdict
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
