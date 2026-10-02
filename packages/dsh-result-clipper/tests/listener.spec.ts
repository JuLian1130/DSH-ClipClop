/**
 * 票 02 第 1、3 条：装上插件后结果逐字相同，PTC 子派发原样放行。
 *
 * 观察面写死在**工具执行的结果**上，不是监听器的返回值：`ctx.tools.execute(...)` 走完整个 post-execute 瀑布
 * 后模型拿到什么，就是判据要用的那一面。三类目标工具与一个非目标工具各跑一次，断言文本逐字相同、`isError`
 * 为假；再断言 PTC 子派发（`exec.parent !== undefined`）在**下游 `block`** 也照样不抛错。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { mount, exec, textOf, textTool } from './support/host.ts'

const open: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
})

describe('票 02 第 1 条：结果与未装时逐字相同', () => {
  it.each(['bash', 'web_fetch', 'read'])('三类目标工具（%s）的文本结果原样返回', async (toolName) => {
    const fixture = await mount({})
    open.push(fixture)
    const body = `body of ${toolName} `.repeat(40)
    fixture.ctx.tools.register(textTool(toolName, body))
    const result = await fixture.ctx.tools.execute(exec(toolName))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(body)
  })

  it('非目标工具的结果也原样返回（首版只介入三类工具的摘要路径）', async () => {
    const fixture = await mount({})
    open.push(fixture)
    fixture.ctx.tools.register(textTool('grep', 'no match'))
    const result = await fixture.ctx.tools.execute(exec('grep'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe('no match')
  })

  it('结果里的附加消息与内容形状不变（只检查内容块逐字相同）', async () => {
    const fixture = await mount({})
    open.push(fixture)
    const body = 'multi\nline\nbody'
    fixture.ctx.tools.register(textTool('read', body))
    const result = await fixture.ctx.tools.execute(exec('read'))
    expect(result.content).toEqual([{ type: 'text', text: body }])
  })
})

describe('票 02 第 3 条：PTC 子派发原样放行', () => {
  it('带父派发的调用不改变子派发结果', async () => {
    const fixture = await mount({})
    open.push(fixture)
    const body = 'sub-dispatch body'
    fixture.ctx.tools.register(textTool('bash', body))
    const result = await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(body)
  })

  it('下游监听器返回 block 时子派发照常结算，插件不抛错也不改写它的决策', async () => {
    const fixture = await mount({})
    open.push(fixture)
    fixture.ctx.tools.register(textTool('bash', 'sub-dispatch body'))
    // 后注册的 prepend 监听器在本插件**内层**：它的 block 就是本插件 `next()` 拿到的决策。
    let innerCalls = 0
    fixture.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => {
      innerCalls += 1
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked by the inner policy' }] }
    }, { prepend: true })
    const result = await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(innerCalls).toBe(1)
    // block 结算成失败结果（原生语义），而不是把异常抛给调用方。
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toBe('blocked by the inner policy')
  })
})
