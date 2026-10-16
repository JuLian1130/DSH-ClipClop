/**
 * 本插件的配置契约。
 *
 * 字段绝大多数是 `volatile`：settings 的写回路径只接受 volatile 路径（写入拒绝非 volatile 字段），这也正是
 * 「开关与参数保存即生效、不需要重启」的实现方式——host 半每次处理结果时读一次引用，读到的就是当前值。
 * 字段的默认值即规格「配置项」的当前默认：**摘要能力开启**（默认只摘要主模型主动请求摘要的调用）、隐私闸门关闭、
 * `web_fetch` 不过隐私闸门、摘要准入判断关闭、摘要 route 与准入 route 未配置、
 * 隐私 route 未配置、阈值 1024/12500、三类请求各自「不推理」（档位字段留空，按该 route 的档位表拼出对应 id）、
 * 提示词留空（用内置规则正文）、摘要提示词摘要**默认关闭**（`ruleSummary`）、debug 关闭且不
 * 自动改用临时路径、干跑关闭、**工具结果精简开启**、**按命令语义精简关闭**、`git diff` 族开启。
 *
 * **精简参数是 6 个非 volatile 字段**（票 15）：尺寸下限与净收益阈值以**估算单位**计（与摘要的两个阈值同一把
 * 尺子），封顶参数按**行数**计。非 volatile 的含义是「只影响配置文件的 A/B，不进设置页」：settings 的写回路径
 * 只接受 volatile 路径，非 volatile 字段在页面上看不见、写入非 volatile 路径也会被拒；写在配置文件里则照常可读、
 * 改了值就按其取值生效。默认值引 `condense.ts` 的 `CONDENSE_DEFAULTS`，不在这里另抄一份数字。
 *
 * **票 16 再加五项**：`condenseByCommand`（「按命令语义精简」，volatile，默认关——它是命令族那一步的总闸）与
 * 四个**非 volatile** 字段——族开关 `condenseGitDiff`（默认**开**：关掉它只用于逐个 A/B 对照，总开关打开就该
 * 有族接手）与它的三个封顶参数。族参数一律按 `condense<族名><参数名>` 平铺，默认值引 `gitdiff.ts` 的
 * `GIT_DIFF_DEFAULTS`（票 14 实测的那一档，换一档门槛读数就不可比）。
 *
 * 提示词留空表示「没有用户覆盖」，内置规则正文在 `summary.ts` 与 `admission.ts`；「恢复默认」就是把该字段
 * 清回空串。三个角色（摘要、摘要准入判断、隐私闸门）各有自己的 route：`routeProvider` / `routeModel` 是摘要
 * route 的键名（票 12 之前它就是「主 route」，语义未变，不为了改名打断已存配置）；准入与隐私的 route 留空时
 * 跟随摘要 route，所以三个角色可以设成同一条，也可以各设一条。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { CONDENSE_DEFAULTS } from './condense.ts'
import { GIT_DIFF_DEFAULTS } from './gitdiff.ts'

/**
 * 本插件的配置。
 *
 * **不写 `z<Config, Required<Config>>` 注解**：volatile 字段读入的是普通值（profile patch 里写
 * `summarize: false`），读出的是稳定引用（`apply` 里 `config.summarize.get()`），两者是不同类型；照出厂
 * 先例让 schema 自己推断，`Config` 接口只描述 `apply` 收到的形状。
 */
