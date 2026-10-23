/**
 * `kind: 'systemone'` 的 provider：契约的题面 ↔ `POST /v1/systemone`。
 *
 * 同一个 kind 覆盖 vllm、SGLang、TypeSafe 等实现，而条目里只有地址与模型——**不认后端是哪一家**，
 * 也不该认：端点常常不是自己部署的，问技术栈既拿不到也不稳。两家的分叉按「怎么被发现」处理：
 *
 * - **后端会大声拒绝的**（`state` 的 `null`/标量、题数/选项数/档位/id 限额、模型不收的多模态）：
 *   原样发，把 4xx/5xx 连后端原文包成 provider 级失败——后端的报错本来就点着字段。
 * - **响应里留着可核对痕迹的**：`labelMass` 读 `answers[qid].x_label_mass` 或
 *   `diagnostics[qid].label_mass`（都没有时按设计归一到 1.0）；量表答案的 `legend` 必须与请求的
 *   `levels` 逐项一致，不一致就抛错点 `levels`——把档位串化成字符串的后端因此被抓住，同样不需要
 *   知道它是谁。
 * - **响应证不了的**：请求级 `instructions` 只有部分后端认、其余会静默忽略，所以在发出请求之前就
 *   抛错并点名该字段（不可证实即不支持）。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '../config.ts'
import { SystemOneProvider, type ProviderRequest } from '../provider.ts'
import type { Answer, Level, ProviderResponse, Question } from '../types.ts'
import { asNumber, at, postJson, requiredNumber, requiredString } from './wire.ts'

/** 线上题面：两家的题型名与 `criteria` 形状一致，差别只在各自支持的字段上。 */
interface WireQuestion {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: unknown
}

/** 线上请求体。`model` 在 SGLang 必填、vllm 可选——条目本来就配了模型名，一律带上。 */
interface WireRequest {
  model: string
  state: unknown
  questions: Record<string, WireQuestion>
  images?: readonly string[]
  chat_template_kwargs?: Readonly<Record<string, unknown>>
}

/** 线上答案里 provider 读到的部分；不认识的字段不读也不透传。 */
interface WireAnswer {
  noul?: unknown
  choice?: unknown
  score?: unknown
  confidence?: unknown
  probabilities?: unknown
  legend?: unknown
  x_label_mass?: unknown
}

/** 每题的诊断项：vllm 把可信度信号放在这里；SGLang 放在答案上（`x_label_mass`），没有 `argmax_is_label`。 */
interface WireDiagnostics {
  label_mass?: unknown
  argmax_is_label?: unknown
}

interface WireResponse {
  model?: unknown
  answers?: Record<string, WireAnswer>
  diagnostics?: Record<string, WireDiagnostics>
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

/** 一个条目的 `/v1/systemone` 实现。 */
class SystemOneHttpProvider extends SystemOneProvider {
  constructor(private readonly entry: Entry, private readonly ctx: Context) {
    super()
  }

  async evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    // 响应里没有 `instructions` 的回显，也就没有可核对的痕迹：vllm 认它、SGLang 静默忽略。
    // 空串不改变任何后端的输入，所以只拒绝非空值。
    if (request.instructions) {
      throw new Error(`${at(this.entry)}: instructions cannot be honored by every systemone backend`)
    }
    const response = await this.post(request)
    const usage = response.usage
    return {
      answers: this.answers(request, response),
      requests: 1,
      ...(typeof response.model === 'string' ? { modelId: response.model } : {}),
      ...(usage === undefined
        ? {}
        : { usage: { inputTokens: asNumber(usage.input_tokens), outputTokens: asNumber(usage.output_tokens) } }),
    }
  }

  /** 发出请求并读回响应体；失败口径见 `postJson`。 */
  private async post(request: ProviderRequest): Promise<WireResponse> {
    const body: WireRequest = {
      model: this.entry.model,
      state: request.state,
      questions: wireQuestions(request.questions),
      ...(request.images === undefined ? {} : { images: request.images }),
      ...(request.chatTemplateKwargs === undefined ? {} : { chat_template_kwargs: request.chatTemplateKwargs }),
    }
    return (await postJson(this.entry, this.ctx, '/v1/systemone', body, request)) as WireResponse
  }

