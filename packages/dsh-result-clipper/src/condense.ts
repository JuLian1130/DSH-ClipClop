/**
 * 工具结果精简的确定性核心：通用形状变换的链、尺寸下限与净收益闸门。
 *
 * 这一层不调用模型、不读磁盘、不改变内容的语义，只按确定性规则压掉不承载判断的机械形状。四条规则按计划
 * §4.3 的 13–16 顺序施加（链式，**无损在前、有损在后**，各自幂等）：剥 ANSI 转义序列 → 去 `\r` 覆盖行 →
 * 相邻游程去重 → 尾部偏置封顶。计划 §4.2 的「首个命中者胜」管的是命令族 handler 的单选，**不是**这一组，
 * 所以这里四条全部依序施加：剥了格式控制序列之后照样做相邻重复行折叠。
 *
 * 一次判定的取值就是计划 §7.3 的四个去向：`condensed`（替换）、`unchanged`（一处都没改动，含不适用工具、
 * 低于尺寸下限）、`abstained`（**忠实性守卫**放弃，计划 §4.1 #8）、`not-shorter`（过了变换但过不了闸门，
 * 计划 §4.1 #2 与 #4）。调用方把它们映射成 debug 取值 `condensed` / `condense-abstained` /
 * `condense-not-shorter`（`unchanged` 不表态，交给既有词表）。
 *
 * 三条实现约束，每条都在计划里有出处：
 *
 * 1. **闸门以模型本来会看到的正文为基准**（计划 §2.2 第 1 条、ADR 0005）。传进来的 `body` 是下游（含 spill）
 *    处理之后的那一份，不是原始投影——否则一条被 spill 压到 5 KB 的结果会被换成 40 KB 的「精简」结果，
 *    与「节省进入上下文的 token」正好相反。
 * 2. **有损替换的回退入口开销算进被比较的那一侧**（计划 §4.1 #1「先拼后比」）。入口说明的实际值写盘前取不到
 *    （`saveText` 才给出 `locator`），所以本层写入口时用它的**预留上界** {@link CondenseParams.entryReserveChars}
 *    计价，与既有摘要路径的裁决 A 同一个办法；上界性质使「真写了入口 ⟹ 实际总长仍更短」成立。正文已有上游入口
 *    时没有新增说明文字，直接比较正文。
 * 3. **两把尺子是一把**（计划 §4.1 表后的「两把尺子必须是一把」）。尺寸下限与净收益阈值都用插件既有的
 *    `@deepseek-ai/dsh-token-meter/estimate`，不引入第二套估算口径。
 *
 * 参数都是普通值（配置文件里的非 volatile 字段，计划 §4.5），所以「改配置里的值就改行为」是构造性的：本模块
 * 每次都从 `params` 现算，没有任何硬编码的阈值或行数。
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { CommandFamilyId } from './dispatch.ts'
import { ENTRY_RESERVE } from './entry.ts'
import {
  isUpstreamNoticeLine,
  TRUNCATED_NOTICE,
  UNAVAILABLE_PATH,
} from './notice.ts'

/**
 * 精简层作用的工具：两个 shell（`bash`、Windows 上是 `pwsh`）与 native `grep`。
 *
 * 这是**本层自己的**工具集，与摘要候选的 `TARGET_TOOLS` 无关（计划 §3.1）：`grep` 只吃精简、不进摘要；
 * `glob` 全池只有 144,180 token、已自带 `GLOB_MAX_RESULTS = 100` 封顶与位置说明，连一个 handler 的维护成本
 * 都盖不住；`read` / `web_fetch` 一个字不动。`pwsh` 进表是**平台条件**：通用变换按内容判定，对它是免费的。
 */
export const CONDENSE_TOOLS = ['bash', 'grep', 'pwsh'] as const

/** 精简层作用的工具名。 */
export type CondenseTool = typeof CONDENSE_TOOLS[number]

/**
 * 工具名是不是精简层的作用对象。
 * @param toolName - 工具名。
 * @returns 在 {@link CONDENSE_TOOLS} 里时为真。
 */
export function isCondenseTool(toolName: string): toolName is CondenseTool {
  return (CONDENSE_TOOLS as readonly string[]).includes(toolName)
}

/** 一条**通用形状变换**的名字。 */
export type GeneralRuleId = 'strip-ansi' | 'strip-cr' | 'dedup-adjacent' | 'tail-cap'

