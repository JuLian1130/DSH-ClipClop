/**
 * dsh-result-clipper 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生插件
 * 写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本票（04）在 03 的摘要最小闭环之上接出**原结果入口与读回识别**：`exec.parent !== undefined` 的 PTC 子派发
 * 照旧直接 `next()`；其余普通派发先 `await next()` 让下游（含 spill）跑完，再按候选范围决定是否改写模型可见
 * 投影。只有三类目标工具、文本结果、长度在 [`minInlineTokens`, `maxSummarizeTokens`) 区间内（`read` 无上界）
 * 才发摘要请求；候选之外的、`bash`/`web_fetch` 超上限的、失败的、模型要求 `keep` 的、摘要没变短的、按入口
 * 读回的，一律原样透传。替换只改 `content`；下游已有的 `additionalContexts` 保留原顺序与来源，插件自己的提醒追加在它们之后（ADR 0003，票 13 修订）。
 *
 * 被替换的正文先写进 spill 存储，把 `locator` 与取回方法作为入口说明接在摘要正文之后（兜底段：先让模型读到
 * 摘要，并能看出这是摘要、够用就不必再读）；长度比较计入入口
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
 * 策略放行原文或拦截；`safe` 且动作为 `summarize` 时正文被摘要替换，`safe` + `keep` 保留原文。隐私模式只发
 * 这一次请求（准入不发），同一工具同一正文连续两次也各判一次（memo 不参与）。隐私 route
 * 未确认为本地、没有 `llm` 服务或 route 没配出来都是配置失败，按失败策略处理，不另发会话提醒。`web_fetch` 的
 * 结果默认不判（`webFetchPrivacyGate` 打开才判）：它取的多是外网公开信息，被跳过的结果与隐私关闭时同路。
 *
 * **隐私这条路自成一路**（票 26 修正）：它不读摘要提示词，判定与摘要是同一次请求的两个字段，所以**摘要总开关
 * 与规则摘要开关都管不到它**——隐私开着时 `safe` 的摘要照旧替换正文（`summarize: false` 也一样；否则这一次
 * 请求的输出白付，判 `safe` 的正文也白白留着）。反过来，非隐私路径仍然要求摘要总开关与规则摘要开关都放它走。
 *
 * 失效必须可见：按 `passthrough` 放行时同一会话内每类原因（未判定 / 判断失败 / 本地窗口不足）各追加一条
 * 不含正文的插件提醒；`block` 策略下拦截本身在对话里可见，不发提醒。窗口不足与普通失败在 debug 记录里取值
 * 不同（`failed-window` / `failed`，放行的未判定是 `uncertain`）。
 *
 * 每条普通派发在 debug 记录里留一条闭合的「结果取值」：摘要提示词路径关闭 `summary-off`（只在没走隐私那条路
 * 时出现）、规则摘要关闭 `rule-summary-off`、非候选 `not-candidate`、准入判 no `admission-no`、保留全文 `kept`、
 * 没变短 `not-shorter`、按入口读回 `read-back`、放行的未判定 `uncertain`、失败 `failed`、窗口不足
 * `failed-window`、已替换 `summarized`、已拦截 `rejected`。
 *
 * 本票（08）接入**干跑**：`dryRun` 开启且 debug 开关与日志路径都就位时，流水线照走（隐私判断、准入与摘要
 * 请求都真的发出），但交回的永远是下游决策——不替换内容、不 append 会话事件、不调用 `saveText`、不写也不查
 * memo；debug 记录加一个 `dryRun` 标记，字段取值记的是「本应替换 / 本应拦截 / 本应跳过及原因」。两项字段
 * （`缓存观测`、`判断器输入 token 数`）与本票一起补齐。
 *
 * 可选参数 `extract`（见 `extract.ts`）跟着**摘要总开关**走：开着才给三类目标工具带上它，声明了目标的调用跳过准入、
 * 规则正文换成目标、**既不查也不写 memo**（键里没有目标，复用会把另一种问法的摘要当答案）；隐私模式不再另设
 * 提示词，而是在同一份隐私规则正文之后固定追加一段，要求按目标只交回不牵涉隐私的部分、脱敏满足不了目标时
 * 照旧返回 `sensitive`/`uncertain`。debug 记录里的 `extract` 布尔记「这次有没有声明目标」。
 *
 * 本票（26）收口 extract 路径的"不摘要"出口，并给规则摘要加一个对照开关。**声明了提取目标的调用，输出契约里
 * 不再提供 `keep`**（`summary.ts` 与 `privacy.ts` 的固定外壳按 `allowKeep` 分叉，`extractRule` 也不再提它）：
 * 那条路径上"透传"只剩一种合法来源——结果长度低于摘要下限，此时程序自己透传、**一个模型请求都不发**（隐私
 * 闸门开着时隐私判断照发，它是闸门不是摘要能力）。另加 `ruleSummary` 开关（默认开启）：关掉后**没声明目标**的
 * 候选结果一律透传并记 `rule-summary-off`，用来量出"`extract` 为空时按摘要提示词摘要"本身有没有必要。它只管
 * 摘要提示词那条路，理由同上：隐私那条路不用摘要提示词。
 *
 * 本票（15）在 block 判定之后、隐私判断之前接入**工具结果精简层**（`condense.ts`）：只在正文恰好是一张文本
 * 块时考虑 `bash` / `grep` / `pwsh`，**基准是下游正文**（含 spill 处理之后的那一份，不是原始投影），总开关
 * 关掉即整层不介入。它的四个去向是：替换（记 `condensed`）、总开关关（`condense-off`）、守卫或回退入口失败
 * 放弃（`condense-abstained`）、过不了净收益闸门（`condense-not-shorter`）；「一处都没改动」时它不表态，取值
 * 照旧交给既有词表。有损替换必须先把**替换前的完整正文**写进回退入口，写不成一律交回下游正文（不留入口）。
 * 干跑下它照算判定、记同一条取值，但不替换正文、不写回退入口、不记台账——干跑是判断「要不要打开它」的唯一
 * 工具。精简过的不再进摘要：隐私判断照常跑在精简后的正文上（隐私那条路是闸门不是摘要能力），候选、memo、
 * 准入与摘要请求整条短路。
 *
 * 本票（16）在精简层里加**分派**（`dispatch.ts`）：打开「按命令语义精简」后，先按扁平事实 map 与有序规则表取
 * **首个命中者**，命中某一族时**只跑那一族**（`gitdiff.ts` 的 `compactDiff`），不再叠一遍通用链；未命中、该族
 * 关着、被族守卫放弃才落通用链。平台面（只认 `bash`）与命令匹配在 `selectFamily` 里；需要完整输入的族用
 * `facts` 自己拒绝截断输入，非零退出码不再拦族（票 20）。观测字段 `condense.family` / `condense.facts` 只在
 * 分派真发生时写。
 *
 * 本票（17）再加两族（`glance.ts`）：`sedWindow`（请求窗口 ≥101 行的 `sed`）与 `rawDump`（`cat` / `ls` /
 * `head` / `tail` / `nl`），规则表顺序 `compactDiff` → `sedWindow` → `rawDump`，命中即只跑那一族。两族各有
 * 自己的非 volatile 开关与参数，关掉一族不影响另一族的取舍；两族都 `lossy: true`，所以每次替换都按票 15 的
 * 安全层先写回退入口。窗口判定走 `FamilyRule.match` 这条纯谓词通道——正则表达不了「脚本地址部分的数字加起来
 * ≥101」。
 *
 * 任何路径都不得抛出——`tools/post-execute` 抛错会把整个工具调用变成错误结果；调用点的兜底 catch 只负责
 * 收住意外，正常失败各自以「透传 / 拦截」结算。精简层的异常归**放弃**不归失败（计划 §4.1 #8），所以在层内
 * 就地兜住、记 `condense-abstained`，不落到那个把取值记成 `failed` 的兜底 catch。
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
import { condenseText, estimateUnits, isCondenseTool } from './condense.ts'
import type { CondenseContext, CondenseRule, CondenseVerdict } from './condense.ts'
import {
  builtinRules,
  compileRules,
  condenseRuleOf,
  dispatchFacts,
  selectFamily,
  type CommandFamilyId,
  type Facts,
  type FamilyRule,
} from './dispatch.ts'
import type { Config } from './config.ts'
import {
  appendDebugRecord,
  measureContent,
  PLUGIN_VERSION,
  type AdmissionVerdict,
  type CondenseObservation,
  type DebugOutcome,
  type DebugRecord,
  type MountRecord,
  type UnmodifiedReason,
} from './debug.ts'
import { ENTRY_RESERVE, isReadBack, noteReadback, writeEntry, type ReadbackLedger } from './entry.ts'
import { createEffortChoice, type EffortChoice } from './efforts.ts'
import { lookupMemo, noteMemo, type SummaryMemo } from './memo.ts'
import {
  composeBlockedFeedback,
  composePrivacyPrompt,
  forgetExtractMissingReminder,
  reminderMessage,
  requestPrivacy,
  type ReminderLedger,
  type ReminderReason,
} from './privacy.ts'
import {
  composeSummaryPrompt,
  describeCall,
  composeRequestPrefix,
  requestSummary,
  summarizeBudget,
  type ModelCallUsage,
  type SummaryAction,
} from './summary.ts'
import { extractEnabled, extractGoalOf, extractRule, installExtractArg, isWholeResult, wantsExactText } from './extract.ts'

export * from './config.ts'
export * from './debug.ts'
export * from './candidate.ts'
export * from './condense.ts'
export * from './summary.ts'
export * from './admission.ts'
export * from './entry.ts'
export * from './extract.ts'
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
  // 三个 role 的推理档位读数：按 route 缓存"该 route 可用的档位表"，所以配置里的空串（不推理）能按各家的拼法
  // 落到 `off` / `none` / 该表最低的一档，而每条结果不再多查一次表（设计稿 §3.2、§9）。
  const efforts = createEffortChoice(ctx)
  // 可选参数 extract：主模型在调用时声明提取目标。启用判据按每次 agent 创建读一次（就是摘要总开关），所以关掉
  // 摘要时，之后创建的 agent 看不到这个参数，也不再覆盖工具。
  installExtractArg(ctx, () => extractEnabled(config), modes => recordMount(config, modes))
  // 命令族规则表在**装载期**编译一次：锚定校验在这里发生，未以行首锚定的规则当场被拒绝并告警（票 16 判据 4）。
  // 封顶参数用 thunk 传进规则里、`apply` 每次现读，所以改配置文件里的值即按其取值生效。
  const familyTable = compileRules(
    builtinRules({
      gitDiff: () => ({
        maxHunkLines: config.condenseGitDiffMaxHunkLines,
        maxLines: config.condenseGitDiffMaxLines,
        leadingContext: config.condenseGitDiffLeadingContext,
      }),
      sedWindow: () => ({
        headLines: config.condenseSedWindowHeadLines,
        tailLines: config.condenseSedWindowTailLines,
        minLines: config.condenseSedWindowMinLines,
      }),
      rawDump: () => ({
        headLines: config.condenseRawDumpHeadLines,
        tailLines: config.condenseRawDumpTailLines,
        minLines: config.condenseRawDumpMinLines,
        hits: config.condenseRawDumpHits,
      }),
    }),
    (rejected) => {
      ctx.logger.warn(`dsh-result-clipper: 命令族 ${rejected.family} 的规则未以行首锚定，已拒绝：${rejected.branch}`)
    },
  )
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    if (exec.parent !== undefined) return next()
    const startedAt = performance.now()
    const decision = await next()
    const applied = await process(ctx, config, readback, memo, reminders, efforts, familyTable.rules, exec, result, decision)
      // 任何意外都不得把工具调用变成错误结果：透传并记 `failed`。
      .catch((): Processed => ({
        decision,
        outcome: { action: 'unmodified', reason: 'failed' },
        admission: 'not-applicable',
        observation: { cacheReadTokens: 0, judgeInputTokens: null },
        extract: false,
        additionalContexts: [],
      }))
    await record(config, exec.name, result, startedAt, applied)
    return withReminders(applied.decision, applied.additionalContexts)
  }, { prepend: true })
}

/**
 * 把本次要交回的提醒作为**附加上下文**挂在决策上：Agent 循环在该结果提交后、下一步边界把它追加成 user 消息
 * （`CONTEXT.md` 的「附加上下文」）。没有提醒时原样交回下游决策。
 * @param decision - 下游决策。
 * @param reminders - 本次要交回的提醒，可能为空。
 * @returns 带上附加上下文的决策。
 */
