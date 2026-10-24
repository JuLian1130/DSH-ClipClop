/**
 * 真实 profile 装载（票据 01、07）。
 *
 * 第一步的测试全部用 `new Context()`：装载路径——profile 的 `dsh.profile.bundles` → 随包
 * `cordis.patch.yml` 的两行 → 真实 Loader 组合——不在任何门禁里。本文件补上它：`pnpm pack` 出两个
 * tarball、`--ignore-scripts` 装进临时 profile，再用发布态 `@deepseek-ai/dsh-app-boot` 组合并启动，
 * 断言两行都 ACTIVE、接入层与通道的工具都能用、按 id 只禁用其中一行时另一行照常（或通道行不激活），
 * 以及 profile 里装不上本包时那条跳过原因点名本包。
 *
 * 工具注册表与提示装配在真实 profile 里由 `dsh-base` 铺的行提供，这里按安装期的同一份工作副本链进
 * profile，只为让通道那一行有服务可用；**本包的两行**仍只从安装副本解析（`bareModuleBaseUrl` 指向
 * profile 的 `node_modules`）。
 *
 * `lib/` 由门禁的构建步（`tsc -p tsconfig.json`）产出并命中 `.gitignore`：夹具**不自己构建**，缺
 * `lib/index.js` 时硬失败，避免在干净检出上把过期或缺失的产物验成 ACTIVE。
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  auditStartupEntries,
  initProfile,
  loadProfileDirectory,
  mountRootInclude,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SystemOneProvider, type ProviderRequest } from '../src/provider.ts'
import type { Answer, ProviderResponse, Question } from '../src/types.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
/** 子包目录：随包 patch 的第二行来自它，宿主服务也从它旁边的工作副本链进 profile。 */
const channelDir = fileURLToPath(new URL('../../dsh-system-one-channel', import.meta.url))
const PACKAGE_NAME = '@dsh-clipclop/dsh-system-one'
const CHANNEL_PACKAGE_NAME = '@dsh-clipclop/dsh-system-one-channel'
/** 随包 patch 里第一行的 id：装载断言的判据，也是客户端半的配置命名空间。 */
const ROW_ID = 'dsh-system-one'
/** 第二行：决策通道；禁用/启用都按这个 id 点它。 */
const CHANNEL_ROW_ID = 'dsh-system-one-channel'
/** 通道注册进工具面的名字（子包的常量在安装副本里，这里按名断言）。 */
const TOOL_NAME = 'systemone_ask'
/** 审计的诊断前缀；warning 走注入的收集器，不去 stderr 上捞。 */
const BIN_NAME = 'dsh-system-one-profile-fixture'
/** 产物验收与装载断言的前置：构建在门禁里，不在夹具里。 */
const builtEntries = [join(packageDir, 'lib/index.js'), join(channelDir, 'lib/index.js')]

/** `FiberState` 是 const enum，不能运行时具名导入；只镜像本文件断言的那一种状态。 */
const ACTIVE = 2 as FiberState.ACTIVE

/** 一行 patch 里本文件用到的字段（`mountRootInclude` 收的 `PatchOptions` 的那个形状）。 */
interface RowPatch {
  id: string
  disabled?: boolean
  config?: unknown
}

const QUESTIONS: Record<string, Question> = {
  'turn.continue': { type: 'boolean', instructions: '本轮是否应该继续？' },
  'turn.route': { type: 'choice', instructions: '下一步走哪条路？', options: ['fix', 'ask'] },
}

const ANSWERS: Record<string, Answer> = {
  'turn.continue': { type: 'boolean', probability: 0.25 },
  'turn.route': { type: 'choice', choice: 'ask', probabilities: [0.3, 0.7] },
}

