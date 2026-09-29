/**
 * 06 的浏览器侧夹具：按**发布态**客户端 bundle 的模块形态在 jsdom 里装配。
 *
 * **为什么自建**（照 navigator 的 `tests/support/client-conversation.ts` 同一形态，但不 import 它）：官方
 * 客户端测试设施 `@deepseek-ai/dsh-client-test-runtime` 从 registry 装下来不可用——它的产物静态 import 了
 * 未随包发布的 `src/**` 路径。这里按发布态装：bundle 走 `window.__ModuleLoader__.load({ id, factory })`，
 * 用 `readFileSync` + `new Function` 求值，再复刻生产的 `stripClientSuffix` 让 `@deepseek-ai/x/client` 与
 * `@deepseek-ai/x` 命中同一个 factory。
 *
 * 服务面是**替身**，但输入不是：`remote.settings` 桥到真的 settings 服务，`remote.llm` 给的是真
 * `listConfigurableProviders()` 的目录，`remote.session.modelCatalog()` 只提供目录加载所需的宿主目录形状
 * ——`ctx.modelDirectories.directoryFor(...)` 本身是真的 `ui-model-selection` 实现，置灰读的是它的
 * `current`（耐久投影的 `next`，缺 `next` 时回退 catalog 的 `default`）。
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { act, render } from '@testing-library/react'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as cordis from '@deepseek-ai/cordis'
import * as store from '@deepseek-ai/dsh-client-store'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import type { LlmConfigurableProvider, ModelCatalog, ModelSelectionProjection } from '@deepseek-ai/dsh-api-remotes/client'
// 类型专用：`ctx.slots` / `ctx.uiSession` / `ctx.modelDirectories` / `ctx.configForms` 的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ReasoningPrunerTabInjected } from '../../src/client/tab.tsx'
import type { SettingsWire, WireReply } from './settings-host.ts'

const nodeRequire = createRequire(import.meta.url)

/** 本插件的产物（被测对象）。 */
const PRUNER_CLIENT = '@dsh-clipclop/dsh-reasoning-pruner/client'

/** 按依赖顺序装载的发布态客户端 bundle。 */
const CLIENT_BUNDLES = [
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-session/client',
  '@deepseek-ai/dsh-client-ui-model-selection/client',
  PRUNER_CLIENT,
] as const

