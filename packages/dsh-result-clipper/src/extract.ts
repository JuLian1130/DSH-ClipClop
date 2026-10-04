/**
 * 可选参数 `extract`：让主模型在调用工具时**自己声明**要拿回什么，从而不必由插件事后猜。
 *
 * 三类目标工具的安装策略来自实测（见 `.scratch/dsh-result-clipper/exp2/RESULTS.md` 与设计稿 §14.5/§14.6）：
 * - `read`：原生 `read` 与 `write`/`edit`/`read_image` 同在一个插件条目里，禁用它会一并失去写与编辑能力，
 *   所以只走 agent 作用域遮蔽（`{...原生定义}` + 一个 `extract` 参数）。
 * - `bash` / `web_fetch`：各自独占一个插件条目，且能用自己的插件定义重新挂载（`ctx.plugin`，见 `TAKEOVER`），
 *   所以优先"全局接管"（条目被 patch 关掉后就地改写原生定义）；原生还在时回落到 agent 作用域遮蔽。
 *
 * 无论哪条策略，模型参数里的 `extract` 都留在 `exec.arguments` 上（遮蔽只是把字段摘掉后委托执行），
 * 所以调用点统一用 {@link extractGoalOf} 取目标。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// 这两个原生包只用于"接管后把工具挂回来"：它们注册的是原生实现，本模块只在原地补参数与包一层 execute。
// 用命名空间导入而不是它们的 `apply`：挂回来要走 `ctx.plugin`，见 `TAKEOVER`。
import * as bashTool from '@deepseek-ai/dsh-tool-bash'
import * as webTool from '@deepseek-ai/dsh-tool-web'

/** 标在已被本模块扩展过的定义上，避免同一次装载里重复补参数或重复包 execute。 */
const EXTENDED = Symbol('dsh-result-clipper:extract')

/** `extract` 参数的说明；三类工具共用。 */
export const EXTRACT_DESCRIPTION = [
  'What you need the result reduced to, when you want a conclusion, a filter, or an aggregation',
  'rather than the complete output (for example "every line containing ERROR, with its timestamp").',
  'Leave it empty when you need the complete output verbatim. Small results pass through unchanged.',
].join(' ')

/** `read` 的工具说明追加段：把"范围读"与"声明提取目标"两条路的边界写清楚。 */
export const READ_GUIDANCE = [
  'When you know which lines you need (you counted them, or grep/glob gave you the line numbers) and you need',
  'that text verbatim, pass offset/limit and read that range — do not pass extract.',
  'When you need a conclusion, a filter, or an aggregation from a large file, or you do not know where in the',
  'file the answer is, pass extract with exactly the information you need back.',
  'extract is optional and costs you nothing when it does not apply: a small result is returned unchanged, and',
  'for a large one the full text stays available at a path you can read later. Write only the information you',
  'need in extract — never restate or change the task there.',
].join(' ')

/** `bash` 的工具说明追加段。 */
export const BASH_GUIDANCE = [
  'When you need a conclusion, a filter, or an aggregation from a large command output, pass extract with',
  'exactly the information you need back. When you need the complete output verbatim, do not pass extract.',
  'extract is optional and costs you nothing when it does not apply: a small output is returned unchanged, and',
  'for a large one the full text stays available at a path you can read later. Write only the information you',
  'need in extract — never restate or change the task there.',
].join(' ')

/** `web_fetch` 的工具说明追加段。 */
export const WEB_FETCH_GUIDANCE = [
  'When you need a conclusion or a few specific facts from a large page, pass extract with exactly the',
  'information you need back (for example "the release date and the version number"). When you need the page',
  'text verbatim, do not pass extract.',
  'extract is optional and costs you nothing when it does not apply: a small page is returned unchanged, and',
  'for a large one the full text stays available at a path you can read later. Write only the information you',
  'need in extract — never restate or change the task there.',
].join(' ')

/** 三类工具各自的说明追加段。 */
const GUIDANCE: Record<string, string> = {
  read: READ_GUIDANCE,
  bash: BASH_GUIDANCE,
  web_fetch: WEB_FETCH_GUIDANCE,
}

/**
 * 这次调用声明的提取目标。
 * @param exec - 工具执行；只读 `arguments.extract`，不解析别的形状。
 * @returns 非空目标；没传、传空串或不是字符串时为 `undefined`。
 */
export function extractGoalOf(exec: { readonly arguments?: unknown }): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const goal = (args as { extract?: unknown }).extract
  if (typeof goal !== 'string') return undefined
  const trimmed = goal.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把主模型声明的目标拼成摘要提示词的规则正文。
 *
 * 生产摘要规则默认「要求逐字就看 keep」，直接拿它配提取目标时，"原样贴出某个函数"这类目标会被判 keep、
 * 整条路径白跑（实测如此）。这里的语义不同：目标要求的那部分可以只贴相关片段，所以显式说明。
 * @param goal - 主模型写的提取目标。
 * @returns 该次摘要请求的规则正文。
 */
export function extractRule(goal: string): string {
  return [
    `主模型这次的提取目标：${goal}`,
    '',
    '按这个目标改写这段工具结果，交回满足目标所需的最小正文：',
    '- 目标要求「原样列出/原样贴出/逐行」时，只贴相关的那几行或那个片段，不要贴全文；',
    '- 目标只问几个值时，只给这几个值和它们所在的键；',
    '- 只要交回的正文比原文短，就返回 summarize；只有目标要求的正文与原文一样长时才返回 keep。',
  ].join('\n')
}

/**
 * 复制一份定义：补上 `extract` 参数、追加说明段，并让执行体把该字段摘掉后委托原生执行。
 *
 * 摘字段是必须的：原生定义的 `execute` 会按自己的参数 schema 校验（未知键目前放行，但不该依赖这点）。
 * @param native - 原生定义（或已扩展过的定义：此时原样返回）。
 * @param name - 工具名，决定追加哪段说明。
 * @returns 可直接注册的扩展定义。
 */
