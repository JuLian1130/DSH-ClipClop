/**
 * `kind: 'deepseek'` 的 provider：契约题面 → `POST {baseUrl}/chat/completions`，读答案位置的
 * `top_logprobs`，把单 token 标识符折回三种答案。
 *
 * 它不是决策端点：DeepSeek 官方只有 chat 接口，所以题面、选项标识符与读出都由这里自己做。
 * 请求固定（关闭 thinking、`temperature: 1.0`、`max_tokens: 1`、`top_logprobs: 20`），每题一次
 * 请求、串行——`temperature: 0` 时 API 只返回 argmax，读不到分布。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '../config.ts'
import { SystemOneProvider, type ProviderRequest } from '../provider.ts'
import type { Answer, Level, ProviderResponse, Question, Warning } from '../types.ts'
import { asNumber, at, postJson } from './wire.ts'

/** 官方文档的截断哨兵：表示「概率极小、不在 top 20 里」，不是真实概率。 */
const SENTINEL = -9999

/** `choice` 的字母表。20 是 `top_logprobs` 的硬上限，超过就保证不了覆盖。 */
const LETTERS = 'abcdefghijklmnopqrst'

/** `score` 的档位上限：标识符是单个数字 token。 */
const MAX_LEVELS = 10

/** 固定的 system 一句：题面由 provider 自己渲染，指令只在这里给一次。 */
const SYSTEM = 'You are a decision engine. Reply with exactly one identifier. Do not explain.'

/** 答案位置的一条候选 token。 */
interface TopToken {
  readonly token: string
  readonly logprob: number
}

interface WireResponse {
  readonly model?: unknown
  readonly choices?: readonly {
    readonly logprobs?: {
      readonly content?: readonly { readonly top_logprobs?: unknown }[]
    }
  }[]
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown }
}

type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

interface Message {
  readonly role: 'system' | 'user'
  readonly content: string | readonly ContentPart[]
}

interface ChatRequest {
  readonly model: string
  readonly messages: readonly Message[]
  readonly thinking: { readonly type: 'disabled' }
  readonly temperature: number
  readonly max_tokens: number
  readonly logprobs: true
  readonly top_logprobs: number
}

/** 一题的读出：答案，以及覆盖率不满时的自报项。 */
interface Readout {
  readonly answer: Answer
  readonly warning?: Warning
}

/** 一个条目的 chat completions 实现。 */
class DeepSeekChatProvider extends SystemOneProvider {
  constructor(private readonly entry: Entry, private readonly ctx: Context) {
    super()
  }

  async evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    // 先在发请求之前把整批题拒掉：后半题不合法时，不应该已经花掉前半题的请求。
    validate(this.entry, request)

    const answers: Record<string, Answer> = {}
    const warnings: Warning[] = []
    let requests = 0
    let firstError: Error | undefined
    let modelId: string | undefined
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    for (const [id, question] of Object.entries(request.questions)) {
      requests += 1
      let response: WireResponse
      try {
        response = (await postJson(
          this.entry,
          this.ctx,
          '/chat/completions',
          body(this.entry, request, question),
          request,
        )) as WireResponse
      } catch (error) {
        // 地址或凭据错时每题都会同样失败：配置类状态码整次抛出，其余只让该题缺席。
        if (isConfigError(error as Error)) throw error
        firstError ??= error as Error
        warnings.push({ type: 'http-error', questionId: id, message: (error as Error).message })
        continue
      }

      if (modelId === undefined && typeof response.model === 'string') modelId = response.model
      inputTokens = add(inputTokens, asNumber(response.usage?.prompt_tokens))
      outputTokens = add(outputTokens, asNumber(response.usage?.completion_tokens))

      const read = readout(id, question, topTokens(this.entry, id, response))
      if (read === undefined) {
        warnings.push({ type: 'no-identifier', questionId: id })
        continue
      }
      answers[id] = read.answer
      if (read.warning !== undefined) warnings.push(read.warning)
    }

    if (Object.keys(answers).length === 0 && firstError !== undefined) throw firstError
    return {
      answers,
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : { usage: { inputTokens, outputTokens } }),
      requests,
      ...(modelId === undefined ? {} : { modelId }),
    }
  }
}

/** `kind: 'deepseek'` 的工厂。 */
export function deepseek(entry: Entry, ctx: Context): SystemOneProvider {
  return new DeepSeekChatProvider(entry, ctx)
}

