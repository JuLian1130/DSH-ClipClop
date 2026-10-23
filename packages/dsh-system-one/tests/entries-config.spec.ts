/**
 * 票据 02a：条目配置与注册。
 *
 * 判据分三层：schema（键名、kind 枚举、label 不唯一）、装载期（id 重复、kind 没有工厂）、配置面
 * （`entries` 整字段 volatile）。本票写的时候工厂表还是空的；`systemone` 的实现落地后（02b），
 * 「配了条目就装不上」只剩 `openai` 这一种 kind 成立。
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

describe('条目配置', () => {
  it('示例 patch 的配置键集合与 Config 的字段集合逐一相等', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const lines = patch.split('\n')
    const start = lines.findIndex(line => line.trim() === '# config:')
    expect(start).toBeGreaterThanOrEqual(0)

    // 示例是注释：去掉行首的 `# ` 后，`config:` 下的一层键就是 Config 的字段。
    const example = lines.slice(start + 1)
      .filter(line => line.trim().startsWith('#'))
      .map(line => line.replace(/^\s*#\s?/, ''))
    const keys = example
      .filter(line => line.trim() !== '' && !line.trim().startsWith('-'))
      .map(line => /^\s*([\w-]+):/.exec(line)?.[1])

    expect(keys).toEqual(Object.keys(Config.dict ?? {}))
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

  it('kind 在枚举内但没有工厂时装载期报错并点出 kind', async () => {
    const { ctx, error } = await mount({ entries: [{ ...ENTRY, kind: 'openai' }] })

    expect((error as Error).message).toBe('system-one: no provider factory for kind "openai" (entry "sglang-local")')
    // 装载失败不留半个服务：fiber 回滚，注册表也没了。
    expect((ctx as { systemOne?: unknown }).systemOne).toBeUndefined()
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
