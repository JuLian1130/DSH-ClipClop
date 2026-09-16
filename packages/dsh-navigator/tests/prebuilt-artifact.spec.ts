/**
 * 预构建产物与真实 profile 装载（票据 02b）。
 *
 * 夹具按安装期口径装配**安装副本**：`pnpm pack` 出 tarball → `--ignore-scripts` 装进临时 profile；
 * 再用发布态 `@deepseek-ai/dsh-app-boot` 从副本按包名挂一个真实 Loader 组合。判据见票据，机制与取舍
 * 见设计文档 `预构建产物的装载与启动审计`。
 *
 * `lib/` 由门禁的构建步（`tsc -p tsconfig.json`）产出并命中 `.gitignore`：夹具**不自己构建**，缺
 * `lib/index.js` 时硬失败，避免在干净检出上验到过期或缺失的产物。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { auditStartupEntries, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { ACTIVE, PENDING, disposeTrackedContexts, trackContext } from './support/cordis-fixture.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
/** 服务桩走**绝对路径**条目：它不是包，只有本仓那一份，两套夹具共用 `tests/support/stub-services.mjs`。 */
const stubModulePath = fileURLToPath(new URL('./support/stub-services.mjs', import.meta.url))
/** 产物验收与装载断言的前置：构建在门禁里，不在夹具里。 */
const builtEntry = join(packageDir, 'lib/index.js')

/** 审计的诊断前缀；warning 走注入的收集器，不去 stderr 上捞。 */
const BIN_NAME = 'dsh-navigator-profile-fixture'

/**
 * 一条 loader 条目里夹具关心的形状。`config` 按桩的唯一一项配置写窄——夹具只给桩传配置，写窄才能
 * 让 tsc 守住这处握手（loader 自己的 `EntryOptions.config` 是 any）。
 */
interface ProfileEntry {
  id: string
  name: string
  config?: { omit?: readonly string[] }
}

/** 被测插件条目：`id` 是 `EntryOptions.id`，`name` 是随包发布的包名。 */
const navigatorEntry: ProfileEntry = { id: 'dsh-navigator', name: '@dsh-clipclop/dsh-navigator' }
/** 服务齐备的桩：不带配置，桩给全。 */
const fullStubs: ProfileEntry = { id: 'stubs', name: stubModulePath }
/**
 * 最小 composition 的桩：除 `sessionProjections` 外全给。按**排除**写而不是列举要给的——04 给 `inject`
 * 追加服务后这里不必回来补名单，「只缺一个服务」的隔离意图照样成立。
 */
const minimalStubs: ProfileEntry = {
  id: 'stubs',
  name: stubModulePath,
  config: { omit: ['sessionProjections'] },
}
/**
 * 对照条目：裸名只存在于本仓 store（本包的 devDependency，不在 peer 清单，临时 profile 不会装它），
 * 基点错到本仓 store 时它会 import 成功。它只进下面那条对照用例，**不进正反两份 composition**
 * ——原因见票据第 2 条。
 */
const controlEntry: ProfileEntry = { id: 'control', name: '@deepseek-ai/dsh-agent-loop' }

let tempRoot: string | undefined
let profileDir: string
/** 安装副本：`files` 清单装配出来的那一份，装载与产物断言都只认它。 */
let installedDir: string
/** 裸包名解析基点：profile 的 hoist 目录。必须是 file:// URL，传裸路径会报 Invalid URL。 */
let bareBase: string

/** 每个用例一个独立根 context；串用会互相干扰。 */
afterEach(disposeTrackedContexts)