/** 整批题的前置拒绝：请求级字段没有位置、或选项多到标识符表示不了。 */
function validate(entry: Entry, request: ProviderRequest): void {
  const kwargs = request.chatTemplateKwargs
  if (kwargs !== undefined && Object.keys(kwargs).length > 0) {
    throw new Error(`${at(entry)}: chatTemplateKwargs has no place in a chat completions request`)
  }
  for (const [id, question] of Object.entries(request.questions)) {
    switch (question.type) {
      case 'boolean':
        break
      case 'choice':
        if (question.options.length === 0) throw new Error(`${at(entry)}: question "${id}": options is empty`)
        if (question.options.length > LETTERS.length) {
          throw new Error(
            `${at(entry)}: question "${id}": options has ${question.options.length} items (at most ${LETTERS.length} can be identified)`,
          )
        }
        break
      case 'score':
        if (question.levels.length === 0) throw new Error(`${at(entry)}: question "${id}": levels is empty`)
        if (question.levels.length > MAX_LEVELS) {
          throw new Error(
            `${at(entry)}: question "${id}": levels has ${question.levels.length} items (at most ${MAX_LEVELS} can be identified)`,
          )
        }
        break
    }
  }
}

/** 一题的请求体。 */
function body(entry: Entry, request: ProviderRequest, question: Question): ChatRequest {
  return {
    model: entry.model,
    messages: messages(request, question),
    thinking: { type: 'disabled' },
    temperature: 1.0,
    max_tokens: 1,
    logprobs: true,
    top_logprobs: 20,
  }
}

/** 固定 system + 一题的 user；有图片时 user 内容换成内容块数组。 */
function messages(request: ProviderRequest, question: Question): readonly Message[] {
  const text = userText(request, question)
  const images: ContentPart[] = (request.images ?? []).map((url) => ({
    type: 'image_url',
    image_url: { url },
  }))
  const content: string | readonly ContentPart[] = images.length === 0 ? text : [{ type: 'text', text }, ...images]
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content },
  ]
}

/** 题面按固定顺序拼：请求级说明、state、本题说明、选项、末段指令。 */
function userText(request: ProviderRequest, question: Question): string {
  const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state)
  return [
    ...(request.instructions ? [request.instructions] : []),
    state,
    question.instructions,
    options(question),
    closing(question),
  ].filter((part) => part !== '').join('\n\n')
}

/** 选项/档位块：标识符在左、描述在右。 */
function options(question: Question): string {
  switch (question.type) {
    case 'boolean': {
      const descriptions = question.optionDescriptions
      return ['Options:', line('no', descriptions?.false), line('yes', descriptions?.true)].join('\n')
    }
    case 'choice':
      return [
        'Options:',
        ...question.options.map(
          (option, index) => `- ${LETTERS[index]}: ${question.optionDescriptions?.[option] ?? option}`,
        ),
      ].join('\n')
    case 'score':
      return [
        'Levels:',
        ...question.levels.map((level, index) => `${index}: ${levelText(level)}`),
      ].join('\n')
  }
}

/** 是非题的一侧：没有描述时只写标识符。 */
function line(identifier: string, description: string | undefined): string {
  return description === undefined ? `- ${identifier}` : `- ${identifier}: ${description}`
}

/** 富 `Level` 落成 JSON 文本：题面是自由文本，原样交出去。 */
function levelText(level: Level): string {
  return typeof level === 'string' ? level : JSON.stringify(level)
}

/** 末段指令：点名本题实际可用的标识符。 */
function closing(question: Question): string {
  switch (question.type) {
    case 'boolean':
      return 'Answer with exactly one word: no or yes.'
    case 'choice':
      return `Answer with exactly one letter: ${identifiers(question).join(', ')}.`
    case 'score':
      return `Answer with exactly one digit: ${identifiers(question).join(', ')}.`
  }
}

/** 本题的标识符，按选项/档位顺序。 */
function identifiers(question: Question): readonly string[] {
  switch (question.type) {
    case 'boolean':
      return ['no', 'yes']
    case 'choice':
      return LETTERS.slice(0, question.options.length).split('')
    case 'score':
      return question.levels.map((_, index) => String(index))
  }
}