function withReminders(decision: PostToolDecision, reminders: readonly UserMessage[]): PostToolDecision {
  if (reminders.length === 0) return decision
  return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], ...reminders] }
}

/** 一次处理交回的判定：工具决策、结果取值与准入结论。 */
interface Applied {
  readonly decision: PostToolDecision
  readonly outcome: DebugOutcome
  readonly admission: AdmissionVerdict
}

/** 一次处理的结果：判定部分，加上这条结果的模型请求观测与「有没有声明提取目标」。 */
interface Processed extends Applied {
  readonly observation: Observation
  /** 这次调用有没有声明提取目标；debug 记录只记这个布尔，不记目标正文。 */
  readonly extract: boolean
  /** 本次要交回的提醒，作为附加上下文挂在决策上；没有时为空的数组。 */
  readonly additionalContexts: readonly UserMessage[]
  /** 精简层的观测（票 15）：只在它对这条结果表过态时存在（见 `debug.ts` 的 {@link CondenseObservation}）。 */
  readonly condense?: CondenseObservation
}

/** 这条结果发出的模型请求的观测累计，即 debug 的「缓存观测」与「判断器输入 token 数」两个字段。 */
interface Observation {
  /** 各次模型请求里命中前缀缓存的输入 token 数之和。 */
  cacheReadTokens: number
  /** 准入判断那次请求的输入规模；没发准入请求时为 `null`。 */
  judgeInputTokens: number | null
}

