/**
 * debug 记录管道：把一条工具结果的处理去向写成一行 metadata JSONL。
 *
 * 记录**不含**原文、摘要正文、完整提示词与凭据（规格「契约 · debug JSONL 字段」），所以这里的字段只有
 * 元数据。`结果取值` 是封闭的两段式（动作 + 未改动原因）：`summary-off` 自 02，`not-candidate`、`kept`、
 * `not-shorter`、`failed` 自 03，`read-back` 自 04，`admission-no` 与「准入结论」字段自 06，`uncertain`、
 * `failed-window` 与 `rejected` 自 07。本票（08）补齐规格列出的另两个字段——`缓存观测`（前缀缓存命中）与
 * `判断器输入 token 数`（准入判断那次请求的输入规模）——并给干跑记录加一个 `dryRun` 标记。票 26 加入
 * `rule-summary-off`（规则摘要关闭且这次没声明提取目标）。票 39 加入 `exact-text`（目标要求逐字原文，
 * 摘要器给不出逐字保证，按失败策略透传）。票 40 加入 `whole-result`（目标是 `WHOLE_RESULT` 哨兵，主模型显式
 * 要整份结果）与 `truncated`（摘要输出撞满输出预算、正文被截断，按原文透传）。票 15 加入动作 `condensed` 与
 * `unmodified` 的三个精简原因（`condense-off` / `condense-abstained` / `condense-not-shorter`），并给精简层
 * 一个自己的观测字段 {@link CondenseObservation}。0.1.4 起每条记录（含挂载决策
 * 记录）带 `pluginVersion`：日志按追加写、跨版本混在一个文件里，没有这个字段就无法把观测归属到当时在跑的构建。
 *
 * 同一个文件里还有一条**挂载决策记录**（`kind: 'mount'`，见 {@link MountRecord}）：每次装载写在最前面，
 * 记下目标工具各自走的是接管还是遮蔽。它是"真单关是否生效"的唯一观测点。
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * 写出这些记录的插件版本：本包 `package.json` 的 `version`，读不到时为 `unknown`。
 *
 * 日志按追加写，同一个文件里混着多个版本的记录，而取值的词表是**累加**的——`not-candidate` 这类取值哪个版本都会
 * 写，所以事后靠字段和取值反推构建是不可靠的（本机真实日志就这样考古过一次：想知道哪些观测属于当时在跑的版本，
 * 只能靠提交时间与文案改版去猜）。版本现读而不是抄成常量：抄一份就会和 `package.json` 漂移，而漂移的版本号比
 * 没有版本号更糟。
 */
export const PLUGIN_VERSION: string = readPluginVersion()

/**
 * 读这个包自己的版本号。
 * @returns `package.json` 的 `version`；文件缺失、解析失败或字段不是字符串时为 `unknown`（诊断字段缺一个不得影响写盘）。
 */
function readPluginVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** `unmodified` 的透传原因。新增取值随引入它的机制一起加到这里。 */
export type UnmodifiedReason =
  | 'summary-off'
  | 'rule-summary-off'
  | 'not-candidate'
  | 'admission-no'
  | 'kept'
  | 'not-shorter'
  | 'read-back'
  | 'uncertain'
  | 'failed'
  | 'failed-window'
  | 'exact-text'
  | 'whole-result'
  | 'truncated'
  /** 精简总开关关着（票 15）：这一层不介入，正文逐字不动。 */
  | 'condense-off'
  /** 精简层放弃（票 15）：忠实性守卫不满足、或有损变换的回退入口写不成；两种都交回下游正文。 */
  | 'condense-abstained'
  /** 精简改了正文但过不了净收益闸门（票 15）：省不到阈值就交回下游正文。 */
  | 'condense-not-shorter'

/**
 * 准入结论：这次结果有没有进准入判断、判断说了什么。`not-applicable` 覆盖所有没进准入阶段的情形
 * （开关关闭、隐私模式、摘要关闭、未进候选、按入口读回、memo 命中）；`failed` 是进了准入阶段但判断没做成
 * （调用失败、超时、空结果、非法结果，或摘要 route 没配出来——准入与摘要共用它）——按契约仍然继续摘要，所以它只出现在这条
 * 字段里，与最终的结果取值分开。
 */
export type AdmissionVerdict = 'yes' | 'no' | 'failed' | 'not-applicable'

/** 一条记录的「结果取值」：动作取闭集之一，`unmodified` 时必须附原因，`rejected` 只记动作不附原因。 */
export type DebugOutcome =
  | { readonly action: 'summarized' }
  | { readonly action: 'rejected' }
  | { readonly action: 'condensed' }
  | { readonly action: 'unmodified'; readonly reason: UnmodifiedReason }

/**
 * 精简层的观测（票 15）：只在它**考虑过**这条结果时写——精简工具（`bash` / `grep` / `pwsh`）、正文是一张
 * 文本块、且结果没被下游 `block`。所以 `read` / `web_fetch` / `glob` 的记录完全没有这个字段；「一处都没改动」
 * （低于尺寸下限、通用链一处都没命中）时它不表态、不改正文，但观测字段照写——规格要的是「输入已被工具截断的
 * 频率」，分母必须是本层看到的所有精简工具结果，而不是被改动过的那些。
 */
