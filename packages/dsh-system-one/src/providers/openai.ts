/**
 * `kind: 'openai'` 的 provider：契约的题面 ↔ `POST /v1/decisions`（OpenAI Decisions API）。
 *
 * 载荷与 `systemone` 处处不同：题目标识叫 `name`（契约用 id）、问题与答案都是数组、概率是
 * `[{value, probability}]`，共享证据在 `input` 里而请求级 `instructions` 只能作为它的一条前置消息。
 *
 * 三处契约字段在这个端点上没有位置，按「不可证实即不支持」在发出请求之前抛错并点名字段、不悄悄改写：
 * 请求级 `chatTemplateKwargs`（Decisions 没有模板参数）、是非题的 `optionDescriptions`（predicate
 * 只有 `instructions`）、非字符串 `Level`（线上档位只有一个字符串 `label`）。
 *
 * 拒答（`type: "refusal"`）按契约落成「该题从 `answers` 缺席 + 一条带 `questionId` 的 `Warning`」；
 * 没写 `name` 的拒答对不上任何题，只能算整次失败。
 *
 * **未对真实端点实测**：夹具按 2026-10-23 的官方指南写（`developers.openai.com` 的 Decisions 页），
 * 接上真实端点后补一次。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '../config.ts'
import { SystemOneProvider, type ProviderRequest } from '../provider.ts'
import type { Answer, JsonValue, ProviderResponse, Question, Warning } from '../types.ts'
import { asNumber, at, postJson, requiredNumber, requiredString } from './wire.ts'

/** 共享证据里的一段内容：文字、结构化数据或图片。 */
type WirePart =
  | { type: 'input_text'; text: string }
  | { type: 'input_json'; data: unknown }
  | { type: 'input_image'; image_url: string }

/** 线上一条消息；请求的 `input` 是它的有序数组。 */
interface WireMessage {
  role: 'developer' | 'user'
  content: readonly WirePart[]
}

/** 线上题面。三种题型共用 `name`/`instructions`，各自多带选项或档位。 */
type WireQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: readonly WireChoice[] }
  | { type: 'score'; name: string; instructions: string; levels: readonly WireLevel[] }

interface WireChoice {
  value: string
  description?: string
}

interface WireLevel {
  label: string
}

/** 线上请求体。 */
interface WireRequest {
  model: string
  input: readonly WireMessage[]
  questions: readonly WireQuestion[]
}

/** 线上答案里 provider 读到的部分；不认识的字段不读也不透传。 */
interface WireAnswer {
  type?: unknown
  name?: unknown
  probability?: unknown
  choice?: unknown
  score?: unknown
  confidence?: unknown
  probabilities?: unknown
}

/** 线上概率项：`value` 是选项值（choice）或档位下标（score）。 */
interface WireProbability {
  value?: unknown
  probability?: unknown
}

interface WireResponse {
  answers?: readonly WireAnswer[]
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

/** 一个条目的 `/v1/decisions` 实现。 */
class OpenAiDecisionProvider extends SystemOneProvider {
  constructor(private readonly entry: Entry, private readonly ctx: Context) {
    super()
  }

  async evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    const body = wireRequest(this.entry, request)
    const response = (await postJson(this.entry, this.ctx, '/v1/decisions', body, request)) as WireResponse
    const { answers, warnings } = this.answers(request, response)
    const usage = response.usage
    return {
      answers,
      requests: 1,
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(usage === undefined
        ? {}
        : { usage: { inputTokens: asNumber(usage.input_tokens), outputTokens: asNumber(usage.output_tokens) } }),
    }
  }

