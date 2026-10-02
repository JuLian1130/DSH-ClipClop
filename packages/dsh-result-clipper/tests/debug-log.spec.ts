/**
 * 票 02 第 4、5 条：debug 管道。
 *
 * 观察面是**写出的文件本身**：开启后按追加方式产出 metadata JSONL（工具名、结果大小、调用耗时），摘要关闭时
 * 记 `summary-off`；关闭或路径为空时零写盘。第 5 条把记录反序列化后逐键核对——字段集合里没有正文、摘要
 * 正文、提示词与凭据的位置，另外再断言原文不出现在整行文本里。
 *
 * 摘要能力开启时本票没有候选判断，因而没有可记录的结果取值（`not-candidate` 等自 03 起引入）；这条边界在
 * 下面的用例里写死，好让 03 接手时知道要改哪里。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, exec, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { Config } from '../src/index.ts'

// 「零写盘」的观察面是**写调用本身**：只断言某个猜出来的文件名不存在是空转的（插件回退到别的默认路径照样
// 绿）。所以把 `appendFile` 包一层记账，其余 fs 行为原样透传。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

/** 每个用例一个临时目录：里面的路径形态（父目录不存在、已有内容、不可写）互不干扰。 */
const roots: string[] = []

/** 本文件装过的插件实例；用例里不断言释放顺序，统一在 afterEach 收场。 */
const open: HostFixture[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.mocked(appendFile).mockClear()
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-'))
  roots.push(root)
  return root
}

/**
 * 装一份被测插件并登记收场。
 * @param config - 插件装载配置。
 * @returns 夹具。
 */
async function mounted(config: Schemastery.TypeS<typeof Config>): Promise<HostFixture> {
  const fixture = await mount(config)
  open.push(fixture)
  return fixture
}

/** 读回一整份 JSONL，逐行解析。 */
function readRecords(path: string): unknown[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as unknown)
}

describe('票 02 第 4 条：开启时按追加写产出元数据记录', () => {
  it('一条工具结果写一行，字段是工具名、结果大小、调用耗时与 summary-off', async () => {
    const root = tempRoot()
    const path = join(root, 'nested', 'debug.jsonl')
    const fixture = await mounted({ summarize: false, debug: true, debugPath: path })
    const body = 'x'.repeat(513)
    fixture.ctx.tools.register(textTool('bash', body))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(existsSync(path)).toBe(true)
    const records = readRecords(path)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      toolName: 'bash',
      resultBytes: Buffer.byteLength(body, 'utf8'),
      durationMs: expect.any(Number),
      action: 'unmodified',
      reason: 'summary-off',
    })
  })

  it('父目录不存在时自动创建（不自动改用临时路径，仍写在配置的路径上）', async () => {
    const root = tempRoot()
    const path = join(root, 'a', 'b', 'c', 'debug.jsonl')
    const fixture = await mounted({ debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('web_fetch', 'page'))
    await fixture.ctx.tools.execute(exec('web_fetch'))
    expect(readRecords(path)).toHaveLength(1)
  })

  it('追加写：已有内容保留，多条结果按调用顺序各占一行', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    writeFileSync(path, `${JSON.stringify({ marker: 'pre-existing' })}\n`)
    const fixture = await mounted({ debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', 'first'))
    fixture.ctx.tools.register(textTool('read', 'second'))
    await fixture.ctx.tools.execute(exec('bash'))
    await fixture.ctx.tools.execute(exec('read'))

    const records = readRecords(path)
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({ marker: 'pre-existing' })
    expect((records[1] as { toolName: string }).toolName).toBe('bash')
    expect((records[2] as { toolName: string }).toolName).toBe('read')
  })

  it('摘要关闭时目标工具与非目标工具都记 summary-off（本票没有候选判断）', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    const fixture = await mounted({ summarize: false, debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('grep', 'matches'))
    await fixture.ctx.tools.execute(exec('grep'))
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ toolName: 'grep', action: 'unmodified', reason: 'summary-off' }),
    ])
  })

  it('PTC 子派发不介入，也不产出记录', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    const fixture = await mounted({ summarize: false, debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', 'sub-dispatch'))
    await fixture.ctx.tools.execute(exec('bash', 'parent-token'))
    expect(existsSync(path)).toBe(false)
  })
})

describe('票 02 第 4 条：关闭时零写盘', () => {
  it('debug 关闭时连文件都不创建，哪怕路径已配置', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    const fixture = await mounted({ debug: false, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(existsSync(path)).toBe(false)
    expect(appendFile).not.toHaveBeenCalled()
  })

  it('debug 开启但路径为空时一次写调用都不发生（不回退到任何默认路径）', async () => {
    const root = tempRoot()
    const fixture = await mounted({ debug: true, debugPath: '' })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(appendFile).not.toHaveBeenCalled()

    // 阳性对照：同一套夹具只把路径填上，写调用就发生——证明上一条断的不是「这条路径恰好没人写」。
    const path = join(root, 'debug.jsonl')
    const writable = await mounted({ debug: true, debugPath: path })
    writable.ctx.tools.register(textTool('bash', 'body'))
    await writable.ctx.tools.execute(exec('bash'))
    expect(appendFile).toHaveBeenCalledTimes(1)
    expect(existsSync(path)).toBe(true)
  })

  it('写入失败（路径的父级是文件）不影响工具结果，也不抛错', async () => {
    const root = tempRoot()
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const fixture = await mounted({ debug: true, debugPath: join(blocker, 'debug.jsonl') })
    fixture.ctx.tools.register(textTool('bash', 'body survives'))
    const result = await fixture.ctx.tools.execute(exec('bash'))
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'body survives' }])
  })
})

describe('票 02 第 4 条：本票边界——摘要开启时没有取值可记', () => {
  it('摘要开启时报不出候选结论，因此不写记录（not-candidate 等取值自 03 起引入）', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    const fixture = await mounted({ summarize: true, debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(existsSync(path)).toBe(false)
  })
})

describe('票 02 第 5 条：记录不含原文、摘要正文、提示词与凭据', () => {
  it('记录的字段集合固定，且整行文本里不出现工具正文与凭据样例', async () => {
    const root = tempRoot()
    const path = join(root, 'debug.jsonl')
    const body = 'SECRET-TOOL-BODY-7f2a'
    const fixture = await mounted({ summarize: false, debug: true, debugPath: path })
    fixture.ctx.tools.register(textTool('bash', body))
    await fixture.ctx.tools.execute(exec('bash'))

    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain(body)
    expect(raw).not.toContain('SECRET-PROMPT')
    expect(raw).not.toContain('sk-credential')
    const [record] = readRecords(path) as [Record<string, unknown>]
    expect(Object.keys(record).sort()).toEqual(['action', 'durationMs', 'reason', 'resultBytes', 'toolName'])
  })
})
