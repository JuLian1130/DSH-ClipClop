/**
 * 票 04 第 10 条：两种 read 顺序都不出现 `FS_NOT_OBSERVED`。
 *
 * 用部署里**真实**的 `read` / `edit` 工具（`@deepseek-ai/dsh-tool-fs`）加一个假 fs 后端：`read` 在工具体内、
 * `post-execute` 之前发出 `fs/observed`（带真实 version），`edit` 走 `fs/edit-intent` 决策槽取观察结果。
 * 观察面是 **edit 的结果**：本插件若越过接缝去干预读取（例如替模型跳过读取、或在替换时吞掉这次派发），
 * 观察就发不出去，edit 会被判失败。
 *
 * 真实的 `fs-observation-policy` 不在本包依赖里，所以用一个只做同一件事的探针占住那个决策槽：**没被观察过的
 * edit 判失败**。阳性对照是一条没读过的路径——它必须真的被判失败，否则「两种 read 顺序没出错」在探针根本
 * 不会拒绝时也为真。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import * as plugin from '../src/index.ts'
import { exec, textOf } from './support/host.ts'
import { FakeRoute } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/** 摘要模型回的短说明。 */
const SHORT_SUMMARY = '这是一段短说明'

/** 被读的文件：200 行、估价 ≥ 1024 个单位，因而进入摘要候选。 */
const FILE_LINES = Array.from({ length: 200 }, (_unused, index) => `line-${index} `.repeat(3)).join('\n')

/** 摘要请求的答复脚本。 */
const REPLY = JSON.stringify({ action: 'summarize', summary: SHORT_SUMMARY })

/** 本文件读的那条路径。 */
const READ_PATH = '/abs/big.txt'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** 假 fs 后端：只要 `read` / `edit` 真正用到的几个方法，观察事件由探针自己收。 */
class FakeFs {
  /** 不约束的后端：`read` / `edit` 因此按无条件路径执行。 */
  readonly sandboxMode = undefined

  readonly files = new Map<string, string>([[READ_PATH, FILE_LINES]])

  /**
   * 解析路径。
   * @param path - 模型给的路径。
   * @returns 解析后的目标。
   */
  async resolve(path: string): Promise<{ targetKey: string, displayPath: string }> {
    return { targetKey: path, displayPath: path }
  }

  /**
   * 文件信息；文件不存在时为 `undefined`。
   * @param target - 解析后的目标。
   * @returns 类型、大小与版本。
   */
  async stat(target: { targetKey: string }): Promise<{ version: string, type: string, size: number } | undefined> {
    const text = this.files.get(target.targetKey)
    return text === undefined ? undefined : { version: 'v1', type: 'file', size: text.length }
  }

  /**
   * 读整段文本。
   * @param target - 解析后的目标。
   * @returns 文件正文。
   */
  async readText(target: { targetKey: string }): Promise<string> {
    return this.files.get(target.targetKey) ?? ''
  }

  /**
   * 流式读取。
   * @param target - 解析后的目标。
   * @returns 单块异步流。
   */
  async streamText(target: { targetKey: string }): Promise<AsyncIterable<string>> {
    const text = this.files.get(target.targetKey) ?? ''
    return (async function* emit(): AsyncIterable<string> { yield text })()
  }

  /**
   * 替换文本。
   * @param target - 解析后的目标。
   * @param edit - 替换参数。
   * @returns 替换前后的正文与新版本。
   */
  async editText(
    target: { targetKey: string },
    edit: { oldString: string, newString: string },
  ): Promise<{ version: string, before: string, after: string }> {
    const before = this.files.get(target.targetKey) ?? ''
    const after = before.split(edit.oldString).join(edit.newString)
    this.files.set(target.targetKey, after)
    return { version: 'v2', before, after }
  }
}

/** 解析后的 fs 目标（只用到 `targetKey`）。 */
interface TargetLike {
  readonly targetKey: string
}

/** `fs/observed` 的观察值。 */
interface ObservationLike {
  readonly kind: 'present' | 'absent'
  readonly version?: string
}

/**
 * fs 事件面的结构视图：`fs/observed` 与 `fs/edit-intent` 的类型声明在 `@deepseek-ai/dsh-fs`（本包没有这个
 * 依赖），而探针只需要这两个事件的形状，所以就地描述。
 */
interface FsEventBus {
  on(name: 'fs/observed', listener: (target: TargetLike, observation: ObservationLike, actor: unknown) => void): unknown
  on(name: 'fs/edit-intent', listener: (target: TargetLike, actor: unknown) => unknown): unknown
}