/** 交给工具的题面：一题是非题（工具参数里的形状，不是契约的映射）。 */
const TOOL_QUESTION = { id: 'turn.continue', type: 'boolean', instructions: '本轮是否应该继续？' } as const

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
    const failure = error as { stdout?: string; stderr?: string }
    throw new Error(
      `pnpm ${args.join(' ')} failed in ${cwd}\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      { cause: error },
    )
  }
}

/**
 * 按 `dsh plugin` 的初始化口径铺一个 profile：清单、用户 patch 层与 pnpm 设置都交给真实的
 * `initProfile`（`nodeLinker: hoisted`——profile 的 `node_modules` 就是解析锚点）。
 *
 * 给了 tarball 就再装上两个包：本包 `private`、子包也没发布，registry 上没有它们，所以子包那一条
 * 依赖用 override 指到本地 tarball（真实部署里那一格由 registry 或 link 安装填上）。
 * @param dir - profile 目录。
 * @param mainTarball - 本包 tarball；省略即「装不上本包」的对照 profile。
 * @param channelTarball - 子包 tarball。
 */
function writeProfile(dir: string, mainTarball?: string, channelTarball?: string): void {
  mkdirSync(dir, { recursive: true })
  initProfile(dir, [PACKAGE_NAME])
  // 根 include 在真实 profile 里铺着 dsh-base 的全部行；这里只留本包两行需要的那两条宿主服务。
  writeFileSync(join(dir, 'cordis.yml'), [
    '# 宿主的两行（真实 profile 里来自 dsh-base）：工具注册表与提示装配。',
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '',
  ].join('\n'), 'utf8')
  if (mainTarball === undefined || channelTarball === undefined) return

  for (const tarball of [mainTarball, channelTarball]) copyFileSync(tarball, join(dir, basename(tarball)))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-system-one-profile',
    private: true,
    dependencies: {
      // 本包唯一的运行时依赖是 cordis，而且只是 peer：profile 不解析它，装载会停在 import 阶段。
      // 指向工作区已装好的那一份，免得为夹具装一整套 DSH。
      '@deepseek-ai/cordis': `link:${join(packageDir, 'node_modules/@deepseek-ai/cordis')}`,
      // 工具注册表与提示装配是宿主服务（真实 profile 里由 dsh-base 的行提供）：通道那一行拿它们做
      // 依赖，`@deepseek-ai/dsh-tools` 还是它唯一的运行时 import。
      '@deepseek-ai/dsh-tools': `link:${join(channelDir, 'node_modules/@deepseek-ai/dsh-tools')}`,
      '@deepseek-ai/dsh-system-prompt': `link:${join(channelDir, 'node_modules/@deepseek-ai/dsh-system-prompt')}`,
      [PACKAGE_NAME]: `file:./${basename(mainTarball)}`,
    },
    dsh: { profile: { bundles: [PACKAGE_NAME] } },
  }, null, 2)}\n`, 'utf8')
  appendFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    `\noverrides:\n  '${CHANNEL_PACKAGE_NAME}': 'file:./${basename(channelTarball)}'\n`,
  )
  // 用户 patch 层：打开通道那一行（随包 patch 里的示例是注释），`target` 指夹具注册的假条目。
  writeFileSync(join(dir, PROFILE_PATCH_FILENAME), [
    `- id: ${CHANNEL_ROW_ID}`,
    '  config:',
    '    enabled: true',
    '    target: probe',
    '',
  ].join('\n'), 'utf8')
}

beforeAll(() => {
  for (const builtEntry of builtEntries) {
    if (!existsSync(builtEntry)) {
      throw new Error(`missing ${builtEntry}; run \`tsc -p tsconfig.json\` before the test suite`)
    }
  }

  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-system-one-profile-'))

  const tarballDir = join(tempRoot, 'tarball')
  mkdirSync(tarballDir)
  // `pnpm pack` 默认会跑 `prepare`（= 构建），把 `lib/` 重写一遍：那会与并行运行的
  // `declaration-merge.spec.ts` 读同一批产物撞车，也让「缺产物就硬失败」的守卫形同虚设。
  // 产物由门禁的构建步给出，这里只要打包。
  for (const dir of [packageDir, channelDir]) {
    runPnpm(['pack', '--config.ignore-scripts=true', '--pack-destination', tarballDir], dir)
  }
  const tarballs = readdirSync(tarballDir).filter(name => name.endsWith('.tgz'))
  expect(tarballs).toHaveLength(2)
  const channelTarball = tarballs.find(name => name.includes(CHANNEL_ROW_ID))
  const mainTarball = tarballs.find(name => name !== channelTarball)
  if (mainTarball === undefined || channelTarball === undefined) {
    throw new Error(`unexpected tarballs: ${tarballs.join(', ')}`)
  }

  profileDir = join(tempRoot, 'profile')
  writeProfile(profileDir, join(tarballDir, mainTarball), join(tarballDir, channelTarball))
  runPnpm(['install', '--ignore-scripts'], profileDir)
}, 300_000)

/**
 * 组合一次真实 profile 并跑完结算：`ctx.plugin(Loader)` → 挂根 include 与 patch 层 → 等树结算 →
 * 启动审计。序列与 `dsh` 的启动同形。
 *
 * 硬前置 `ctx.loader.internal`：拿不到时 `bareModuleBaseUrl` 会被忽略，裸名改从本进程能解析到的
 * 任何位置取，于是从工作副本装载同样是 ACTIVE（假绿）。基点显式给 profile 的 `node_modules`，
 * 那两行的模块只能从安装副本里来。
 * @param overrides - 追加在最后（= `--patch` 那样的启动器层）的 patch：按 id 覆盖或禁用某一行。
 * @returns 已结算的根 context、审计 warning 与该 profile 的组合结果。
 */
async function mountProfile(overrides: RowPatch[] = []) {
  const profile = loadProfileDirectory(BIN_NAME, profileDir, join(profileDir, 'package.json'))
  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...overrides,
  ]
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

/** 装载树里某一行的 entry：被禁用时 entry 还在，但没有 fiber。 */
function row(ctx: Context, id: string) {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)
}

/**
 * 注册假条目，再经工具面调一次。
 * @returns 假 provider 收到的请求。
 */