export function extendedDefinition(native: ToolDefinition, name: string): ToolDefinition {
  if (isExtended(native)) return native
  const guidance = GUIDANCE[name] ?? ''
  const parameters = native.parameters ?? {}
  const extended: ToolDefinition = {
    ...native,
    description: guidance === '' ? native.description : `${native.description}\n${guidance}`,
    parameters: {
      ...parameters,
      type: parameters.type ?? 'object',
      properties: {
        ...(parameters.properties ?? {}),
        extract: { type: 'string', description: EXTRACT_DESCRIPTION },
      },
    },
    async execute(args, exec) {
      const rest = stripExtract(args)
      return native.execute(rest, exec)
    },
  }
  markExtended(extended)
  return extended
}

/**
 * 就地改写一条**已经注册**的定义：补参数、追加说明、包一层 execute。
 *
 * 只有这条路能在"原生条目已被 patch 关掉、名字由我们挂回来"时用：注册表没有替换 API（同层重名会抛错），
 * 所以拿到的定义只能原地改。依据：定义对象不冻结；模型侧 schema 在组装时才读 `definition.parameters`；
 * 派发时直接调 `tool.execute`。
 * @param definition - 注册表里的定义对象。
 * @param name - 工具名，决定追加哪段说明。
 */
export function extendInPlace(definition: ToolDefinition, name: string): void {
  if (isExtended(definition)) return
  const guidance = GUIDANCE[name] ?? ''
  const nativeExecute = definition.execute
  const parameters = definition.parameters ?? {}
  definition.description = guidance === '' ? definition.description : `${definition.description}\n${guidance}`
  definition.parameters = {
    ...parameters,
    type: parameters.type ?? 'object',
    properties: {
      ...(parameters.properties ?? {}),
      extract: { type: 'string', description: EXTRACT_DESCRIPTION },
    },
  }
  definition.execute = async (args, exec) => nativeExecute(stripExtract(args), exec)
  markExtended(definition)
}

/** 摘掉 `extract`，其余参数原样。 */
function stripExtract(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args
  const rest = { ...args as Record<string, unknown> }
  delete rest.extract
  return rest
}

/** 这条定义是否已被本模块扩展过。 */
function isExtended(definition: ToolDefinition): boolean {
  return (definition as unknown as Record<symbol, unknown>)[EXTENDED] === true
}

/** 打上扩展标记（不参与 JSON、不进模型侧 schema）。 */
function markExtended(definition: ToolDefinition): void {
  Object.defineProperty(definition, EXTENDED, { value: true, enumerable: false })
}

/**
 * 独占一个插件条目、且能重新挂载的工具：优先"全局接管"。
 *
 * 用 `ctx.plugin` 挂回来，不直接调它们的 `apply`：服务解析按**访问方 fiber 的 inject** 走，本插件的 inject 只有
 * `tools`，直接 `applyBashTool(ctx, {})` 会在原生实现内部读 `ctx.systemPrompt` / `ctx.shell` / `ctx.web` 时抛
 * `cannot get property "…" without inject`——这一抛发生在 `agent/created` 的串行监听器里，会把 agent 创建一起弄
 * 失败。`ctx.plugin` 用原生插件自己的 inject 建子 fiber，解析照原生来；它交回可 await 的 fiber，等它落地再取
 * 定义，模型侧 schema 才是扩过的。`web_fetch` 只挂取回这一个：`web_search` 照旧由原生条目提供。
 */
const TAKEOVER: Record<string, (ctx: Context) => unknown> = {
  bash: (ctx) => ctx.plugin(bashTool, {}),
  web_fetch: (ctx) => ctx.plugin(webTool, { fetch: true, search: false }),
}

/**
 * 装载 `extract` 参数：`read` 走 agent 作用域遮蔽；`bash` / `web_fetch` 先试全局接管，接管不到再回落遮蔽。
 *
 * `read` 不尝试接管：原生 `read` 与 `write`/`edit`/`read_image` 同一条目，禁用它会一并失去写与编辑能力。
 *
 * 接管判定放在**第一个 agent 创建时**而不是 `apply()` 里：装载顺序会让早执行的那一次看到空表，从而误判
 * "原生不在"并对仍在装载的原生条目重复注册（同层重名会抛错，整条插件装载失败）。挂回来是异步的（`ctx.plugin`
 * 交回的 fiber），所以监听器改成 async 并 await 它，模型侧 schema 才是扩过的。
 * @param ctx - 插件 context；`tools` 已就绪。
 */
export function installExtractArg(ctx: Context): void {
  const taken = new Set<string>()
  let decided = false
  ctx.on('agent/created', async ({ agent }) => {
    if (!decided) {
      decided = true
      for (const name of ['bash', 'web_fetch']) {
        // 原生已经不在了 = 部署用 patch 关掉了那个条目，可以自己挂回来并就地改写。
        if (ctx.tools.get(name) !== undefined) continue
        await TAKEOVER[name]?.(ctx)
        const registered = ctx.tools.get(name)
        if (registered === undefined) continue
        extendInPlace(registered, name)
        taken.add(name)
      }
    }
    for (const name of ['read', 'bash', 'web_fetch']) {
      if (taken.has(name)) continue
      // 该 agent 本来就看不到这个工具（被限制或没装载）时不动它：作用域自有注册不过 allow/deny 过滤，
      // 遮蔽一个不可见的工具等于把限制悄悄解除。
      const native = ctx.tools.get(name, agent)
      if (native === undefined) continue
      agent.ctx.tools.register(extendedDefinition(native, name))
    }
  })
}
