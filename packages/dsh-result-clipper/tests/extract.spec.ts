/**
 * 可选参数 `extract`：目标提取的读法、定义扩展、以及"声明了目标就不再问准入模型"这条策略。
 *
 * 观察面：模型侧看得到的定义（参数表与说明）、原生执行体收到的参数（`extract` 必须被摘掉），以及假 route
 * 收到的请求（声明目标时只有一次摘要请求，没有准入请求）。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import {
  EXTRACT_DESCRIPTION,
  extractGoalOf,
  extractRule,
  extendedDefinition,
  extendInPlace,
  READ_GUIDANCE,
} from '../src/extract.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { FakeRoute, requestText } from './support/route.ts'
import type { FakeReply } from './support/route.ts'

const LONG_BODY = 'x'.repeat(5000)
const SHORT_SUMMARY = '这是一段短说明'
const REPLY = JSON.stringify({ action: 'summarize', summary: SHORT_SUMMARY })
const YES = JSON.stringify({ answer: true })

const open: HostFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-extract-'))
  roots.push(root)
  return root
}

/**
 * 挂一份开启摘要与 debug 的夹具。
 * @param overrides - 覆盖的配置项。
 * @param script - 假 route 的答复序列。
 * @returns 夹具、假 route 与 debug 路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: REPLY }],
): Promise<{ fixture: HostFixture, route: FakeRoute, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const route = new FakeRoute(script)
  const fixture = await mount(
    { summarize: true, debug: true, debugPath: path, routeProvider: 'mock', routeModel: 'mock', ...overrides } as Schemastery.TypeS<typeof Config>,
    undefined,
    route,
  )
  open.push(fixture)
  return { fixture, route, path }
}

type Schemastery = typeof import('@deepseek-ai/schemastery')

describe('extractGoalOf：只认 arguments.extract 上的非空字符串', () => {
  it.each([
    [{}, undefined],
    [{ extract: '' }, undefined],
    [{ extract: '   ' }, undefined],
    [{ extract: 42 }, undefined],
    [{ extract: null }, undefined],
    [{ extract: ' 只要标题 ' }, '只要标题'],
  ])('%j → %s', (args, expected) => {
    expect(extractGoalOf({ arguments: args })).toBe(expected)
  })

  it('参数不是对象时不抛', () => {
    expect(extractGoalOf({ arguments: undefined })).toBeUndefined()
    expect(extractGoalOf({ arguments: 'x' })).toBeUndefined()
  })
})

describe('extractRule：目标进规则正文，并说明"原样"也可以只贴片段', () => {
  it('含目标原文，且明确 keep 只在等长时才用', () => {
    const rule = extractRule('只要 redis 段的两个值')
    expect(rule).toContain('只要 redis 段的两个值')
    expect(rule).toContain('只贴相关的那几行或那个片段')
    expect(rule).toContain('返回 summarize')
  })
})

describe('extendedDefinition：补参数、追加说明、执行时摘掉 extract', () => {
  /** 记下原生执行体收到的参数，再逐字返回正文。 */
  function recordingTool(name: string, seen: unknown[]): ToolDefinition {
    return {
      ...textTool(name, LONG_BODY),
      async execute(args: unknown) {
        seen.push(args)
        return [{ type: 'text', text: LONG_BODY }]
      },
    } as unknown as ToolDefinition
  }

  it('参数表多出 extract，原有参数与说明都保留', () => {
    const native = textTool('read', LONG_BODY)
    const extended = extendedDefinition(native, 'read')
    expect(Object.keys(extended.parameters.properties ?? {})).toContain('extract')
    expect(extended.parameters).not.toBe(native.parameters)
    expect(extended.description).toContain(native.description)
    expect(extended.description).toContain(READ_GUIDANCE)
    const properties = extended.parameters.properties as Record<string, { description?: string }> | undefined
    expect(properties?.extract?.description).toBe(EXTRACT_DESCRIPTION)
  })

  it('同一份定义扩展两次拿到同一个对象（不重复补参数）', () => {
    const native = textTool('read', LONG_BODY)
    const once = extendedDefinition(native, 'read')
    expect(extendedDefinition(once, 'read')).toBe(once)
    expect(once.description.split('extract is optional')).toHaveLength(2)
  })

  it('执行体把 extract 摘掉后委托原生', async () => {
    const seen: unknown[] = []
    const extended = extendedDefinition(recordingTool('read', seen), 'read')
    await extended.execute({ file_path: 'a.txt', extract: '只要标题' }, exec('read') as never)
    expect(seen).toEqual([{ file_path: 'a.txt' }])
  })
})

describe('extendInPlace：就地改写已注册的定义', () => {
  it('同一个对象被改写、可执行、且幂等', async () => {
    const seen: unknown[] = []
    const definition = {
      ...textTool('bash', LONG_BODY),
      async execute(args: unknown) {
        seen.push(args)
        return [{ type: 'text', text: LONG_BODY }]
      },
    } as unknown as ToolDefinition
    extendInPlace(definition, 'bash')
    expect(Object.keys(definition.parameters.properties ?? {})).toContain('extract')
    await definition.execute({ command: 'ls', extract: '只要文件名' }, exec('bash') as never)
    expect(seen).toEqual([{ command: 'ls' }])
    const after = definition.description
    extendInPlace(definition, 'bash')
    expect(definition.description).toBe(after)
  })
})

describe('策略：主模型声明了目标就不再问准入模型', () => {
  it('开了准入判断，但这次调用带了 extract → 只有一次摘要请求，且规则正文是目标', async () => {
    // 准入被跳过，所以第一发就是摘要请求，脚本里只给摘要答复。
    const { fixture, route, path } = await mounted({ admissionJudge: true }, [{ text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { extract: '只要 ERROR 的时间戳' }))

    expect(route.requests).toHaveLength(1)
    expect(requestText(route.requests[0]!)).toContain('只要 ERROR 的时间戳')
    expect(textOf(result.content)).toContain(SHORT_SUMMARY)
    expect(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown)
      .toMatchObject({ action: 'summarized', admission: 'not-applicable' })
    expect(existsSync(path)).toBe(true)
  })

  it('阴性对照：没带 extract 时准入请求照发（同一配置）', async () => {
    const { fixture, route } = await mounted({ admissionJudge: true }, [{ text: YES }, { text: REPLY }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(requestText(route.requests[1]!)).not.toContain('主模型这次的提取目标')
  })
})