afterAll(() => {
  // `lib/` 缺失时 beforeAll 先硬失败，此时还没有临时目录可清理。
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 跑一次 pnpm，失败时把子进程输出带进错误文本。
 * @param args - pnpm 参数。
 * @param cwd - 工作目录。
 */
function runPnpm(args: readonly string[], cwd: string): void {
  try {
    execFileSync('pnpm', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 240_000,
    })
  } catch (error) {
    const failure = error as { stdout?: string, stderr?: string }
    throw new Error(
      `pnpm ${args.join(' ')} failed in ${cwd}\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      { cause: error },
    )
  }
}

beforeAll(() => {
  if (!existsSync(builtEntry)) {
    throw new Error(`missing ${builtEntry}; run \`tsc -p tsconfig.json\` before the test suite`)
  }

  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-navigator-profile-'))

  const tarballDir = join(tempRoot, 'tarball')
  mkdirSync(tarballDir)
  runPnpm(['pack', '--pack-destination', tarballDir], packageDir)
  const tarballs = readdirSync(tarballDir).filter(name => name.endsWith('.tgz'))
  expect(tarballs).toHaveLength(1)

  profileDir = join(tempRoot, 'profile')
  mkdirSync(profileDir)
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-navigator-profile',
    private: true,
    // 临时 profile 是另一个 npm 上下文：pin 住 pnpm 主版本，别让结果随 PATH 上那个版本漂。
    packageManager: 'pnpm@10.12.1',
    dependencies: {
      // 本包内已声明不等于 profile 能解析它：app-boot 只把它作为 peer 带进 .pnpm 内部。
      '@deepseek-ai/cordis': '^4.0.2',
    },
  }, null, 2)}\n`, 'utf8')

  runPnpm(['add', join(tarballDir, tarballs[0]), '--ignore-scripts'], profileDir)

  installedDir = join(profileDir, 'node_modules/@dsh-clipclop/dsh-navigator')
  bareBase = pathToFileURL(join(profileDir, 'node_modules/.pnpm/node_modules/')).href
}, 300_000)

/**
 * 用一份只靠补丁插入条目的空配置，挂一个组合并跑完结算与启动审计。
 *
 * 每个用例一份独立配置：composition 不同，夹具配置就不同。
 *
 * 基点前置①：挂载前硬断 `ctx.loader.internal` 可用——拿不到时基点参数被忽略、裸名落到本仓 store，
 * 从工作副本装载同样 ACTIVE（假绿；机制见设计文档 `预构建产物的装载与启动审计`）。
 * @param configName - 临时 profile 下的配置文件名。
 * @param insert - 本组合的条目表，顺序即 activation 顺序。
 * @returns 根 context 与本次审计收集到的 warning。
 */
async function mountComposition(configName: string, insert: ProfileEntry[]) {
  const configPath = join(profileDir, configName)
  writeFileSync(configPath, '[]\n', 'utf8')
  const ctx = trackContext(new Context())
  await ctx.plugin(Loader)
  expect(ctx.loader.internal).toBeDefined()
  const warnings: string[] = []
  await mountRootInclude(ctx, configPath, [{ insert }], bareBase)
  await ctx.get('loader')?.await()
  await auditStartupEntries(ctx, BIN_NAME, line => warnings.push(line))
  return { ctx, warnings }
}

/**
 * 按条目 id 取组合里的条目，取不到就硬失败。
 * @param ctx - 已结算的根 context。
 * @param id - `EntryOptions.id`。
 * @returns loader 条目。
 */
function loaderEntry(ctx: Context, id: string) {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`loader entry ${id} is missing from the settled tree`)
  return entry
}

describe('安装副本', () => {
  it('不执行任何构建脚本也带 lib/index.js 与 lib/index.d.ts，但不含 src', () => {
    expect(existsSync(join(installedDir, 'lib/index.js'))).toBe(true)
    expect(existsSync(join(installedDir, 'lib/index.d.ts'))).toBe(true)
    expect(existsSync(join(installedDir, 'src'))).toBe(false)
  })

  it('package.json 的 dsh.bundle.patch 指向随包发布的 cordis.patch.yml', () => {
    const manifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(join(installedDir, 'cordis.patch.yml'))).toBe(true)
  })
})

describe('真实 Loader 组合从安装副本装载', () => {
  it('服务齐备时条目 ACTIVE，且 apply 的接线跑到了最后一步', async () => {
    const { ctx, warnings } = await mountComposition('active.yml', [fullStubs, navigatorEntry])

    expect(loaderEntry(ctx, 'dsh-navigator').fiber?.state).toBe(ACTIVE)
    // 桩记录的是 `register` 的 key；这里取到的是桩对象而不是真注册表，按桩的形状读它的记录。
    const projections = ctx.get('sessionProjections') as unknown as { registered: string[] }
    expect(projections.registered).toContain('navigatorSteps')
    expect(warnings).toEqual([])
  })

  it('对照条目 import 失败，证明裸名解析基点落在临时 profile', async () => {
    // 只断到对照条目的模块说明符：同组合减去它就能激活（见上一条用例），所以抛错本身即 import 失败；
    // 不绑 app-boot/loader 的包装文案。
    await expect(mountComposition('control.yml', [fullStubs, controlEntry, navigatorEntry]))
      .rejects.toThrow('@deepseek-ai/dsh-agent-loop')
  })

  it('只缺 sessionProjections 时启动不失败，审计以 warning 报出本条目停在 PENDING', async () => {
    // ① 启动不失败：挂载、裸名解析与结算都兑现（抛错则本用例在这里就失败）。
    const { ctx, warnings } = await mountComposition('missing-service.yml', [minimalStubs, navigatorEntry])

    // ② 审计落在本条目上（最小 composition 里只有它未激活），并点名缺的服务。按包名断言，不绑
    // app-boot 的诊断文案格式。
    const report = warnings.join('')
    expect(report).toContain('@dsh-clipclop/dsh-navigator')
    expect(report).toContain('pending')
    expect(report).toContain('sessionProjections')
    expect(loaderEntry(ctx, 'dsh-navigator').fiber?.state).toBe(PENDING)
  })
})
