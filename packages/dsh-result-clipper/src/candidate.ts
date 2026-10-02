/**
 * 摘要候选范围：哪三条工具、哪种投影、两个阈值怎么用。
 *
 * 资格用监听器第二个参数（**原始投影**）测量，理由见设计文档「监听器位置、PTC 与观察面」的双视图：spill 之后
 * 的正文只剩头尾，用它测量会把超大结果误判成候选、再去摘要 spill 的预览并形成双重落盘。
 *
 * `read` 不设插件上界——`read` 工具自身按 `readMaxBytes` 封顶，而 spill 硬编码豁免 `read`，所以只有会被
 * spill 接管的 `bash` / `web_fetch` 需要上界。
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** 首版硬编码的三类目标工具；其余工具的结果一律不进摘要候选。 */
export const TARGET_TOOLS = ['bash', 'web_fetch', 'read'] as const

/** 目标工具名。 */
export type TargetTool = typeof TARGET_TOOLS[number]

/** 一条结果的摘要资格。 */
export type CandidateVerdict =
  | { readonly kind: 'candidate'; readonly tool: TargetTool; readonly text: string }
  | { readonly kind: 'skip' }

/**
 * 判定一条结果是否进入摘要候选。
 * @param toolName - 工具名。
 * @param result - 工具结果的**原始投影**（未经 post-execute 链处理）。
 * @param minInlineTokens - 下限（估算器单位）；低于它透传。
 * @param maxSummarizeTokens - `bash` / `web_fetch` 的上限；达到或超过它交给 spill，`read` 不受它约束。
 * @returns 候选时给出正文；否则 `skip`。
 */
export function candidateOf(
  toolName: string,
  result: Readonly<ToolExecutionResult>,
  minInlineTokens: number,
  maxSummarizeTokens: number,
): CandidateVerdict {
  if (!isTargetTool(toolName)) return { kind: 'skip' }
  // 含图片等非文本块的结果透传：摘要不破坏多模态结果。
  const texts = result.content.filter(
    (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
  )
  if (texts.length !== result.content.length || texts.length === 0) return { kind: 'skip' }
  const text = texts.map(block => block.text).join('')
  const estimated = estimateContent(result.content)
  if (estimated < minInlineTokens) return { kind: 'skip' }
  if (toolName !== 'read' && estimated >= maxSummarizeTokens) return { kind: 'skip' }
  return { kind: 'candidate', tool: toolName, text }
}

/**
 * 工具名是不是三类目标工具之一。
 * @param toolName - 工具名。
 * @returns 是目标工具时为真。
 */
export function isTargetTool(toolName: string): toolName is TargetTool {
  return (TARGET_TOOLS as readonly string[]).includes(toolName)
}