/**
 * 干跑是否生效：`dryRun` 开启**且** debug 开关与日志路径都就位。两者缺一就不生效（照常替换），由页面提示
 * ——干跑的产出就是这条日志，因此干跑不受「debug 关闭时零写盘」的例外对待。
 * @param config - 解析后的配置。
 * @returns 干跑生效时为真。
 */
function dryRunInEffect(config: Required<Config>): boolean {
  return config.dryRun.get() && config.debug.get() && config.debugPath.get() !== ''
}

/**
 * 一条普通派发的完整流水线：隐私判断（开启时）→ 摘要候选 → memo → 准入 → 摘要请求 → 替换或透传。
 *
 * 隐私开启时判断先于摘要（设计文档「隐私闸门」），且 `safe` 之后的候选、读回与 `keep` 分支与隐私关闭时同源；
 * 隐私关闭时按原顺序走准入与 memo。
 *
 * 干跑只改两件事：交回的决策永远是下游决策（`dryRun ? decision : …`），以及所有写状态的动作（`saveText`、
 * 读回台账、memo、提醒台账——包括交回提醒与放回名额）都不发生；判定与模型请求照常，所以记录里的取值是真实预报。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置。
 * @param readback - 本进程内各会话写出的入口台账。
 * @param memo - 本进程内各会话已产出的摘要。
 * @param reminders - 本进程内各会话的失效提醒台账。
 * @param families - 装载期编译好的命令族规则表（票 16）；「按命令语义精简」关着时它整表不参与分派。
 * @param exec - 工具执行（会话归属与 `read` 的路径）。
 * @param result - 工具结果的原始投影（摘要资格按它测量）。
 * @param decision - 下游（含 spill）的决策，也是隐私判断与替换的对象。
 * @returns 交回的决策、结果取值、准入结论与模型请求观测。
 */