/** fs 观察探针：占住 `fs/edit-intent` 决策槽，没被观察过的 edit 判失败（`fs-observation-policy` 的同一件事）。 */
class ObservationProbe {
  /** 观察到的「会话 + 目标」键。 */
  readonly observed = new Set<string>()

  /** 收到的 `fs/observed` 版本，按键。 */
  readonly versions = new Map<string, string>()

  /**
   * 键：观察按（会话, 目标）归属，与真实策略一致。
   * @param target - 解析后的目标。
   * @param actor - 工具执行。
   * @returns 台账键。
   */
  #key(target: TargetLike, actor: unknown): string {
    const session = (actor as { agent?: { session?: { header?: { id?: string } } } } | undefined)
      ?.agent?.session?.header?.id ?? ''
    return `${session}|${target.targetKey}`
  }

  /**
   * 装探针。
   * @param ctx - 夹具 context。
   */
  install(ctx: Context): void {
    const bus = ctx as unknown as FsEventBus
    bus.on('fs/observed', (target, observation, actor) => {
      this.observed.add(this.#key(target, actor))
      if (observation.kind === 'present' && observation.version !== undefined) {
        this.versions.set(this.#key(target, actor), observation.version)
      }
    })
    bus.on('fs/edit-intent', (target, actor) => {
      if (!this.observed.has(this.#key(target, actor))) {
        throw new Error('FS_NOT_OBSERVED: edit requires reading the file first')
      }
    })
  }
}

/** 装好的夹具。 */
interface Fixture {
  readonly ctx: Context
  readonly route: FakeRoute
  readonly spill: FakeSpill
  readonly probe: ObservationProbe
}

/**
 * 装真 `read` / `edit` + 假 fs + 假 route + 假 spill + 被测插件。
 * @returns 夹具。
 */
async function setup(): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const route = new FakeRoute([{ text: REPLY }])
  ctx.provide('llm', route as never)
  const spill = new FakeSpill()
  ctx.provide('spillStore', spill as never)
  ctx.provide('fs', new FakeFs() as never)
  const probe = new ObservationProbe()
  probe.install(ctx)
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(plugin, {
    summarize: true, routeProvider: 'mock', routeModel: 'mock',
  } as Schemastery.TypeS<typeof Config>)
  return { ctx, route, spill, probe }
}

/**
 * 读一次文件。
 * @param ctx - 夹具 context。
 * @returns 模型最终看到的文本。
 */
async function read(ctx: Context): Promise<string> {
  const result = await ctx.tools.execute(exec('read', undefined, { file_path: READ_PATH }))
  return textOf(result.content)
}

/**
 * 编辑一次文件。
 * @param ctx - 夹具 context。
 * @param path - 要编辑的路径。
 * @returns 工具结果。
 */
async function edit(ctx: Context, path: string): Promise<ToolResult> {
  return ctx.tools.execute(exec('edit', undefined, {
    file_path: path, old_string: 'line-0 ', new_string: 'LINE-0 ',
  }))
}

describe('票 04 第 10 条：read 之后的 edit 不出现 FS_NOT_OBSERVED', () => {
  it('阳性对照：同一条路径没读过时一定被判失败，探针不是空转的', async () => {
    const { ctx } = await setup()
    const result = await edit(ctx, READ_PATH)
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('FS_NOT_OBSERVED')
  })

  it('同一 turn 先 read 后 edit：read 的摘要替换不影响这次观察，edit 不再被判失败', async () => {
    const { ctx } = await setup()
    const observed = await read(ctx)
    // 阳性对照：这条 read 真的走了摘要路径（否则「观察照常发出」在插件没装上时也为真）。
    expect(observed).toContain(SHORT_SUMMARY)
    expect(observed).not.toBe(FILE_LINES)

    const result = await edit(ctx, READ_PATH)
    expect(textOf(result.content)).not.toContain('FS_NOT_OBSERVED')
    expect(result.isError).toBe(false)
  })

  it('read 被摘要后再 edit：模型看到的是入口说明 + 摘要，edit 仍不被判失败', async () => {
    const { ctx, spill, probe } = await setup()
    const observed = await read(ctx)
    expect(spill.saves).toHaveLength(1)
    expect(observed).toContain(spill.refs[0]!.locator)
    expect(observed.endsWith(SHORT_SUMMARY)).toBe(true)

    // 观察面写死：真实 version 已经发出（`fs-observation-policy` 记录的正是这一条）。
    expect(probe.versions.get(`s1|${READ_PATH}`)).toBe('v1')
    const result = await edit(ctx, READ_PATH)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).not.toContain('FS_NOT_OBSERVED')
  })
})
