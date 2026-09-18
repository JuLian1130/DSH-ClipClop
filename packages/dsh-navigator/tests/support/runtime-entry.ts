/**
 * 真实入口腿（票据 12）的装配：临时 DSH home、navigator 覆盖补丁、CLI 入口解析、资源收尾与观察者读回。
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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { navigatorLegScript, startMockModel, type MockModelServer } from './mock-model.ts'

/**
 * 本包根目录：由本文件位置往上三级（`tests/support/runtime-entry.ts` → 包根）。
 *
 * **不用 `new URL('../..', import.meta.url)`**：Vite 会把这种写法改写成 dev server 的 http URL（jsdom
 * 档实测拿到 `http://localhost:3000/@fs/...`），`fileURLToPath` 随即抛 `URL must be of scheme file`。
 */
const packageDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 被测插件的构建产物入口；由覆盖补丁按绝对路径装载。 */
const pluginEntry = join(packageDir, 'lib/index.js')

/** 观察者条目；同样按绝对路径装载，所以是 `.mjs`。 */
const observerEntry = join(packageDir, 'tests/support/notice-observer.mjs')

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

/** 一次腿用例的收尾登记：`dispose` 按登记顺序**倒着**跑，后建的先拆。 */
export interface LegScope {
  add(cleanup: () => Promise<void> | void): void
  dispose(): Promise<void>
}

/**
 * 开一个收尾作用域。
 * @returns 登记与拆除入口。
 */
export function createLegScope(): LegScope {
  const cleanups: (() => Promise<void> | void)[] = []
  return {
    add: (cleanup) => { cleanups.push(cleanup) },
    dispose: async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    },
  }
}

/** 一次腿用例的前置。 */
export interface NavigatorLeg {
  /** 临时 DSH home；settings.yaml 已把 deepseek 适配器切到 chat-completions，与 mock 的 SSE 帧对上。 */
  readonly home: string
  /** 观察者落 notice 的文件。 */
  readonly noticesFile: string
  /** 覆盖补丁路径。 */
  readonly patch: string
  /** 脚本化模型服务。 */
  readonly model: MockModelServer
}

/**
 * 装一次腿用例的前置：临时 home、navigator 覆盖补丁、观察者条目与脚本化 mock 模型。触发间隔固定为 1，
 * 让第一次复核落在第 2 步（第 1 步由脚本用工具调用撑住）。home 与 mock 的收尾登记进 `scope`。
 * @param prefix - 临时目录前缀，便于失败时认出是哪条腿。
 * @param review - 复核请求的答复结论。
 * @param scope - 本用例的收尾作用域。
 * @returns 前置的各个句柄。
 */
export async function mountNavigatorLeg(
  prefix: string,
  review: Record<string, unknown>,
  scope: LegScope,
): Promise<NavigatorLeg> {
  const home = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n')
  const noticesFile = join(home, 'notices.jsonl')
  const patch = join(home, 'navigator.patch.yml')
  writeFileSync(patch, stringify([{
    insert: [
      { id: 'navigator', name: pluginEntry, config: { triggerEverySteps: 1 } },
      { id: 'notice-observer', name: observerEntry, config: { file: noticesFile } },
    ],
  }]))
  const model = await startMockModel(navigatorLegScript(review))
  scope.add(() => model.close())
  scope.add(() => { rmSync(home, { recursive: true, force: true }) })
  return { home, noticesFile, patch, model }
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