export interface Config {
  /**
   * 摘要能力开关，**默认开启**。开着才会覆盖三类目标工具并给他们带上可选参数 `extract`。
   *
   * 默认只摘要"主模型主动请求摘要"的调用（`ruleSummary` 关着）；没有配 route 时请求不发、结果原样透传，
   * 所以默认开启不会替用户把正文发到任何地方——发不发由 route 是否配出来决定。
   *
   * 它管的是**摘要提示词那条路**：关掉时那条路不发请求也不替换，取值记 `summary-off`。**隐私闸门不受它影响**——
   * 隐私是同一次请求里既判定又给摘要的独立一路（见 `index.ts` 的「隐私这条路自成一路」）。
   */
  summarize?: Volatile<boolean>
  /**
   * 摘要提示词的摘要开关，**默认关闭**（页面上的「自动摘要大内容」）。
   *
   * 默认只摘要"主模型主动请求摘要"的调用（`extract`）；打开它才会对没请求摘要的候选结果也按摘要提示词试一次，
   * 取值记 `rule-summary-off`（关着且没声明 `extract` 的那批）。用途是量出「`extract` 为空时按摘要提示词摘要」
   * 本身有没有必要。与 `summarize` 同一范围：**它只管摘要提示词那条路**，隐私闸门不用摘要提示词、因而不受
   * 它影响。
   */
  ruleSummary?: Volatile<boolean>
  /** 隐私闸门开关，默认关闭（用户故事 2）。 */
  privacyGate?: Volatile<boolean>
  /**
   * 是否把 `web_fetch` 的结果也交给隐私闸门，默认关闭。
   *
   * `web_fetch` 取的多是外网公开信息，默认不必过闸门（少数取内网地址的部署可以打开它）；其余工具的结果不受这个
   * 开关影响，只要 `privacyGate` 开着就仍然逐条判断。
   */
  webFetchPrivacyGate?: Volatile<boolean>
  /** 摘要准入判断开关，默认关闭（用户故事 17）。 */
  admissionJudge?: Volatile<boolean>
  /** debug 记录开关，默认关闭；关闭时零写盘。 */
  debug?: Volatile<boolean>
  /** debug JSONL 路径；空串表示没有配置路径，此时不开 debug 也不写盘。 */
  debugPath?: Volatile<string>
  /** 干跑开关，默认关闭；开启且 debug 开关与路径都就位时只写「本应发生什么」的记录（用户故事 50）。 */
  dryRun?: Volatile<boolean>
  /** 摘要 route 的 provider；空串表示未配置，此时摘要路径失败并透传。 */
  routeProvider?: Volatile<string>
  /** 摘要 route 的 model id；与 provider 一起决定请求发往哪条 route。 */
  routeModel?: Volatile<string>
  /** 准入 route 的 provider；空串时跟随摘要 route。 */
  admissionProvider?: Volatile<string>
  /** 准入 route 的 model id；空串时跟随摘要 route。 */
  admissionModel?: Volatile<string>
  /** 隐私 route 的 provider；空串时跟随摘要 route。 */
  privacyProvider?: Volatile<string>
  /** 隐私 route 的 model id；空串时跟随摘要 route。 */
  privacyModel?: Volatile<string>
  /** 摘要候选的下限（估算器单位）；低于它的结果原样透传。`0` 表示不设下限。 */
  minInlineTokens?: Volatile<number>
  /** `bash` / `pwsh` / `web_fetch` 的上限；达到或超过它的结果原样交给 spill。`read` 不受它约束。 */
  maxSummarizeTokens?: Volatile<number>
  /** 摘要请求的推理档位；空串表示不推理（按该 route 的档位表拼出对应 id）。 */
  summaryReasoningEffort?: Volatile<string>
  /** 准入请求的推理档位；空串表示不推理（按该 route 的档位表拼出对应 id）。 */
  admissionReasoningEffort?: Volatile<string>
  /** 摘要提示词的规则正文覆盖；空串表示用内置默认。 */
  summaryPrompt?: Volatile<string>
  /** 准入提示词的规则正文覆盖；空串表示用内置默认。 */
  admissionPrompt?: Volatile<string>
  /** 隐私提示词的规则正文覆盖；空串表示用内置默认。 */
  privacyPrompt?: Volatile<string>
  /** 隐私请求的推理档位；空串表示不推理（按该 route 的档位表拼出对应 id）。 */
  privacyReasoningEffort?: Volatile<string>
  /** 「隐私 route 已确认为本地」确认位；未确认时隐私模式按失败策略处理并显示常驻警告（用户故事 30、31）。 */
  privacyConfirmedLocal?: Volatile<boolean>
  /** 隐私失效的处理策略：`passthrough` 放行原文（默认），`block` 给出拒绝结果（用户故事 27、28）。 */
  failurePolicy?: Volatile<'passthrough' | 'block'>
  /**
   * 工具结果精简总开关，**默认开启**（票 15）：长 shell 结果装上就变短，不额外发任何模型请求。
   *
   * 关掉时这一层完全不介入——正文逐字不动、其余流水线照旧，诊断记录记 `condense-off`。它只是本层的开关，
   * 不改变摘要那条路：`summarize` 关着时精简照旧生效（精简取代的是「把整段正文交给模型」）。
   */
  condense?: Volatile<boolean>
  /**
   * 「按命令语义精简」开关，**默认关闭**（票 16）：打开后命令族 handler 才参与分派——命中某一族时只跑那一族，
   * 未命中（或该族关着、被忠实性守卫放弃、非零退出码、输入已被工具自身截断）照旧走通用链。
   *
   * 默认关是刻意的：命令族那一层是**有损**的（它按命令语义丢内容），要不要由用户决定。关着时整层只剩通用形状
   * 变换，行为与票 15 完全一样。
   */
  condenseByCommand?: Volatile<boolean>
  /** 精简的尺寸下限（估算单位）：低于它的结果一个都不触发精简，也不写回退入口。 */
  condenseMinUnits?: number
  /** 精简的净收益阈值（估算单位）：省不到它就交回下游正文，免得为小结果付入口说明的开销。 */
  condenseMinNetGainUnits?: number
  /** 封顶保留的头行数。 */
  condenseHeadLines?: number
  /** 封顶保留的尾行数；错误通常在末尾，所以尾部配额更大。 */
  condenseTailLines?: number
  /** 封顶的**触发**行数：超过它才保留头尾（不是保留量）。 */
  condenseMaxLines?: number
  /** 单行字符上限：超过它的单行被截断并带标记。 */
  condenseMaxLineChars?: number
  /**
   * `git diff` 族（`compactDiff`）的开关，**默认开启**。非 volatile：只影响配置文件里的逐个对照，不进设置页。
   *
   * 默认开是必须的：判据 1 要的是「打开『按命令语义精简』后同一份改动视图就被收窄」——族开关若默认关，总开关
   * 打开却什么都不发生。它的用途是 A/B 时**逐个关掉**某一族，看那一族单独贡献了多少。
   */
  condenseGitDiff?: boolean
  /** 这一族**每 hunk** 保留的明细行数上限（删增行都算）。 */
  condenseGitDiffMaxHunkLines?: number
  /** 这一族整体保留的行数上限（含每文件头与聚合量）；前导上下文不计入它。 */
  condenseGitDiffMaxLines?: number
  /**
   * 这一族**每 hunk** 的前导上下文行数上限。
   *
   * 全 diff 的前导上下文上限由 `condenseGitDiffMaxLines / 10` 推导，两者都**不计入** `condenseGitDiffMaxLines`
   * ——只给「每 hunk」留字段而不写这条推导，前导上下文会跨 hunk 无界增长。
   */
  condenseGitDiffLeadingContext?: number
}

