/**
 * Web 腿（票据 12 第 1 条）的自建客户端渲染夹具：在 jsdom 里用**发布态**客户端包把真实会话装配成对话
 * 视图，断言那条「上下文注入」折叠行出现、展开后含正文。
 *
 * **为什么自建**：DSH 官方的客户端测试设施 `@deepseek-ai/dsh-client-test-runtime` 从 registry 装下来
 * 不可用——它的 `lib/index.js` 静态 import 了未随包发布的 `@deepseek-ai/dsh-client-ui-renderer/src/...`
 * 等路径（发布清单不带 `src`）。这里按发布态的模块形态自己装：客户端 bundle 走
 * `window.__ModuleLoader__.load({ id, factory })`，用 `readFileSync` + `new Function` 求值，再复刻生产的
 * `stripClientSuffix` 让 `@deepseek-ai/x/client` 与 `@deepseek-ai/x` 命中同一个 factory；渲染器、槽位与
 * 会话、对话、聊天四层用它们真正的 `apply`。
 *
 * **重载语义**：`bootConversation` 每次调用都重建模块注册表、cordis context、会话绑定与事件源，事件从
 * 调用方给的那份持久化条目列表读入——所以用例读两次文件、装配两次，就是「重新装配后再断」。
 *
 * 读数选择器（与 DSH 客户端自身的行实现同名）：`[data-disclosure-row="true"]`（折叠行，未展开时
 * `aria-expanded="false"`）、`[data-context-summary]`（折叠行上那行字）、`[data-context-injection-body]`
 * （展开后的正文，带 `data-context-form`）。
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { act, render } from '@testing-library/react'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as cordis from '@deepseek-ai/cordis'
import * as store from '@deepseek-ai/dsh-client-store'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const nodeRequire = createRequire(import.meta.url)

/** 客户端装配吃的一条历史条目；本夹具只喂持久事件，不喂 transient 帧。 */
export interface ClientSessionEntry {
  readonly type: 'event'
  readonly event: SessionEvent
}

/** 装好并渲染出来的对话视图。 */
export interface BootedConversation {
  /** 渲染容器；选择器读数都从它取。 */
  readonly container: HTMLElement
  /** 卸载并释放这次装配的 context。 */
  readonly dispose: () => Promise<void>
}

/** 发布态客户端 bundle，按依赖顺序装载。 */
const CLIENT_BUNDLES = [
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-session/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-chat/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-api-gateway/client',
  '@deepseek-ai/dsh-api-session-controller/client',
] as const

/** 客户端 bundle 通过 `require` 拿到的平台模块；不在表里的一律走 bundle 注册表。 */
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

/** 复刻生产模块系统的 `stripClientSuffix`：`@deepseek-ai/x/client` 与 `@deepseek-ai/x` 是同一份。 */
function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/**
 * 每次装配一份全新的模块表：bundle 源文件重新求值，模块缓存清空——与页面重载同义。
 * @returns 按 id 取模块的 require。
 */
function loadClientModules(): (spec: string) => unknown {
  const registry = new Map<string, (req: (id: string) => unknown) => unknown>()
  const cache = new Map<string, unknown>()
  const globals = globalThis as unknown as { window: { __ModuleLoader__?: unknown } }
  globals.window.__ModuleLoader__ = {
    load(registration: { id: string, factory: (req: (id: string) => unknown) => unknown }) {
      registry.set(registration.id, registration.factory)
    },
  }
  for (const spec of CLIENT_BUNDLES) {
    const source = readFileSync(nodeRequire.resolve(spec), 'utf8')
    new Function('window', 'document', source)(globals.window, globalThis.document)
  }
  const externals = platformExternals()
  const load = (spec: string): unknown => {
    if (spec in externals) return externals[spec]
    const id = stripClientSuffix(spec)
    if (cache.has(id)) return cache.get(id)
    const factory = registry.get(id)
    if (factory === undefined) throw new Error(`no client bundle registered for ${JSON.stringify(id)}`)
    const shell: { exports: unknown } = { exports: {} }
    cache.set(id, shell.exports)
    cache.set(id, factory(load) ?? shell.exports)
    return cache.get(id)
  }
  return load
}

/** 客户端插件模块只用到 `apply` 与 `inject`；缺任一项说明装错了 bundle，直接报错而不是把 undefined 传下去。 */
interface ClientPlugin {
  readonly inject: readonly string[]
  readonly apply: (ctx: never, config: never) => void
}

/**
 * 取一个客户端插件模块，并核对它的两个具名导出。
 * @param load - 本次装配的模块加载器。
 * @param id - bundle id。
 * @returns 插件模块。
 */
function clientPlugin(load: (spec: string) => unknown, id: string): ClientPlugin {
  const module = load(id) as Partial<ClientPlugin>
  if (typeof module.apply !== 'function' || !Array.isArray(module.inject)) {
    throw new Error(`client bundle ${JSON.stringify(id)} exports no apply/inject`)
  }
  return module as ClientPlugin
}

