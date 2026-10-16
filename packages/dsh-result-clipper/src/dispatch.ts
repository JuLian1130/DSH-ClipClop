/**
 * 分派层：把一条结果的事实摊平成扁平 map，按**有序规则表**取**首个命中者**，选中一个命令族 handler。
 *
 * 出处是计划 §4.2（`doc/tool-result-trimming-plan.md:123-135`）与规格「测试决定 · 规则表」（`spec.md:234`）；
 * 层序（分派先于通用链、命中某一族时只跑那一族）见计划 §4.2 末尾那段与票 16 备注的层序条。这一层**不调用
 * 模型、不读磁盘、不改正文**：它只回答「这次轮到哪一族」，收窄与取舍交给族 handler 与安全层。
 *
 * 三条判据落在这一层，每条都是**纯函数**、夹具可注入规则（票 16 判据 3）：
 *
 * 1. **缺失的事实不匹配**（判据 2）：`Facts` 里**没有**这一项就是没有，不是空值——要求某事实在场的规则在它
 *    缺失时不命中。`undefined` 与 `false` / `0` / `''` 是两回事。
 * 2. **装载时锚定校验**（判据 4）：命令正则按**顶层** `|` 拆开，每个分支都必须以 `^` 开头，否则整条规则被拒绝
 *    并记进 {@link RuleTable.rejected}。字符组、分组与转义里的 `|` 不算顶层分支（`^git (diff|show)` 合法）。
 * 3. **脚手架不参与**（判据 5）：`cd X && echo "标题" && 真命令 | head` 按**首个实质命令**匹配规则；目录切换、
 *    纯变量赋值与标题回显都是脚手架，管道右侧（`| head`）也不是产出正文的命令。
 *
 * 两条**守卫**在选族之前拦下整族（判据 6、7）：输入已被工具自身截断时不接族（理由：命令族 handler 会输出
 * 跨文件聚合量，而只有尾部片段时那些是假事实）；命令以非零退出码结束时也不接族（失败的输出往往正是要精读的
 * 错误正文）。两者都只放弃**命令族那一步**，通用形状变换照常生效——所以这里的返回值是「没有族接手」，
 * 调用方落回通用链。
 *
 * @module
 */

import { compactDiff, type GitDiffParams } from './gitdiff.ts'

/** 分派事实的名字。事实是**扁平**的：没有嵌套容器，键即语义。 */
export type FactName = 'command' | 'exitCode' | 'truncated' | 'format' | 'bytes' | 'lines' | 'estimated'

/** 一条事实的取值。`format` 取 `'text'`（正文恰好一张文本块）或 `'other'`。 */
export type FactValue = string | number | boolean

/**
 * 一次结果的事实 map。**缺失的事实不在 map 里**——这是判据 2 的实现方式：`get` 到 `undefined` 表示「没有这个
 * 事实」，与「事实的取值是 `0` / `false` / 空串」必须分得开。
 */
export type Facts = ReadonlyMap<FactName, FactValue>

/**
 * 命令族的 id。
 *
 * 票 16 只落 `compactDiff`，它的三个封顶参数的字段名与命名法见 `config.ts`；另外两族（`sedWindow` / `rawDump`）
 * 的名字由票 16 备注的「族参数命名」条定死、随票 17 落地，这里不提前放进来。
 */
export type CommandFamilyId = 'compactDiff'

/** 一条命令族规则：命令匹配 + 附加事实要求 + 命中后对正文的收窄。 */
export interface FamilyRule {
  /** 这一族。 */
  readonly family: CommandFamilyId
  /**
   * 命令匹配的正则**源码**（不是 `RegExp` 对象）：装载时要按顶层 `|` 拆分支做锚定校验，源码是可比对的那一份。
   * 匹配的对象是**首个实质命令**（{@link firstSubstantiveCommand}），不是整条命令串。
   */
  readonly command: string
  /** 还要求哪些事实在场且取这些值；**事实缺失即不命中**（判据 2）。 */
  readonly facts?: Readonly<Partial<Record<FactName, FactValue>>>
  /** 这一族会不会丢掉内容；会丢的必须写出回退入口（安全层的判据归票 15）。 */
  readonly lossy: boolean
  /**
   * 收窄正文。交回 `undefined` 表示**这一族的忠实性守卫放弃了这次收窄**，调用方落回通用链；抛出的异常由
   * 调用方按「守卫放弃」兜住，不按「失败」记（票 15 已定的归口）。
   * @param text - 下游正文（模型本来会看到的那一份）。
   * @returns 收窄后的正文；守卫放弃时为 `undefined`。
   */
  apply(text: string): string | undefined
}