/**
 * 一条精简规则的 id：通用形状变换，或**命令族**（票 16 起后者也会出现在观测里）。
 *
 * 两种 id 不会在同一条记录里同时出现——命中某一族时只跑那一族、不再叠一遍通用链（层序，票 16 备注）。观测
 * 要能回答「这次是哪一族接手的」，所以族 id 与通用变换 id 走同一个字段。
 */
export type CondenseRuleId = GeneralRuleId | CommandFamilyId

/**
 * 一条精简规则：一条确定性文本变换及其适用条件。
 *
 * `apply` 交回改动后的正文；**交回 `undefined` 表示这条规则的忠实性守卫放弃了这次变换**，此时整层放弃、原样
 * 交回下游正文（`CONTEXT.md` 的「忠实性守卫」：不满足时该次变换整体放弃）。抛出的异常由
 * {@link condenseText} 兜住，与守卫放弃同一个去向——按计划 §4.1 #8，异常归「放弃」不归「失败」。
 */
export interface CondenseRule {
  readonly id: CondenseRuleId
  /** 这条规则会不会丢掉内容；会丢的必须写出回退入口（计划 §4.1 #3）。 */
  readonly lossy: boolean
  apply(text: string): string | undefined
}

/** 通用形状变换的一条规则：id 收窄到 {@link GeneralRuleId}，于是调用方不必为族 id 留分支。 */
export interface GeneralRule extends CondenseRule {
  readonly id: GeneralRuleId
}

/**
 * 精简参数：配置文件里的非 volatile 字段再加上回退入口的预留上界。
 *
 * 尺寸下限与净收益阈值以**估算单位**计（与摘要的两个阈值同一把尺子），封顶参数按**行数**计。
 */
export interface CondenseParams {
  /** 尺寸下限（估算单位）：低于它的调用一个都不触发精简。不沿用 1024——那个下限是为「值不值得发一次模型请求」设的。 */
  readonly minUnits: number
  /** 净收益阈值（估算单位）：省不到它就透传，免得为小结果付入口说明的开销。 */
  readonly minNetGainUnits: number
  /** 封顶保留的头行数。 */
  readonly headLines: number
  /** 封顶保留的尾行数。错误通常在末尾，所以尾部配额更大。 */
  readonly tailLines: number
  /** 封顶的**触发**行数：超过它才保留头尾（计划 §4.3 的「总 300 行」即此，不是保留量）。 */
  readonly maxLines: number
  /** 单行字符上限：超过它的单行被截断并带标记。 */
  readonly maxLineChars: number
  /** 回退入口说明在净收益比较里的预留上界（字符数）：有损替换才用得上。 */
  readonly entryReserveChars: number
}

/**
 * 默认参数：计划 §4.3 #13–16 与 §4.1 #4/#5 的取值。配置 schema 的默认值引这里，避免两处各写一份。
 */
export const CONDENSE_DEFAULTS = {
  minUnits: 128,
  minNetGainUnits: 24,
  headLines: 50,
  tailLines: 200,
  maxLines: 300,
  maxLineChars: 2000,
  entryReserveChars: ENTRY_RESERVE,
} as const satisfies CondenseParams

/** 一次精简的判定。 */
export type CondenseVerdict =
  /** 一处都没改动（不适用工具、空正文、低于尺寸下限、四条规则都没改动任何一处）。 */
  | { readonly kind: 'unchanged' }
  /** 忠实性守卫放弃：原样交回下游正文。 */
  | { readonly kind: 'abstained' }
  /** 改了，但过不了净收益闸门：交回下游正文。`rules` 记下**命中**（改动了正文）的规则——「为什么这条大结果没变短」的答案就在这里。 */
  | { readonly kind: 'not-shorter'; readonly rules: readonly CondenseRuleId[] }
  /**
   * 替换：`text` 是精简后的正文。`lossy` 为真时 `entry` 指出回退入口的归属——本层写（`own`）或正文里
   * 已经有一条上游入口（`upstream`，不再追加第二条）。
   */
  | {
    readonly kind: 'condensed'
    readonly text: string
    readonly lossy: false
    /** 这次真正改动了正文的规则，按施加顺序。 */
    readonly rules: readonly CondenseRuleId[]
  }
  | {
    readonly kind: 'condensed'
    readonly text: string
    readonly lossy: true
    /** 有损替换的入口归属：本层写，或正文里已有上游入口。 */
    readonly entry: 'own' | 'upstream'
    /** 这次真正改动了正文的规则，按施加顺序。 */
    readonly rules: readonly CondenseRuleId[]
  }

