/**
 * dsh-result-clipper 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生插件
 * 写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本票（04）在 03 的摘要最小闭环之上接出**原结果入口与读回识别**：`exec.parent !== undefined` 的 PTC 子派发
 * 照旧直接 `next()`；其余普通派发先 `await next()` 让下游（含 spill）跑完，再按候选范围决定是否改写模型可见
 * 投影。只有三类目标工具、文本结果、长度在 [`minInlineTokens`, `maxSummarizeTokens`) 区间内（`read` 无上界）
 * 才发摘要请求；候选之外的、`bash`/`web_fetch` 超上限的、失败的、模型要求 `keep` 的、摘要没变短的、按入口
 * 读回的，一律原样透传。替换只改 `content`，`additionalContexts` 原样保留（ADR 0003）。
 *
 * 被替换的正文先写进 spill 存储，把 `locator` 与取回方法作为入口说明放在摘要正文最前；长度比较计入入口
 * 说明的预留上界、发生在写盘之前（设计文档裁决 A），所以 `not-shorter` 与 `keep` 都不留无人引用的副本。
 *
 * 本票（05）接入**摘要 memo**：隐私关闭时按（工具名, 正文 hash）在当前会话内复用同一条摘要（查找在准入判断
 * 之前）；`keep` 与失败不进 memo；隐私开启时不查找、不写入（裁决 B）。
 *
 * 本票（06）在 memo 查找之后、摘要请求之前接入**摘要准入判断**：隐私模式、摘要关闭、未进候选、按入口读回与
 * memo 命中的结果都不发准入请求；准入判 `no` 时原文透传并记 `admission-no`，判断失败仍继续摘要。
 *
 * 本票（07）在候选路径之前接入**隐私闸门**：`await next()` 之后先判隐私——判断对象是模型即将看到的完整
 * **文本**投影（下游处理后的正文与附加上下文，图片块不送分类器），不受结果长度限制，也不看工具是否在摘要
 * 候选内。判定敏感一律返回原生 `block`（固定文案，含工具名、不含参数与正文）；`uncertain` 与技术失败按失败
 * 策略放行原文或拦截；`safe` 且动作为 `summarize` 时照常走摘要路径、正文被摘要替换，`safe` + `keep` 保留
 * 原文。隐私模式只发这一次请求（准入不发），同一工具同一正文连续两次也各判一次（memo 不参与）。主 route
 * 未确认为本地、没有 `llm` 服务或 route 没配出来都是配置失败，按失败策略处理，不另发会话提醒。
 *
 * 失效必须可见：按 `passthrough` 放行时同一会话内每类原因（未判定 / 判断失败 / 本地窗口不足）各追加一条
 * 不含正文的插件提醒；`block` 策略下拦截本身在对话里可见，不发提醒。窗口不足与普通失败在 debug 记录里取值
 * 不同（`failed-window` / `failed`，放行的未判定是 `uncertain`）。
 *
 * 每条普通派发在 debug 记录里留一条闭合的「结果取值」：摘要关闭 `summary-off`、非候选 `not-candidate`、
 * 准入判 no `admission-no`、保留全文 `kept`、没变短 `not-shorter`、按入口读回 `read-back`、放行的未判定
 * `uncertain`、失败 `failed`、窗口不足 `failed-window`、已替换 `summarized`、已拦截 `rejected`。
 *
 * 任何路径都不得抛出——`tools/post-execute` 抛错会把整个工具调用变成错误结果；调用点的兜底 catch 只负责
 * 收住意外，正常失败各自以「透传 / 拦截」结算。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型专用：激活 `ctx.llm` 的 Context 声明。
import type {} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { composeAdmissionPrompt, requestAdmission } from './admission.ts'
import { candidateOf } from './candidate.ts'
import type { Config } from './config.ts'
import {
  appendDebugRecord,
  measureContent,
  type AdmissionVerdict,
  type DebugOutcome,
  type DebugRecord,
  type UnmodifiedReason,
} from './debug.ts'
import { ENTRY_RESERVE, isReadBack, noteReadback, writeEntry, type ReadbackLedger } from './entry.ts'
import { lookupMemo, noteMemo, type SummaryMemo } from './memo.ts'
import {
  composeBlockedFeedback,
  composePrivacyPrompt,
  notifyFailure,
  requestPrivacy,
  type ReminderLedger,
} from './privacy.ts'
import { composeSummaryPrompt, requestSummary, type SummaryAction } from './summary.ts'

export * from './config.ts'
export * from './debug.ts'
export * from './candidate.ts'
export * from './summary.ts'
export * from './admission.ts'
export * from './entry.ts'
export * from './memo.ts'
export * from './privacy.ts'

export const name = 'dsh-result-clipper'

/** 监听 `tools/post-execute` 需要工具运行时在场；装载顺序（在 spill-policy 之后）由 profile 侧保证。 */
export const inject = ['tools']