/** 一条被装载期拒绝的规则：它有一个未锚定的分支。 */
export interface RejectedRule {
  /** 被拒绝的规则属于哪一族。 */
  readonly family: CommandFamilyId
  /** 未以 `^` 开头的那个顶层分支原文。 */
  readonly branch: string
}

/** 装载后的规则表：能用的规则 + 被拒绝的规则（后者要告警，见 {@link compileRules}）。 */
export interface RuleTable {
  readonly rules: readonly FamilyRule[]
  readonly rejected: readonly RejectedRule[]
}

/** 命令链的分段符：`&&` / `||` / `;` / `|` / 换行。 */
const SEGMENT_SEPARATOR = /&&|\|\||;|\||\n/

/**
 * 脚手架成分的开头：目录切换、纯变量赋值、单纯的计时 / 环境包装。它们不产出被收窄的正文，因而不参与分派。
 * 词表照 `docs/dsh-condense-measure/transforms_gitdiff.py:54` 的测量原型（票 14 用同一张表量出的读数）。
 */
const SCAFFOLD = /^(?:cd|pushd|popd|export|set|source|\.|time|env|umask|ulimit)\b/

/** 标题横幅：`echo` / `printf` 打出来的分隔行，同样不参与分派。 */
const BANNER = /^(?:echo|printf)\b/

/**
 * 按**顶层** `|` 拆开一条正则源码。
 *
 * 顶层指不在字符组（`[...]`）、不在分组（`(...)`）、且未被转义（`\|`）的位置——这三处里面的 `|` 是正则自己的
 * 语法，不是「分支」。拆错的后果是把合法规则当成未锚定而拒绝，所以这三条都要认。
 * @param source - 正则源码。
 * @returns 顶层分支的原文，按出现顺序。
 */
function topLevelBranches(source: string): string[] {
  const branches: string[] = []
  let current = ''
  let depth = 0
  let inClass = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string
    if (char === '\\') {
      current += char + (source[index + 1] ?? '')
      index++
      continue
    }
    if (inClass) {
      current += char
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
      current += char
      continue
    }
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(depth - 1, 0)
    if (char === '|' && depth === 0) {
      branches.push(current)
      current = ''
      continue
    }
    current += char
  }
  branches.push(current)
  return branches
}

/**
 * 装载规则表：拒绝未锚定的规则，其余按声明顺序保留（顺序即优先级，判据 3）。
 *
 * 拒绝是**逐规则**的：一条规则里只要有一个未锚定分支，整条规则都不参与分派——半条规则匹配得上比没有更危险。
 * 被拒绝的规则记进 {@link RuleTable.rejected}，并**逐条交给 `onRejected`**（判据 4 的「告警」：调用方把它接到
 * 装载期的日志上）。
 * @param specs - 规则表，按优先级从高到低。
 * @param onRejected - 每条被拒绝的规则调一次；不给时只记进返回值。
 * @returns 能用的规则与被拒绝的规则。
 */
export function compileRules(
  specs: readonly FamilyRule[],
  onRejected?: (rejected: RejectedRule) => void,
): RuleTable {
  const rules: FamilyRule[] = []
  const rejected: RejectedRule[] = []
  for (const spec of specs) {
    const unanchored = topLevelBranches(spec.command).filter(branch => !branch.startsWith('^'))
    if (unanchored.length > 0) {
      for (const branch of unanchored) {
        rejected.push({ family: spec.family, branch })
        onRejected?.({ family: spec.family, branch })
      }
      continue
    }
    rules.push(spec)
  }
  return { rules, rejected }
}

