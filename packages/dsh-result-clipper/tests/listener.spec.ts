/**
 * 票 02 第 1、3 条：装上插件后结果逐字相同，PTC 子派发原样放行。
 *
 * 观察面写死在**工具执行的结果**上：`ctx.tools.execute(...)` 走完整个 post-execute 瀑布后模型拿到什么，就是
 * 判据要用的那一面。三类目标工具与一个非目标工具各跑一次，断言文本逐字相同、`isError` 为假。
 *
 * 每条用例都同时打开 debug 并把日志路径指到临时文件：**放行本身在「插件没装上」时也为真**，所以每条断言都
 * 搭配一条阳性对照——普通派发后日志恰多一行（工具名对得上），证明本插件的 `prepend` 监听器确实在这条瀑布上
 * 跑过、且是 `next()` 的外层。PTC 用例因此还能顺带钉住「子派发不产出记录」。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'

/** 本文件装过的夹具与它们的临时目录。 */
const open: HostFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 装一份夹具并打开 debug 管道。
 * @returns 夹具与它的日志路径。
 */
async function mounted(): Promise<{ fixture: HostFixture, path: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-listener-'))
  roots.push(root)
  const path = join(root, 'debug.jsonl')
  const fixture = await mount({ debug: true, debugPath: path })
  open.push(fixture)
  return { fixture, path }
}

/**
 * 读回日志里的记录。
 * @param path - 日志路径。
 * @returns 逐行解析出的记录；文件还不存在时为空数组。
 */
function records(path: string): Array<{ toolName: string }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { toolName: string })
}

describe('票 02 第 1 条：结果与未装时逐字相同', () => {
  it.each(['bash', 'web_fetch', 'read'])('三类目标工具（%s）的文本结果原样返回，且插件在这条瀑布上跑过', async (toolName) => {
    const { fixture, path } = await mounted()
    const body = `body of ${toolName} `.repeat(40)
    fixture.ctx.tools.register(textTool(toolName, body))
    const result = await fixture.ctx.tools.execute(exec(toolName))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(body)
    // 阳性对照：没有这一行就说明断言在「插件未装」下同样为真。
    expect(records(path).map(record => record.toolName)).toEqual([toolName])
  })

  it('非目标工具的结果也原样返回（首版只介入三类工具的摘要路径），插件同样跑过', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('grep', 'no match'))
    const result = await fixture.ctx.tools.execute(exec('grep'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe('no match')
    expect(records(path).map(record => record.toolName)).toEqual(['grep'])
  })

  it('结果的内容块形状不变', async () => {
    const { fixture, path } = await mounted()
    const body = 'multi\nline\nbody'
    fixture.ctx.tools.register(textTool('read', body))
    const result = await fixture.ctx.tools.execute(exec('read'))
    expect(result.content).toEqual([{ type: 'text', text: body }])
    expect(records(path)).toHaveLength(1)
  })
})

describe('票 02 第 3 条：PTC 子派发原样放行', () => {
  it('带父派发的调用不改变子派发结果，且不产出记录', async () => {
    const { fixture, path } = await mounted()
    const body = 'sub-dispatch body'
    fixture.ctx.tools.register(textTool('bash', body))
    // 阳性对照：先跑一次普通派发，证明本插件的 prepend 监听器确实在这条瀑布上（未装插件时这里是 0 行）。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(records(path)).toHaveLength(1)

    const result = await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(body)
    // 子派发直接 next()：既不改写，也不进记录管道。
    expect(records(path)).toHaveLength(1)
  })

  it('下游监听器返回 block 时子派发照常结算，插件不抛错也不改写它的决策', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', 'sub-dispatch body'))
    // 阳性对照：block 监听器注册之前先跑一次普通派发，证明本插件在链上。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(records(path)).toHaveLength(1)

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
    // 子派发仍然不产出记录。
    expect(records(path)).toHaveLength(1)
  })
})
