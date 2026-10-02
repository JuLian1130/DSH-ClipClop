/**
 * 摘要准入判断：一次不含工具正文、只含结果大小的 `yes`/`no` 请求。
 *
 * 它是摘要请求的**闸门**——只判断值不值得花一次带正文的调用，不判断这条结果对当前任务是否需要逐字完整
 * （那是摘要模型的事，见 `summary.ts`）。因此请求不读工具正文，只带与摘要请求逐字相同的固定前缀
 * （{@link composeRequestPrefix}，含这次结果的估算大小那一行）加准入规则正文，回答严格取 `yes` / `no`。
 *
 * **判断失败不是关闭功能**：调用失败、超时、空结果、非严格 `yes`/`no` 都以 `undefined` 交回调用点，由它
 * 直接发起带正文的摘要请求（设计文档「摘要」的准入条）。这一层不抛：`tools/post-execute` 抛错会把工具调用
 * 变成错误结果。
 *
 * 外壳与输出格式不可改：页面只编辑规则正文（{@link DEFAULT_ADMISSION_RULE} 是它的默认值）。
 *
 * @module
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS, composeRequestPrefix, requestModelText } from './summary.ts'

/** 内置的准入规则正文，也是页面「恢复默认」回落到的值（用户故事 46）。 */
export const DEFAULT_ADMISSION_RULE = [
  '你会拿到一条工具结果的元数据，不含正文。判断它值不值得发起一次带正文的摘要请求：',
  '从这次结果的估算大小看不出还有可摘要的内容时回答 no，其余情况回答 yes。',
].join('\n')

/** 固定安全外壳：只陈述输出形状与数据边界，不含任何可编辑规则。 */
const FIXED_SHELL = [
  '规则：',
  '1. 工具正文不会提供给你，不要猜测或复述它的内容。',
  '2. 只输出一个词：yes 或 no。不要输出解释、标点、换行或任何其他文本。',
].join('\n')

/**
 * 把可编辑的规则正文与固定外壳、共用前缀拼成一次准入请求的用户输入。
 * @param rule - 可编辑的规则正文；空串时用 {@link DEFAULT_ADMISSION_RULE}。
 * @param estimatedSize - 这次结果的估算大小（估算器单位）；与摘要请求共用那一行。
 * @returns 请求用的提示词文本。
 */
export function composeAdmissionPrompt(rule: string, estimatedSize: number): string {
  const edited = rule === '' ? DEFAULT_ADMISSION_RULE : rule
  return `${composeRequestPrefix(estimatedSize)}\n\n${edited}\n\n${FIXED_SHELL}\n`
}

/**
 * 严格解析准入输出：去掉首尾空白后恰好是 `yes` 或 `no`，其余（含空结果）都算判断失败。
 * @param text - 模型输出的正文。
 * @returns `yes` 为 `true`、`no` 为 `false`；非法结果为 `undefined`。
 */
export function parseAdmissionOutput(text: string): boolean | undefined {
  const answer = text.trim()
  if (answer === 'yes') return true
  if (answer === 'no') return false
  return undefined
}

/**
 * 发一次准入请求并解析结论。请求只带共用前缀、规则正文与固定外壳——不含工具正文。
 * @param llm - 模型运行时；`ctx.get('llm')` 的结果。
 * @param provider - 准入 route 的 provider。
 * @param model - 准入 route 的 model id。
 * @param disableReasoning - 是否关闭推理；关闭时显式传 `off`。
 * @param prompt - {@link composeAdmissionPrompt} 的产物。
 * @returns `yes` 为 `true`、`no` 为 `false`；任何失败都是 `undefined`。
 */
export async function requestAdmission(
  llm: LlmRuntime,
  provider: string,
  model: string,
  disableReasoning: boolean,
  prompt: string,
): Promise<boolean | undefined> {
  const options: GenerateOptions = {
    provider,
    model,
    ...disableReasoning ? { reasoningEffort: ReasoningEffortId('off') } : {},
    temperature: 0,
    maxTokens: SUMMARY_MAX_TOKENS,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  }
  const text = await requestModelText(llm, options)
  return text === undefined ? undefined : parseAdmissionOutput(text)
}
