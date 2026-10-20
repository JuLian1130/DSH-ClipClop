/**
 * 决策判断的请求与答案词汇表。
 *
 * 三种题型是两套外部规范的同一种语义：是非题（jev 叫 Noul、OpenAI 叫 predicate）、闭集单选
 * （choice）、有序量表（score）。答案带概率而不是生成文本——本服务不产出内容；是非题的
 * `probability` 必带，choice/score 的分布是 provider 的自报项，缺席表示没报分布、不是均匀分布。
 *
 * 题面与答案都按 id 组织（`Record<id, …>`）而不是数组：消费者按稳定 id 取答案，顺序在契约层
 * 没有用，各家规范要的 name 数组由 provider 自己转。
 *
 * 可选字段分两类：影响模型输入的（`instructions`、`optionDescriptions`、富 `levels`、`images`、
 * `chatTemplateKwargs`）与只描述答案质量的（`confidence`、`labelMass`、`argmaxIsLabel`）。前者由
 * provider 按后端如实发送，后端不支持时抛错，不得静默丢弃；后者缺席表示没测到，不是某个默认值。
 * @module @dsh-clipclop/dsh-system-one
 */

/** 可放进 `state`、档位与题面描述的 JSON 值。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

/** JSON 对象值。 */
export type JsonObject = { readonly [key: string]: JsonValue }

/** JSON 数组值。 */
export type JsonArray = readonly JsonValue[]

/**
 * 量表档位的值。
 *
 * 字符串是 vllm 与 sglang 都忠实支持的公共集；JSON 对象/数组只有 sglang 会原样保留，
 * 发给 vllm 的 provider 必须拒绝（它会把非字符串档位串化）。
 */
export type Level = string | JsonObject | JsonArray

/**
 * 一道题。
 *
 * 是非题与单选可用 `optionDescriptions` 单列两侧/各选项的含义，缺席表示含义写在 `instructions`
 * 里。量表没有单独的说明字段：档位本身就是说明，值可以是字符串或 JSON。
 */
export type Question =
  | {
      readonly type: 'boolean'
      readonly instructions: string
      /** 两侧含义；key 用 true/false，与答案的 `probability` 对齐。 */
      readonly optionDescriptions?: { readonly true?: string; readonly false?: string }
    }
  | {
      readonly type: 'choice'
      readonly instructions: string
      readonly options: readonly string[]
      /** 按选项名给出的说明；key 必须是 `options` 的子集。 */
      readonly optionDescriptions?: Readonly<Record<string, string>>
    }
  | {
      readonly type: 'score'
      readonly instructions: string
      /** 每档一个值；索引即 0 基档位。 */
      readonly levels: readonly Level[]
    }

/**
 * 答案的可信度信号。
 *
 * - `confidence`：provider 自报的集中程度。定义随 provider 而变，不可跨 provider 比较；
 *   是非题在部分 provider 上缺席。
 * - `labelMass`：答案标签在整个词表上的概率质量，0–1；缺席表示没测到。
 * - `argmaxIsLabel`：读位置的最高概率 token 是否属于答案标签；只有测得到这一点的 provider 才填。
 */
interface AnswerDiagnostics {
  readonly confidence?: number
  readonly labelMass?: number
  readonly argmaxIsLabel?: boolean
}

/** 是非题的答案：条件为真的概率，0–1。 */
export interface BooleanAnswer extends AnswerDiagnostics {
  readonly type: 'boolean'
  readonly probability: number
}

/** 闭集单选的答案：选中的选项，以及可选地与 `options` 同序的概率分布。 */
export interface ChoiceAnswer extends AnswerDiagnostics {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities?: readonly number[]
}

/** 有序量表的答案：档位上的小数位置（0 = 第一档），以及可选地与 `levels` 同序的分布与档位回显。 */
export interface ScoreAnswer extends AnswerDiagnostics {
  readonly type: 'score'
  readonly score: number
  readonly probabilities?: readonly number[]
  /** 与请求 `levels` 同序；`legend[i]` 是第 i 档的档位值。 */
  readonly legend?: readonly Level[]
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
  /** 整次请求共享的前置上下文，放在所有题之前；不支持该字段的 provider 会抛错。 */
  readonly instructions?: string
  /** 图片 URL 或 data URL；模型不支持图片时由后端报错。 */
  readonly images?: readonly string[]
  /** 传给 chat template 的参数，例如关闭 thinking；后端可能忽略或拒绝。 */
  readonly chatTemplateKwargs?: Readonly<Record<string, JsonValue>>
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
  /** 服务侧测得的整次调用耗时。`ask()` 每次都填，所以是必填项。 */
  readonly latencyMs: number
}
