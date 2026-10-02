/**
 * 票 05：摘要 memo。
 *
 * 观察面只有两个：**假 route 的请求数**（「不再调用摘要模型」唯一的可见面——只断言正文没变会在「第二次也
 * 发请求、恰好回了同一段摘要」下也为真）与**模型最终看到的正文**（复用的是同一条摘要，不是重新生成的一段）。
 * 每条「命中」都配一次「不该命中」的阳性对照，两者用同一张答复脚本、靠请求数与摘要文本区分。
 *
 * 会话隔离与上限用同一套夹具直接观测：换一个会话 id 即换一个会话；上限用例用 `minInlineTokens: 0` 让短正文
 * 也进候选，从而不必为 200 条上限造 200 段长正文。
 *
 * 「隐私开启时不查找、不写入 memo」这两半在单开关夹具里都看不到（写入守卫会让 memo 恒为空，查找守卫在或不在
 * 观察面一样）。那两条用真 profile 在同一份插件实例里改写 volatile 开关：开启→关闭那臂观察写入侧，关闭→开启
 * 那臂观察查找侧（隐私关闭期先缓存一条摘要，开隐私后必须不再命中）；任一侧失守都会命中并复用，断言随即为假。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { MEMO_LIMIT } from '../src/memo.ts'
import { mount, exec, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'
import { FakeRoute } from './support/route.ts'
import type { FakeReply } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 刚过摘要下限的正文：估价 ≥ 1024 个单位。 */
const LONG_BODY = 'x'.repeat(5000)

/** 两份答复各用一段可区分的摘要，命中与重新摘要在返回正文上就分得开。 */
const REPLY_A = JSON.stringify({ action: 'summarize', summary: '摘要A' })
const REPLY_B = JSON.stringify({ action: 'summarize', summary: '摘要B' })
const REPLY_KEEP = JSON.stringify({ action: 'keep', summary: null })

const open: HostFixture[] = []
const live: LiveFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  await Promise.all(live.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => { cleanupProfiles() })

/**
 * 装一条真 profile（真 settings + 真 Loader）并登记收场：跨隐私开关的用例要靠它把 volatile 开关**原地**改写，
 * 手搓配置对象换不到同一份插件实例里那张 memo 台账。
 * @param config - 本插件那一行的 profile 配置。
 * @returns 夹具。
 */
async function booted(config: Record<string, unknown>): Promise<LiveFixture> {
  const fixture = await bootProfile(config)
  live.push(fixture)
  return fixture
}

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-memo-'))
  roots.push(root)
  return root
}

/**
 * 装一份夹具：开启 debug、配好主 route，并把假 route 放进 context。
 * @param overrides - 覆盖默认的插件配置。
 * @param script - 假 route 的答复脚本；按请求顺序取用，用完后重复最后一段。
 * @returns 夹具、假 route 与 debug 日志路径。
 */
async function mounted(
  overrides: Record<string, unknown> = {},
  script: readonly FakeReply[] = [{ text: REPLY_A }, { text: REPLY_B }],
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

/**
 * 读回 debug 记录。
 * @param path - 日志路径。
 * @returns 逐行解析出的记录；文件不存在时为空数组。
 */
function records(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * 正文每次执行时现取的文本工具：复现「同一路径的文件被修改」——工具名与会话不变，正文变了。
 * @param name - 工具名。
 * @param body - 取当前正文的函数。
 * @returns 注册用的工具定义。
 */
function mutableTextTool(name: string, body: () => string): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: body() }] },
  })
}

describe('票 05：同工具同正文复用同一条摘要', () => {
  it('第二次读取命中 memo：不再调用摘要模型，且模型可见结果与第一次逐字相同', async () => {
    const { fixture, route, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    // 阳性对照：第一次真的发过请求、真的被替换过——否则「第二次相同」在两次都透传下也为真。
    expect(route.requests).toHaveLength(1)
    expect(textOf(first.content)).not.toBe(LONG_BODY)
    expect(textOf(first.content)).toContain('摘要A')

    const second = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(1)
    expect(textOf(second.content)).toBe(textOf(first.content))
    expect(records(path)).toEqual([
      expect.objectContaining({ toolName: 'bash', action: 'summarized' }),
      expect.objectContaining({ toolName: 'bash', action: 'summarized' }),
    ])
  })

  it('正文变化后 hash 变化：重新摘要，用新正文得到的摘要', async () => {
    const { fixture, route } = await mounted()
    let body = LONG_BODY
    fixture.ctx.tools.register(mutableTextTool('bash', () => body))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    body = `${LONG_BODY}改过了`
    const second = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain('摘要A')
    expect(textOf(second.content)).toContain('摘要B')
  })

  it('跨工具不复用：同一正文来自不同工具时各得一条摘要', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    fixture.ctx.tools.register(textTool('read', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    const second = await fixture.ctx.tools.execute(exec('read'))

    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain('摘要A')
    expect(textOf(second.content)).toContain('摘要B')
  })
})

describe('票 05：keep 的结果不进 memo', () => {
  it('第一次 keep 后同一正文再次读取照常重新判断，第二次可被摘要', async () => {
    const { fixture, route, path } = await mounted({}, [{ text: REPLY_KEEP }, { text: REPLY_B }])
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(first.content)).toBe(LONG_BODY)
    expect(records(path).at(-1)).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'kept' }))

    const second = await fixture.ctx.tools.execute(exec('bash'))
    expect(route.requests).toHaveLength(2)
    expect(textOf(second.content)).toContain('摘要B')
  })
})

