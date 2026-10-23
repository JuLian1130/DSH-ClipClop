/**
 * 真实 profile 装载（票据 01）。
 *
 * 第一步的测试全部用 `new Context()`：装载路径——profile 的 `dsh.profile.bundles` → 随包
 * `cordis.patch.yml` 那一行 → 真实 Loader 组合——不在任何门禁里。本文件补上它：`pnpm pack` 出
 * tarball、`--ignore-scripts` 装进临时 profile，再用发布态 `@deepseek-ai/dsh-app-boot` 组合并启动，
 * 断言那一行 ACTIVE、`ctx.systemOne` 能注册假 provider 并 `ask` 成功，以及 profile 里装不上本包时
 * 那条跳过原因点名本包。
 *
 * `lib/` 由门禁的构建步（`tsc -p tsconfig.json`）产出并命中 `.gitignore`：夹具**不自己构建**，缺
 * `lib/index.js` 时硬失败，避免在干净检出上把过期或缺失的产物验成 ACTIVE。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { auditStartupEntries, loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SystemOneProvider, type ProviderRequest } from '../src/provider.ts'
import type { Answer, ProviderResponse, Question } from '../src/types.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = '@dsh-clipclop/dsh-system-one'
/** 随包 patch 里那一行的 id：装载断言的判据，也是客户端半的配置命名空间。 */
const ROW_ID = 'dsh-system-one'
/** 审计的诊断前缀；warning 走注入的收集器，不去 stderr 上捞。 */
const BIN_NAME = 'dsh-system-one-profile-fixture'
/** 产物验收与装载断言的前置：构建在门禁里，不在夹具里。 */
const builtEntry = join(packageDir, 'lib/index.js')

/** `FiberState` 是 const enum，不能运行时具名导入；只镜像本文件断言的那一种状态。 */
const ACTIVE = 2 as FiberState.ACTIVE

const QUESTIONS: Record<string, Question> = {
  'turn.continue': { type: 'boolean', instructions: '本轮是否应该继续？' },
  'turn.route': { type: 'choice', instructions: '下一步走哪条路？', options: ['fix', 'ask'] },
}

const ANSWERS: Record<string, Answer> = {
  'turn.continue': { type: 'boolean', probability: 0.25 },
  'turn.route': { type: 'choice', choice: 'ask', probabilities: [0.3, 0.7] },
}

/**
 * 由装载方（第三方 provider 插件）注册的假条目。
 *
 * 它继承**源码**里的 `SystemOneProvider`，注册进的是**安装副本**的服务：服务只按形状调用
 * `evaluate`，不做 `instanceof` 判断，所以注册方与注册表可以来自不同的模块副本——这正是
 * provider 作者面的形状。
 */
class StubProvider extends SystemOneProvider {
  readonly calls: ProviderRequest[] = []

  async evaluate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request)
    return { answers: ANSWERS }
  }
}

let tempRoot: string | undefined
let profileDir: string

afterAll(() => {
  // `lib/` 缺失时 beforeAll 先硬失败，此时还没有临时目录可清理。
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true })
})

/** 跑一次 pnpm；失败时把子进程输出带进错误文本，免得只剩一个退出码。 */
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

/**
 * 按安装期口径写一份 profile 清单：一个 bundle（本包）加它唯一的运行时 peer。
 * @param dir - profile 目录。
 */
function writeProfileManifest(dir: string): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-system-one-profile',
    private: true,
    dependencies: {
      // 本包唯一的运行时依赖是 cordis，而且只是 peer：profile 不解析它，装载会停在 import 阶段。
      // 指向工作区已装好的那一份：装 profile 时不必再问 registry，门禁就不再依赖网络。
      '@deepseek-ai/cordis': `link:${join(packageDir, 'node_modules/@deepseek-ai/cordis')}`,
    },
    dsh: { profile: { bundles: [PACKAGE_NAME] } },
  }, null, 2)}\n`, 'utf8')
  // 根 include 与真实 profile 一样是空数组：那一行只来自包自己的 patch 层。
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')
}

beforeAll(() => {
  if (!existsSync(builtEntry)) {
    throw new Error(`missing ${builtEntry}; run \`tsc -p tsconfig.json\` before the test suite`)
  }

  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-system-one-profile-'))

  const tarballDir = join(tempRoot, 'tarball')
  mkdirSync(tarballDir)
  // `pnpm pack` 默认会跑 `prepare`（= 构建），把 `lib/` 重写一遍：那会与并行运行的
  // `declaration-merge.spec.ts` 读同一批产物撞车，也让「缺产物就硬失败」的守卫形同虚设。
  // 产物由门禁的构建步给出，这里只要打包。
  runPnpm(['pack', '--config.ignore-scripts=true', '--pack-destination', tarballDir], packageDir)
  const tarballs = readdirSync(tarballDir).filter(name => name.endsWith('.tgz'))
  expect(tarballs).toHaveLength(1)

  profileDir = join(tempRoot, 'profile')
  mkdirSync(profileDir)
  writeProfileManifest(profileDir)
  runPnpm(['add', join(tarballDir, tarballs[0]!), '--ignore-scripts'], profileDir)
}, 300_000)

