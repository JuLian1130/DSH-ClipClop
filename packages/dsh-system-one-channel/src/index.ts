/**
 * 决策通道子插件的宿主半：一个 `systemone_ask` 工具、一个技能、两档引导、默认开启的开关与可选阈值。
 *
 * 它按第三方 provider 的用法接接入层（`inject: ['systemOne']`），用哪个条目由自己这一行的配置回答；
 * 接入层因此不需要新增插件面，也不需要「当前 provider」这类全局状态。
 *
 * 工具面只有一个 `ask`：请求级的 `instructions`、`images`、`chatTemplateKwargs` 不暴露给模型——前两者
 * 各有它没法产出的来源，后一个是部署参数；`target` 也不进参数（那是使用者选的，不是模型选的）。
 *
 * @module
 */

import type { Context, Disposable } from '@deepseek-ai/cordis'
// 类型专用：`loader/volatile-update` 的事件声明（运行时由宿主派发，不 import 它的实现）。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AskResult, Question } from '@dsh-clipclop/dsh-system-one'
import { Config, type Config as ChannelConfig } from './config.ts'
import { decide, type Decision } from './decisions.ts'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from './skill.ts'

/** 插件名：与 patch 行的 `id` 同一个字符串（那一行的 id 同时是客户端半的配置命名空间）。 */
export const name = 'dsh-system-one-channel'

/**
 * 依赖的三个服务。
 *
 * 技能注册表**不在这里**：它是可选依赖（profile 没组合技能子系统时只少技能），用一条单独的
 * `ctx.inject` 纤维等它出现——缺席时那条纤维一直不激活，工具照常可用。
 */
export const inject = ['systemOne', 'tools', 'systemPrompt']

/** 工具名。技能正文与引导句都按这个名字指它。 */
export const TOOL_NAME = 'systemone_ask'

/**
 * 第二档多出来的那句固定引导。
 *
 * 它是「一句」，不是一段：第二档与第一档的差别就是这一句，别的地方都不变。
 */
export const CONTEXT_GUIDANCE = 'When a judgement, a choice among options, or a score decides what you do next, call `systemone_ask` and act on its answer instead of deciding on your own.'

/**
 * 引导段的位次。
 *
 * DSH 的位次表（`SECTION_ORDERS`）是闭集、只给内建引导分配了名字，第三方没有位次可用，只能给数字。
 * 2500 落在内建工具引导之间（`TOOL_GOAL` 2400 / `TOOL_WORKFLOW` 2600）。
 */
const SECTION_ORDER = 2500

/** 工具描述：第一档的模型可见面就是它加一个技能。 */
export const TOOL_DESCRIPTION = [
  'Ask a decision model for a typed judgement and get answers with probabilities back.',
  'Use it when the decision matters and you want an auditable answer instead of writing an opinion: whether a condition holds, which of a closed set of options is right, or where a value sits on an ordered scale.',
  'Do not use it to generate content, to research a topic, or to ask anything that needs free-form prose back; those are a category error, not a question type.',
  '`state` carries everything the judgement depends on: the decision model sees `state` and the questions only, never this conversation.',
  '`questions` is a list; each entry has its own `id`, its `type` (`boolean`, `choice`, or `score`) and self-contained `instructions`. Ask one judgement per question.',
  'The result returns the answers keyed by question id; a question the decision model did not answer is absent.',
  'When a confidence threshold is configured, the result also carries `decisions`: one entry per question with `verdict` `act` or `abstain` (plus a `reason`). `abstain` means "below the confidence threshold you configured", not "the answer is wrong": the answer and its probability are still returned.',
].join(' ')

const ID_PROPERTY = {
  type: 'string',
  required: true,
  description: 'Stable id for this question; answers and decisions are keyed by it.',
} as const

const INSTRUCTIONS_PROPERTY = {
  type: 'string',
  required: true,
  description: 'The question itself, with the context it needs: the decision model does not see this conversation.',
} as const

/** 量表档位：字符串是两家公共集；对象/数组档位只有原样保留档位的后端能用。 */
const LEVEL = {
  oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { type: 'json' } },
  ],
} as const

const BOOLEAN_QUESTION = {
  type: 'object',
  additionalProperties: false,
  description: 'A yes/no question; the answer is the probability that the condition is true.',
  properties: {
    id: ID_PROPERTY,
    type: { type: 'string', required: true, const: 'boolean' },
    instructions: INSTRUCTIONS_PROPERTY,
  },
} as const

const CHOICE_QUESTION = {
  type: 'object',
  additionalProperties: false,
  description: 'A single answer from a closed list of options.',
  properties: {
    id: ID_PROPERTY,
    type: { type: 'string', required: true, const: 'choice' },
    instructions: INSTRUCTIONS_PROPERTY,
    options: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'The options to choose between, in the order a human would read them.',
    },
  },
} as const

const SCORE_QUESTION = {
  type: 'object',
  additionalProperties: false,
  description: 'A point on an ordered scale.',
  properties: {
    id: ID_PROPERTY,
    type: { type: 'string', required: true, const: 'score' },
    instructions: INSTRUCTIONS_PROPERTY,
    levels: {
      type: 'array',
      required: true,
      items: LEVEL,
      description: 'The scale from low to high, one entry per level. A string is the portable form; an object or array level only works with backends that keep it verbatim.',
    },
  },
} as const

/**
 * 工具参数。
 *
 * `questions` 是**数组**（每项自带 `id`）而不是契约里那张映射：工具 schema 只能给每个属性一个定名
 * 形状，异构的映射值表达不出来（模型就只能靠描述猜每题的字段）。数组还能让 `defineTool` 在派发前
 * 校验题面，坏题在进入 provider 之前就被点名。转成契约的 `Record<id, Question>` 只是一次遍历。
 */
