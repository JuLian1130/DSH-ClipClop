/**
 * 票 06 第 12 条：未装载浏览器半时宿主半仍工作。
 *
 * 两个方向各一条：
 * ① composition 里只有 host 行、没有浏览器行时，host 行仍 ACTIVE，且一次真实的到点裁剪照常落盘（复用 03
 *    的驱动口径）——只断 ACTIVE 的话「装载了但什么都没干」也绿。
 * ② 浏览器半的产物缺失或 `dsh.client` 声明不合法时，宿主半仍 ACTIVE。**失败形态写准**：产物缺失与声明不
 *    合法都在 `ClientModuleRegistry` **服务构造期同步抛出**，结果是 client-modules 那个 fiber FAILED，而
 *    本插件的 host 行与它无依赖、仍 ACTIVE。把「FAILED 说成 warning」这件事钉住。
 *
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ClientModuleRegistry from '@deepseek-ai/dsh-client-modules'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { cleanupRoots, lifecycle, persistedPrunes, registerTool, toolCallScript } from './support/session-harness.ts'

/** `FiberState` 是 const enum，不能运行时具名导入；这两个是本文件用到的取值。 */
const ACTIVE = 2
const FAILED = 3

afterEach(cleanupRoots)

/** 装一个临时包目录：只有 `package.json`，产物按参数决定存在与否。 */
const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixturePackage(options: { readonly platform?: unknown, readonly artifact: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reasoning-pruner-client-pkg-'))
  roots.push(dir)
  if (options.artifact) {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'client.js'), 'window.__ModuleLoader__.load({ id: "fixture", factory: () => ({}) });\n')
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@dsh-clipclop/fixture-client-package',
    version: '1.0.0',
    exports: { './client': './lib/client.js' },
    dsh: { client: { platform: options.platform ?? 'web' } },
  }))
  writeFileSync(join(dir, 'index.js'), 'export {}\n')
  // `resolveMeta` 从**模块 URL 的目录**起找最近的 `package.json`，所以行名要指到包内的一个模块。
  return join(dir, 'index.js')
}

/**
 * 把一条 client 行放进 composition：一个只回答 `entries()` 的 loader 替身（`resolveMeta` 只用它的
 * `options.name` 与解析基址），再挂真正的 `ClientModuleRegistry`。
 * @param entryPath - 该行指向的模块（绝对路径，包内）。
 * @returns 宿主半的 fiber、client-modules 的 fiber 与构造期的错误。
 */
async function composition(entryPath: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.reflect.provide('loader', {
    entries: () => [{
      options: { name: entryPath },
      // 组成扫描只看这几项：名字、是否已激活（`fiber`）、是否被禁用，以及解析基址。
      fiber: {},
      disabled: false,
      parent: { tree: { ctx: { baseUrl: pathToFileURL(`${entryPath}/`).href } } },
    }],
  })
  const host = ctx.plugin(plugin, {})
  await host
  const modules = ctx.plugin(ClientModuleRegistry)
  const error = await modules.then(() => undefined, (reason: unknown) => reason)
  return { ctx, host, modules, error }
}

describe('票 06 第 12 条：未装载浏览器半时宿主半仍工作', () => {
  it('① 只有 host 行、没有浏览器行：host 行 ACTIVE 且一次真实的到点裁剪照常落盘', async () => {
    const lc = await lifecycle(toolCallScript(6), { toolsThrough: 5, config: { everySteps: 6, keepRecentSteps: 2 } })
    try {
      registerTool(lc.ctx, 'noop')
      const { agent, session } = await lc.createSession('host-only')
      await lc.step(agent, 'go')
      expect(lc.pluginFiber?.state).toBe(ACTIVE)
      expect(persistedPrunes(session)).toHaveLength(1)
    } finally {
      await lc.dispose()
    }
  })

  it('② 产物缺失时：client-modules 那个 fiber 是 FAILED（不是一条 warning），宿主半仍 ACTIVE', async () => {
    const { ctx, host, modules, error } = await composition(fixturePackage({ artifact: false }))
    try {
      expect(host.state).toBe(ACTIVE)
      expect(modules.state).toBe(FAILED)
      expect(error).toBeInstanceOf(AggregateError)
      // 聚合诊断点名缺哪份产物（`MissingClientBundleError` 的正文）。
      expect(String(error)).toContain('client bundles not found')
      expect(String(error)).toContain(join('lib', 'client.js'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('② `dsh.client` 声明不合法时：同样在构造期抛出并让那个 fiber FAILED，宿主半仍 ACTIVE', async () => {
    const { ctx, host, modules, error } = await composition(fixturePackage({ artifact: true, platform: 42 }))
    try {
      expect(host.state).toBe(ACTIVE)
      expect(modules.state).toBe(FAILED)
      expect(error).toBeInstanceOf(AggregateError)
      expect(String(error)).toContain('dsh.client.platform must be a string')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