/** 相邻游程的最短长度：少于三行不算游程（计划 §4.3 #15）。 */
const MIN_RUN = 3

/**
 * 格式控制序列：CSI、OSC、字符集选择、两字符转义，最后一条裸 `ESC` 是兜底——它保证第一遍之后正文里再没有
 * `ESC`，于是第二遍必然不动，幂等是构造出来的而不是碰巧成立的（计划 §4.1 #6）。
 */
const ANSI = new RegExp(
  '\\x1b\\[[0-?]*[ -/]*[@-~]'                  // CSI
  + '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?' // OSC
  + '|\\x1b[()][0-9A-Za-z]'                    // 字符集选择
  + '|\\x1b[@-Z\\\\-_]'                        // 两字符转义
  + '|\\x1b',                                  // 兜底
  'g',
)

/**
 * 正文末尾的上游位置说明（含开头的 `\n\n`）。
 * @param text - 下游正文。
 * @returns 末尾的说明块；没有时为 `undefined`。
 */
function trailingPositionNotice(text: string): string | undefined {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(')')) return undefined
  const start = trimmed.lastIndexOf('\n\n(')
  if (start < 0) return undefined
  const notice = trimmed.slice(start)
  return isUpstreamNoticeLine(notice.slice(2)) ? notice : undefined
}

/** bash 工具在非零退出时追加的尾部标记；留在 `compactDiff` 的输入里会让它把整段当成非 diff。 */
const EXIT_MARKER = /\n\[exit code: \d+\]$/

/**
 * `compactDiff` 的输入必须是纯 diff：把末尾的上游位置说明与退出标记剥下来，变换后按原顺序回贴。
 *
 * 这两个块是工具 / spill 写给模型看的元数据，本身不是 diff 内容；族 handler 看见它们会整体放弃。剥下来只影响
 * 解析，不影响模型最终看到的正文——`condenseText` 会把它们原样接回精简结果之后。
 * @param text - 下游正文。
 * @returns 纯 diff 的部分与要回贴的尾部块。
 */
function splitForCompactDiff(text: string): { readonly core: string, readonly tail: string } {
  let core = text
  let tail = ''
  const notice = trailingPositionNotice(core)
  if (notice !== undefined) {
    tail = notice
    core = core.trimEnd().slice(0, -notice.length)
  }
  const cut = core.trimEnd()
  const exit = EXIT_MARKER.exec(cut)
  if (exit !== null) {
    tail = cut.slice(exit.index) + tail
    core = cut.slice(0, exit.index)
  }
  return { core, tail }
}

/**
 * 这次有损替换是否已经有一条上游入口可回退。
 *
 * 两条来源：正文末尾的 `(... stored at: ...)`（spill-policy / `grep` / `glob`），以及 bash 的
 * `[output truncated; full output: <path>]`（路径不是 `(unavailable)` 时）。**还必须确认说明本身真的留在替换
 * 结果里**：尾部预算会留住它、单行截断不碰它，但如果某条规则把它裁掉了，就不能假装还有入口——那时交回
 * `false`，由本层写自己的入口。只认出 ` stored at: ` 不够：路径被切掉的说明指不回完整输出（票 20 复审）；
 * 前导的两个换行只是分隔符，尾部预算只剩 1 行时会被裁掉，不算说明被裁。
 * @param body - 下游正文。
 * @param composed - 精简后、已接回尾部块的正文。
 * @returns 已有上游入口时为真。
 */
function hasUpstreamEntry(body: string, composed: string): boolean {
  const notice = trailingPositionNotice(body)
  if (notice !== undefined && composed.includes(notice.trim())) return true
  for (const match of body.matchAll(TRUNCATED_NOTICE)) {
    if (match[1] !== UNAVAILABLE_PATH && composed.includes(match[0])) return true
  }
  return false
}

/**
 * 把一张文本块按插件既有的估算器计价。
 *
 * 导出给分派层用：事实里的 `estimated` 与这一层的尺寸下限、净收益阈值必须是**同一把尺子**（计划 §4.1 表后的
 * 「两把尺子必须是一把」）。
 * @param text - 正文。
 * @returns 估算单位（`ceil(字符数/4) + 4`）。
 */
