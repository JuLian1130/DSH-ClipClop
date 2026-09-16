/**
 * 复核输出的严格解析（规格「输出契约」）。
 *
 * 判定口径刻意从严：整段输出去掉首尾空白后必须**本身就是那一个 JSON 对象**。用代码块围栏包起来、
 * 前后夹带其它文字、或出现第二个顶层 JSON 值都算复核失败——宽松解析会让「用户删不掉固定字段」
 * 这条契约失效，而且模型偶尔加围栏的习惯会变成隐性的格式漂移。对象内部多出契约之外的字段不算失败。
 *
 * @module
 */

import type { NavigatorVerdict } from './types.ts'

/** 一次复核的结论内容。 */
export interface ReviewOutcome {
  /** 三种结论之一。 */
  readonly verdict: NavigatorVerdict
  /** 判断依据，非空。 */
  readonly reason: string
  /** 建议内容，非空。 */
  readonly recommendation: string
}

/**
 * 解析复核输出。
 * @param text - 模型输出的整段文本。
 * @returns 结论；不是恰好一个合法对象时返回 null（调用方按复核失败处理）。
 */
export function parseReviewOutcome(text: string): ReviewOutcome | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    // 整段解析本身就排除了围栏、夹带文字与第二个顶层值：它们都会让 JSON.parse 抛错。
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const { verdict, reason, recommendation } = record
  if (verdict !== 'continue' && verdict !== 'adjust' && verdict !== 'stop') return null
  if (typeof reason !== 'string' || reason.length === 0) return null
  if (typeof recommendation !== 'string' || recommendation.length === 0) return null

  return { verdict, reason, recommendation }
}
