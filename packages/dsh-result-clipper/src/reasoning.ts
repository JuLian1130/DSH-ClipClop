/**
 * 两半共用的推理档位词表：host 半的配置 schema 用它约束字段取值，浏览器半的三个下拉框用它生成选项。
 *
 * 与 `rules.ts` 同理放在一个不 import 任何东西的模块里：host 半的模块都依赖 `@deepseek-ai/dsh-llm`，浏览器半
 * 的产物不能把它们打进客户端，把词表抄进 `src/client/` 就会有两份会各自漂移的副本。
 *
 * 档位 id 本身没有全局词表（DSH 的 `ReasoningEffortId` 只是品牌字符串），可用档位由每条 route 的档位表声明；
 * 这里的七个是 pi-ai 的规范档位，是下拉框的**候选集**而非任何 route 的保证——选中而不被 route 声明时，由
 * `summary.ts` 的去掉字段重发一次兜住（票 09）。
 *
 * @module
 */

/** 下拉框的全部候选档位，按从「不推理」到「最高」的升序。 */
export const REASONING_EFFORT_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 一个推理档位 id。 */
export type ReasoningEffort = (typeof REASONING_EFFORT_IDS)[number]
