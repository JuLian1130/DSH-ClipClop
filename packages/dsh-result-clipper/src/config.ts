/**
 * 本插件的配置契约。
 *
 * 全部字段都 `volatile`：settings 的写回路径只接受 volatile 路径（写入拒绝非 volatile 字段），这也正是
 * 「开关与参数保存即生效、不需要重启」的实现方式——host 半每次处理结果时读一次引用，读到的就是当前值。
 * 字段的默认值即规格「配置项」的首版默认：两项能力关闭、`web_fetch` 不过隐私闸门、摘要准入判断关闭、摘要 route 与准入 route 未配置、
 * 隐私 route 未配置、阈值 1024/12500、三类请求各自「不推理」、提示词留空（用内置规则正文）、debug 关闭且不
 * 自动改用临时路径、干跑关闭。
 *
 * 提示词留空表示「没有用户覆盖」，内置规则正文在 `summary.ts` 与 `admission.ts`；「恢复默认」就是把该字段
 * 清回空串。三个角色（摘要、摘要准入判断、隐私闸门）各有自己的 route：`routeProvider` / `routeModel` 是摘要
 * route 的键名（票 12 之前它就是「主 route」，语义未变，不为了改名打断已存配置）；准入与隐私的 route 留空时
 * 跟随摘要 route，所以三个角色可以设成同一条，也可以各设一条。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { REASONING_EFFORT_IDS } from './reasoning.ts'
import type { ReasoningEffort } from './reasoning.ts'

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
  /**
   * 是否把 `web_fetch` 的结果也交给隐私闸门，默认关闭。
   *
   * `web_fetch` 取的多是外网公开信息，默认不必过闸门（少数取内网地址的部署可以打开它）；其余工具的结果不受这个
   * 开关影响，只要 `privacyGate` 开着就仍然逐条判断。
   */
  webFetchPrivacyGate?: Volatile<boolean>
  /** 摘要准入判断开关，默认关闭（用户故事 17）。 */
  admissionJudge?: Volatile<boolean>
  /**
   * 可选参数 `extract` 的装载开关，默认关闭。
   *
   * 开启后三类目标工具的 schema 多一个 `extract`：主模型自己声明要拿回什么，声明了就按它提取、不再问准入模型；
   * 没声明时行为与关闭时一致（走规则与准入）。`read` 走 agent 作用域遮蔽；`bash` / `web_fetch` 先试全局接管，
   * 原生还在时回落遮蔽，见 `extract.ts`。
   */
  extractArg?: Volatile<boolean>
  /** debug 记录开关，默认关闭；关闭时零写盘。 */
  debug?: Volatile<boolean>
  /** debug JSONL 路径；空串表示没有配置路径，此时不开 debug 也不写盘。 */
  debugPath?: Volatile<string>
  /** 干跑开关，默认关闭；开启且 debug 开关与路径都就位时只写「本应发生什么」的记录（用户故事 50）。 */
  dryRun?: Volatile<boolean>
  /** 摘要 route 的 provider；空串表示未配置，此时摘要路径失败并透传。 */
  routeProvider?: Volatile<string>
  /** 摘要 route 的 model id；与 provider 一起决定请求发往哪条 route。 */
  routeModel?: Volatile<string>
  /** 准入 route 的 provider；空串时跟随摘要 route。 */
  admissionProvider?: Volatile<string>
  /** 准入 route 的 model id；空串时跟随摘要 route。 */
  admissionModel?: Volatile<string>
  /** 隐私 route 的 provider；空串时跟随摘要 route。 */
  privacyProvider?: Volatile<string>
  /** 隐私 route 的 model id；空串时跟随摘要 route。 */
  privacyModel?: Volatile<string>
  /** 摘要候选的下限（估算器单位）；低于它的结果原样透传。`0` 表示不设下限。 */
  minInlineTokens?: Volatile<number>
  /** `bash` / `web_fetch` 的上限；达到或超过它的结果原样交给 spill。`read` 不受它约束。 */
  maxSummarizeTokens?: Volatile<number>
  /** 摘要请求的推理档位；默认 `off`（不推理），让本地模型更快响应（用户故事 47）。 */
  summaryReasoningEffort?: Volatile<ReasoningEffort>
  /** 准入请求的推理档位；默认 `off`（不推理），让本地模型更快响应（用户故事 47）。 */
  admissionReasoningEffort?: Volatile<ReasoningEffort>
  /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
  summaryPrompt?: Volatile<string>
  /** 准入提示词的规则正文覆盖；空串表示用内置默认。 */
  admissionPrompt?: Volatile<string>
  /** 隐私提示词的规则正文覆盖；空串表示用内置默认。 */
  privacyPrompt?: Volatile<string>
  /** 隐私请求的推理档位；默认 `off`（不推理），让本地模型更快响应（用户故事 47）。 */
  privacyReasoningEffort?: Volatile<ReasoningEffort>
  /** 「隐私 route 已确认为本地」确认位；未确认时隐私模式按失败策略处理并显示常驻警告（用户故事 30、31）。 */
  privacyConfirmedLocal?: Volatile<boolean>
  /** 隐私失效的处理策略：`passthrough` 放行原文（默认），`block` 给出拒绝结果（用户故事 27、28）。 */
  failurePolicy?: Volatile<'passthrough' | 'block'>
}

/**
 * 一个推理档位字段：候选集是 pi-ai 的规范档位，默认 `off`。
 *
 * 用 `z.union` 而不是 `z.string()`：写进配置的取值只能是这七个之一，拼错的档位在装载期就被拒，而不是等到
 * 某条结果上被 route 以 `UNSUPPORTED_REASONING_EFFORT` 拒收。
 */
const effort = () =>
  z.union(REASONING_EFFORT_IDS.map(id => z.const(id))).default('off').volatile()

/** 配置 schema：字段全部可选并在装载时解析成默认值。 */
export const Config = z.object({
  summarize: z.boolean().default(false).volatile(),
  privacyGate: z.boolean().default(false).volatile(),
  webFetchPrivacyGate: z.boolean().default(false).volatile(),
  admissionJudge: z.boolean().default(false).volatile(),
  extractArg: z.boolean().default(false).volatile(),
  debug: z.boolean().default(false).volatile(),
  debugPath: z.string().default('').volatile(),
  dryRun: z.boolean().default(false).volatile(),
  routeProvider: z.string().default('').volatile(),
  routeModel: z.string().default('').volatile(),
  admissionProvider: z.string().default('').volatile(),
  admissionModel: z.string().default('').volatile(),
  privacyProvider: z.string().default('').volatile(),
  privacyModel: z.string().default('').volatile(),
  minInlineTokens: z.number().default(1024).volatile(),
  maxSummarizeTokens: z.number().default(12500).volatile(),
  summaryReasoningEffort: effort(),
  admissionReasoningEffort: effort(),
  summaryPrompt: z.string().default('').volatile(),
  admissionPrompt: z.string().default('').volatile(),
  privacyPrompt: z.string().default('').volatile(),
  privacyReasoningEffort: effort(),
  privacyConfirmedLocal: z.boolean().default(false).volatile(),
  failurePolicy: z.union([z.const('passthrough'), z.const('block')]).default('passthrough').volatile(),
})