/** 平台模块（`PLATFORM_MODULES`）：bundle 的 `require` 从这张表里取。 */
function platformExternals(): Record<string, unknown> {
  return {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': store,
    '@deepseek-ai/dsh-client-ui-slots': slots,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
}

/** 复刻生产模块系统的 `stripClientSuffix`。 */
function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/** bundle 的闭包工厂形态。 */
export interface Registration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/** 客户端插件模块的两个具名导出。 */
interface ClientPlugin {
  readonly inject: readonly string[]
  readonly apply: (ctx: never, config: never) => void
}

/**
 * 每次装配一份全新的模块表：bundle 源文件重新求值、模块缓存清空——与页面重载同义。
 * @returns 按 id 取模块的 require。
 */
function loadClientModules(): (spec: string) => unknown {
  const registry = new Map<string, Registration['factory']>()
  const globals = globalThis as unknown as { window: { __ModuleLoader__?: unknown } }
  globals.window.__ModuleLoader__ = {
    load(registration: Registration) { registry.set(registration.id, registration.factory) },
  }
  for (const spec of CLIENT_BUNDLES) {
    const source = readFileSync(nodeRequire.resolve(spec), 'utf8')
    new Function('window', 'document', source)(globals.window, globalThis.document)
  }
  const externals = platformExternals()
  const cache = new Map<string, unknown>()
  const load = (spec: string): unknown => {
    if (spec in externals) return externals[spec]
    const id = stripClientSuffix(spec)
    if (cache.has(id)) return cache.get(id)
    const factory = registry.get(id)
    if (factory === undefined) throw new Error(`no client bundle registered for ${JSON.stringify(id)}`)
    const exports = factory(load)
    cache.set(id, exports)
    return exports
  }
  return load
}

/**
 * 挂一个客户端插件模块。模块的 `apply` 收 `(ctx, config)`，但客户端插件的配置来自模块表而不是这里的形参
 * ——按框架的挂载形态把第二参留给它，夹具只提供 `ctx`。
 * @param ctx - 客户端根 context。
 * @param plugin - 该 bundle 的具名导出。
 */
async function mount(ctx: Context, plugin: ClientPlugin): Promise<void> {
  await ctx.plugin({
    inject: [...plugin.inject],
    apply: plugin.apply as unknown as (ctx: Context) => void,
  }).await()
}

/** 取一个客户端插件模块并核对它的两个具名导出。 */
function clientPlugin(load: (spec: string) => unknown, id: string): ClientPlugin {
  const module = load(id) as Partial<ClientPlugin>
  if (typeof module.apply !== 'function' || !Array.isArray(module.inject)) {
    throw new Error(`client bundle ${JSON.stringify(id)} exports no apply/inject`)
  }
  return module as ClientPlugin
}

/** 固定的可观察读数：夹具的替身只被读快照，不需要推送。 */
function observable<T>(read: () => T): { getSnapshot: () => T, subscribe: () => () => void } {
  return { getSnapshot: read, subscribe: () => () => {} }
}

/**
 * 客户端 locale 的替身：够本插件用（`register` + `bind`），同时它就是渲染机要的 LocaleFace。字典按命名空间
 * 记账、`bind` 在调用时读当前语言，所以「页签名随语言切换」这条判据能在这个夹具上成立。
 * @returns 服务面、渲染面，以及切换当前语言的动作。
 */
function fixtureLocale(): {
  service: Record<string, unknown>
  face: { getSnapshot: () => { revision: number }, subscribe: () => () => void, bind: (ns: string) => (key: string) => string }
  setActive: (next: 'zh' | 'en') => void
} {
  const dictionaries = new Map<string, Record<'zh' | 'en', Record<string, string>>>()
  let active: 'zh' | 'en' = 'en'
  const bind = (ns: string) => (key: string) => {
    const dicts = dictionaries.get(ns)
    return dicts?.[active][key] ?? dicts?.en[key] ?? key
  }
  const face = { getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {}, bind }
  return {
    face,
    service: {
      ...face,
      register: (ns: string, dicts: Record<'zh' | 'en', Record<string, string>>) => {
        dictionaries.set(ns, dicts)
        return () => { dictionaries.delete(ns) }
      },
    },
    setActive: (next) => { active = next },
  }
}

/** 一条 slot 注册条目（观察面只用它的 `options.id` / `options.label` 与 `inject`）。 */
export interface SlotEntryLike {
  readonly options: { readonly id?: string, readonly label?: string | (() => string) }
  readonly inject?: ((...args: never[]) => unknown) | undefined
}

/** 装好的一页。 */
export interface ClientTabHarness {
  readonly ctx: Context
  /** 该 slot 当前的注册条目。 */
  entries(): readonly SlotEntryLike[]
  /** 注册面注入的业务面。 */
  injected(): ReasoningPrunerTabInjected
  /** 切到另一种界面语言（页签名的观察面用）。 */
  setLocaleActive(next: 'zh' | 'en'): void
  /** 渲染这一页并返回容器。 */
  render(): Promise<HTMLElement>
  /** 模拟 Host 推来的失效通知（真 wire 上 `settings/document-updated` 就是这么来的）。 */
  push(event: string): void
  dispose(): Promise<void>
}

/**
 * 在 jsdom 里装出「本插件的一页 + 它 inject 的全部客户端服务」。
 * @param options - 服务面的输入：settings 桥、真 provider 目录、catalog 形状、当前会话的耐久投影。
 * @returns 该装配的能力对象。
 */
export async function mountClientTab(options: {
  readonly settings: SettingsWire
  readonly providers: readonly LlmConfigurableProvider[]
  readonly catalog: ModelCatalog
  readonly projection?: ModelSelectionProjection | undefined
  readonly sessionId?: string | undefined
}): Promise<ClientTabHarness> {
  const load = loadClientModules()
  const renderer = clientPlugin(load, '@deepseek-ai/dsh-client-ui-renderer')
  const uiSettings = clientPlugin(load, '@deepseek-ai/dsh-client-ui-settings')
  const uiSession = clientPlugin(load, '@deepseek-ai/dsh-client-ui-session')
  const modelSelection = clientPlugin(load, '@deepseek-ai/dsh-client-ui-model-selection')
  const pruner = clientPlugin(load, PRUNER_CLIENT)

  const ctx = new Context()
  const sessionId = options.sessionId ?? 'session-1'
  const listState = {
    phase: 'ready',
    ids: [sessionId],
    byId: { [sessionId]: { id: sessionId, running: false, retainedBy: { mainView: 1 } } },
    projectionsBySession: {},
  }
  const projection = observable<ModelSelectionProjection | undefined>(() => options.projection)
  const binding = {
    sessionId,
    // `ui-session` 会在这个作用域 context 上挂 effect（binding 的 release）；夹具给一个只会记账的替身。
    ctx: { effect: () => () => {}, get: () => undefined },
    session: {
      sessionId,
      projections: { faceOf: (key: string) => key === 'modelSelection' ? projection : observable(() => undefined) },
    },
  }
  // `ctx.remote.<ns>` 读的是 remote 服务值上的属性（生产里由 remotes 插件挂命名空间代理），而 inject 的
  // `'remote.<ns>'` 走 cordis 的扁平服务名——两条路都要给。
  const llmRemote = { listConfigurableProviders: async () => ({ ok: true, value: options.providers }) }
  const sessionRemote = {
    modelCatalog: async () => ({ ok: true, value: options.catalog }),
    selectModel: async (): Promise<WireReply<never>> => ({ ok: false, error: { message: 'fixture: read-only' } }),
  }
  // `remote.$on` 记下订阅者，夹具用例可以模拟一次 Host 推送（真 wire 上文档变更就是推过来的）。
  const pushes = new Map<string, Set<() => void>>()
  const locale = fixtureLocale()
  const services: Record<string, unknown> = {
    sessions: {
      list: observable(() => listState),
      retainInfo: () => observable(() => ({ retainedBy: { mainView: 1 } })),
      binding: (id: unknown) => id === sessionId ? binding : undefined,
      // `directoryFor` 把作用域 effect 挂在这个 context 上；夹具用根 context 顶替（只为拿到 disposer）。
      scope: (id: unknown) => id === sessionId ? ctx : undefined,
      subagentAddress: () => undefined,
    },
    remote: {
      $host: { isLoopback: true },
      $on: (event: string, handler: () => void) => {
        const set = pushes.get(event) ?? new Set<() => void>()
        set.add(handler)
        pushes.set(event, set)
        return () => { set.delete(handler) }
      },
      call: async (): Promise<WireReply<never>> => ({ ok: false, error: { message: 'fixture: no transport' } }),
      settings: options.settings,
      llm: llmRemote,
      session: sessionRemote,
    },
    'remote.settings': options.settings,
    'remote.llm': llmRemote,
    'remote.session': sessionRemote,
    locale: locale.service,
    commandUi: { register: () => () => {} },
  }
  for (const [name, value] of Object.entries(services)) ctx.reflect.provide(name, value)

  for (const plugin of [renderer, uiSettings, uiSession, modelSelection]) await mount(ctx, plugin)
  // 渲染机的 `t` 座位由 locale 面backing：夹具在首次渲染前装上它（真装配里也是启动期装好）。
  ctx.slots.installLocale(locale.face)

  // 本插件先挂、持有者后声明 `settings.plugins.tab`——这是真装配里的另一种（更严的）顺序：宿主那一节何时
  // 挂载不由本插件决定，所以注册只能走 `ctx.slots.inject` 等声明上账。裸 `register` 在这份夹具上会抛
  // （未声明槽位），不会静默通过。
  await mount(ctx, pruner)

  // 内置插件那一节：声明并渲染 `settings.plugins.tab` 这个 additive list seat。
  await ctx.slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, (props: ComposedProps<'root', string, 'settings.plugins.tab', undefined, object>) =>
    React.createElement('div', { 'data-fixture': 'settings-plugins' }, props.renderSlot('settings.plugins.tab', {})))

  // 注册还包在 `whileServed` 里，所以它要等 settings 镜像真的 serve 了本插件的命名空间才出现——观察面因此
  // 是「镜像 ready 后」，不是 `apply` 同步返回时。
  await ctx.configForms.describe().ensure()

  let view: { container: HTMLElement, unmount: () => void } | undefined
  return {
    ctx,
    entries: () => ctx.slots.entries('settings.plugins.tab') as readonly SlotEntryLike[],
    injected: () => {
      const entry = ctx.slots.entries('settings.plugins.tab')[0] as SlotEntryLike | undefined
      if (entry?.inject === undefined) throw new Error('fixture: the pruner tab is not registered')
      return entry.inject() as ReasoningPrunerTabInjected
    },
    setLocaleActive: (next) => { locale.setActive(next) },
    push: (event: string) => {
      for (const handler of [...pushes.get(event) ?? []]) handler()
    },
    render: async () => {
      const mounted = await act(async () => render(React.createElement(React.Fragment, null, ctx.slots.renderSlot('root', {}))))
      view = mounted
      return mounted.container
    },
    dispose: async () => {
      view?.unmount()
      await ctx.fiber.dispose()
    },
  }
}

/** 一条 catalog 分组（夹具只提供加载所需的形状；置灰判据不读 `groups`）。 */
export function catalogOf(defaultSelection: ModelCatalog['default'], routes: readonly string[]): ModelCatalog {
  return {
    default: defaultSelection,
    routableProviders: [...routes],
    groups: routes.map(id => ({ id, name: id, models: [{ id: 'model-1', name: 'Model 1' }] })),
    failures: [],
  }
}

/** 一条耐久 modelSelection 投影。 */
export function projectionOf(next: ModelCatalog['default'] | null): ModelSelectionProjection {
  return { lastUsed: next, next }
}
