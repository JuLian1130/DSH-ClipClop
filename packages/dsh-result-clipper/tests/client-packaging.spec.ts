// @vitest-environment jsdom
/**
 * 票 02 「两面构建」：**双面包**的装载契约。
 *
 * 观察面写死：读包内 `package.json` 的 `dsh.client` / `exports["./client"]`，对解析结果做 `existsSync`——**不在
 * 测试期构建**。装载器在找不到浏览器产物时同步抛出（`client-modules: client bundle not found`），所以产物
 * 缺失必须是一条红，不是一次跳过。
 *
 * 产物的形态是第二条判据：在 jsdom 里用一个**记录的** `__ModuleLoader__` 桩加 `new Function` 求值，断言
 * `load` 恰被调用一次、`registration.id` 逐字符等于包名、`factory(require)` 返回带 `inject` 与 `apply` 的
 * 对象。不从 bundle 文本里搜字符串——那样在产物格式变了以后照样绿。
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { name as pluginName } from '../src/index.ts'

const nodeRequire = createRequire(import.meta.url)

/** 包根（vitest 在包目录里跑）。jsdom 环境里 `import.meta.url` 不是 file:，所以走 cwd。 */
const packageRoot = process.cwd()

/** 包内 `package.json`。 */
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  readonly name: string
  readonly exports: Record<string, unknown>
  readonly dsh?: {
    readonly client?: { readonly platform?: string }
    readonly bundle?: { readonly patch?: string }
  }
}

/** 装载器接受的 `exports["./client"]` 形状：字符串，或带字符串 `default` 的对象。 */
function clientExport(entry: unknown): string {
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null && typeof (entry as { default?: unknown }).default === 'string') {
    return (entry as { default: string }).default
  }
  throw new Error('package.json exports["./client"] is neither a string nor an object with a string default')
}

/** bundle 的闭包工厂形状。 */
interface Registration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

describe('两面构建第 1 条：双面包的声明与产物', () => {
  it('package.json 有 dsh.client（platform 为 web）与 exports["./client"]', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports['./client']).toBeDefined()
    expect(clientExport(manifest.exports['./client'])).toMatch(/^\.\//)
  })

  it('exports["./client"] 解析出的文件**已经存在**（不在测试期构建）', () => {
    const resolved = nodeRequire.resolve(`${manifest.name}/client`)
    expect(resolved).toBe(join(packageRoot, clientExport(manifest.exports['./client']).replace(/^\.\//, '')))
    expect(existsSync(resolved)).toBe(true)
  })

  it('随包的 bundle patch 存在，且行的 id 与包名和插件入口一致', async () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    const patchPath = join(packageRoot, patch!.replace(/^\.\//, ''))
    expect(existsSync(patchPath)).toBe(true)
    // patch 是 YAML，这里不做通用解析、也不引入 YAML 依赖：只核对两条决定「按哪个 id、装哪个模块」的取值。
    // 这两条一旦脱钩，settings 命名空间（客户端 `whileServed` 与写回都按同一个 id）会整片失效，而任何其它
    // 用例都看不见。
    const text = readFileSync(patchPath, 'utf8')
    expect(text).toContain(`id: ${pluginName}`)
    expect(text).toContain(`name: '${manifest.name}'`)
  })
})

describe('两面构建第 2 条：产物是闭包工厂注册', () => {
  it('求值后 __ModuleLoader__.load 恰被调用一次，id 等于包名，factory 交出 inject 与 apply', () => {
    const registrations: Registration[] = []
    const globals = globalThis as unknown as { window: { __ModuleLoader__?: unknown } }
    globals.window.__ModuleLoader__ = {
      load(registration: Registration) { registrations.push(registration) },
    }
    const source = readFileSync(nodeRequire.resolve(`${manifest.name}/client`), 'utf8')
    new Function('window', 'document', source)(globals.window, globalThis.document)

    expect(registrations).toHaveLength(1)
    const registration = registrations[0]!
    expect(registration.id).toBe(manifest.name)
    // 平台模块表里本产物只会用到这几个（跨包协作一律走 cordis 服务，所以没有别的 external）。
    const externals: Record<string, unknown> = {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      '@deepseek-ai/dsh-client-ui-primitives': primitives,
    }
    // 记账并核「实际 require 的正是那三个平台模块」：只查「没有集合之外的 require」抓不到某个 external 被
    // 内联（内联会让平台模块多出一份，React 会因此拿不到渲染机装的 dispatcher）。
    const requested: string[] = []
    const exported = registration.factory((id) => {
      if (!(id in externals)) throw new Error(`unexpected require(${JSON.stringify(id)})`)
      requested.push(id)
      return externals[id]
    })
    // 同一模块被 require 多次是正常的（模块缓存由装载器持有），所以按去重后的集合比对。
    expect([...new Set(requested)].sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
    expect(Array.isArray(exported.inject)).toBe(true)
    expect(typeof exported.apply).toBe('function')
  })
})
