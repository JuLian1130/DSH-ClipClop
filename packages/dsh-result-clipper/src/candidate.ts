/**
 * 摘要候选范围：哪几个工具、哪种投影、两个阈值怎么用。
 *
 * 资格用监听器第二个参数（**原始投影**）测量，理由见设计文档「监听器位置、PTC 与观察面」的双视图：spill 之后
 * 的正文只剩头尾，用它测量会把超大结果误判成候选、再去摘要 spill 的预览并形成双重落盘。
 *
 * `read` 不设插件上界——`read` 工具自身按 `readMaxBytes` 封顶，而 spill 硬编码豁免 `read`，所以只有会被
 * spill 接管的 `bash` / `pwsh` / `web_fetch` 需要上界。
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * 目标工具：两个 shell（`bash`，Windows 上是 `pwsh`）、取网页的 `web_fetch` 与读文件的 `read`；其余工具的结果
 * 一律不进摘要候选。两个 shell 名字都在表里是**平台条件**：base bundle 在 Windows 上禁用 `tool-bash`、改挂
 * `tool-pwsh`（注册名 `pwsh`），插件不是只给本机（macOS/Linux）用的。
 */
export const TARGET_TOOLS = ['bash', 'web_fetch', 'read', 'pwsh'] as const

/** 目标工具名。 */
export type TargetTool = typeof TARGET_TOOLS[number]

/** 一条结果的摘要资格。 */
export type CandidateVerdict =
  | {
    readonly kind: 'candidate'
    readonly tool: TargetTool
    readonly text: string
    /** 这次结果的估算大小（估算器单位）：准入与摘要两次请求共用的前缀里要写它。 */
    readonly estimated: number
  }
  | { readonly kind: 'skip' }

/**
 * 判定一条结果是否进入摘要候选。
 * @param toolName - 工具名。
 * @param result - 工具结果的**原始投影**（未经 post-execute 链处理）。
 * @param minInlineTokens - 下限（估算器单位）；低于它透传。
 * @param maxSummarizeTokens - `bash` / `pwsh` / `web_fetch` 的上限；达到或超过它交给 spill，`read` 不受它约束。
 * @returns 候选时给出正文与估算大小；否则 `skip`。
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
  return { kind: 'candidate', tool: toolName, text, estimated }
}

/**
 * 工具名是不是三类目标工具之一。
 * @param toolName - 工具名。
 * @returns 是目标工具时为真。
 */
export function isTargetTool(toolName: string): toolName is TargetTool {
  return (TARGET_TOOLS as readonly string[]).includes(toolName)
}
