/**
 * 决策判断的请求与答案词汇表。
 *
 * 三种题型是两套外部规范的同一种语义：是非题（jev 叫 Noul、OpenAI 叫 predicate）、闭集单选
 * （choice）、有序量表（score）。答案带概率而不是生成文本——本服务不产出内容；是非题的
 * `probability` 必带，choice/score 的分布是 provider 的自报项，缺席表示没报分布、不是均匀分布。
 *
 * 题面与答案都按 id 组织（`Record<id, …>`）而不是数组：消费者按稳定 id 取答案，顺序在契约层
 * 没有用，各家规范要的 name 数组由 provider 自己转。
 * @module @dsh-clipclop/dsh-system-one
 */

/** 可放进 `state` 与题面的 JSON 值。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

/**
 * 一道题。
 *
 * 三种题型都只有一段 `instructions`；选项与档位各自的含义写在同一段指令里，不单列描述字段
 * ——两套外部规范都允许描述缺席，需要时再按实际用到的规范补。
 */
export type Question =
  | { readonly type: 'boolean'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly options: readonly string[] }
  | { readonly type: 'score'; readonly instructions: string; readonly levels: readonly string[] }

/**
 * 判断自身的置信度。
 *
 * 两套外部规范对它的定义与来源不一致，它表示的是分布的集中程度，**不是答案正确的概率**。
 */
type Confidence = { readonly confidence?: number }

/** 是非题的答案：条件为真的概率，0–1。 */
export interface BooleanAnswer extends Confidence {
  readonly type: 'boolean'
  readonly probability: number
}

/** 闭集单选的答案：选中的选项，以及可选地与 `options` 同序的概率分布；缺席表示 provider 没报分布。 */
export interface ChoiceAnswer extends Confidence {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities?: readonly number[]
}

/** 有序量表的答案：档位上的小数位置（0 = 第一档），以及可选地与 `levels` 同序的概率分布；缺席表示 provider 没报分布。 */
export interface ScoreAnswer extends Confidence {
  readonly type: 'score'
  readonly score: number
  readonly probabilities?: readonly number[]
}

export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer

/** provider 对某题的非致命说明，例如它的输入被截断过。 */
export interface Warning {
  readonly type: string
  readonly message?: string
  readonly questionId?: string
}

/** 一次判断消耗的 token。 */
export interface Usage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** 一次 `ask`。 */
export interface AskRequest {
  /** 已注册的 provider 条目 id。 */
  readonly target: string
  /** 供判断的局部状态；具体形状由调用方与 provider 约定。 */
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, Question>>
  /** 调用方的取消信号，服务原样转发给 provider。 */
  readonly signal?: AbortSignal
  /** 调用方给的 deadline；服务原样转发，自己不实现超时。 */
  readonly timeoutMs?: number
}

/**
 * provider 的回答。分片与重试由 provider 自己决定，服务不介入。
 *
 * 一次 `ask` 的结果就是在它之上加一项耗时，所以两者写成继承、不各抄一遍字段。
 */
export interface ProviderResponse {
  /** 每题一条。provider 没答的题**不在这里出现**，消费者必须处理缺席。 */
  readonly answers: Readonly<Record<string, Answer>>
  readonly warnings?: readonly Warning[]
  readonly usage?: Usage
  /** provider 实际发起的请求数：分片与重试由 provider 决定，只有它知道这个数。 */
  readonly requests?: number
  /** provider 实际回答所用的模型：调用方只点名条目 id，条目指向哪个模型由 provider 的配置决定。 */
  readonly modelId?: string
}

/** 一次 `ask` 的结果：provider 的回答，加上服务侧测得的耗时。 */
export interface AskResult extends ProviderResponse {
  /** 服务侧测得的整次调用耗时。 */
  readonly latencyMs?: number
}