/** 答案位置的候选；缺 `logprobs` / `top_logprobs` 或只剩 argmax 都按 provider 级失败。 */
function topTokens(entry: Entry, id: string, response: WireResponse): readonly TopToken[] {
  const logprobs = response.choices?.[0]?.logprobs
  if (logprobs === undefined || logprobs === null) {
    throw new Error(`${at(entry)}: question "${id}": the response has no logprobs`)
  }
  const content = logprobs.content
  const top = Array.isArray(content) ? content[0]?.top_logprobs : undefined
  if (!Array.isArray(top)) {
    throw new Error(`${at(entry)}: question "${id}": the response has no top_logprobs`)
  }
  if (top.length < 2) {
    throw new Error(`${at(entry)}: question "${id}": top_logprobs has ${top.length} entries (need at least 2)`)
  }

  const real: TopToken[] = []
  for (const item of top as readonly { token?: unknown; logprob?: unknown }[]) {
    if (typeof item?.logprob !== 'number' || item.logprob <= SENTINEL) continue
    real.push({ token: typeof item.token === 'string' ? item.token : '', logprob: item.logprob })
  }
  if (real.length <= 1) {
    throw new Error(
      `${at(entry)}: question "${id}": top_logprobs has ${real.length} real entries (expected more than one); check the temperature is not 0`,
    )
  }
  return real
}

/**
 * 一题的读出：只算 top-20 里命中的标识符，因此 `labelMass` 是下界。
 * @returns 没有标识符（或候选概率全下溢到 0）时返回 `undefined`，由调用方记 `no-identifier`。
 */
function readout(id: string, question: Question, tops: readonly TopToken[]): Readout | undefined {
  const names = identifiers(question)
  const universe = new Set(names)
  const logSums = new Map<string, number>()
  let argmax: TopToken | undefined

  for (const top of tops) {
    if (argmax === undefined || top.logprob > argmax.logprob) argmax = top
    const name = normalize(top.token)
    if (!universe.has(name)) continue
    const previous = logSums.get(name)
    logSums.set(name, previous === undefined ? top.logprob : logSumExp(previous, top.logprob))
  }
  if (logSums.size === 0) return undefined

  const probability = new Map<string, number>()
  let rawMass = 0
  for (const [name, log] of logSums) {
    const value = Math.exp(log)
    probability.set(name, value)
    rawMass += value
  }
  if (!(rawMass > 0)) return undefined

  const complete = probability.size === names.length
  const signals = {
    confidence: Math.min(1, Math.max(...probability.values())),
    labelMass: Math.min(1, rawMass),
    argmaxIsLabel: argmax !== undefined && universe.has(normalize(argmax.token)),
  }

  switch (question.type) {
    case 'boolean': {
      const answer: Answer = {
        type: 'boolean',
        probability: (probability.get('yes') ?? 0) / rawMass,
        ...signals,
      }
      return complete ? { answer } : { answer, warning: { type: 'coverage', questionId: id } }
    }
    case 'choice': {
      const index = names.reduce((best, name, candidate) => {
        return (probability.get(name) ?? 0) > (probability.get(names[best]) ?? 0) ? candidate : best
      }, 0)
      const answer: Answer = {
        type: 'choice',
        choice: question.options[index],
        ...(complete ? { probabilities: names.map((name) => (probability.get(name) ?? 0) / rawMass) } : {}),
        ...signals,
      }
      return complete ? { answer } : { answer, warning: { type: 'coverage', questionId: id } }
    }
    case 'score': {
      const probabilities = names.map((name) => (probability.get(name) ?? 0) / rawMass)
      const answer: Answer = {
        type: 'score',
        score: probabilities.reduce((sum, p, index) => sum + index * p, 0),
        ...(complete ? { probabilities } : {}),
        // 题面由 provider 自己渲染，不需要后端回显核对；`legend` 只是把请求里的档位交回去。
        legend: question.levels,
        ...signals,
      }
      return complete ? { answer } : { answer, warning: { type: 'coverage', questionId: id } }
    }
  }
}

/** `top_logprobs` 的表面形式 → 规范标识符；顺序与 test-jev 的 `normalize` 相同，不能换。 */
function normalize(token: string): string {
  let value = token.trim()
  value = value.replace(/[:,.]+$/, '').trim()
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1).trim()
  }
  return value.toLowerCase()
}

/** 同一标识符的多个表面变体在 log 域合并：`log(e^a + e^b)`。 */
function logSumExp(a: number, b: number): number {
  const max = Math.max(a, b)
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max))
}

/** `postJson` 把非 2xx 包成 `HTTP <status> from <url>`；401/403/404 是条目配置或地址错。 */
function isConfigError(error: Error): boolean {
  const status = Number(/HTTP (\d{3}) from /.exec(error.message)?.[1])
  return status === 401 || status === 403 || status === 404
}

/** 可选的 token 计数求和；两端都没有时保持缺席。 */
function add(total: number | undefined, value: number | undefined): number | undefined {
  if (value === undefined) return total
  return (total ?? 0) + value
}