/**
 * 命令链里的**首个实质命令**：跳过空段、脚手架与标题横幅，回到第一个真正产出正文的命令段。
 *
 * 只按分隔符切段、不解析 shell 语法：票面判据 5 要的就是「带壳的命令也能被正确识别」，不是完整的 shell 解析。
 * 管道右侧（`| head`）自然落在后面的段里，因此不参与判定——产出正文的是管道左侧。
 * @param command - 工具调用里的命令串原文。
 * @returns 首个实质命令段（已去首尾空白）；整条链都是脚手架时为 `undefined`。
 */
export function firstSubstantiveCommand(command: string): string | undefined {
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const trimmed = segment.trim()
    if (trimmed === '' || SCAFFOLD.test(trimmed) || BANNER.test(trimmed)) continue
    return trimmed
  }
  return undefined
}

/**
 * 规则要求的事实是否都在场且取值相同。
 * @param facts - 这次结果的事实 map。
 * @param required - 规则要求的事实。
 * @returns 每一项都在场且相等时为真；任何一项缺失即为假（判据 2）。
 */
function satisfies(facts: Facts, required: Readonly<Partial<Record<FactName, FactValue>>>): boolean {
  for (const [name, value] of Object.entries(required) as [FactName, FactValue][]) {
    const present = facts.get(name)
    if (present === undefined || present !== value) return false
  }
  return true
}

/**
 * 选出接手这次结果的族规则：平台面 → 两条守卫 → 正文形态 → 首个实质命令 → 规则表按序取首个命中者。
 *
 * 顺序即判据，每一步都能独立观察：平台面（判据 13）只认 `bash`，`pwsh` 上即使命令串是 unix 命令也不接族；
 * 守卫拦的是整族（判据 6、7）；正文形态不是单张文本块时没有可收窄的对象；命令事实缺失时没有可匹配的命令串。
 * @param toolName - 工具名。
 * @param facts - 这次结果的事实 map。
 * @param rules - 已装载的规则表（{@link compileRules} 的产物）。
 * @returns 接手的规则；没有族接手时为 `undefined`。
 */
export function selectFamily(
  toolName: string,
  facts: Facts,
  rules: readonly FamilyRule[],
): FamilyRule | undefined {
  // 平台面：命令族规则只认 unix 命令串，因而只在 `bash` 结果上求值（票 14 原型把规则注册在 ("bash","pwsh")
  // 上是测量产物，不是生产门禁）。
  if (toolName !== 'bash') return undefined
  // 守卫一：输入已被工具自身截断——只有尾部片段时跨文件聚合量是假事实。
  if (facts.get('truncated') === true) return undefined
  // 守卫二：非零退出码。**事实缺失时不由它挡下**——缺失是「不知道」，与「知道它失败了」不是一回事。
  const exitCode = facts.get('exitCode')
  if (typeof exitCode === 'number' && exitCode !== 0) return undefined
  // 正文形态：不是恰好一张文本块时，压成一块会改变结果的形状，不在命令族的判据里。
  if (facts.get('format') !== 'text') return undefined
  // 缺失的事实永不匹配：没有命令事实就没有可匹配的命令串。
  const command = facts.get('command')
  if (typeof command !== 'string') return undefined
  const substantive = firstSubstantiveCommand(command)
  if (substantive === undefined) return undefined
  for (const rule of rules) {
    if (rule.facts !== undefined && !satisfies(facts, rule.facts)) continue
    if (new RegExp(rule.command).test(substantive)) return rule
  }
  return undefined
}

/**
 * `git diff` 族的命令匹配。
 *
 * 容得下前导选项：本语料里过下限的 1,887 次 git diff 调用中有 144 次带 flag（`git -C <路径> diff` 115 次、
 * `git --no-pager diff` 29 次，量法见 `docs/dsh-condense-measure/verify_dispatch_diff.py`），只认 `^git diff`
 * 会漏掉它们。放宽的代价可控：误命中（如 `git log --grep diff`）由族 handler 的守卫兜住——那种正文里没有
 * `@@` 也没有 `diff --`，它会放弃、落回通用链。
 */
