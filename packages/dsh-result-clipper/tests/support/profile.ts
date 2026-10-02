/**
 * 「保存即生效」的观察面：一条**真实**的 DSH profile（`dsh-app-boot` 的 `boot` + 真 `configEditor`、真
 * `settings`、真 Loader），本插件作为其中的一行装载。
 *
 * 为什么不用替身：volatile 的「保存即生效」是 settings 服务 + Loader 一起兑现的——写入落在 profile patch
 * 上、装载期解析出的引用**原地更新**，不需要重挂载。手搓这条链路会把判据的输入换成夹具自己的假设。
 *
 * 本文件同时提供真 `tools` / `systemPrompt` 两行，所以工具结果可以照常经 `ctx.tools.execute` 走一遍
 * `tools/post-execute`——「写完设置立刻改变 host 行为」这一条因此是可观察的，而不是只断言引用变了。
 *
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../../src/index.ts'

/** settings 命名空间 = profile patch 行的 id（本插件的 host 入口名，不是包名）。 */
export const PREFERENCE_NAMESPACE = 'dsh-result-clipper'

/** 一行 volatile 字段解析后的引用。 */
export interface LiveConfig {
  readonly summarize: { get(): boolean }
  readonly privacyGate: { get(): boolean }
  readonly admissionJudge: { get(): boolean }
  readonly debug: { get(): boolean }
  readonly debugPath: { get(): string }
  readonly routeProvider: { get(): string }
  readonly routeModel: { get(): string }
  readonly admissionProvider: { get(): string }
  readonly admissionModel: { get(): string }
  readonly minInlineTokens: { get(): number }
  readonly maxSummarizeTokens: { get(): number }
  readonly summaryDisableReasoning: { get(): boolean }
  readonly admissionDisableReasoning: { get(): boolean }
  readonly privacyDisableReasoning: { get(): boolean }
  readonly routeConfirmedLocal: { get(): boolean }
  readonly failurePolicy: { get(): 'passthrough' | 'block' }
  readonly summaryPrompt: { get(): string }
  readonly admissionPrompt: { get(): string }
  readonly privacyPrompt: { get(): string }
}

/** 一条装好的 profile。 */
export interface LiveFixture {
  readonly ctx: Context
  /** 本插件那一行**解析后**的配置引用；读它即装载期解析出的取值。 */
  readonly config: LiveConfig
  dispose(): Promise<void>
}

/** 释放本文件创建过的全部 profile 目录。 */
const roots: string[] = []

/** 删除本文件创建过的全部 profile 目录。 */
export function cleanupProfiles(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/**
 * 装一条最小 profile：settings + 编辑器 + 工具运行时 + 被测插件各一行。
 * @param config - 被测插件那一行的 profile 配置（用户层）。
 * @returns 该 profile 的能力对象。
 */
export async function bootProfile(config: Record<string, unknown>): Promise<LiveFixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-result-clipper-')))
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
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'system-prompt', name: 'cordis:systemPrompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: PREFERENCE_NAMESPACE, name: 'cordis:result-clipper', config },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
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
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), (root) => {
    root.provide('profileContext', profile)
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      systemPrompt: SystemPrompt,
      tools: ToolRuntime,
      'result-clipper': plugin,
    })
  })
  return {
    ctx,
    config: resolvedConfig(ctx),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** 本插件那一行装载期解析出的配置引用。 */
function resolvedConfig(ctx: Context): LiveConfig {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === PREFERENCE_NAMESPACE)
  const config = entry?.fiber?.config as Partial<LiveConfig> | undefined
  if (config?.summarize === undefined || config.privacyGate === undefined
    || config.admissionJudge === undefined || config.debug === undefined || config.debugPath === undefined
    || config.routeProvider === undefined || config.routeModel === undefined
    || config.admissionProvider === undefined || config.admissionModel === undefined
    || config.minInlineTokens === undefined || config.maxSummarizeTokens === undefined
    || config.summaryDisableReasoning === undefined || config.admissionDisableReasoning === undefined
    || config.privacyDisableReasoning === undefined || config.routeConfirmedLocal === undefined
    || config.failurePolicy === undefined
    || config.summaryPrompt === undefined || config.admissionPrompt === undefined
    || config.privacyPrompt === undefined) {
    throw new Error('profile fixture: the result-clipper row has no resolved volatile config')
  }
  return config as LiveConfig
}