export interface CondenseObservation {
  /**
   * 本次**命中**（改动了正文）的精简规则 id，按施加顺序。一处都没命中、或整层守卫放弃时是空数组；
   * `condense-not-shorter` 的行里照记——闸门挡下的是「替换」，不是「哪条规则命中过」，那个区别正是
   * 「为什么这条大结果没变短」的答案。票 16 起这里也会出现**命令族 id**（`compactDiff`）：命中某一族时只跑
   * 那一族，不再叠一遍通用链。
   */
  readonly rules: readonly string[]
  /**
   * 输入是否已被工具自身截断（`bash` 的 `stdout.truncated` / `stderr.truncated`）。它只记事实、不参与取舍，
   * 用途是解释「为什么这次没有更省」——已被截断的输出，头尾封顶能压掉的东西本来就不多。
   */
  readonly truncated: boolean
  /**
   * 本次**选中的命令族**（票 16 判据 11）。没有族接手时这个字段不存在——未命中、该族关着、平台面不接，
   * 或需要完整输入的族被截断事实拒绝（票 20 起非零退出码不再拦族），都是这个样子。族被选中但**它的守卫
   * 放弃了**时这个字段在、而 `rules` 记的是随后通用链里真正改动正文的 id（层序：守卫放弃落通用链）。
   */
  readonly family?: string
  /**
   * 分派事实的扁平 map（票 16 判据 2）：`command` / `exitCode` / `truncated` / `format` / `bytes` / `lines` /
   * `estimated`。**缺失的事实不在里面**——少了哪一项就是没有那一项，不是空值。
   */
  readonly facts?: Readonly<Record<string, string | number | boolean>>
}

/** 一行 debug JSONL。 */
export type DebugRecord = DebugOutcome & {
  /** 写下这条记录的插件版本（{@link PLUGIN_VERSION}）；日志跨版本追加，靠它把记录归属到构建。 */
  pluginVersion: string
  /** 工具名。 */
  toolName: string
  /** 结果大小：文本块的 UTF-8 字节数（图片等非文本块不计入）。 */
  resultBytes: number
  /** 准入结论；没发准入请求时是 `not-applicable`。 */
  admission: AdmissionVerdict
  /** 调用耗时：本监听器从拿到结果到最终决策的毫秒数。 */
  durationMs: number
  /** 缓存观测：这条结果的各次模型请求里命中前缀缓存的输入 token 数之和；没发请求或底层未报告时为 0。 */
  cacheObservation: number
  /**
   * 判断器输入 token 数：摘要准入判断那次请求的输入规模（未缓存 + 缓存读 + 缓存写三种输入 token 之和）。
   * 没发准入请求（开关关闭、隐私模式、未进候选、按入口读回、memo 命中、摘要关闭）时为 `null`。
   */
  judgeInputTokens: number | null
  /**
   * 这次调用有没有声明提取目标（`arguments.extract` 上的非空字符串，且摘要与可选参数两个开关都开着才算）。
   *
   * 只记这个布尔、不记目标正文（记录不含原文与提示词）。它的用途是回答「主模型判断该不该传参数准不准」——那是
   * 「观察一段时间后删掉准入判断」这条退出条件的前提。
   */
  extract: boolean
  /**
   * 精简观测（票 15）：本层考虑过这条结果时就存在。它让「已精简」与三个未改动原因都能被事后分辨，并记下输入
   * 是否已被工具自身截断（用来统计截断占比）；不含正文，规则命中是文字变换而不是命令族（命令族 handler 属票
   * 16/17）。
   */
  condense?: CondenseObservation
  /**
   * 干跑记录：动作与原因记的是「本应发生什么」的预报，不是真实结果。真实记录没有这个键。
   */
  dryRun?: true
}

/**
 * 结果大小：文本块的 UTF-8 字节数。
 * @param content - 工具结果的渲染投影。
 * @returns 文本块合计字节数；没有文本块时为 0。
 */
export function measureContent(content: readonly ContentBlock[]): number {
  let bytes = 0
  for (const block of content) {
    if (block.type === 'text') bytes += Buffer.byteLength(block.text, 'utf8')
  }
  return bytes
}

/**
 * 以追加方式写一行记录，父目录不存在时先创建。
 * @param path - 用户配置的日志路径。
 * @param record - 要写入的记录：一条工具结果，或一条挂载决策。
 */
export async function appendDebugRecord(path: string, record: DebugRecord | MountRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 一个目标工具在本次装载里走的路：全局接管 / agent 作用域遮蔽 / 这个 agent 看不到它。 */
export type MountMode = 'takeover' | 'shadow' | 'absent'

/**
 * 一行挂载决策记录（`kind: 'mount'`），每次装载只写一行（首个 agent 创建时），记录的是那个时点的快照：
 * 首次挂载失败、之后重试成功也不补写。
 *
 * 为什么单独要这一行：部署用 patch 关掉原生条目后由插件挂回（真单关），与"原生还在、插件只是遮蔽了它"交出的
 * 工具完全一样——模型侧 schema、工具行为、debug 里的结果记录都分不出来。要确认真单关真的生效，只能把当时
 * `ctx.tools.get(name)` 的判定结果记下来。
 */
export type MountRecord = {
  readonly kind: 'mount'
  /** 写下这条记录的插件版本（{@link PLUGIN_VERSION}）；与结果记录同一用途。 */
  readonly pluginVersion: string
  /** `process.platform`：接管计划按平台不同，看诊断时先看这个。 */
  readonly platform: string
  /** 工具名 → 走的路。缺键表示那个工具不在本次接管计划里，也没有被遮蔽。 */
  readonly tools: Readonly<Record<string, MountMode>>
}