async function process(
  ctx: Context,
  config: Required<Config>,
  readback: ReadbackLedger,
  memo: SummaryMemo,
  reminders: ReminderLedger,
  efforts: EffortChoice,
  families: readonly FamilyRule[],
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
): Promise<Processed> {
  const dryRun = dryRunInEffect(config)
  // 主模型这次调用有没有声明提取目标：它由两个开关共同决定（`extractEnabled`），关闭时传了也不认——否则
  // 「关闭」只是不宣传而不是不生效。取法只认 `arguments.extract` 上的非空字符串。
  const required = extractEnabled(config)
  const goal = required ? extractGoalOf(exec) : undefined
  // 投给提示词的"目标"：哨兵与逐字要求不是摘要目标——哨兵的意思是"不要摘要"，逐字要求这条路我们不会采信摘要
  // 正文，两者都按「没有提取目标」投，免得让摘要器去完成一个自相矛盾的任务（隐私闸门的判定与摘要是同一次请求，
  // 判定必须先做，所以这条路真的会把提示词发出去）。同一个判定也是精简层的让路条件（故事 60）。
  const wantsWholeOrExact = goal !== undefined && (isWholeResult(goal) || wantsExactText(goal))
  const promptGoal = wantsWholeOrExact ? undefined : goal
  const observation: Observation = { cacheReadTokens: 0, judgeInputTokens: null }
  // 精简层（票 15）的局部状态，只在这里承载，不改动其余结构：
  // - `current` 是本层替换正文后的决策（没替换时就是下游决策）；隐私判断与交回都看它。
  // - `condensed` 记「本层替换了正文」（干跑时是「本应替换」），它同时是跳过摘要提示词路的开关。
  // - `condenseReason` 是本层**没**替换却表了态时的取值（总开关关 / 守卫放弃 / 过不了闸门），下面的
  //   `unchanged(...)` 优先采用它；后续真的改写正文的分支返回自己的动作，天然覆盖它。
  // - `condense` 是本层的观测字段：本层**考虑过**这条结果（精简工具、正文一张文本块、没被下游 block）就写。
  let current: PostToolDecision = decision
  let condensed = false
  let condenseReason: UnmodifiedReason | undefined
  let condense: CondenseObservation | undefined
  /** 本次要交回的提醒；`settle` 在返回时读它，所以提醒必须在本条路径返回之前取。 */
  const remindersOut: UserMessage[] = []
  const remind = (reason: ReminderReason): void => {
    if (dryRun) return
    const message = reminderMessage(reminders, exec.agent?.session, reason)
    if (message !== undefined) remindersOut.push(message)
  }
  // 这次把 extract 填上了：放回「漏填」的名额——同类只提醒一次是为了不刷屏，不是永久豁免。
  // 放回名额也是台账写入，所以与 `remind` 一样受干跑约束：干跑不能改变随后真实运行的提醒次序。
  if (!dryRun && required && goal !== undefined) forgetExtractMissingReminder(reminders, exec.agent?.session)
  const settle = (applied: Applied): Processed => ({
    ...applied,
    observation,
    extract: goal !== undefined,
    additionalContexts: remindersOut,
    ...condense === undefined ? {} : { condense },
  })
  const unchanged = (reason: UnmodifiedReason, admission: AdmissionVerdict = 'not-applicable'): Processed =>
    settle({
      decision: current,
      outcome: { action: 'unmodified', reason: condenseReason ?? reason },
      admission,
    })
  // 声明逐字原文时按原文透传：摘要器只能改写，给不出逐字保证（exp9 实测 6 条候选里 4 条被改写、模型随即
  // 又读一次同一文件）。放在候选判定之后，所以低于下限的结果仍记 `not-candidate`。
  const exactText = (): Processed => {
    remind('exact-text')
    return unchanged('exact-text')
  }
  // `extract` 是必填参数，哨兵 `WHOLE_RESULT` 是"要整份结果"的唯一写法：显式要整份就按原文透传、不发摘要请求，
  // 也不再受规则摘要开关影响（开关管的是"没声明时怎么办"，不是"声明了整份还摘要"）。
  const wholeResult = (): Processed => unchanged('whole-result')
  // 漏填或空串：必填字段漏填是模型侧的错误，提醒一次让它下次填上。提醒不改变这条路怎么走——怎么走仍由规则摘要
  // 开关决定（见下面 `rule-summary-off` 那条判定），这里只负责让模型知道。
  // 下游策略拒绝时模型看到的是那段反馈、不是可摘要的工具正文；它也不是本次要判断的工具内容。
  if (decision.kind === 'block') return unchanged('not-candidate')

  // 要替换掉的那段**模型即将看到的投影**是下游决策的正文；附加上下文与图片块只影响隐私判断的文本投影。
  let visible = decision.content ?? result.content

  // 故事 60：模型明确要整份或逐字原文时，精简层不介入。`extract` 跟着摘要总开关走，所以这条模型级出口只在
  // 摘要开着时存在（关掉摘要时没有这个参数，用户级出口是精简总开关，见 README）。放在精简块之前而不是替换后：
  // 有损替换一旦写出入口就没有无痕回退路径（计划 §7.4 第 1 条）。

  // —— 本票（15）精简层：在 block 判定之后、隐私判断之前（计划 §2.1 第 1、2 条）——
  // 只在正文恰好是一张文本块时考虑：多块正文压成一块会改变结果的形状，不在本层的判据里（此时不表态，取值
  // 交给既有词表）。`body` 取下游正文，尺寸下限、净收益闸门与全部变换都以它为基准，不是 `result` 的原始投影。
  if (!wantsWholeOrExact && isCondenseTool(exec.name) && visible.length === 1 && visible[0]?.type === 'text') {
    const body = visible[0].text
    // 输入截断事实在 `try` 外取一次：无论走哪条路（含异常兜底）都要写进观测，且它本身不参与取舍。
    const truncated = truncatedOf(result)
    // 整段自带兜底（计划 §4.1 #8）：任何抛出都归「守卫放弃」，不能落到 `apply()` 调用点那个把取值记成
    // `failed` 的兜底 catch——那是「模型或 route 出了问题」，与「这次变换不做了」不是一回事。
    try {
      if (!config.condense.get()) {
        condenseReason = 'condense-off'
        condense = { rules: [], truncated }
      } else {
        const params = {
          // 六个参数是配置里的非 volatile 字段，读到的就是普通值（不是每步现读的 volatile 引用）。
          minUnits: config.condenseMinUnits,
          minNetGainUnits: config.condenseMinNetGainUnits,
          headLines: config.condenseHeadLines,
          tailLines: config.condenseTailLines,
          maxLines: config.condenseMaxLines,
          maxLineChars: config.condenseMaxLineChars,
          entryReserveChars: ENTRY_RESERVE,
        }
        // 票 26：通用链里的「命中长行裁剪」要看命令，且只作用于 bash 的 grep 输出（设计文档的边界）。上下文只在
        // 本次调用里拼，不落盘；「按命令语义精简」关着时那条规则也不跑——与命令族不接手是同一层产品语义。
        const condenseContext: CondenseContext = {
          command: exec.name === 'bash' ? commandOf(exec) : undefined,
          condenseByCommand: config.condenseByCommand.get(),
        }
        // 票 16：先分派、再决定跑哪一套。事实按**下游正文**现算（计划 §4.2 末尾）；「不接族」的判据都在
        // `selectFamily` 里（平台面只认 bash；需要完整输入的族用 `facts` 自守），只放弃命令族那一步——
        // 票 20 起非零退出码不再拦族。
        // 开关关着时连事实都不摊——那时不发生分派，观测里也就不该有分派事实。
        const facts = config.condenseByCommand.get() ? factsOf(exec, result, body, truncated) : undefined
        // 族开关关着就等于那一族不在表里（票 17 判据 1）：它不接手，这次落通用链。
        const hit = facts === undefined
          ? undefined
          : selectFamily(exec.name, facts, families.filter(rule => familyEnabled(config, rule.family)))
        const familyVerdict = hit === undefined ? undefined : condenseText(exec.name, body, params, [familyRule(hit)])
        // **命中某一族时只跑那一族**，不再叠一遍通用链；族 handler 的忠实性守卫放弃时落回通用链（票 16 的
        // 层序条）。命中之后再叠一遍链会把 `+`/`-` 行整段丢掉，那是这一族的忠实性要求不允许的。
        const verdict: CondenseVerdict = familyVerdict === undefined || familyVerdict.kind === 'abstained'
          ? condenseText(exec.name, body, params, undefined, condenseContext)
          : familyVerdict
        // 观测字段在**本层考虑过这条结果**时就写（判据 10）：这样「输入已被工具截断的频率」的分母是「本层看到
        // 的所有精简工具结果」，而不是「被改动过的那些」。`unchanged` 只是不表态、取值交给既有词表。
        condense = {
          rules: [],
          truncated,
          ...hit === undefined ? {} : { family: hit.family },
          ...facts === undefined ? {} : { facts: Object.fromEntries(facts) },
        }
        if (verdict.kind === 'abstained') {
          condenseReason = 'condense-abstained'
        } else if (verdict.kind === 'not-shorter') {
          // 闸门挡下的是「替换」，不是「哪条规则命中过」：命中的规则照记，这是「为什么这条没变短」的答案。
          condenseReason = 'condense-not-shorter'
          condense = { ...condense, rules: verdict.rules }
        } else if (verdict.kind === 'condensed') {
          // 有损替换必须有一条可回退的入口：本层写，或正文里已经有一条上游入口（票 20）。上游那条指向完整
          // 输出，比本层指向下游正文的入口更好；两条入口会让模型面对互相竞争的说明（规格故事 69）。所以
          // `entry === 'upstream'` 时既不写盘、也不要求 spill 后端存在。写不成（没有存储后端、写入抛错、没有
          // 会话归属）一律交回下游正文，且不留下入口（计划 §7.4 第 1 条）。干跑不写盘，只预报配置层面的那一半：
          // 没有存储后端时真实运行同样写不成入口。
          const needsOwnEntry = verdict.lossy && verdict.entry !== 'upstream'
          const store = needsOwnEntry ? ctx.get('spillStore') : undefined
          const written = store === undefined || dryRun
            ? undefined
            : await writeEntry(store, exec, exec.name, body, 'condense').catch((): undefined => undefined)
          if (needsOwnEntry && (store === undefined || (!dryRun && written === undefined))) {
            // 观测字段保持上面那份（本次没有正文被替换，`rules` 就是空的）。
            condenseReason = 'condense-abstained'
          } else {
            let text = verdict.text
            if (written !== undefined) {
              noteReadback(readback, written)
              text += written.entry
            }
            condense = { ...condense, rules: verdict.rules }
            condensed = true
            // 干跑不替换正文：交回的仍是下游决策（计划 §2.1 第 5 条）。
            if (!dryRun) {
              const content: ContentBlock[] = [{ type: 'text', text }]
              current = {
                kind: 'accept',
                content,
                ...decision.additionalContexts === undefined
                  ? {}
                  : { additionalContexts: decision.additionalContexts },
              }
              visible = content
            }
          }
        }
        // `unchanged`（不适用工具之外的一切「一处都没改动」）：本层不表态，取值交给既有词表。
      }
    } catch {
      // 异常归「放弃」不归「失败」（计划 §4.1 #8）。已经替换完成的那次不回退——入口已经写出去了，回退只会留下
      // 无人引用的副本；没替换的一律由 `current` 交回下游正文。
      condenseReason = 'condense-abstained'
      condense = { rules: [], truncated }
    }
  }

  // 隐私闸门默认不判 `web_fetch`：它取的多是外网公开信息（`webFetchPrivacyGate` 可以把内网部署的它纳入）。被跳过
  // 的结果与「隐私关闭」同路（候选 → memo → 准入 → 摘要），不是既不判也不加工。
  if (config.privacyGate.get() && (config.webFetchPrivacyGate.get() || exec.name !== 'web_fetch')) {
    const projection = projectionText(
      visible,
      [...result.additionalContexts ?? [], ...decision.additionalContexts ?? []],
    )
    const judgement = await judgePrivacy(ctx, config, remind, projection, observation, promptGoal, efforts)
    // 干跑只预报「本应拦截」，交回的仍是下游决策——模型可见内容一个字都不变。
    if (judgement.kind === 'block') {
      return settle({
        decision: dryRun ? decision : blockedDecision(exec.name),
        outcome: { action: 'rejected' },
        admission: 'not-applicable',
      })
    }
    // 精简过的不再进摘要（规格 237、用户故事 62）：判定为 `condensed` 时隐私判断照常跑在**精简后的正文**上
    // ——隐私那条路是闸门不是摘要能力，所以它照跑——但候选、memo、准入与摘要请求整条短路。拦截仍然优先于
    // 精简（上面那条先返回），按 `passthrough` 放行时交回的仍是精简后的正文。
    if (condensed) return settle({ decision: current, outcome: { action: 'condensed' }, admission: 'not-applicable' })
    // 隐私闸门**自成一路**：它不经过摘要提示词，判定与摘要是同一次请求的两个字段，所以摘要总开关与
    // 规则摘要开关都管不到它——隐私开着时 `safe` 的摘要照旧替换正文（否则这一次请求的输出白付，正文也白白留着）。
    if (judgement.kind === 'passthrough') return unchanged(judgement.reason)
    // 按入口读回跳过整个摘要路径（含准入），但仍经过刚做完的隐私判断。
    if (exec.name === 'read' && isReadBack(readback, exec)) return unchanged('read-back')
    const verdict = candidateOf(exec.name, result, config.minInlineTokens.get(), config.maxSummarizeTokens.get())
    if (verdict.kind === 'skip') return unchanged('not-candidate')
    if (goal !== undefined && isWholeResult(goal)) return wholeResult()
    if (goal !== undefined && wantsExactText(goal)) return exactText()
    if (required && goal === undefined) remind('extract-missing')
    // `keep` 是信号而非复述：正文逐字不变，模型输出里的任何正文都不被采用，也不写存储、不进 memo。
    if (judgement.action.action === 'keep') return unchanged('kept')
    return settle(await replace(
      ctx, readback, exec, decision, visible, judgement.action.summary, 'not-applicable', dryRun,
    ))
  }

  // 精简过的不再进摘要（规格 237、用户故事 62）：隐私关着时同样短路候选、memo、准入与摘要请求——精简已经把它
  // 压到不值得再发一次模型请求的程度。干跑照样短路：干跑的意义就是预报「打开之后会发生什么」。
  if (condensed) return settle({ decision: current, outcome: { action: 'condensed' }, admission: 'not-applicable' })

  if (!config.summarize.get()) return unchanged('summary-off')
  // 按入口读回：跳过整个摘要路径（含准入判断）。识别只做字符串比对，见 `entry.ts`。
  if (exec.name === 'read' && isReadBack(readback, exec)) return unchanged('read-back')
  const verdict = candidateOf(exec.name, result, config.minInlineTokens.get(), config.maxSummarizeTokens.get())
  if (verdict.kind === 'skip') return unchanged('not-candidate')
  if (goal !== undefined && isWholeResult(goal)) return wholeResult()
  if (goal !== undefined && wantsExactText(goal)) return exactText()
  // 没声明提取目标：必填字段漏填（或空串手写），先提醒一次；随后照旧按规则摘要开关处理。
  if (required && goal === undefined) remind('extract-missing')
  // 规则摘要关闭（`ruleSummary`）且这次没声明提取目标：候选结果直接透传，这条取值就是该对照实验的计数。
  // 放在候选判定之后：不是候选的结果仍记 `not-candidate`，`rule-summary-off` 才恰好是"本该摘要却没摘"的那批。
  if (goal === undefined && !config.ruleSummary.get()) return unchanged('rule-summary-off')

  // memo 只在隐私关闭时参与判重（裁决 B），并且必须在准入判断之前查找——命中即整条摘要请求路径短路。干跑
  // 既不写也不查：查找会刷新最近使用次序，同样改变随后真实运行的行为，而命中与否不改变记录里的取值。
  // 声明了目标的调用既不查也不写：memo 的键只有（工具名, 正文），不含目标，复用会把另一种问法的摘要当答案。
  const reused = dryRun || goal !== undefined ? undefined : lookupMemo(memo, exec, verdict.text)
  if (reused !== undefined) {
    return settle(await replace(ctx, readback, exec, decision, visible, reused, 'not-applicable', dryRun))
  }

  const llm = ctx.get('llm')
  // 调用的形态进共用前缀：规则正文只写判据，而实测里最强的三个信号（整文件 read、同一路径曾被摘过、bash）
  // 全是调用形态，模型只有在前缀里才看得见它们。前缀在这里拼一次，准入与摘要两次请求逐字共用。
  const prefix = composeRequestPrefix(describeCall(exec.name, exec.arguments), verdict.estimated)
  // 声明了目标的调用不再问准入模型：目标本身就是最强的那份局部意图，规则正文也用目标改写。
  // 准入判断与摘要请求走同一条 route（没有单独的准入模型选择），但固定不推理：它只回 yes/no，
  // 不该跟着摘要的推理档位思考。
  let admission: AdmissionVerdict = 'not-applicable'
  if (config.admissionJudge.get() && goal === undefined) {
    const provider = config.routeProvider.get()
    const model = config.routeModel.get()
    if (llm === undefined || provider === '' || model === '') {
      admission = 'failed'
    } else {
      const called = await requestAdmission(
        llm, provider, model,
        await efforts.choose(provider, model, ''),
        composeAdmissionPrompt(config.admissionPrompt.get(), prefix),
      )
      observation.judgeInputTokens = noteUsage(observation, called.usage)
      // 判断失败不是关功能：`failed` 只记进准入结论，照常发起带正文的摘要请求。
      admission = called.answer === undefined ? 'failed' : called.answer ? 'yes' : 'no'
      if (called.answer === false) return unchanged('admission-no', 'no')
    }
  }
  const provider = config.routeProvider.get()
  const model = config.routeModel.get()
  if (llm === undefined || provider === '' || model === '') return unchanged('failed', admission)
  const outcome = await requestSummary(
    llm, provider, model,
    await efforts.choose(provider, model, config.summaryReasoningEffort.get()),
    composeSummaryPrompt(
      goal === undefined ? config.summaryPrompt.get() : extractRule(goal),
      prefix,
      verdict.text,
      // 声明了提取目标时输出契约里没有 `keep`：那条路径上只有"长度低于摘要下限"才透传，且由程序自己透传。
      goal === undefined,
    ),
    // 输出预算随这次正文的估算大小放大（下限 512，上限由入口说明的长度约束反推）：撞满预算的结果会整条透传，
    // 而那正是最大的一条结果最不该付出的代价。
    summarizeBudget(verdict.estimated),
  )
  noteUsage(observation, outcome.usage)
  // 输出被预算截断与"这次请求没做成"分开记：都是原文透传，但前者说明预算不够、后者说明模型/route 出了问题。
  if (outcome.action === undefined) {
    return unchanged(outcome.failure === 'truncated' ? 'truncated' : 'failed', admission)
  }
  if (outcome.action.action === 'keep') return unchanged('kept', admission)
  // 带目标的摘要不进 memo：见上面查找处的注释（键里没有目标）。
  if (!dryRun && goal === undefined) noteMemo(memo, exec, verdict.text, outcome.action.summary)
  return settle(await replace(ctx, readback, exec, decision, visible, outcome.action.summary, admission, dryRun))
}