async function askThroughTool(ctx: Context): Promise<ProviderRequest[]> {
  const definition = ctx.tools.get(TOOL_NAME)
  if (definition === undefined) throw new Error(`${TOOL_NAME} is not registered`)
  const provider = new StubProvider()
  const dispose = ctx.systemOne.register('probe', provider)
  try {
    const value = await definition.execute(
      { state: { step: 3 }, questions: [TOOL_QUESTION] },
      // 工具体只读 `signal`；其余字段（callId、agent、token…）是执行器的账，夹具不需要编。
      { signal: new AbortController().signal } as unknown as ToolRunContext,
    )
    expect(value).toMatchObject({ answers: ANSWERS })
  } finally {
    dispose()
  }
  return provider.calls
}

describe('真实 profile 装载', () => {
  it('接入层那一行 ACTIVE，且 ctx.systemOne 注册假 provider 后 ask 成功', async () => {
    const { ctx, warnings, profile } = await mountProfile()
    try {
      // 组合阶段没有跳过任何 bundle，且解析到的是临时 profile 里那一份（不是本仓工作副本）。
      expect(profile.skippedBundles).toEqual([])
      expect(profile.layers[0]?.packageDir).toBe(join(profileDir, 'node_modules', PACKAGE_NAME))
      expect(row(ctx, ROW_ID)?.fiber?.state).toBe(ACTIVE)
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

  it('两行都 ACTIVE：通道的工具进了工具面，调一次走完接入层', async () => {
    const { ctx, warnings } = await mountProfile()
    try {
      expect(row(ctx, ROW_ID)?.fiber?.state).toBe(ACTIVE)
      expect(row(ctx, CHANNEL_ROW_ID)?.fiber?.state).toBe(ACTIVE)
      expect(warnings).toEqual([])

      const calls = await askThroughTool(ctx)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.state).toEqual({ step: 3 })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('子包列在本包的 dependencies 里，两行都从安装副本解析', () => {
    // 源清单：子包是运行时 dependency——那一行的模块名要在 profile 的 node_modules 里解析得到。
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toHaveProperty(CHANNEL_PACKAGE_NAME)

    // 安装副本：打包把 workspace 协议换成了可安装的版本号。
    const installed = JSON.parse(
      readFileSync(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(installed.dependencies?.[CHANNEL_PACKAGE_NAME]).toMatch(/^\d+\.\d+\.\d+/)

    // 两行都从 profile 里解析：临时目录的上级没有可借的 node_modules，解析到工作副本就说明装错了。
    // `require.resolve` 交回的是真实路径（`/var` 在 macOS 上是 `/private/var` 的软链），比较前先归位。
    const realProfileDir = realpathSync(profileDir)
    const require = createRequire(join(profileDir, 'package.json'))
    for (const name of [PACKAGE_NAME, CHANNEL_PACKAGE_NAME]) {
      expect(require.resolve(name).startsWith(realProfileDir)).toBe(true)
    }
  })

  it('只禁用通道那一行：接入层照常，工具不存在', async () => {
    const { ctx, warnings } = await mountProfile([{ id: CHANNEL_ROW_ID, disabled: true }])
    try {
      expect(row(ctx, CHANNEL_ROW_ID)?.fiber).toBeUndefined()
      expect(row(ctx, ROW_ID)?.fiber?.state).toBe(ACTIVE)
      expect(ctx.tools.get(TOOL_NAME)).toBeUndefined()
      // 被禁用不是「没激活」：启动审计不该为此报警。
      expect(warnings).toEqual([])

      const provider = new StubProvider()
      const dispose = ctx.systemOne.register('probe', provider)
      const result = await ctx.systemOne.ask({ target: 'probe', state: { step: 3 }, questions: QUESTIONS })
      expect(result.answers).toEqual(ANSWERS)
      dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('只禁用接入层那一行：通道行不激活、工具不存在，不静默降级', async () => {
    const { ctx, warnings } = await mountProfile([{ id: ROW_ID, disabled: true }])
    try {
      expect(row(ctx, ROW_ID)?.fiber).toBeUndefined()
      const channel = row(ctx, CHANNEL_ROW_ID)
      // 没有被禁用，只是依赖的服务不在：不是 active，也没有留下半注册的工具。
      expect(channel?.disabled).toBe(false)
      expect(channel?.fiber?.state).not.toBe(ACTIVE)
      expect(ctx.tools.get(TOOL_NAME)).toBeUndefined()
      // 不静默：启动审计点名这一行在等接入层的服务。
      expect(warnings.join('\n')).toContain(CHANNEL_ROW_ID)
      expect(warnings.join('\n')).toContain('systemOne')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('重新启用接入层那一行后，通道行恢复 ACTIVE、工具重新出现', async () => {
    const { ctx, warnings } = await mountProfile()
    try {
      expect(row(ctx, CHANNEL_ROW_ID)?.fiber?.state).toBe(ACTIVE)
      expect(ctx.tools.get(TOOL_NAME)).toBeDefined()
      expect(warnings).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('profile 里装不上本包时，装载被跳过且原因点名本包', () => {
    const uninstalledDir = join(tempRoot!, 'uninstalled')
    writeProfile(uninstalledDir)

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
