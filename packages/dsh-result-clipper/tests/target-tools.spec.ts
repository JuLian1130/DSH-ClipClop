/**
 * 票 03 第 12 条：三个目标工具均不定义 `finalizeContent`（守护测试）。
 *
 * `finalizeContent` 在 `tools/post-execute` **之后**执行、是模型可见的最后一跳，所以目标工具一旦挂上它，
 * 本插件的替换就会被它改写。这不靠读源码保证，而是把部署里真实的三条工具装进真 `ToolRuntime` 后逐个查。
 *
 * 阳性对照用一条**定义了** `finalizeContent` 的工具证明探针看得见该字段——没有它，「都为 undefined」在
 * 「探针根本没取到工具」的实现下同样为真。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 三个目标工具名。 */
const TARGETS = ['bash', 'web_fetch', 'read'] as const

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/**
 * 装真 `ToolRuntime` 与部署里注册这三条工具的三个插件。执行期才用到的服务给最小桩：本用例只查注册面，
 * 不发起任何调用。
 * @returns 装好的 context。
 */
async function loaded(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // 不约束的后端：`sandboxMode` 缺席时两个工具都不要求 `sandboxPolicy`。
  ctx.provide('fs', { sandboxMode: undefined } as never)
  ctx.provide('web', {} as never)
  ctx.provide('shell', { sandboxMode: undefined } as never)
  ctx.provide('shellEnv', {} as never)
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(ToolWeb, { search: false })
  await ctx.plugin(ToolBash, {})
  return ctx
}

describe('票 03 第 12 条：目标工具不定义 finalizeContent', () => {
  it('bash、web_fetch、read 都注册成功，且都不带 finalizeContent', async () => {
    const ctx = await loaded()
    for (const name of TARGETS) {
      const tool = ctx.tools.get(name)
      expect(tool, `${name} 未注册`).toBeDefined()
      expect(tool?.finalizeContent, `${name} 定义了 finalizeContent`).toBeUndefined()
    }
  })

  it('阳性对照：定义了 finalizeContent 的工具能被同一个探针查到', async () => {
    const ctx = await loaded()
    ctx.tools.register(defineTool({
      name: 'terminal_fixture',
      description: 'fixture',
      parameters: {},
      output: { schema: { type: 'json' }, render: (): ContentBlock[] => [{ type: 'text', text: 'ok' }] },
      finalizeContent: (_exec, result) => [...result.content],
      execute: async () => ({}),
    }))
    expect(ctx.tools.get('terminal_fixture')?.finalizeContent).toBeTypeOf('function')
  })
})
