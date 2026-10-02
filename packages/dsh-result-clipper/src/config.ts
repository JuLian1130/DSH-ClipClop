/**
 * 本插件的配置契约。
 *
 * 全部字段都 `volatile`：settings 的写回路径只接受 volatile 路径（写入拒绝非 volatile 字段），这也正是
 * 「开关与参数保存即生效、不需要重启」的实现方式——host 半每次处理结果时读一次引用，读到的就是当前值。
 * 字段的默认值即规格「配置项」的首版默认：两项能力关闭、摘要准入判断关闭、主 route 与准入 route 未配置、
 * 阈值 1024/12500、三类请求各自关闭推理、提示词留空（用内置规则正文）、debug 关闭且不自动改用临时路径。
 *
 * 提示词留空表示「没有用户覆盖」，内置规则正文在 `summary.ts` 与 `admission.ts`；「恢复默认」就是把该字段
 * 清回空串。准入 route 的两个字段留空时跟随主 route（准入请求与摘要请求共用主 route 的部署最常见）。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/**
 * 本插件的配置。
 *
 * **不写 `z<Config, Required<Config>>` 注解**：volatile 字段读入的是普通值（profile patch 里写
 * `summarize: false`），读出的是稳定引用（`apply` 里 `config.summarize.get()`），两者是不同类型；照出厂
 * 先例让 schema 自己推断，`Config` 接口只描述 `apply` 收到的形状。
 */
export interface Config {
  /** 摘要能力开关，默认关闭（用户故事 1）。 */
  summarize?: Volatile<boolean>
  /** 隐私闸门开关，默认关闭（用户故事 2）。 */
  privacyGate?: Volatile<boolean>
  /** 摘要准入判断开关，默认关闭（用户故事 17）。 */
  admissionJudge?: Volatile<boolean>
  /** debug 记录开关，默认关闭；关闭时零写盘。 */
  debug?: Volatile<boolean>
  /** debug JSONL 路径；空串表示没有配置路径，此时不开 debug 也不写盘。 */
  debugPath?: Volatile<string>
  /** 主 route 的 provider（摘要与隐私共用）；空串表示未配置，此时摘要路径失败并透传。 */
  routeProvider?: Volatile<string>
  /** 主 route 的 model id；与 provider 一起决定请求发往哪条 route。 */
  routeModel?: Volatile<string>
  /** 准入 route 的 provider；空串时跟随主 route。 */
  admissionProvider?: Volatile<string>
  /** 准入 route 的 model id；空串时跟随主 route。 */
  admissionModel?: Volatile<string>
  /** 摘要候选的下限（估算器单位）；低于它的结果原样透传。`0` 表示不设下限。 */
  minInlineTokens?: Volatile<number>
  /** `bash` / `web_fetch` 的上限；达到或超过它的结果原样交给 spill。`read` 不受它约束。 */
  maxSummarizeTokens?: Volatile<number>
  /** 摘要请求是否关闭推理，默认关闭推理（用户故事 47）。 */
  summaryDisableReasoning?: Volatile<boolean>
  /** 准入请求是否关闭推理，默认关闭推理（用户故事 47）。 */
  admissionDisableReasoning?: Volatile<boolean>
  /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
  summaryPrompt?: Volatile<string>
  /** 准入提示词的规则正文覆盖；空串表示用内置默认。 */
  admissionPrompt?: Volatile<string>
}

/** 配置 schema：字段全部可选并在装载时解析成默认值。 */
export const Config = z.object({
  summarize: z.boolean().default(false).volatile(),
  privacyGate: z.boolean().default(false).volatile(),
  admissionJudge: z.boolean().default(false).volatile(),
  debug: z.boolean().default(false).volatile(),
  debugPath: z.string().default('').volatile(),
  routeProvider: z.string().default('').volatile(),
  routeModel: z.string().default('').volatile(),
  admissionProvider: z.string().default('').volatile(),
  admissionModel: z.string().default('').volatile(),
  minInlineTokens: z.number().default(1024).volatile(),
  maxSummarizeTokens: z.number().default(12500).volatile(),
  summaryDisableReasoning: z.boolean().default(true).volatile(),
  admissionDisableReasoning: z.boolean().default(true).volatile(),
  summaryPrompt: z.string().default('').volatile(),
  admissionPrompt: z.string().default('').volatile(),
})
