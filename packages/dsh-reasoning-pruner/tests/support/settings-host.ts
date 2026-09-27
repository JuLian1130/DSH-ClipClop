/**
 * 06 的 host 侧夹具：一条**真实**的 DSH profile（`dsh-app-boot` 的 `boot` + 真 `configEditor`、真
 * `settings`、真 Loader），本插件作为其中的一行装载。
 *
 * 为什么不用替身：settings 的命名空间视图带着**真实序列化的 schema 信封**（客户端 `ConfigForm` 的默认
 * `decode` 会 rehydrate 它并校验 section），而 `listConfigurableProviders()` 的目录由真的 `llm-pi-ai` /
 * `llm-deepseek` 插件声明。手搓这两样都会把「置灰判据的输入」换成夹具自己的假设。
 *
 * profile patch 文件（`cordis.patch.yml`）就是 **settings 文档**：写回落在它上面，重挂载就是拿同一个目录再
 * `boot` 一次。
 *
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  LlmConfigurableProvider, SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeekKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore from '@deepseek-ai/dsh-session'
import Settings from '@deepseek-ai/dsh-settings'
import * as plugin from '../../src/index.ts'

/** settings 命名空间 = profile patch 行 id（本插件的 host 入口名，与包名无关）。 */
export const PREFERENCE_NAMESPACE = 'dsh-reasoning-pruner'

/**
 * 替身的答复包装。真 wire 面是 `RemoteResult<T>`，但它的失败分支要求一个完整的 `RemoteFailure`（`code` /
 * `details` / `isDSHRemoteError` / `name`），而夹具只模拟「Host 业务拒绝」这一种结算；客户端在这条路径上
 * 只读 `ok` 与 `error.message`。视图本身用框架类型（`SettingsDescribeValue`），不另抄一份。
 */
export type WireReply<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: { readonly message: string } }

/** 浏览器侧 `remote.settings` 的替身：直接调本进程里的真服务。 */
export interface SettingsWire {
  readonly describe: () => Promise<WireReply<SettingsDescribeValue>>
  readonly mutate: (ns: string, ops: readonly SettingsPathOpView[], revision: number | undefined) => Promise<WireReply<SettingsNamespaceView>>
}

/** 一次派发出去的写操作与它的结算（`ok: false` 即 Host 业务拒绝）。 */
export interface RecordedWrite {
  readonly ns: string
  readonly ops: readonly SettingsPathOpView[]
  readonly ok: boolean | undefined
}

/**
 * 把 {@link SettingsHost.wire} 包成会记账的 wire：路径与条数是第 6 条的判据，结算的 `ok` 是第 7 条的判据。
 * @param wire - 该 host 的真服务桥。
 * @param writes - 记账数组，按派发顺序追加。
 * @returns 会记账的 wire。
 */
export function recordingWire(wire: SettingsWire, writes: RecordedWrite[]): SettingsWire {
  return {
    describe: wire.describe,
    mutate: async (ns, ops, revision) => {
      const record: { ns: string, ops: SettingsPathOpView[], ok: boolean | undefined } = { ns, ops: [...ops], ok: undefined }
      writes.push(record)
      const reply = await wire.mutate(ns, ops, revision)
      record.ok = reply.ok
      return reply
    },
  }
}

/** 一条装好的 host profile。 */
export interface SettingsHost {
  readonly ctx: Context
  /** profile 目录（同一个目录再 `boot` 一次就是「重挂载」）。 */
  readonly dir: string
  /** 真 `listConfigurableProviders()` 的当前目录。 */
  readonly providers: () => readonly LlmConfigurableProvider[]
  /** 本插件那一行**解析后**的 `manualPrune`（volatile 引用，读它即 loader 解析出的取值）。 */
  readonly manualPrune: () => boolean
  /** 浏览器侧 `remote.settings` 的桥。 */
  readonly wire: SettingsWire
  /** 释放整个 context；不删 profile 目录（重挂载还要用它）。 */
  dispose(): Promise<void>
}

/** 释放本文件创建过的全部 profile 目录。 */
const roots: string[] = []