export function estimateUnits(text: string): number {
  return estimateContent([{ type: 'text', text } satisfies ContentBlock])
}

/**
 * 把回退入口说明的预留上界计价：预留是接在同一张文本块之后的字符数，所以按同一把尺子当成那张块的尾部来算——
 * 不自己声明「4 字符/单位」这个常数，免得两把尺子漂移。
 * @param text - 精简后的正文。
 * @param entryReserveChars - 入口说明的预留上界（字符数）。
 * @returns 估算单位。
 */
function unitsWithReserve(text: string, entryReserveChars: number): number {
  return estimateUnits(text + 'x'.repeat(entryReserveChars))
}

/** 剥 ANSI 转义序列。正文里没有 `ESC` 时原样交回（O(n) 预检，计划 §4.1 #9）。 */
function stripAnsi(text: string): string {
  if (!text.includes('\u001b')) return text
  return text.replace(ANSI, '')
}

/** 去 `\r` 覆盖行：CRLF 先归一，再对每行只保留最后一个 `\r` 之后的内容（进度条只留最终态）。 */
function stripCr(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line)
    .join('\n')
}

/** 相邻游程去重：游程 >= {@link MIN_RUN} 且非空行时压成一行 + `[xN]`；仅相邻、不跨距离；空行游程豁免。 */
function dedupAdjacent(text: string): string {
  if (!text.includes('\n')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    if (j - i >= MIN_RUN && (lines[i] as string).trim() !== '') {
      out.push(lines[i] as string, `[x${j - i}]`)
      changed = true
    } else {
      out.push(...lines.slice(i, j))
    }
    i = j
  }
  return changed ? out.join('\n') : text
}

/**
 * 尾部偏置封顶：先截超长单行，再在超过 {@link CondenseParams.maxLines} 行时保留头
 * {@link CondenseParams.headLines} + 尾 {@link CondenseParams.tailLines}，中间换成一行省略标记。
 *
 * 计划 §4.3 写的是「头 50 / 尾 200 / 总 300 行」，而 50 + 200 = 250 ≠ 300，唯一自洽的读法是 300 为**触发**
 * 阈值而非保留量（本仓票 15 已把这条读法写死）。单行截断把标记也算进 2000 字符预算，于是产出恰好 <= 2000，
 * 第二遍不再触发；行封顶的产出是 250 行上下，同样不再触发——这条有损规则因此也是幂等的。
 *
 * **上游位置说明**：它通常在正文末尾，`tailLines` 的尾部预算会把它留住；留住的那一条由 `condenseText` 识别为
 * 上游入口，调用方不再写本层入口（票 20）。这条规则因此不再因为说明的存在而放弃。**位置说明与截断说明所在的
 * 行不参与单行截断**：它们指向完整输出，截掉路径等于把入口弄坏（票 20 复审）。
 * @param text - 下游正文。
 * @param params - 精简参数。
 * @returns 封顶后的正文；不触发封顶时原样交回。
 */
function tailCap(text: string, params: CondenseParams): string {
  const lines = text.split('\n')
  const overLongLine = lines.some(line => line.length > params.maxLineChars)
  if (lines.length <= params.maxLines && !overLongLine) return text
  let capped = lines
  let truncated = 0
  if (overLongLine) {
    capped = capped.map((line) => {
      if (line.length <= params.maxLineChars || isUpstreamNoticeLine(line)) return line
      const mark = `…[单行截断 +${line.length - params.maxLineChars}]`
      truncated++
      return line.slice(0, params.maxLineChars - mark.length) + mark
    })
  }
  if (capped.length > params.maxLines) {
    const dropped = capped.length - (params.headLines + params.tailLines)
    capped = [
      ...capped.slice(0, params.headLines),
      `…[省略 ${dropped} 行]`,
      ...capped.slice(-params.tailLines),
    ]
  }
  return truncated === 0 && capped.length === lines.length ? text : capped.join('\n')
}

/**
 * 通用形状变换的链（计划 §4.3 的 13–16）：无损在前、有损在后，各自幂等。
 * @param params - 精简参数；封顶那条规则按它取值。
 * @returns 依施加顺序排列的规则表。
 */