/**
 * 记下一次模型请求的观测：缓存命中累加进「缓存观测」，并交回这次请求的输入规模。
 * @param observation - 这条结果的观测累计。
 * @param usage - 这次请求的用量；底层没报告时为 `undefined`。
 * @returns 这次请求的输入 token 总数（未缓存 + 缓存读 + 缓存写）；没有用量时为 `null`。
 */
function noteUsage(observation: Observation, usage: ModelCallUsage | undefined): number | null {
  if (usage === undefined) return null
  observation.cacheReadTokens += usage.cacheReadTokens
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
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
 * **配置失败**（隐私 route 未确认为本地、没有 `llm` 服务或 route 没配出来）按失败策略处理：它的可见面是配置项
 * 与卡片常驻警告（静态配置状态），因此不另发提醒。**运行期失效**（未能判定 / 判断失败 / 窗口不足）在按
 * `passthrough` 放行时各提醒一条，`block` 策略下不发提醒（拦截本身在对话里可见）；干跑下两者都不发生——
 * 提醒既不交回也不进台账，否则会改变随后真实运行的提醒去重。
 * @param ctx - 插件的 context。
 * @param config - 解析后的配置。
 * @param remind - 取一条本次要交回的提醒（附加上下文）；干跑、同类已提醒过或没有会话归属时不产出。
 * @param projection - 模型即将看到的完整文本投影。
 * @param observation - 这条结果的模型请求观测累计。
 * @param goal - 投给这次请求的提取目标（{@link process} 已把哨兵与逐字要求折成 `undefined`）；没声明时为
 *   `undefined`（此时请求与关闭该参数之前逐字相同）。
 * @param efforts - 档位读数：把配置里的值换成这次请求实际要发的档位。
 * @returns 这次判断的结论。
 */
async function judgePrivacy(
  ctx: Context,
  config: Required<Config>,
  remind: (reason: ReminderReason) => void,
  projection: string,
  observation: Observation,
  goal: string | undefined,
  efforts: EffortChoice,
): Promise<PrivacyJudgement> {
  const blocked = config.failurePolicy.get() === 'block'
  const llm = ctx.get('llm')
  const provider = config.privacyProvider.get() || config.routeProvider.get()
  const model = config.privacyModel.get() || config.routeModel.get()
  if (!config.privacyConfirmedLocal.get() || llm === undefined || provider === '' || model === '') {
    return blocked ? { kind: 'block' } : { kind: 'passthrough', reason: 'failed' }
  }
  const called = await requestPrivacy(
    llm, provider, model,
    await efforts.choose(provider, model, config.privacyReasoningEffort.get()),
    composePrivacyPrompt(config.privacyPrompt.get(), projection, goal),
    // 这一次请求的输入是整条投影，输出里除摘要还有判定字段，所以预算同样按输入放大（估算口径：4 字符/token）。
    summarizeBudget(Math.ceil(projection.length / 4)),
  )
  noteUsage(observation, called.usage)
  const answer = called.result
  if (!answer.ok) {
    if (blocked) return { kind: 'block' }
    const reason: UnmodifiedReason = answer.failure === 'failed-window' ? 'failed-window' : 'failed'
    remind(reason)
    return { kind: 'passthrough', reason }
  }
  // 判定敏感在任何失败策略下都拦截。
  if (answer.verdict === 'sensitive') return { kind: 'block' }
  if (answer.verdict === 'uncertain') {
    if (blocked) return { kind: 'block' }
    // `uncertain` 连带取消摘要：既不摘要也不拦截，按失败策略放行原文。
    remind('uncertain')
    return { kind: 'passthrough', reason: 'uncertain' }
  }
  return { kind: 'safe', action: answer.action }
}

/**
 * 判定敏感或按失败策略拦截时交回模型的决策：原生 `block`，文案固定且只带工具名。
 * @param toolName - 被拦下的工具名。
 * @returns 交回的决策。
 */
function blockedDecision(toolName: string): PostToolDecision {
  return { kind: 'block', feedback: [{ type: 'text', text: composeBlockedFeedback(toolName) }] }
}

/**
 * 用一条摘要替换模型可见投影：先按入口说明的预留上界比长度，严格更短才写盘并接上入口说明。
 *
 * 干跑只走到「本应替换」为止：不写盘、不记入口，交回的仍是下游决策。
 * @param ctx - 插件的 context。
 * @param readback - 本进程内各会话写出的入口台账。
 * @param exec - 工具执行（会话归属与工具来源）。
 * @param decision - 要替换的决策；干跑时原样交回。
 * @param visible - 要被替换掉的那段模型可见投影。
 * @param summary - 要放进去的摘要正文（可能来自 memo 或隐私模式的合并请求）。
 * @param admission - 这次结果的准入结论，原样记进 debug 记录。
 * @param dryRun - 干跑：不调用 `saveText`、不记读回台账，只预报结果取值。
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
  dryRun: boolean,
): Promise<Applied> {
  const unchanged = (reason: UnmodifiedReason): Applied =>
    ({ decision, outcome: { action: 'unmodified', reason }, admission })
  const original = textOf(visible)
  // 入口说明的实际值写盘前取不到，所以比较用它的预留上界（裁决 A）：不短就透传、一次 `saveText` 都不发。
  if (summary.length + ENTRY_RESERVE >= original.length) return unchanged('not-shorter')

  const store = ctx.get('spillStore')
  if (store === undefined) return unchanged('failed')
  // 干跑没有入口（入口由 `saveText` 产生），所以「本应替换」只记动作、不记摘要文本。
  if (dryRun) return { decision, outcome: { action: 'summarized' }, admission }
  // 后端写入失败的抛出在这里就地兜住：走调用点的兜底 catch 会把准入结论记成「不适用」。
  // `writeEntry` 交回 `undefined` 是「没有会话归属」，与写入失败同走 `failed` 透传。
  const written = await writeEntry(store, exec, exec.name, original).catch((): undefined => undefined)
  if (written === undefined) return unchanged('failed')
  noteReadback(readback, written)
  return {
    decision: {
      kind: 'accept',
      content: [{ type: 'text', text: summary + written.entry }],
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
 * 输入是否已被工具自身截断（票 15）：只读 `result.value` 上的两处已知字段，只认严格 `true`——形状不认识就是
 * `false`，不解析、不猜测、不抛。它是诊断事实，不参与任何取舍。
 * @param result - 工具结果的原始投影。
 * @returns `stdout.truncated` 或 `stderr.truncated` 为 `true` 时为真。
 */
function truncatedOf(result: Readonly<ToolExecutionResult>): boolean {
  const value = result.value as
    | { readonly stdout?: { readonly truncated?: unknown }, readonly stderr?: { readonly truncated?: unknown } }
    | undefined
  if (typeof value !== 'object' || value === null) return false
  return value.stdout?.truncated === true || value.stderr?.truncated === true
}

/**
 * 工具结果里的退出码（票 16 判据 6）：只读 `result.value.exitCode`，不是整数就**没有这个事实**。
 *
 * 缺失与「退出码是 0」在分派里必须分得开（判据 2「缺失的事实永不匹配」）：缺失是「不知道」，不会替用户
 * 把一次失败的命令当成成功的。
 * @param result - 工具结果的原始投影。
 * @returns 整数退出码；形状不认识时为 `undefined`。
 */
function exitCodeOf(result: Readonly<ToolExecutionResult>): number | undefined {
  const value = result.value as { readonly exitCode?: unknown } | undefined
  if (typeof value !== 'object' || value === null) return undefined
  const exitCode = (value as { readonly exitCode?: unknown }).exitCode
  return typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined
}

/**
 * 把命中的族规则交给安全层：族 id 就是记录里的规则 id（{@link condenseRuleOf} 是与语料对账共用的那个映射）。
 * @param rule - 命中的族规则。
 * @returns 可以交给 `condenseText` 的规则。
 */
function familyRule(rule: FamilyRule): CondenseRule {
  return condenseRuleOf(rule)
}

/**
 * 某一族的开关是否打开（票 17 判据 1）：关着的族等于**不在规则表里**——它不接手，这次结果落通用链。
 *
 * 三个字段都是配置文件里的非 volatile 普通值、各管一族，所以打开其中一族不改变另一族的取舍。
 * @param config - 解析后的配置。
 * @param family - 族 id。
 * @returns 该族开关的当前取值。
 */
function familyEnabled(config: Required<Config>, family: CommandFamilyId): boolean {
  switch (family) {
    case 'compactDiff': return config.condenseGitDiff
    case 'sedWindow': return config.condenseSedWindow
    case 'rawDump': return config.condenseRawDump
  }
}

/**
 * 这条结果的分派事实（票 16 判据 2）：先把 DSH 的两处形状读出来，再交给 `dispatch.ts` 摊成扁平 map——摊的规则
 * 与语料对账共用一份，两边的尺子不会各自漂。
 *
 * `bytes` / `lines` / `estimated` 按**下游正文**现算（计划 §4.2 末尾：分派判的是下游正文），与票 15 的尺寸
 * 下限、净收益闸门同一份基准、同一把尺子。`truncated` 与票 15 的诊断字段同源（形状读不到就当没有）。
 * @param exec - 工具执行（命令串在调用参数里）。
 * @param result - 工具结果的原始投影（退出码在 `value` 上）。
 * @param body - 下游正文。
 * @param truncated - 输入是否已被工具自身截断。
 * @returns 事实 map。
 */
function factsOf(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  body: string,
  truncated: boolean,
): Facts {
  return dispatchFacts({
    command: commandOf(exec),
    exitCode: exitCodeOf(result),
    truncated,
    body,
  }, estimateUnits)
}

/**
 * 这次调用的 shell 命令全文；不是 shell 形状（没有 `command` 参数）时 `undefined`。
 * @param exec - 这次工具调用。
 */
function commandOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { readonly command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/**
 * 追加一行挂载决策记录（`kind: 'mount'`）：首个 agent 创建时，每个目标工具走的是接管、遮蔽，还是它看不到。
 *
 * 与结果记录共用开关与路径，所以 debug 关闭或路径为空时同样不写盘。它从 `agent/created` 的监听器里调用，
 * 因此不 await、也不抛：诊断失败不得影响 agent 创建。
 * @param config - 解析后的配置。
 * @param record - 要写入的那一行（内容由 `extract.ts` 按当时的判定拼好）。
 */
function recordMount(config: Required<Config>, record: MountRecord): void {
  if (!config.debug.get()) return
  const path = config.debugPath.get()
  if (path === '') return
  void appendDebugRecord(path, record).catch(() => {
    // 与结果记录同一条契约：诊断写入失败不得把工具调用或 agent 创建变成错误结果。
  })
}

/**
 * 按配置追加一行 debug 记录。debug 关闭或路径为空时不写盘；干跑生效时这一行带 `dryRun` 标记（它的取值是
 * 「本应发生什么」的预报）。
 * @param config - 解析后的配置。
 * @param toolName - 工具名。
 * @param result - 工具结果的原始投影。
 * @param startedAt - 拿到结果前的时间戳。
 * @param applied - 本条结果的结果取值、准入结论与模型请求观测。
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
    pluginVersion: PLUGIN_VERSION,
    toolName,
    resultBytes: measureContent(result.content),
    admission: applied.admission,
    durationMs: Math.round(performance.now() - startedAt),
    cacheObservation: applied.observation.cacheReadTokens,
    judgeInputTokens: applied.observation.judgeInputTokens,
    extract: applied.extract,
    ...applied.condense === undefined ? {} : { condense: applied.condense },
    ...applied.outcome,
    ...(dryRunInEffect(config) ? { dryRun: true } : {}),
  }
  try {
    await appendDebugRecord(path, line)
  } catch {
    // 诊断写入失败不得把工具调用变成错误结果（任何路径都不得抛）；路径由用户配置，插件不自动改用临时路径。
  }
}