/**
 * 注册工具结果监听器。
 *
 * `{ prepend: true }` 是判据的一部分：本插件要与 spill-policy 一起排在最前，且必须**后注册**才能位于 spill
 * 外层（两个 prepend 监听器之间后注册的先跑），从而看到 spill 截断之后的正文。这一条由部署的装载顺序兑现，
 * 本票不新增检测；顺序相反时退化为判断原文（更保守，不报错），由受控装载顺序的用例覆盖。
 * @param ctx - 插件的 context；`tools` 已就绪。
 * @param config - 解析后的配置；字段都是 volatile 引用，每次调用时读当前值。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  /** 本会话写出的入口 `locator`，按会话 id 分开（fork 出的新会话不继承父会话的入口）。 */
  const readback: ReadbackLedger = new Map()
  /** 本会话已产出的摘要，按会话 id 分开（重启或 fork 后不复用）。 */
  const memo: SummaryMemo = new Map()
  /** 本会话已提醒过的失效原因，按会话 id 分开（同一类原因至多一条）。 */
  const reminders: ReminderLedger = new Map()
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    if (exec.parent !== undefined) return next()
    const startedAt = performance.now()
    const decision = await next()
    const applied = await process(ctx, config, readback, memo, reminders, exec, result, decision)
      // 任何意外都不得把工具调用变成错误结果：透传并记 `failed`。
      .catch((): Processed => ({
        decision,
        outcome: { action: 'unmodified', reason: 'failed' },
        admission: 'not-applicable',
      }))
    await record(config, exec.name, result, startedAt, applied)
    return applied.decision
  }, { prepend: true })
}

/** 一次处理的结果：交回的工具决策、结果取值与准入结论。 */
interface Processed {
  readonly decision: PostToolDecision
  readonly outcome: DebugOutcome
  readonly admission: AdmissionVerdict
}

/**
 * 一条普通派发的完整流水线：隐私判断（开启时）→ 摘要候选 → memo → 准入 → 摘要请求 → 替换或透传。
 *
 * 隐私开启时判断先于摘要（设计文档「隐私闸门」），且 `safe` 之后的候选、读回与 `keep` 分支与隐私关闭时同源；
 * 隐私关闭时按原顺序走准入与 memo。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置。
 * @param readback - 本进程内各会话写出的入口台账。
 * @param memo - 本进程内各会话已产出的摘要。
 * @param reminders - 本进程内各会话的失效提醒台账。
 * @param exec - 工具执行（会话归属与 `read` 的路径）。
 * @param result - 工具结果的原始投影（摘要资格按它测量）。
 * @param decision - 下游（含 spill）的决策，也是隐私判断与替换的对象。
 * @returns 交回的决策、结果取值与准入结论。
 */
