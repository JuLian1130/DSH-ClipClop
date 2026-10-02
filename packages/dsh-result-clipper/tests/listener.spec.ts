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
import type { Context } from '@deepseek-ai/cordis'
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
 * @param before - 在被测插件之前跑一次的钩子（用于观察注册位置）。
 * @returns 夹具与它的日志路径。
 */
async function mounted(before?: (ctx: Context) => void): Promise<{ fixture: HostFixture, path: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-listener-'))
  roots.push(root)
  const path = join(root, 'debug.jsonl')
  const fixture = await mount({ debug: true, debugPath: path }, before)
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

describe('票 02 接缝第 1 条：注册为 prepend（位于更早注册的普通监听器外层）', () => {
  it('早注册的短路监听器挡不住本插件：它仍在链上并留下记录', async () => {
    // 短路监听器**先注册**且**不带 prepend**：`push` 让它排在列表末位＝最内层。本插件若带 `prepend`，
    // `unshift` 把它排到 0 号位＝最外层，于是先跑、`next()` 到短路监听器并拿到它的决策，记录照写；若去掉
    // `prepend`，插件被 `push` 到短路监听器之后，短路监听器先跑且不调 `next()`，插件一次都不跑、记录为 0。
    const { fixture, path } = await mounted((ctx) => {
      ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
    })
    const body = 'body'
    fixture.ctx.tools.register(textTool('bash', body))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe(body)
    expect(records(path).map(record => record.toolName)).toEqual(['bash'])
  })
})

describe('票 02 第 3 条：PTC 子派发原样放行', () => {  it('带父派发的调用不改变子派发结果，且不产出记录', async () => {
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
    // 阳性对照：普通派发留下一条记录，证明本插件的 prepend 监听器在这条瀑布上。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(records(path)).toHaveLength(1)

    // cordis 的 waterfall 按列表从前到后跑：`prepend: true` 走 `unshift` 排在最前＝最外层，后注册的更靠前；
    // 不带 prepend 的走 `push` 排最后＝最内层。所以这里的 block 监听器是本插件的**下游**，插件先跑并 `next()`
    // 到它；反过来给它加 prepend 会把插件挡在链外，这条判据就空转了。
    let innerCalls = 0
    fixture.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => {
      innerCalls += 1
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked by the inner policy' }] }
    })
    // 非父派发 + 下游 block：插件作为外层跑过、额外留一条记录，说明它没有因下游 block 而抛错或改写决策。
    const blocked = await fixture.ctx.tools.execute(exec('bash'))
    expect(innerCalls).toBe(1)
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked.content)).toBe('blocked by the inner policy')
    expect(records(path)).toHaveLength(2)

    // 父派发：同样结算成下游的 block，且 `innerCalls` 前进证明链确实穿过了插件（它调用了 next()、没有自己抛错
    // 或自己返回 block）；插件在父派发上早退，所以记录不增。
    const result = await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(innerCalls).toBe(2)
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toBe('blocked by the inner policy')
    expect(records(path)).toHaveLength(2)
  })
})