const PARAMETERS = {
  state: {
    type: 'json',
    required: true,
    description: 'Everything the judgement depends on (the diff, snippet, criteria, facts). It is sent verbatim, so leave out what does not matter.',
  },
  questions: {
    type: 'array',
    required: true,
    description: 'One entry per question. Each question carries its own id, its type, and self-contained instructions.',
    items: { oneOf: [BOOLEAN_QUESTION, CHOICE_QUESTION, SCORE_QUESTION] },
  },
} as const

/** 工具交回的规范值：形状上就是 JSON，具体类型由 dsh-tools 的 `InferValue` 给。 */
const OUTPUT = { type: 'json' } as const

/** `questions` 参数推断出来的题型；工具体按它收窄。 */
type ToolQuestion = InferArgs<typeof PARAMETERS>['questions'][number]

/**
 * 插件入口：校验配置，然后按开关注册工具、引导段与技能。
 *
 * 开关默认开启，但没选条目时什么也不注册——装上插件本身不改变 agent 的行为，选好条目后才有工具。
 * 开关是 volatile：页面写回后 loader 只把新值提交进这条 fiber、再派发 `loader/volatile-update`，不重挂载。
 * 所以注册面由本插件自己跟着那个事件整批换——工具、引导段与技能一起出现或一起消失。
 * @param ctx - 插件的 context；三个注入服务都已就绪。
 * @param config - 解析后的配置；四个 volatile 字段在装载期取到引用，之后按次现读。
 */
export function apply(ctx: Context, config: Required<ChannelConfig>): void {
  /** 开着的那一批注册；空数组即「关着」。技能跟着工具走——指引模型去调一个不存在的工具，比不装技能更糟。 */
  let registered: Disposable[] = []
  const stop = (): void => {
    for (const dispose of registered.splice(0)) void dispose()
  }
  /**
   * 按当前开关换注册：开关关着、或开着但还没选条目，都是「什么都不注册」的同一批。
   *
   * `target` 也走这里：选上条目就注册、清空条目就收起；只是换一个条目则不用换注册（工具体每次现读）。
   */
  const sync = (): void => {
    if (!config.enabled.get() || config.target.get() === '') { stop(); return }
    if (registered.length > 0) return
    const tool = ctx.tools.register(askTool(ctx, config))
    // 档位按每次组装现读，所以设置页切档不需要重载插件：第一档让这一段是空串（渲染时空段被丢掉）。
    const section = ctx.systemPrompt.section({
      name: `tool:${TOOL_NAME}`,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => config.guidance.get() === 'context' ? CONTEXT_GUIDANCE : '',
    })
    // 技能注册表是可选依赖：这条 inject 纤维等它出现，缺席时不激活、插件照常加载。换开关时连同它一起换。
    const skillFiber = ctx.inject(['skills'], (scoped) => {
      scoped.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        content: SKILL_CONTENT,
        source: 'bundled',
      })
    })
    registered = [tool, section, () => { void skillFiber.dispose() }]
  }
  ctx.on('loader/volatile-update', (paths) => {
    if (paths.some(path => path[0] === 'enabled' || path[0] === 'target')) sync()
  })
  sync()
}

/**
 * 建出 `systemone_ask`：题面转成契约的映射，交给接入层，阈值开着时再加一层标记。
 * @param ctx - 插件的 context（`systemOne` 从这里取）。
 * @param config - 配置；`target` 与 `threshold` 每次调用现读。
 * @returns 可注册的工具定义。
 */
function askTool(ctx: Context, config: Required<ChannelConfig>): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const questions = toQuestions(args.questions)
      const result = await ctx.systemOne.ask({
        target: config.target.get(),
        state: args.state,
        questions,
        // 工具运行上下文里没有 deadline 字段（`ToolRunContext` 继承的 `ToolExecution` 只有 `signal`），
        // 所以 `timeoutMs` 不传：服务自己不实现超时，编一个值传下去只会假装有超时。
        signal: exec.signal,
      })
      // 阈值关闭时这一层不出现，`answers` 本体两种情况都一样。
      const threshold = config.threshold.get()
      const value: AskResult | (AskResult & { decisions: Record<string, Decision> }) = threshold.enabled
        ? { ...result, decisions: decide(questions, result.answers, threshold.value) }
        : result
      // 工具层的规范值就是 JSON；`AskResult` 是只读接口、没有索引签名，交回时要一次转型（零运行时开销）。
      return value as unknown as InferValue<typeof OUTPUT>
    },
  })
}

/**
 * 把工具参数里的题面转成契约的映射。
 * @param entries - 模型给的题面；每项自带 `id`。
 * @returns 题 id → 题面。
 * @throws 同 id 出现两次：答案按 id 组织，后一道会悄悄顶掉前一道，等于丢题。
 */
function toQuestions(entries: readonly ToolQuestion[]): Readonly<Record<string, Question>> {
  // 空题单是一次手滑：工具 schema 的数组没有 `minItems` 可写（DSH 的参数 DSL 只到 `items`），在这里拦，
  // 免得为一次白跑付一次外部决策模型的调用。
  if (entries.length === 0) throw new Error(`${TOOL_NAME}: ask at least one question`)
  // 无原型：题 id 是模型给的，`__proto__` 这类键在普通对象上会改掉原型而不是当成一道题。
  const questions = Object.create(null) as Record<string, Question>
  for (const { id, ...question } of entries) {
    if (Object.hasOwn(questions, id)) throw new Error(`${TOOL_NAME}: question id "${id}" is used twice`)
    questions[id] = question
  }
  return questions
}

export { Config } from './config.ts'
export type { Guidance, Threshold } from './config.ts'