/** 固定的可观察读数：夹具的服务替身只被读一次快照，不需要推送。 */
function observable<T>(read: () => T): { getSnapshot: () => T, subscribe: () => () => void } {
  return { getSnapshot: read, subscribe: () => () => {} }
}

/**
 * 用一份已持久化的会话事件列表装配并渲染对话视图。
 * @param sessionId - 会话 id；装配与绑定都按它取。
 * @param entries - 会话历史条目，按 seq 升序。
 * @returns 渲染容器与释放入口。
 */
export async function bootConversation(
  sessionId: string,
  entries: readonly ClientSessionEntry[],
): Promise<BootedConversation> {
  const load = loadClientModules()
  const renderer = clientPlugin(load, '@deepseek-ai/dsh-client-ui-renderer')
  const uiSession = clientPlugin(load, '@deepseek-ai/dsh-client-ui-session')
  const uiConversation = clientPlugin(load, '@deepseek-ai/dsh-client-ui-conversation')
  const locale = clientPlugin(load, '@deepseek-ai/dsh-client-locale')
  const chat = clientPlugin(load, '@deepseek-ai/dsh-client-ui-chat')
  const sessionController = load('@deepseek-ai/dsh-api-session-controller') as {
    MutableSessionEventSource: new () => { replace: (entries: readonly ClientSessionEntry[], hasMore: boolean) => void }
  }

  const ctx = new cordis.Context() as never as {
    plugin: (plugin: unknown) => { await: () => Promise<unknown> }
    provide: (name: string, value: unknown) => void
    slots: { register: (options: unknown, component: unknown) => unknown, renderSlot: (name: string, props: object) => React.ReactNode }
    fiber: { dispose: () => Promise<void> }
  }
  await ctx.plugin({ inject: [], apply: renderer.apply }).await()

  // 真实的会话事件源：feed 由持久化条目重新播种——这就是「会话重载」重放的输入。
  const eventSource = new sessionController.MutableSessionEventSource()
  eventSource.replace(entries, false)

  const sessionSnapshot = {
    sessionId,
    pendingSubmissions: [],
    queue: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
  }
  const sessionFace = {
    sessionId,
    ...observable(() => sessionSnapshot),
    loadOlder: async () => {},
    loadThrough: async () => {},
    projections: { faceOf: () => observable(() => undefined), set: () => {} },
  }
  const binding = { sessionId, session: sessionFace, eventSource, ctx: { effect: () => () => {}, get: () => undefined } }
  const reference = { sessionId, binding, ready: Promise.resolve(binding), release: () => {} }
  const listState = {
    phase: 'ready',
    current: sessionId,
    byId: { [sessionId]: { id: sessionId, displayTitle: 'fixture', blank: false, origin: 'user' } },
  }
  const services: Record<string, unknown> = {
    sessions: {
      list: observable(() => listState),
      binding: (id: unknown) => (id === sessionId ? binding : undefined),
      scope: () => undefined,
    },
    remote: { $on: () => () => {}, call: async () => undefined },
    'remote.session': {},
    'remote.commands': {},
    'remote.subagents': {},
    settingsScope: { bind: () => observable(() => ({ value: { preference: 'zh' }, set: () => {} })) },
    fileUpload: { upload: async () => { throw new Error('web leg fixture: file upload is not stubbed') } },
    uiWorkspace: { openSession: () => {}, openWorkspace: async () => {} },
    sidebarRight: { openResource: () => {} },
    connection: {},
    typert: {},
  }
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
  for (const plugin of [locale, uiSession, uiConversation, chat]) {
    await ctx.plugin({ inject: plugin.inject, apply: plugin.apply }).await()
  }

  /** 根框架：渲染器把 `renderSlot` 与 `SessionProvider` 作为 props 交给它。 */
  const Frame = (props: {
    renderSlot: (slot: string, options: object, filter?: object) => React.ReactNode
    SessionProvider: React.ComponentType<{ session: unknown, children?: React.ReactNode }>
  }) => React.createElement(
    props.SessionProvider,
    { session: reference },
    props.renderSlot(
      'conversation.view',
      { viewRequest: null, openView: () => {}, completeViewRequest: () => {} },
      { only: 'chat' },
    ),
  )
  await ctx.slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } }, Frame)

  let view: { container: HTMLElement, unmount: () => void } | undefined
  await act(async () => {
    view = render(React.createElement(React.Fragment, null, ctx.slots.renderSlot('root', {})))
  })
  const mounted = view
  if (mounted === undefined) throw new Error('web leg fixture: the conversation view did not render')
  return {
    container: mounted.container,
    dispose: async () => {
      mounted.unmount()
      await ctx.fiber.dispose()
    },
  }
}
