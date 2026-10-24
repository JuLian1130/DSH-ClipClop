/**
 * 票据 05：配置契约与 patch 行。
 *
 * 判据：示例行与包名对得上；三个业务字段都是 volatile（设置页写回的前置）；配置非法在装载期报错并
 * 点出键名——不是注册一个之后每次调用才失败的东西。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import * as Channel from '../src/index.ts'
import { TARGET, mount, tool } from './support/channel.ts'

/** schema 的字段表（volatile 标记在 `meta` 上，宿主写回门禁读的就是它）。 */
const fields = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict

/** 门槛那一层的字段表：示例里它是嵌套的，内层两个键同样不能与 schema 漂移。 */
const thresholdFields = (fields.threshold as unknown as { dict: Record<string, unknown> }).dict

/** patch 文件的全文。 */
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** bundle 随包 patch 的全文：安装路径上那一行来自这里。 */
const bundlePatch = readFileSync(new URL('../../dsh-system-one/cordis.patch.yml', import.meta.url), 'utf8')

/**
 * 取出某份 patch 里本包那一行的示例配置行（去掉注释前缀，保留缩进层级）。
 * @param source - patch 文件的全文。
 * @returns 示例配置的行；块从 `# config:` 下一行起，到第一个空行为止。
 */
function exampleLines(source: string): string[] {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${Channel.name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const config = lines.findIndex((line, index) => index > start && line.trim() === '# config:')
  expect(config).toBeGreaterThan(start)
  // 示例是连续的一段注释：去掉前缀后第一个空行就是块的结尾（与接入层那份夹具同一个口径）。
  const block = lines.slice(config + 1).map(line => /^\s*# ?(.*)$/.exec(line)?.[1] ?? '')
  return block.slice(0, block.indexOf('')).filter(line => line.trim() !== '')
}

/** 一层 YAML 里的键，按出现顺序。 */
function keysOf(lines: string[]): string[] {
  return lines
    .map(line => /^\s*([\w-]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
}

describe('patch 行', () => {
  it('行 id 与插件名是同一个字符串，包名指向本包，且只有这一行', () => {
    expect(Channel.name).toBe('dsh-system-one-channel')
    const rows = patch.split('\n').filter(line => line.trim().startsWith('- id:'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.trim()).toBe('- id: dsh-system-one-channel')
    expect(patch).toContain("name: '@dsh-clipclop/dsh-system-one-channel'")
  })

  it('两处示例的配置键集合与 Config 的字段集合逐一相等：`config:` 下四个字段，门槛里再两个', () => {
    // bundle 里那份是用户照抄的那一份；子包自己那份留在单装路径上——两处都不能与 schema 漂移。
    for (const source of [bundlePatch, patch]) {
      const lines = exampleLines(source)
      const base = Math.min(...lines.map(line => line.search(/\S/)))
      expect(keysOf(lines.filter(line => line.search(/\S/) === base))).toEqual(Object.keys(fields))
      expect(keysOf(lines.filter(line => line.search(/\S/) > base))).toEqual(Object.keys(thresholdFields))
    }
  })
})

describe('配置契约', () => {
  it('三个业务字段都是 volatile，开关不是', () => {
    // 设置页的写回路径只接受 volatile 路径；开关改的是装载期注册，本来就要重挂载插件。
    expect(fields.target?.meta?.volatile).toBe(true)
    expect(fields.guidance?.meta?.volatile).toBe(true)
    expect(fields.threshold?.meta?.volatile).toBe(true)
    expect(fields.enabled?.meta?.volatile).toBeUndefined()
  })

  it('默认关闭：不配任何字段时插件照常加载，工具不注册', async () => {
    const { ctx, error } = await mount()
    expect(error).toBeUndefined()
    expect(tool(ctx)).toBeUndefined()
  })

  it('开关打开但 target 为空：装载期报错并点出键名', async () => {
    const { error } = await mount({ channel: { enabled: true } })
    const message = (error as Error).message
    expect(message).toContain('"target"')
    expect(message).toContain('"enabled"')
  })

  it('阈值越界：装载期报错并点出键名', async () => {
    const { error } = await mount({
      channel: { enabled: true, target: TARGET, threshold: { enabled: true, value: 2 } },
    })
    const message = (error as Error).message
    expect(message).toContain('threshold')
    expect(message).toContain('value')
  })
})
