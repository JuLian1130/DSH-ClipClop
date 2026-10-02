/**
 * dsh-result-clipper 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生插件
 * 写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本票（03）在 02 的放行骨架之上接出**摘要最小闭环**：`exec.parent !== undefined` 的 PTC 子派发照旧直接
 * `next()`；其余普通派发先 `await next()` 让下游（含 spill）跑完，再按候选范围决定是否改写模型可见投影。
 * 只有三类目标工具、文本结果、长度在 [`minInlineTokens`, `maxSummarizeTokens`) 区间内（`read` 无上界）
 * 才发摘要请求；候选之外的、`bash`/`web_fetch` 超上限的、失败的、模型要求 `keep` 的、摘要没变短的，一律
 * 原样透传。替换只改 `content`，`additionalContexts` 原样保留（ADR 0003）。
 *
 * 摘要请求的 route 与两个阈值、「关闭推理」开关与提示词规则正文由配置面给出（保存即生效）；模型不可用、
 * 未配置 route、超时、空结果与非法结果都是摘要路径的失败，等价于透传，且绝不抛出——`tools/post-execute`
 * 抛错会把整个工具调用变成错误结果。
 *
 * 每条普通派发在 debug 记录里留一条闭合的「结果取值」：摘要关闭 `summary-off`、非候选 `not-candidate`、
 * 保留全文 `kept`、没变短 `not-shorter`、失败 `failed`、已替换 `summarized`。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型专用：激活 `ctx.llm` 的 Context 声明。
import type {} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { candidateOf } from './candidate.ts'
import type { Config } from './config.ts'
import { appendDebugRecord, measureContent, type DebugOutcome, type DebugRecord } from './debug.ts'
import { composeSummaryPrompt, requestSummary } from './summary.ts'

export * from './config.ts'
export * from './debug.ts'
export * from './candidate.ts'
export * from './summary.ts'

export const name = 'dsh-result-clipper'

/** 监听 `tools/post-execute` 需要工具运行时在场；装载顺序（在 spill-policy 之后）由 profile 侧保证。 */
export const inject = ['tools']

/**
 * 注册工具结果监听器。
 *
 * `{ prepend: true }` 是判据的一部分：本插件要与 spill-policy 一起排在最前，且必须**后注册**才能位于 spill
 * 外层（两个 prepend 监听器之间后注册的先跑），从而看到 spill 截断之后的正文。这一条由部署的装载顺序兑现，
 * 本票不新增检测。
 * @param ctx - 插件的 context；`tools` 已就绪。
 * @param config - 解析后的配置；字段都是 volatile 引用，每次调用时读当前值。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    if (exec.parent !== undefined) return next()
    const startedAt = performance.now()
    const decision = await next()
    const applied = await summarize(ctx, config, exec.name, result, decision)
      // 摘要路径的任何意外都不得把工具调用变成错误结果：透传并记 `failed`。
      .catch((): Summarized => ({ decision, outcome: { action: 'unmodified', reason: 'failed' } }))
    await record(config, exec.name, result, startedAt, applied.outcome)
    return applied.decision
  }, { prepend: true })
}

/** 一次处理的结果：交回的工具决策与要记录的结果取值。 */
interface Summarized {
  readonly decision: PostToolDecision
  readonly outcome: DebugOutcome
}

/**
 * 摘要路径：判定候选、发一次请求、按结论决定替换还是透传。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置。
 * @param toolName - 工具名。
 * @param result - 工具结果的原始投影（摘要资格按它测量）。
 * @param decision - 下游（含 spill）的决策。
 * @returns 交回的决策与结果取值。
 */
async function summarize(
  ctx: Context,
  config: Required<Config>,
  toolName: string,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
): Promise<Summarized> {
  const unchanged = (reason: Extract<DebugOutcome, { action: 'unmodified' }>['reason']): Summarized =>
    ({ decision, outcome: { action: 'unmodified', reason } })
  if (!config.summarize.get()) return unchanged('summary-off')
  // 下游策略拒绝时模型看到的是那段反馈、不是可摘要的工具正文，本插件不改写它。
  if (decision.kind === 'block') return unchanged('not-candidate')
  const verdict = candidateOf(toolName, result, config.minInlineTokens.get(), config.maxSummarizeTokens.get())
  if (verdict.kind === 'skip') return unchanged('not-candidate')

  const provider = config.routeProvider.get()
  const model = config.routeModel.get()
  const llm = ctx.get('llm')
  if (llm === undefined || provider === '' || model === '') return unchanged('failed')
  const action = await requestSummary(
    llm, provider, model, config.summaryDisableReasoning.get(),
    composeSummaryPrompt(config.summaryPrompt.get(), verdict.text),
  )
  if (action === undefined) return unchanged('failed')
  // `keep` 是信号而非复述：正文逐字不变，模型输出里的任何正文都不被采用。
  if (action.action === 'keep') return unchanged('kept')

  const visible = decision.content ?? result.content
  if (action.summary.length >= textOf(visible).length) return unchanged('not-shorter')
  return {
    decision: {
      kind: 'accept',
      content: [{ type: 'text', text: action.summary }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    },
    outcome: { action: 'summarized' },
  }
}

/**
 * 拼起模型可见投影里的文本块。
 * @param content - 内容块。
 * @returns 文本块正文按顺序拼接的结果。
 */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * 按配置追加一行 debug 记录。debug 关闭或路径为空时不写盘。
 * @param config - 解析后的配置。
 * @param toolName - 工具名。
 * @param result - 工具结果的原始投影。
 * @param startedAt - 拿到结果前的时间戳。
 * @param outcome - 本条结果的结果取值。
 */
async function record(
  config: Required<Config>,
  toolName: string,
  result: Readonly<ToolExecutionResult>,
  startedAt: number,
  outcome: DebugOutcome,
): Promise<void> {
  if (!config.debug.get()) return
  const path = config.debugPath.get()
  if (path === '') return
  const line: DebugRecord = {
    toolName,
    resultBytes: measureContent(result.content),
    durationMs: Math.round(performance.now() - startedAt),
    ...outcome,
  }
  try {
    await appendDebugRecord(path, line)
  } catch {
    // 诊断写入失败不得把工具调用变成错误结果（任何路径都不得抛）；路径由用户配置，插件不自动改用临时路径。
  }
}