/**
 * 一个推理档位字段：**空串表示"不推理"**——具体发哪个 id 由该 route 的档位表决定（`off` → `none` → 该表里最低的
 * 一档）；非空值是"这次请求就发这个档位"，能不能发同样由那张表判定（不在表里就不发）。
 *
 * 用 `z.string()` 而不是候选集联合：档位 id 由 route 声明，各家词表不同（cline-pass 是 `none`、deepseek 是
 * `off`），还可能声明兜底词表以外的 id，所以装载期判定不了合法性——判定挪到请求前，依据是 route 的档位表
 * （`src/efforts.ts`；设计稿 §3.2 与 §9）。
 */
const effort = () => z.string().default('').volatile()

/** 配置 schema：字段全部可选并在装载时解析成默认值。 */
export const Config = z.object({
  summarize: z.boolean().default(true).volatile(),
  ruleSummary: z.boolean().default(false).volatile(),
  privacyGate: z.boolean().default(false).volatile(),
  webFetchPrivacyGate: z.boolean().default(false).volatile(),
  admissionJudge: z.boolean().default(false).volatile(),
  debug: z.boolean().default(false).volatile(),
  debugPath: z.string().default('').volatile(),
  dryRun: z.boolean().default(false).volatile(),
  routeProvider: z.string().default('').volatile(),
  routeModel: z.string().default('').volatile(),
  admissionProvider: z.string().default('').volatile(),
  admissionModel: z.string().default('').volatile(),
  privacyProvider: z.string().default('').volatile(),
  privacyModel: z.string().default('').volatile(),
  minInlineTokens: z.number().default(1024).volatile(),
  maxSummarizeTokens: z.number().default(12500).volatile(),
  summaryReasoningEffort: effort(),
  admissionReasoningEffort: effort(),
  summaryPrompt: z.string().default('').volatile(),
  admissionPrompt: z.string().default('').volatile(),
  privacyPrompt: z.string().default('').volatile(),
  privacyReasoningEffort: effort(),
  privacyConfirmedLocal: z.boolean().default(false).volatile(),
  failurePolicy: z.union([z.const('passthrough'), z.const('block')]).default('passthrough').volatile(),
  condense: z.boolean().default(true).volatile(),
  // 「按命令语义精简」默认关（票 16）：命令族那一层是有损的，要不要由用户决定。
  condenseByCommand: z.boolean().default(false).volatile(),
  // 六个精简参数**不带 `.volatile()`**：它们只影响配置文件里的 A/B，不出现在设置页（计划 §4.5）。
  condenseMinUnits: z.number().default(CONDENSE_DEFAULTS.minUnits),
  condenseMinNetGainUnits: z.number().default(CONDENSE_DEFAULTS.minNetGainUnits),
  condenseHeadLines: z.number().default(CONDENSE_DEFAULTS.headLines),
  condenseTailLines: z.number().default(CONDENSE_DEFAULTS.tailLines),
  condenseMaxLines: z.number().default(CONDENSE_DEFAULTS.maxLines),
  condenseMaxLineChars: z.number().default(CONDENSE_DEFAULTS.maxLineChars),
  // 票 16 的 `git diff` 族：开关与三个封顶参数同样**不带 `.volatile()`**。默认值取票 14 实测的那一档——
  // 换一档，`docs/dsh-condense-measure/` 里记的门槛读数就不可比（默认值引 `GIT_DIFF_DEFAULTS`，不抄数字）。
  condenseGitDiff: z.boolean().default(true),
  condenseGitDiffMaxHunkLines: z.number().default(GIT_DIFF_DEFAULTS.maxHunkLines),
  condenseGitDiffMaxLines: z.number().default(GIT_DIFF_DEFAULTS.maxLines),
  condenseGitDiffLeadingContext: z.number().default(GIT_DIFF_DEFAULTS.leadingContext),
})
