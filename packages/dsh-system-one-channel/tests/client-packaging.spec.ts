// @vitest-environment jsdom
/**
 * 票据 06「两面构建」：通道包作为**双面包**的装载契约。
 *
 * 观察面写死：读包内 `package.json` 的 `dsh.client` / `exports["./client"]` / `exports["./locale/*.json"]`，
 * 用 `require.resolve` 落到包内文件的真实路径（解析不到就直接抛错）——**不在测试期构建**。装载器在找不到浏览器
 * 产物时同步抛出，所以产物缺失必须是一条红，不是一次跳过。
 *
 * 第二条判据是产物形态：在 jsdom 里用一个**记录的** `__ModuleLoader__` 桩加 `new Function` 求值，断言 `load`
 * 恰被调用一次、`registration.id` 逐字符等于包名、`factory(require)` 返回带 `inject` 与 `apply` 的对象，且
 * `require` 到的正好是平台模块表里那几个（**值引用别的 DSH 包会被内联进产物**，那样 React 就拿不到渲染机装的
 * dispatcher，而只查「没有集合之外的 require」抓不到这种错）。
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
import { inject as pageInject, PREFERENCE_NAMESPACE } from '../src/client/index.ts'

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
    expect(clientExport(manifest.exports['./client'])).toMatch(/^\.\//)
  })

  it('exports["./client"] 解析出的就是包内那个文件（不在测试期构建）', () => {
    // `require.resolve` 在文件缺失时自己就抛错，所以这一条的判据只有「解析到了哪个路径」。
    const resolved = nodeRequire.resolve(`${manifest.name}/client`)
    expect(resolved).toBe(join(packageRoot, clientExport(manifest.exports['./client']).replace(/^\.\//, '')))
  })

  it('随包的 locale 文案与 bundle patch 都在，且 patch 的行 id 就是页面的写回命名空间', async () => {
    // 插件管理器给包卡片显示的标题与描述来自这两份文案；缺一份就是卡片上没有可读的名字。
    expect(manifest.exports['./locale/*.json']).toBeDefined()
    for (const lang of ['zh', 'en']) {
      const file = join(packageRoot, 'locale', `${lang}.json`)
      expect(existsSync(file)).toBe(true)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: string, description?: string } }
      expect(parsed.meta?.title).toBeTruthy()
      expect(parsed.meta?.description).toBeTruthy()
    }
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    const patchPath = join(packageRoot, patch!.replace(/^\.\//, ''))
    expect(existsSync(patchPath)).toBe(true)
    // patch 是 YAML，这里不做通用解析、也不引入 YAML 依赖：只核对两条决定「按哪个 id、装哪个模块」的取值。
    // 行 id 一旦与页面的写回命名空间脱钩，页面上的三项就写进一个不存在的命名空间（宿主一律拒绝），而任何其它
    // 用例都看不见。
    const text = readFileSync(patchPath, 'utf8')
    expect(text).toContain(`id: ${pluginName}`)
    expect(PREFERENCE_NAMESPACE).toBe(pluginName)
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
    const requested: string[] = []
    const exported = registration.factory((id) => {
      if (!(id in externals)) throw new Error(`unexpected require(${JSON.stringify(id)})`)
      requested.push(id)
      return externals[id]
    })
    // 同一模块被 require 多次是正常的（模块缓存由装载器持有），所以按去重后的集合比对。
    expect([...new Set(requested)].sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
    // 注入清单是契约的一部分（接入层没装时页照常可用），所以与源码逐项相等比「是个数组」有用。
    expect(exported.inject).toEqual(pageInject)
    expect(typeof exported.apply).toBe('function')
  })
})