export const GIT_DIFF_COMMAND = '^git\\s+[^|;&\\n]*\\bdiff(?:\\s|$)'

/**
 * 已发布的命令族规则表，按优先级从高到低（票 16 只有一族）。
 *
 * `params` 用 thunk 传进来、`apply` 每次现读：三个封顶参数是配置文件里的非 volatile 字段，改了值就该按其
 * 取值生效（与票 15 的六个参数同一条规矩），所以表在装载期编译一次，参数在调用期读。
 * @param params - 读这一族当前封顶参数的取值函数。
 * @returns 规则表；还没做锚定校验，装载时交给 {@link compileRules}。
 */
export function builtinRules(params: () => GitDiffParams): readonly FamilyRule[] {
  return [{
    family: 'compactDiff',
    command: GIT_DIFF_COMMAND,
    lossy: true,
    apply: (text: string): string | undefined => compactDiff(text, params()),
  }]
}

/**
 * 把命中的族规则适配成安全层认的规则：**族 id 就是记录里的规则 id**（票 16 判据 11），有损与否由族自己声明。
 *
 * 生产接线与语料对账（`tests/condense-corpus-diff.spec.ts`）共用这一个映射——对账要是自己抄一份，两边的尺子就
 * 会各自漂。
 * @param rule - 命中的族规则。
 * @returns 可以交给 `condenseText` 的规则（结构上与 `condense.ts` 的 `CondenseRule` 一致，这里不引它，免得两个
 *   模块互相 import 类型）。
 */
export function condenseRuleOf(rule: FamilyRule): {
  readonly id: CommandFamilyId
  readonly lossy: boolean
  apply(text: string): string | undefined
} {
  return { id: rule.family, lossy: rule.lossy, apply: (text: string) => rule.apply(text) }
}

/** 摊事实要用的四样输入：命令串、退出码、截断事实与**下游正文**。 */
export interface FactInput {
  /** 命令串；没有（非 shell 形状的结果）就不放进 map。 */
  readonly command?: string | undefined
  /** 退出码；读不到就不放进 map——缺失与「退出码是 0」必须分得开（判据 2）。 */
  readonly exitCode?: number | undefined
  /** 输入是否已被工具自身截断。 */
  readonly truncated: boolean
  /** 下游正文（模型本来会看到的那一份）。 */
  readonly body: string
}

/**
 * 按下游正文与三条调用事实摊出**扁平事实 map**（票 16 判据 2）：`command` / `exitCode` / `truncated` / `format` /
 * `bytes` / `lines` / `estimated`，**没有的事实不放进去**。
 *
 * `bytes` / `lines` / `estimated` 按下游正文现算（计划 §4.2 末尾：分派判的是下游正文），与票 15 的尺寸下限、
 * 净收益闸门同一份基准。`format` 在这里只有 `'text'` 一种取值能走到分派（正文恰好一张文本块），它是「这次为什么
 * 没有族接手」的直接答案。
 *
 * 生产接线与语料对账共用它，免得两边的尺子各自漂。
 * @param input - 命令串、退出码、截断事实与下游正文。
 * @param estimate - 计价函数；默认用布局里现成的那把尺子。语料对账与生产都走默认值。
 * @returns 事实 map。
 */
export function dispatchFacts(input: FactInput, estimate: (text: string) => number): Facts {
  const facts = new Map<FactName, FactValue>()
  if (input.command !== undefined && input.command !== '') facts.set('command', input.command)
  if (input.exitCode !== undefined) facts.set('exitCode', input.exitCode)
  facts.set('truncated', input.truncated)
  facts.set('format', 'text')
  facts.set('bytes', Buffer.byteLength(input.body, 'utf8'))
  facts.set('lines', input.body.split('\n').length)
  facts.set('estimated', estimate(input.body))
  return facts
}
