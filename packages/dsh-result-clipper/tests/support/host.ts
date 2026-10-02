/**
 * host 侧夹具：按 `packages/spill/spill-policy` 测试的形态装出「真 ToolRuntime + 一个文本工具」，再用
 * `ctx.tools.execute(exec)` 把结果送过 `tools/post-execute` 瀑布。
 *
 * 只提供被测插件真正需要的服务：`systemPrompt`（ToolRuntime 的 inject）与 `tools`。PTC 子派发用 `exec.parent`
 * 直接构造——它与普通派发走同一条 post-execute，插件对两者的区别恰好就是这一个判据。
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

/** 装好的夹具。 */
export interface HostFixture {
  readonly ctx: Context
  /** 释放整棵 context。 */
  dispose(): Promise<void>
}

/**
 * 装出 ToolRuntime 并挂上被测插件。
 * @param config - 插件装载配置（loader 解析前的形状）。
 * @returns 夹具。
 */
export async function mount(config: Schemastery.TypeS<typeof Config> = {}): Promise<HostFixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, config)
  return { ctx, dispose: async () => { await ctx.fiber.dispose() } }
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
 * 一次调用的最小 exec 形状；`parent` 给出时即为 PTC 子派发。
 * @param name - 工具名。
 * @param parent - 父派发 token；不给就是模型直连调用。
 * @returns 可交给 `ctx.tools.execute` 的 exec。
 */
export function exec(name: string, parent?: string): ToolExecution {
  return {
    callId: ToolCallId(`call-${name}`),
    name,
    arguments: {},
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
