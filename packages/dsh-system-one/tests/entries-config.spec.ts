/**
 * 票据 02a：条目配置与注册。
 *
 * 判据分三层：schema（键名、kind 枚举、label 不唯一）、装载期（id 重复、三个 kind 都能建出条目）、
 * 配置面（`entries` 整字段 volatile）。工厂表在 02b/02c/03 填满后是穷尽的：枚举外与「枚举内没实现」
 * 两种失败都不会走到装载期——前者被 schema 拦下，后者在 `tsc` 就报错。
 */

import { readFileSync } from 'node:fs'
import { Context, ValidationError } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import * as SystemOne from '../src/index.ts'

/** 一个合法条目；用例按需改其中一两项。 */
const ENTRY = {
  id: 'sglang-local',
  label: '本地 SGLang',
  kind: 'systemone',
  baseUrl: 'http://127.0.0.1:30000',
  model: 'qwen3-4b',
}

/**
 * 装一份配置并等它收场。
 * @param config - 装载配置；省略即默认。
 * @returns context、fiber 与 rejection 的原因（装载成功时为 `undefined`）。
 */
async function mount(config?: object) {
  const ctx = new Context()
  const fiber = config === undefined
    ? ctx.plugin(SystemOne)
    : ctx.plugin(SystemOne, config as never)
  const error = await fiber.then(() => undefined, (reason: unknown) => reason)
  return { ctx, fiber, error }
}

/** 解析出来的 `entries`（volatile 引用，读一次）。 */
function resolvedEntries(fiber: { config?: unknown }): unknown {
  return (fiber.config as { entries: { get(): unknown } }).entries.get()
}

/** 已注册的条目 id；插件面只有 register/ask，所以越过去看服务实例。 */
function providerIds(ctx: Context): readonly string[] {
  return (ctx.systemOne as SystemOne.SystemOneService).providers()
}

/** schema 的字段表：顶层是 `entries`，再往下一层是条目自己的字段。 */
const dict = Config.dict as unknown as { entries: { inner: { dict: Record<string, unknown> } } }

/**
 * 取出随包 patch 里某一行的示例配置。
 *
 * 示例是注释：先认行 id，再认它下面的 `# config:`，然后一路收注释行到第一个空行。
 * @param patch - patch 文件的全文。
 * @param rowId - 行 id。
 * @returns 去掉注释前缀后的示例配置行（缩进保留层级）。
 */
function exampleConfigLines(patch: string, rowId: string): string[] {
  const lines = patch.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${rowId}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const config = lines.findIndex((line, index) => index > start && line.trim() === '# config:')
  expect(config).toBeGreaterThan(start)
  const block = lines.slice(config + 1).map(line => /^\s*# ?(.*)$/.exec(line)?.[1] ?? '')
  return block.slice(0, block.indexOf(''))
}

/** 一层 YAML 里的键（`- ` 列表项也算同一层的键）。 */
function keysOf(lines: string[]): string[] {
  return lines
    .map(line => /^\s*(?:- )?([\w-]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
}

describe('条目配置', () => {
  it('示例 patch 的键集合与 schema 的字段集合逐一相等：`config:` 下是 Config，再往下是条目的六个字段', () => {
    const example = exampleConfigLines(
      readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
      SystemOne.name,
    )
    const base = Math.min(...example.map(line => line.search(/\S/)))
    expect(keysOf(example.filter(line => line.search(/\S/) === base))).toEqual(Object.keys(dict))
    expect(keysOf(example.filter(line => line.search(/\S/) > base))).toEqual(Object.keys(dict.entries.inner.dict))
  })

  it('entries 默认空数组：没有条目，ask 点名未注册的 target', async () => {
    const { ctx, error } = await mount()

    expect(error).toBeUndefined()
    expect(providerIds(ctx)).toEqual([])
    await expect(ctx.systemOne.ask({ target: 'nope', state: null, questions: {} }))
      .rejects.toThrow('system-one: no provider registered as "nope" (registered: none)')
  })

  it('label 可以不唯一：两个同名、id 不同的条目通过配置校验并存', async () => {
    const { ctx, error } = await mount({
      entries: [
        { ...ENTRY, id: 'a', label: '本地 SGLang' },
        { ...ENTRY, id: 'b', label: '本地 SGLang' },
      ],
    })

    expect(error).toBeUndefined()
    expect(providerIds(ctx)).toEqual(['a', 'b'])
  })

  it('id 重复时抛错', async () => {
    const { error } = await mount({ entries: [{ ...ENTRY, id: 'same' }, { ...ENTRY, id: 'same', label: '另一个' }] })

    expect((error as Error).message).toBe('system-one: entry id "same" is used twice')
  })

  it('id 缺失时装载期报错并点出键名', async () => {
    const { id: _id, ...missingId } = ENTRY
    const { error } = await mount({ entries: [missingId] })

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('entries.0.id')
  })

  it('kind 取枚举外的值时装载期报错并点出键名', async () => {
    const { error } = await mount({ entries: [{ ...ENTRY, kind: 'grpc' }] })

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('entries.0.kind')
  })

  it('三个 kind 的条目同时装载：各自注册、按配置顺序', async () => {
    const { ctx, error } = await mount({
      entries: [
        ENTRY,
        { ...ENTRY, id: 'openai-decisions', label: 'OpenAI Decisions', kind: 'openai', baseUrl: 'https://api.openai.com' },
        { ...ENTRY, id: 'deepseek-chat', label: 'DeepSeek 官方', kind: 'deepseek', baseUrl: 'https://api.deepseek.com' },
      ],
    })

    expect(error).toBeUndefined()
    expect(providerIds(ctx)).toEqual(['sglang-local', 'openai-decisions', 'deepseek-chat'])
  })

  it('entries 是整字段 volatile：解析出稳定引用，schema 上打了标记', async () => {
    // 宿主设置写回的门禁看的就是这个标记（非 volatile 路径直接拒绝）。
    expect((Config.dict as Record<string, { meta?: { volatile?: boolean } }>).entries.meta?.volatile).toBe(true)

    const { fiber, error } = await mount()
    expect(error).toBeUndefined()
    expect(typeof (fiber.config as { entries: { get?: unknown } }).entries.get).toBe('function')
    expect(resolvedEntries(fiber)).toEqual([])
  })
})