async function process(
  ctx: Context,
  config: Required<Config>,
  readback: ReadbackLedger,
  memo: SummaryMemo,
  reminders: ReminderLedger,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
): Promise<Processed> {
  const unchanged = (reason: UnmodifiedReason, admission: AdmissionVerdict = 'not-applicable'): Processed =>
    ({ decision, outcome: { action: 'unmodified', reason }, admission })
  // 下游策略拒绝时模型看到的是那段反馈、不是可摘要的工具正文；它也不是本次要判断的工具内容。
  if (decision.kind === 'block') return unchanged('not-candidate')

  // 判断与替换的对象都是**模型即将看到的投影**：下游决策的正文加两边交回的附加上下文（图片块不参与判断）。
  const visible = decision.content ?? result.content
  const projection = projectionText(visible, [...result.additionalContexts ?? [], ...decision.additionalContexts ?? []])

  if (config.privacyGate.get()) {
    const judgement = await judgePrivacy(ctx, config, reminders, exec, projection)
    if (judgement.kind === 'block') return rejected(exec.name)
    if (judgement.kind === 'passthrough') return unchanged(judgement.reason)
    // 隐私通过：摘要能力关闭时不再发任何摘要路径请求（判 safe 与放行都记 summary-off）。
    if (!config.summarize.get()) return unchanged('summary-off')
    // 按入口读回跳过整个摘要路径（含准入），但仍经过刚做完的隐私判断。
    if (exec.name === 'read' && isReadBack(readback, exec)) return unchanged('read-back')
    const verdict = candidateOf(exec.name, result, config.minInlineTokens.get(), config.maxSummarizeTokens.get())
    if (verdict.kind === 'skip') return unchanged('not-candidate')
    // `keep` 是信号而非复述：正文逐字不变，模型输出里的任何正文都不被采用，也不写存储、不进 memo。
    if (judgement.action.action === 'keep') return unchanged('kept')
    return replace(ctx, readback, exec, decision, visible, judgement.action.summary, 'not-applicable')
  }

  if (!config.summarize.get()) return unchanged('summary-off')
  // 按入口读回：跳过整个摘要路径（含准入判断）。识别只做字符串比对，见 `entry.ts`。
  if (exec.name === 'read' && isReadBack(readback, exec)) return unchanged('read-back')
  const verdict = candidateOf(exec.name, result, config.minInlineTokens.get(), config.maxSummarizeTokens.get())
  if (verdict.kind === 'skip') return unchanged('not-candidate')

  // memo 只在隐私关闭时参与判重（裁决 B），并且必须在准入判断之前查找——命中即整条摘要请求路径短路。
  const reused = lookupMemo(memo, exec, verdict.text)
  if (reused !== undefined) return replace(ctx, readback, exec, decision, visible, reused, 'not-applicable')

  const llm = ctx.get('llm')
  let admission: AdmissionVerdict = 'not-applicable'
  if (config.admissionJudge.get()) {
    const provider = config.admissionProvider.get() || config.routeProvider.get()
    const model = config.admissionModel.get() || config.routeModel.get()
    if (llm === undefined || provider === '' || model === '') {
      admission = 'failed'
    } else {
      const answer = await requestAdmission(
        llm, provider, model, config.admissionDisableReasoning.get(),
        composeAdmissionPrompt(config.admissionPrompt.get(), verdict.estimated),
      )
      // 判断失败不是关功能：`failed` 只记进准入结论，照常发起带正文的摘要请求。
      admission = answer === undefined ? 'failed' : answer ? 'yes' : 'no'
      if (answer === false) return unchanged('admission-no', 'no')
    }
  }
  const provider = config.routeProvider.get()
  const model = config.routeModel.get()
  if (llm === undefined || provider === '' || model === '') return unchanged('failed', admission)
  const action = await requestSummary(
    llm, provider, model, config.summaryDisableReasoning.get(),
    composeSummaryPrompt(config.summaryPrompt.get(), verdict.estimated, verdict.text),
  )
  if (action === undefined) return unchanged('failed', admission)
  if (action.action === 'keep') return unchanged('kept', admission)
  noteMemo(memo, exec, verdict.text, action.summary)
  return replace(ctx, readback, exec, decision, visible, action.summary, admission)
}

/**
 * 隐私判断的结论：拦截、按失败策略放行（附结果取值的原因），或通过并给出摘要动作。
 * 拦截包含「判定敏感」与「失败策略为 `block` 时的各类失效」两种来源。
 */
type PrivacyJudgement =
  | { readonly kind: 'block' }
  | { readonly kind: 'passthrough'; readonly reason: UnmodifiedReason }
  | { readonly kind: 'safe'; readonly action: SummaryAction }

/**
 * 对一个标准工具结果的模型可见投影做一次隐私判断。
 *
 * **配置失败**（主 route 未确认为本地、没有 `llm` 服务或 route 没配出来）按失败策略处理：它的可见面是配置项
 * 与卡片常驻警告（静态配置状态），因此不另发会话提醒。**运行期失效**（未能判定 / 判断失败 / 窗口不足）在按
 * `passthrough` 放行时各提醒一条，`block` 策略下不发提醒（拦截本身在对话里可见）。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置。
 * @param reminders - 本进程内各会话的失效提醒台账。
 * @param exec - 工具执行（取会话归属）。
 * @param projection - 模型即将看到的完整文本投影。
 * @returns 这次判断的结论。
 */
async function judgePrivacy(
  ctx: Context,
  config: Required<Config>,
  reminders: ReminderLedger,
  exec: ToolExecution,
  projection: string,
): Promise<PrivacyJudgement> {
  const blocked = config.failurePolicy.get() === 'block'
  const llm = ctx.get('llm')
  const provider = config.routeProvider.get()
  const model = config.routeModel.get()
  if (!config.routeConfirmedLocal.get() || llm === undefined || provider === '' || model === '') {
    return blocked ? { kind: 'block' } : { kind: 'passthrough', reason: 'failed' }
  }
  const answer = await requestPrivacy(
    llm, provider, model, config.privacyDisableReasoning.get(),
    composePrivacyPrompt(config.privacyPrompt.get(), projection),
  )
  if (!answer.ok) {
    if (blocked) return { kind: 'block' }
    const reason: UnmodifiedReason = answer.failure === 'failed-window' ? 'failed-window' : 'failed'
    notifyFailure(reminders, exec.agent?.session, reason)
    return { kind: 'passthrough', reason }
  }
  // 判定敏感在任何失败策略下都拦截。
  if (answer.verdict === 'sensitive') return { kind: 'block' }
  if (answer.verdict === 'uncertain') {
    if (blocked) return { kind: 'block' }
    // `uncertain` 连带取消摘要：既不摘要也不拦截，按失败策略放行原文。
    notifyFailure(reminders, exec.agent?.session, 'uncertain')
    return { kind: 'passthrough', reason: 'uncertain' }
  }
  return { kind: 'safe', action: answer.action }
}