/**
 * 组合一次真实 profile 并跑完结算：`ctx.plugin(Loader)` → 挂根 include 与 patch 层 → 等树结算 →
 * 启动审计。序列与 `dsh` 的启动同形。
 *
 * 硬前置 `ctx.loader.internal`：拿不到时 `bareModuleBaseUrl` 会被忽略，裸名改从本进程能解析到的
 * 任何位置取，于是从工作副本装载同样是 ACTIVE（假绿）。基点显式给 profile 的 `node_modules`，
 * 那一行的模块只能从安装副本里来。
 * @returns 已结算的根 context、审计 warning 与该 profile 的组合结果。
 */
async function mountProfile() {
  const profile = loadProfileDirectory(BIN_NAME, profileDir, join(profileDir, 'package.json'))
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches]
  const ctx = new Context()
  await ctx.plugin(Loader)
  expect(ctx.loader.internal).toBeDefined()
  const warnings: string[] = []
  await mountRootInclude(
    ctx,
    join(profileDir, 'cordis.yml'),
    patches,
    pathToFileURL(join(profileDir, 'node_modules')).href,
    BIN_NAME,
  )
  await ctx.get('loader')?.await()
  await auditStartupEntries(ctx, BIN_NAME, line => warnings.push(line))
  return { ctx, warnings, profile }
}

describe('真实 profile 装载', () => {
  it('这一行 ACTIVE，且 ctx.systemOne 注册假 provider 后 ask 成功', async () => {
    const { ctx, warnings, profile } = await mountProfile()
    try {
      // 组合阶段没有跳过任何 bundle，且解析到的是临时 profile 里那一份（不是本仓工作副本）。
      expect(profile.skippedBundles).toEqual([])
      expect(profile.layers[0]?.packageDir).toBe(join(profileDir, 'node_modules', PACKAGE_NAME))
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === ROW_ID)
      if (entry === undefined) throw new Error(`loader entry ${ROW_ID} is missing from the settled tree`)
      expect(entry.fiber?.state).toBe(ACTIVE)
      expect(warnings).toEqual([])

      const provider = new StubProvider()
      const dispose = ctx.systemOne.register('probe', provider)
      const result = await ctx.systemOne.ask({ target: 'probe', state: { step: 3 }, questions: QUESTIONS })

      expect(provider.calls).toHaveLength(1)
      expect(provider.calls[0]?.state).toEqual({ step: 3 })
      expect(result.answers).toEqual(ANSWERS)
      expect(typeof result.latencyMs).toBe('number')
      dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('profile 里装不上本包时，装载被跳过且原因点名本包', () => {
    const uninstalledDir = join(tempRoot!, 'uninstalled')
    mkdirSync(uninstalledDir)
    writeProfileManifest(uninstalledDir)

    // 这一段必须跑在**子进程**里：vitest 会给本进程注入 `NODE_PATH`（指向本仓
    // `node_modules/.pnpm/node_modules`），本包恰好在那里也有一份，CJS 的 `resolve.paths` 会把它
    // 「找回」来——装不上的 profile 于是解析成功。去掉 `NODE_PATH` 才是干净 profile 的解析环境。
    const script = `
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
const dir = process.argv[1]
const profile = loadProfileDirectory(${JSON.stringify(BIN_NAME)}, dir, dir + '/package.json')
console.log(JSON.stringify({ layers: profile.layers.length, skipped: profile.skippedBundles }))
`
    const env = { ...process.env }
    delete env.NODE_PATH
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, uninstalledDir],
      { cwd: packageDir, encoding: 'utf8', env },
    )
    const result = JSON.parse(output) as { layers: number, skipped: { packageName: string, reason: string }[] }

    // 一个 patch 层都没组合出来，且跳过原因点名本包：失败不会被静默当成「没有这一行」。
    expect(result.layers).toBe(0)
    expect(result.skipped.map(skipped => skipped.packageName)).toEqual([PACKAGE_NAME])
    expect(result.skipped[0]?.reason).toContain(PACKAGE_NAME)
  })
})