  /** 按请求逐题取回答案：`name` 对回 id；拒答的题缺席并自报一条警告。 */
  private answers(
    request: ProviderRequest,
    response: WireResponse,
  ): { answers: Record<string, Answer>; warnings: Warning[] } {
    const warnings: Warning[] = []
    const refused = new Set<string>()
    const byName = new Map<string, WireAnswer>()
    for (const wire of response.answers ?? []) {
      if (wire.type === 'refusal') {
        // 没有 `name` 的拒答对不上任何题，也就没法只让一题缺席：整次失败。
        if (typeof wire.name !== 'string') {
          throw new Error(`${at(this.entry)}: the decisions endpoint refused without naming a question`)
        }
        refused.add(wire.name)
        warnings.push({ type: 'refusal', questionId: wire.name })
        continue
      }
      if (typeof wire.name === 'string') byName.set(wire.name, wire)
    }

    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      if (refused.has(id)) continue
      const wire = byName.get(id)
      if (wire !== undefined) answers[id] = this.answer(id, question, wire)
    }
    return { answers, warnings }
  }

  private answer(id: string, question: Question, wire: WireAnswer): Answer {
    const confidence = asNumber(wire.confidence)
    const signals = confidence === undefined ? {} : { confidence }
    switch (question.type) {
      case 'boolean':
        return { type: 'boolean', probability: requiredNumber(this.entry, wire.probability, id, 'probability'), ...signals }
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
        const probabilities = this.probabilities(
          wire.probabilities,
          question.levels.map((_, index) => index),
          id,
        )
        return {
          type: 'score',
          score: requiredNumber(this.entry, wire.score, id, 'score'),
          ...(probabilities === undefined ? {} : { probabilities }),
          ...signals,
        }
      }
    }
  }

  /** `[{value, probability}]` → 与 `values` 同序的分布；后端没报分布时整项缺席。 */
  private probabilities(value: unknown, values: readonly (string | number)[], id: string): number[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new Error(`${at(this.entry)}: question "${id}": probabilities is not an array`)

    const items = value as readonly WireProbability[]
    return values.map((wanted) => {
      const field = `probabilities[value ${JSON.stringify(wanted)}]`
      const item = items.find((candidate) => candidate.value === wanted)
      if (item === undefined) throw new Error(`${at(this.entry)}: question "${id}": the response has no ${field}`)
      return requiredNumber(this.entry, item.probability, id, field)
    })
  }
}

/** `kind: 'openai'` 的工厂。 */
export function openai(entry: Entry, ctx: Context): SystemOneProvider {
  return new OpenAiDecisionProvider(entry, ctx)
}

/** 契约请求 → 线上请求体；先拒掉这边没有位置的字段，再拼共享证据与题面。 */
function wireRequest(entry: Entry, request: ProviderRequest): WireRequest {
  const kwargs = request.chatTemplateKwargs
  if (kwargs !== undefined && Object.keys(kwargs).length > 0) {
    throw new Error(`${at(entry)}: chatTemplateKwargs has no place in a decisions request`)
  }
  return {
    model: entry.model,
    input: wireInput(entry, request),
    questions: Object.entries(request.questions).map(([id, question]) => wireQuestion(entry, id, question)),
  }
}

/** 共享证据 → 线上 `input`：请求级 `instructions`（若有）是一条前置的 developer 消息。 */
function wireInput(entry: Entry, request: ProviderRequest): readonly WireMessage[] {
  const parts: WirePart[] = [statePart(entry, request.state)]
  for (const image of request.images ?? []) parts.push({ type: 'input_image', image_url: image })
  const user: WireMessage = { role: 'user', content: parts }
  if (!request.instructions) return [user]
  return [{ role: 'developer', content: [{ type: 'input_text', text: request.instructions }] }, user]
}

/** `state` 落成内容块：字符串进 `input_text`，对象/数组进 `input_json`。 */
function statePart(entry: Entry, state: JsonValue): WirePart {
  if (typeof state === 'string') return { type: 'input_text', text: state }
  if (typeof state === 'object' && state !== null) return { type: 'input_json', data: state }
  // 线上只有「文字」与「JSON 对象/数组」两种内容块：把 null 或标量塞进任一种都是换掉判断依据。
  throw new Error(`${at(entry)}: state must be a string, object or array for the decisions endpoint`)
}

/** 契约题面 → 线上题面。 */
function wireQuestion(entry: Entry, id: string, question: Question): WireQuestion {
  const instructions = question.instructions
  switch (question.type) {
    case 'boolean':
      // predicate 只有 `instructions`：没有单列两侧含义的位置。空对象等于没给（与空 `chatTemplateKwargs` 同一条）。
      if (question.optionDescriptions !== undefined && Object.keys(question.optionDescriptions).length > 0) {
        throw new Error(`${at(entry)}: question "${id}": optionDescriptions has no place in a decisions predicate`)
      }
      return { type: 'predicate', name: id, instructions }
    case 'choice':
      return {
        type: 'choice',
        name: id,
        instructions,
        choices: question.options.map((option) => {
          const description = question.optionDescriptions?.[option]
          return description === undefined ? { value: option } : { value: option, description }
        }),
      }
    case 'score':
      return {
        type: 'score',
        name: id,
        instructions,
        levels: question.levels.map((level, index) => {
          if (typeof level !== 'string') {
            throw new Error(
              `${at(entry)}: question "${id}": levels[${index}] cannot be expressed (a decisions level label is a string)`,
            )
          }
          return { label: level }
        }),
      }
  }
}