/**
 * 判定敏感或按失败策略拦截：交回原生 `block`，文案固定且只带工具名。
 * @param toolName - 被拦下的工具名。
 * @returns 交回的决策、`rejected` 取值与不适用的准入结论。
 */
function rejected(toolName: string): Processed {
  return {
    decision: { kind: 'block', feedback: [{ type: 'text', text: composeBlockedFeedback(toolName) }] },
    outcome: { action: 'rejected' },
    admission: 'not-applicable',
  }
}

/**
 * 用一条摘要替换模型可见投影：先按入口说明的预留上界比长度，严格更短才写盘并拼入口说明。
 * @param ctx - 插件的 context。
 * @param readback - 本进程内各会话写出的入口台账。
 * @param exec - 工具执行（会话归属与工具来源）。
 * @param decision - 要替换的决策。
 * @param visible - 要被替换掉的那段模型可见投影。
 * @param summary - 要放进去的摘要正文（可能来自 memo 或隐私模式的合并请求）。
 * @param admission - 这次结果的准入结论，原样记进 debug 记录。
 * @returns 交回的决策、结果取值与准入结论。
 */
async function replace(
  ctx: Context,
  readback: ReadbackLedger,
  exec: ToolExecution,
  decision: PostToolDecision,
  visible: readonly ContentBlock[],
  summary: string,
  admission: AdmissionVerdict,
): Promise<Processed> {
  const unchanged = (reason: UnmodifiedReason): Processed =>
    ({ decision, outcome: { action: 'unmodified', reason }, admission })
  const original = textOf(visible)
  // 入口说明的实际值写盘前取不到，所以比较用它的预留上界（裁决 A）：不短就透传、一次 `saveText` 都不发。
  if (summary.length + ENTRY_RESERVE >= original.length) return unchanged('not-shorter')

  const store = ctx.get('spillStore')
  if (store === undefined) return unchanged('failed')
  // 后端写入失败的抛出在这里就地兜住：调用点的兜底 catch 不知道准入已经跑过，会把准入结论记成「不适用」。
  // `writeEntry` 交回 `undefined` 是「没有会话归属」，与写入失败同走 `failed` 透传。
  const written = await writeEntry(store, exec, exec.name, original).catch((): undefined => undefined)
  if (written === undefined) return unchanged('failed')
  noteReadback(readback, written)
  return {
    decision: {
      kind: 'accept',
      content: [{ type: 'text', text: written.entry + summary }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    },
    outcome: { action: 'summarized' },
    admission,
  }
}

/**
 * 拼起隐私判断的对象：模型可见投影里的全部文本块与附加上下文文本。图片块不参与判断，所以只取 `text`。
 * @param visible - 下游决策的正文投影。
 * @param contexts - 这次结果两侧交回的附加上下文，按模型可见顺序。
 * @returns 各文本段按顺序用空行连接的结果。
 */
function projectionText(visible: readonly ContentBlock[], contexts: readonly UserMessage[]): string {
  return [textOf(visible), ...contexts.map(message => textOf(message.content))]
    .filter(text => text !== '')
    .join('\n\n')
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
 * @param applied - 本条结果的结果取值与准入结论。
 */
async function record(
  config: Required<Config>,
  toolName: string,
  result: Readonly<ToolExecutionResult>,
  startedAt: number,
  applied: Processed,
): Promise<void> {
  if (!config.debug.get()) return
  const path = config.debugPath.get()
  if (path === '') return
  const line: DebugRecord = {
    toolName,
    resultBytes: measureContent(result.content),
    admission: applied.admission,
    durationMs: Math.round(performance.now() - startedAt),
    ...applied.outcome,
  }
  try {
    await appendDebugRecord(path, line)
  } catch {
    // 诊断写入失败不得把工具调用变成错误结果（任何路径都不得抛）；路径由用户配置，插件不自动改用临时路径。
  }
}
