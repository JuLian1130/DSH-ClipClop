/**
 * host 侧夹具：按 `packages/spill/spill-policy` 测试的形态装出「真 ToolRuntime + 一个文本工具」，再用
 * `ctx.tools.execute(exec)` 把结果送过 `tools/post-execute` 瀑布。
 *
 * 只提供被测插件真正需要的服务：`systemPrompt`（ToolRuntime 的 inject）与 `tools`，另可按需放进假 route
 * （摘要请求）与假 spill 后端（原结果入口）。PTC 子派发用 `exec.parent` 直接构造——它与普通派发走同一条
 * post-execute，插件对两者的区别恰好就是这一个判据。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as plugin from '../../src/index.ts'
import { Config } from '../../src/index.ts'
import type { FakeRoute } from './route.ts'
import { FakeSpill } from './spill.ts'

/** 装好的夹具。 */
export interface HostFixture {
  readonly ctx: Context
  /** 假 spill 后端；`spill: null` 装载时没有后端（`undefined`）。 */
  readonly spill: FakeSpill | undefined
  /** 释放整棵 context。 */
  dispose(): Promise<void>
}

/**
 * 装出 ToolRuntime 并挂上被测插件。
 * @param config - 插件装载配置（loader 解析前的形状）。
 * @param before - 在装载被测插件**之前**跑一次的钩子（用来先注册别的 post-execute 监听器，从而观察本插件的注册位置）。
 * @param llm - 摘要请求要用的假 route；不给时 context 里没有 `llm` 服务。
 * @param spill - 假 spill 后端；省略时新装一个，显式传 `null` 表示没有后端。
 * @returns 夹具。
 */
export async function mount(
  config: Schemastery.TypeS<typeof Config> = {},
  before?: (ctx: Context) => void,
  llm?: FakeRoute,
  spill: FakeSpill | null = new FakeSpill(),
): Promise<HostFixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (llm !== undefined) ctx.provide('llm', llm as never)
  if (spill !== null) ctx.provide('spillStore', spill as never)
  before?.(ctx)
  await ctx.plugin(plugin, config)
  return { ctx, spill: spill ?? undefined, dispose: async () => { await ctx.fiber.dispose() } }
}

/**
 * 一个把 `text` 逐字返回的文本工具；名字可指定，以便注册 `bash` / `web_fetch` / `read`。
 * @param name - 工具名。
 * @param text - 工具正文。
 * @returns 注册用的工具定义。
 */
export function textTool(name: string, text: string): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text }] },
  })
}

/**
 * 一次调用的最小 exec 形状；`parent` 给出时即为 PTC 子派发，`session` 是 spill 归属用的会话 id。
 * @param name - 工具名。
 * @param parent - 父派发 token；不给就是模型直连调用。
 * @param args - 工具参数；默认空对象，需要时可放入哨兵值检验「记录不泄漏它们」。
 * @param session - 会话 id；默认 `s1`。换一个 id 即模拟 fork／重启后的新会话。
 * @returns 可交给 `ctx.tools.execute` 的 exec。
 */
export function exec(name: string, parent?: string, args: unknown = {}, session = 's1'): ToolExecution {
  const agent = { session: { header: { id: session } } }
  return {
    callId: ToolCallId(`call-${name}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
    ...parent === undefined ? {} : { parent: parent as unknown as ToolExecutionToken },
  } as unknown as ToolExecution
}

/**
 * 把结果里的文本块拼起来（判据是「逐字相同」，所以按文本比较）。
 * @param content - 结果内容。
 * @returns 拼接后的文本。
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}