describe('票 05：memo 的范围限定为隐私关闭时', () => {
  it('隐私开启时同正文两次各发一次请求，不复用 memo', async () => {
    const { fixture, route } = await mounted({ privacyGate: true })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    const second = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain('摘要A')
    expect(textOf(second.content)).toContain('摘要B')
  })

  it('阳性对照：同一份夹具关掉隐私后两次只发一次请求，复用同一条摘要', async () => {
    const { fixture, route } = await mounted({ privacyGate: false })
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    const second = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(second.content)).toBe(textOf(first.content))
  })
})

describe('票 05：memo 按会话隔离、LRU 上限 200 条', () => {
  it('换一个会话 id 后同一正文不复用，重新摘要', async () => {
    const { fixture, route } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const first = await fixture.ctx.tools.execute(exec('bash'))
    const second = await fixture.ctx.tools.execute(exec('bash', undefined, {}, 's2'))

    expect(route.requests).toHaveLength(2)
    expect(textOf(first.content)).toContain('摘要A')
    expect(textOf(second.content)).toContain('摘要B')
  })

  it('命中刷新最近使用次序：超上限淘汰最久未用的一条，最近用过的仍在', async () => {
    // 上限是规格冻结的固定常量（`spec.md`「固定常量」的 200 条），这里连值一起核对。
    expect(MEMO_LIMIT).toBe(200)
    const { fixture, route } = await mounted({ minInlineTokens: 0 }, [{ text: JSON.stringify({ action: 'summarize', summary: '短' }) }])
    let body = ''
    fixture.ctx.tools.register(mutableTextTool('bash', () => body))
    const read = async (index: number): Promise<string> => {
      // 320 字符 > 摘要长度 + 入口预留（256），保证每条都被替换、都有摘要可进 memo。
      body = `${'x'.repeat(320)}#${index}`
      return textOf((await fixture.ctx.tools.execute(exec('bash'))).content)
    }

    for (let index = 0; index < MEMO_LIMIT; index++) await read(index)
    expect(route.requests).toHaveLength(MEMO_LIMIT)

    // 命中第 0 条：把它刷成最近使用，请求数不变。
    await read(0)
    expect(route.requests).toHaveLength(MEMO_LIMIT)

    // 再进一条（第 200 条）触发淘汰：最久未用的现在是第 1 条。
    await read(MEMO_LIMIT)
    expect(route.requests).toHaveLength(MEMO_LIMIT + 1)

    // 第 1 条已被淘汰：重新摘要（若无淘汰，这里仍是命中）。
    await read(1)
    expect(route.requests).toHaveLength(MEMO_LIMIT + 2)

    // 第 0 条刚被刷新过：仍在 memo 里（若淘汰的是它，这里会再多一次请求）。
    await read(0)
    expect(route.requests).toHaveLength(MEMO_LIMIT + 2)
  })
})

describe('票 05：隐私开关的切换不跨边界复用 memo（同一夹具里跨开关）', () => {
  it('隐私开启那一次不进 memo：随后关掉隐私，同一正文仍重新发请求', async () => {
    // 两条单开关用例各用一份新夹具，且写入守卫会使 memo 恒为空，查找守卫在或不在都一样；写入侧只有让两次
    // 执行落在**同一份插件实例**上、且第二次隐私已关闭时才可见——否则隐私开启的第二次又被查找侧挡住。
    const fixture = await booted({
      summarize: true, privacyGate: true, routeProvider: 'mock', routeModel: 'mock',
    })
    const route = new FakeRoute([{ text: REPLY_A }, { text: REPLY_B }])
    fixture.ctx.provide('llm', route as never)
    fixture.ctx.provide('spillStore', new FakeSpill() as never)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    const first = await fixture.ctx.tools.execute(exec('bash'))
    // 阳性对照：隐私开启时确实走了摘要路径、产出了一条摘要——否则没有东西可被错误地写进 memo。
    expect(route.requests).toHaveLength(1)
    expect(textOf(first.content)).toContain('摘要A')

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['privacyGate'], value: false }])
    expect(fixture.config.privacyGate.get()).toBe(false)
    const second = await fixture.ctx.tools.execute(exec('bash'))

    // 隐私开启时若写进了 memo，这次（隐私已关闭）会命中并复用「摘要A」，请求数停在 1。
    expect(route.requests).toHaveLength(2)
    expect(textOf(second.content)).toContain('摘要B')
  })

  it('隐私关闭期缓存的摘要不进隐私开启后的查找：开隐私后同正文仍重新发请求', async () => {
    // 反方向的同一件事：写入守卫在时，只有「隐私关闭期先缓存、会话中途开隐私」才会让查找守卫单独可观察——
    // 否则 memo 恒为空，查不查都 miss。
    const fixture = await booted({
      summarize: true, privacyGate: false, routeProvider: 'mock', routeModel: 'mock',
    })
    const route = new FakeRoute([{ text: REPLY_A }, { text: REPLY_B }])
    fixture.ctx.provide('llm', route as never)
    fixture.ctx.provide('spillStore', new FakeSpill() as never)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))

    const first = await fixture.ctx.tools.execute(exec('bash'))
    // 阳性对照：隐私关闭的这一次确实进了 memo（否则没有可被错误复用的摘要）。
    expect(route.requests).toHaveLength(1)
    expect(textOf(first.content)).toContain('摘要A')

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['privacyGate'], value: true }])
    expect(fixture.config.privacyGate.get()).toBe(true)
    const second = await fixture.ctx.tools.execute(exec('bash'))

    // 隐私开启时若仍查找 memo，这次会命中并复用「摘要A」，请求数停在 1。
    expect(route.requests).toHaveLength(2)
    expect(textOf(second.content)).toContain('摘要B')
  })
})
