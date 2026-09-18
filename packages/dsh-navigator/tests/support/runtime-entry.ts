/**
 * 真实入口腿（票据 12）的装配：临时 DSH home、navigator 覆盖补丁、CLI 入口解析与观察者读回。
 *
 * 两条腿都走**发布态 CLI 的真实 profile**（`--profile sdk` / `--profile acp`），用 `--patch` 覆盖把本包
 * 的构建产物按**绝对路径**插进 profile。这不走「按包名从安装副本装载」那条路线，所以 02b 的装载组合
 * 不参与本票（结论见票据备注）。
 *
 * 覆盖补丁装载的是构建产物：门禁先跑 `tsc -p tsconfig.json`，`lib/index.js` 缺失时硬失败——与 02b 的
 * 产物验收同一个前提。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))

/** 被测插件的构建产物入口；由覆盖补丁按绝对路径装载。 */
const pluginEntry = join(packageDir, 'lib/index.js')

/** 观察者条目；同样按绝对路径装载，所以是 `.mjs`。 */
const observerEntry = fileURLToPath(new URL('./notice-observer.mjs', import.meta.url))

/** 与 02b 同口径：产物缺失时硬失败，不隐式跳过。 */
export function assertBuiltEntry(): void {
  if (!existsSync(pluginEntry)) {
    throw new Error(`missing ${pluginEntry}; run \`tsc -p tsconfig.json\` before the test suite`)
  }
}

/** 发布态 `@deepseek-ai/dsh` 的 bin；版本与本包 devDependencies 里钉住的 `0.1.6-alpha.1` 同源。 */
export function dshBinPath(): string {
  const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifest), 'lib/bin.js')
}

/**
 * 一个临时 DSH home：settings.yaml 把 deepseek 适配器切到 chat-completions，与 mock 的 SSE 帧对上。
 * @param prefix - 临时目录前缀，便于失败时认出是哪条腿。
 * @returns 绝对路径。
 */
export function createLegHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n')
  return home
}

/** navigator 覆盖补丁的配置。 */
export interface NavigatorPatchOptions {
  /** 触发间隔；两条腿都用 1，让第一次复核落在第 2 步。 */
  readonly triggerEverySteps: number
  /** 给出时把观察者条目一并插进同一份补丁，notice 逐条追加到该文件。 */
  readonly noticesFile?: string
}

/**
 * 写一份覆盖补丁：插入 navigator，按需再插观察者。
 * @param home - 临时 home。
 * @param options - 触发间隔与观察者文件。
 * @returns 补丁文件绝对路径。
 */
export function writeNavigatorPatch(home: string, options: NavigatorPatchOptions): string {
  const entries: Record<string, unknown>[] = [
    {
      id: 'navigator',
      name: pluginEntry,
      config: { triggerEverySteps: options.triggerEverySteps },
    },
  ]
  if (options.noticesFile !== undefined) {
    entries.push({ id: 'notice-observer', name: observerEntry, config: { file: options.noticesFile } })
  }
  const patch = join(home, 'navigator.patch.yml')
  writeFileSync(patch, stringify([{ insert: entries }]))
  return patch
}

/** 观察者记下的一条 notice。 */
export interface ObservedNotice {
  readonly id: string
  readonly text: string
}

/**
 * 读回观察者落下的 notice 记录。
 * @param file - 观察者写入的文件。
 * @returns 逐行解析出的记录，按落盘顺序。
 */
export function readObservedNotices(file: string): ObservedNotice[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as ObservedNotice)
}

/**
 * 给子进程的完整环境：临时 home、本地 mock 作模型后端、免审批。
 * @param baseURL - mock 模型服务基点。
 * @param home - 临时 home。
 * @returns 子进程环境。
 */
export function legEnv(baseURL: string, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'dsh-navigator-leg-key',
    DEEPSEEK_BASE_URL: baseURL,
    DSH_PERMISSION_MODE: 'danger-full-access',
  }
}