/** 删除本文件创建过的全部 profile 目录。 */
export function cleanupHosts(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** profile patch 里的一行。 */
interface PatchRow {
  readonly id: string
  readonly name: string
  readonly config?: Record<string, unknown>
}

/**
 * 建一个临时 profile 目录（照 DSH 自己的 settings 夹具：一个安装根 + 一个 bundle + 一份 patch 文件）。
 * @param rows - 写进 bundle patch 的 `insert` 行。
 * @returns 安装根与 `ProfileContext`。
 */
function makeProfile(rows: readonly PatchRow[]): { home: string, profile: ProfileContext } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-reasoning-pruner-host-')))
  roots.push(home)
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle',
    version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  return {
    home,
    profile: {
      name: 'test',
      startedBundles: ['test-bundle'],
      dir,
      patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home,
      home,
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
  }
}

/**
 * 装一条真实 profile。
 *
 * 行 id 照出厂 bundle：`llm-deepseek` → `dsh-llm-deepseek-api-key`（它的目录项 `settingsNs` 就是这一行的
 * id）、`llm-pi-ai` → `dsh-llm-pi-ai`。
 * @param options - 可选项。
 * @param options.manualPrune - 本插件那一行的 `manualPrune`（缺省 `true`，即出厂默认）。
 * @param options.rows - 追加／覆盖的 patch 行。
 * @param options.dir - 复用已有 profile 目录（重挂载）。
 * @returns 该 profile 的能力对象。
 */
export async function bootSettingsHost(options: {
  readonly manualPrune?: boolean
  readonly rows?: readonly PatchRow[]
  readonly dir?: string
} = {}): Promise<SettingsHost> {
  const built = options.dir === undefined ? makeProfile(options.rows ?? defaultRows(options.manualPrune ?? true)) : undefined
  const dir = options.dir ?? built!.profile.dir
  const active = built?.profile ?? profileFromDir(dir)
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', active), (root) => {
    root.provide('profileContext', active)
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      sessions: SessionStore,
      commands: CommandRuntime,
      llm: LlmRuntime,
      'pi-ai': PiAi,
      'deepseek-key': DeepSeekKey,
      'reasoning-pruner': plugin,
    })
  })
  return {
    ctx,
    dir,
    providers: () => ctx.llm.listConfigurableProviders(),
    manualPrune: () => prunerConfig(ctx).manualPrune.get(),
    wire: {
      // 真 `settings.describe({ redactSecrets: true })`（远端那层做的就是这个投影，`namespaceView`）。
      describe: async () => ({
        ok: true,
        value: {
          writable: ctx.settings.writable,
          hasDocument: true,
          namespaces: ctx.settings.describe({ redactSecrets: true }).map(view),
        },
      }),
      mutate: async (ns, ops, revision) => {
        try {
          await ctx.settings.mutate(ns, ops as never, revision)
        } catch (error) {
          return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
        const descriptor = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
        if (descriptor === undefined) return { ok: false, error: { message: `settings namespace "${ns}" is gone` } }
        return { ok: true, value: view(descriptor) }
      },
    },
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/**
 * 出厂行 + 本插件那一行，并把 pi-ai 的路由 profile 写进它那一行——`llm-pi-ai` 的 settings 值就是这段
 * profile 字典，所以置灰判据分支②/③的输入取自真的 settings 命名空间值。
 * @param manualPrune - 本插件那一行的开关取值。
 * @param providers - pi-ai 的路由 profile 字典。
 * @returns patch 行。
 */
export function rowsWithPiAiRoutes(manualPrune: boolean, providers: Record<string, unknown>): readonly PatchRow[] {
  return defaultRows(manualPrune).map(row => row.id === 'llm-pi-ai' ? { ...row, config: { providers } } : row)
}

/** 出厂行 + 本插件那一行。 */
function defaultRows(manualPrune: boolean): readonly PatchRow[] {
  return [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'commands', name: 'cordis:commands' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'llm-pi-ai', name: 'cordis:pi-ai' },
    { id: 'llm-deepseek', name: 'cordis:deepseek-key' },
    // 行里带上两个数值键：写回只动 `manualPrune`，另外两个键必须原样留在文档里（criterion 6）。
    { id: PREFERENCE_NAMESPACE, name: 'cordis:reasoning-pruner', config: { everySteps: 50, keepRecentSteps: 10, manualPrune } },
  ]
}

/** 复用一个已有 profile 目录时的 `ProfileContext`（字段与 {@link makeProfile} 同源）。 */
function profileFromDir(dir: string): ProfileContext {
  const home = join(dir, '..', '..')
  return {
    name: 'test',
    startedBundles: ['test-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
}

/** 本插件那一行的 loader 条目。 */
function prunerEntry(ctx: Context) {
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === PREFERENCE_NAMESPACE)
  if (entry === undefined) throw new Error(`host fixture: profile has no "${PREFERENCE_NAMESPACE}" row`)
  return entry
}

/** 本插件那一行解析后的配置（`fiber.config`）。 */
function prunerConfig(ctx: Context): { manualPrune: { get(): boolean } } {
  const config = prunerEntry(ctx).fiber?.config as { manualPrune?: { get(): boolean } } | undefined
  if (config?.manualPrune === undefined) throw new Error('host fixture: the pruner row has no resolved manualPrune')
  return config as { manualPrune: { get(): boolean } }
}

/** 远端那层对 describe 结果做的投影（客户端只读 `ns`/`schema`/`value`/`base`/`user`/`revision`）。 */
function view(descriptor: {
  ns: unknown, autoGenerate: boolean, schema: unknown, value: unknown
  base?: unknown, user?: unknown, applies: 'live', revision: number
  secrets?: readonly { path: readonly (string | number)[], set: boolean }[]
}): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    autoGenerate: descriptor.autoGenerate,
    schema: descriptor.schema as SettingsNamespaceView['schema'],
    value: descriptor.value as SettingsNamespaceView['value'],
    ...descriptor.base === undefined ? {} : { base: descriptor.base as SettingsNamespaceView['value'] },
    ...descriptor.user === undefined ? {} : { user: descriptor.user as SettingsNamespaceView['value'] },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: secret.path.map(String), set: secret.set })),
    revision: descriptor.revision,
  }
}