  /** 按请求逐题取回答案；响应里没有的题就是缺席，不补答案、不合成警告。 */
  private answers(request: ProviderRequest, response: WireResponse): Record<string, Answer> {
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const wire = response.answers?.[id]
      if (wire !== undefined) answers[id] = this.answer(id, question, wire, response.diagnostics?.[id])
    }
    return answers
  }

  private answer(id: string, question: Question, wire: WireAnswer, diagnostics: WireDiagnostics | undefined): Answer {
    const signals = confidenceSignals(wire, diagnostics)
    switch (question.type) {
      case 'boolean':
        return { type: 'boolean', probability: requiredNumber(this.entry, wire.noul, id, 'noul'), ...signals }
      case 'choice': {
        const probabilities = this.probabilities(wire.probabilities, question.options, id)
        return {
          type: 'choice',
          choice: requiredString(this.entry, wire.choice, id, 'choice'),
          ...(probabilities === undefined ? {} : { probabilities }),
          ...signals,
        }
      }
      case 'score': {
        const probabilities = this.probabilities(wire.probabilities, question.levels.map((_, index) => String(index)), id)
        const legend = this.legend(question.levels, wire.legend, id)
        return {
          type: 'score',
          score: requiredNumber(this.entry, wire.score, id, 'score'),
          ...(probabilities === undefined ? {} : { probabilities }),
          ...(legend === undefined ? {} : { legend }),
          ...signals,
        }
      }
    }
  }

  /** 与 `names` 同序的概率分布；后端没报分布时整项缺席。 */
  private probabilities(value: unknown, names: readonly string[], id: string): number[] | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${at(this.entry)}: question "${id}": probabilities is not an object`)
    }
    const byName = value as Record<string, unknown>
    return names.map((name) => requiredNumber(this.entry, byName[name], id, `probabilities["${name}"]`))
  }

  /** 量表答案的档位回显：转成与 `levels` 同序的数组，并要求后端回的就是请求里那些值。 */
  private legend(levels: readonly Level[], value: unknown, id: string): readonly Level[] | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${at(this.entry)}: question "${id}": legend is not an object`)
    }
    const echoed = value as Record<string, unknown>
    const returned = Object.keys(echoed).length
    if (returned !== levels.length) {
      throw new Error(
        `${at(this.entry)}: question "${id}": legend has ${returned} values for ${levels.length} levels`,
      )
    }
    // shortcut: 逐字节比较 JSON 文本，键顺序不同的同值会被误判为不一致；等到有后端重排键再换深比较。
    levels.forEach((level, index) => {
      if (JSON.stringify(echoed[String(index)]) !== JSON.stringify(level)) {
        throw new Error(
          `${at(this.entry)}: question "${id}": levels[${index}] cannot be echoed faithfully (server returned ${JSON.stringify(echoed[String(index)])})`,
        )
      }
    })
    return levels
  }
}

/** `kind: 'systemone'` 的工厂。 */
export function systemone(entry: Entry, ctx: Context): SystemOneProvider {
  return new SystemOneHttpProvider(entry, ctx)
}

/** 契约题面 → 线上题面；题型名与 `criteria` 是两家共同的形状。 */
function wireQuestions(questions: Readonly<Record<string, Question>>): Record<string, WireQuestion> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, wireQuestion(question)]))
}

function wireQuestion(question: Question): WireQuestion {
  switch (question.type) {
    case 'boolean': {
      const descriptions = question.optionDescriptions
      return {
        type: 'noul',
        instructions: question.instructions,
        // key 用 true/false（不是后端的 yes/no）；没有描述时整项不发，两家默认都是「没有 criteria」。
        ...(descriptions === undefined
          ? {}
          : { criteria: { true: descriptions.true ?? null, false: descriptions.false ?? null } }),
      }
    }
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        // 选项名到描述的映射；没有描述的选项给 null。
        criteria: Object.fromEntries(
          question.options.map((option) => [option, question.optionDescriptions?.[option] ?? null]),
        ),
      }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.levels }
  }
}

/** 答案的可信度信号：有就透传；`labelMass` 缺席按设计归一到 1.0（只对允许项打分的后端不报它）。 */
function confidenceSignals(
  wire: WireAnswer,
  diagnostics: WireDiagnostics | undefined,
): { confidence?: number; labelMass: number; argmaxIsLabel?: boolean } {
  const confidence = asNumber(wire.confidence)
  const argmaxIsLabel = diagnostics?.argmax_is_label
  return {
    ...(confidence === undefined ? {} : { confidence }),
    labelMass: asNumber(wire.x_label_mass) ?? asNumber(diagnostics?.label_mass) ?? 1,
    ...(typeof argmaxIsLabel === 'boolean' ? { argmaxIsLabel } : {}),
  }
}