export function generalRules(params: CondenseParams): readonly GeneralRule[] {
  return [
    { id: 'strip-ansi', lossy: false, apply: stripAnsi },
    { id: 'strip-cr', lossy: false, apply: stripCr },
    { id: 'dedup-adjacent', lossy: false, apply: dedupAdjacent },
    { id: 'tail-cap', lossy: true, apply: (text: string) => tailCap(text, params) },
  ]
}

/**
 * 对一份下游正文跑一次精简，并按尺寸下限与净收益闸门给出取舍。
 *
 * 顺序即判据：不适用工具 / 空正文 / 低于尺寸下限一律不表态（`unchanged`）；链上没有一处改动也是 `unchanged`
 * （计划 §4.1 #2 的「拒绝 no-op」）；守卫放弃是 `abstained`；改动过不了闸门是 `not-shorter`。
 *
 * 闸门用**预留上界**代替入口说明的实际长度（写盘前取不到），所以「真写了入口 ⟹ 实际总长仍严格更短」成立：
 * 调用方只要在 `lossy` 为真且 `entry === 'own'` 时先写入口、再按写成的说明拼正文，就不会出现「先写后弃」。
 * 正文里已有上游入口时替换不会新增说明文字，闸门直接比较正文（票 20）。
 * @param toolName - 工具名；不在 {@link CONDENSE_TOOLS} 里时直接 `unchanged`。
 * @param body - **模型本来会看到的正文**（下游含 spill 处理之后的那一份）。
 * @param params - 精简参数。
 * @param rules - 规则表；默认是 {@link generalRules}。它不是给将来预留的扩展点：当前唯一的非默认用法是
 *   `tests/condense.spec.ts` 注入一条必抛异常的规则，把「异常归守卫放弃」这条判据钉在固定用例上——纯字符串
 *   变换没有别的办法确定性地抛出来。命令族 handler 落地时若不需要换表，这个参数应当删掉。
 * @returns 这次精简的判定。
 */
export function condenseText(
  toolName: string,
  body: string,
  params: CondenseParams,
  rules: readonly CondenseRule[] = generalRules(params),
): CondenseVerdict {
  if (!isCondenseTool(toolName)) return { kind: 'unchanged' }
  if (body === '') return { kind: 'unchanged' }
  const before = estimateUnits(body)
  if (before < params.minUnits) return { kind: 'unchanged' }

  // `compactDiff` 的解析器要求整段都是 diff：末尾的上游位置说明与退出标记先剥下来，变换后回贴。
  // 通用链与另外两族不需要这条——它们的头尾预算会把尾部块留住（票 20）。
  const compactDiff = rules.length === 1 && rules[0]?.id === 'compactDiff'
  const split = compactDiff ? splitForCompactDiff(body) : { core: body, tail: '' }

  let text = split.core
  const applied: CondenseRuleId[] = []
  let lossy = false
  for (const rule of rules) {
    let next: string | undefined
    try {
      next = rule.apply(text)
    } catch {
      // 异常归「放弃」不归「失败」（计划 §4.1 #8）：这一层抛出去会把整个工具调用变成错误结果。
      return { kind: 'abstained' }
    }
    if (next === undefined) return { kind: 'abstained' }
    if (next !== text) {
      applied.push(rule.id)
      text = next
      if (rule.lossy) lossy = true
    }
  }
  if (text === split.core) return { kind: 'unchanged' }

  const composed = text + split.tail
  const upstream = lossy && hasUpstreamEntry(body, composed)
  // 有上游入口时没有本层入口的开销，预留不参与比较（票 20）；否则仍用预留上界。
  const after = lossy
    ? upstream ? estimateUnits(composed) : unitsWithReserve(composed, params.entryReserveChars)
    : estimateUnits(composed)
  // 两道判据，缺一不可：**不严格更短就交回下游正文**——这一条由机制本身保证，任何配置都关不掉它（计划 §4.1 #2
  // 的「不可配置关闭」指的正是它，否则把阈值配成 0 或负数就能让本层交出更长或等长的正文）；以及省幅要过阈值，
  // 那一条才是配置里的 `minNetGainUnits`。
  if (after >= before || before - after < params.minNetGainUnits) {
    return { kind: 'not-shorter', rules: applied }
  }
  if (!lossy) return { kind: 'condensed', text: composed, lossy: false, rules: applied }
  const entry: 'own' | 'upstream' = upstream ? 'upstream' : 'own'
  return { kind: 'condensed', text: composed, lossy: true, entry, rules: applied }
}
