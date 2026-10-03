/**
 * 浏览器半夹具：真 `Context` + 三个服务替身（`slots` / `locale` / `configForms`），把 `apply` 注册出来的
 * 条目与它注入的业务面留给用例。
 *
 * 只替服务面、不替输入：槽位注册、`whileServed` 的 served 集合、settings section 的当前值与写入路径都按发布
 * 契约的形状提供，所以「两个开关注册在哪、点了开关写什么」是这一层能直接观察到的行为。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as client from '../../src/client/index.ts'
import type { ResultClipperLocaleKey } from '../../src/client/locales.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ReasoningEffort } from '../../src/reasoning.ts'

/** 本插件的 settings section 值。 */
export interface StubSection {
  summarize: boolean
  privacyGate: boolean
  admissionJudge: boolean
  debug: boolean
  dryRun: boolean
  debugPath: string
  routeProvider: string
  routeModel: string
  admissionProvider: string
  admissionModel: string
  privacyProvider: string
  privacyModel: string
  minInlineTokens: number
  maxSummarizeTokens: number
  summaryReasoningEffort: ReasoningEffort
  admissionReasoningEffort: ReasoningEffort
  privacyReasoningEffort: ReasoningEffort
  privacyConfirmedLocal: boolean
  failurePolicy: 'passthrough' | 'block'
  summaryPrompt: string
  admissionPrompt: string
  privacyPrompt: string
}

/** section 缺席时控件读到的默认值（与 host 半 schema 的默认一致）。 */
export const SECTION_DEFAULTS: StubSection = {
  summarize: false,
  privacyGate: false,
  admissionJudge: false,
  debug: false,
  dryRun: false,
  debugPath: '',
  routeProvider: '',
  routeModel: '',
  admissionProvider: '',
  admissionModel: '',
  privacyProvider: '',
  privacyModel: '',
  minInlineTokens: 1024,
  maxSummarizeTokens: 12500,
  summaryReasoningEffort: 'off',
  admissionReasoningEffort: 'off',
  privacyReasoningEffort: 'off',
  privacyConfirmedLocal: false,
  failurePolicy: 'passthrough',
  summaryPrompt: '',
  admissionPrompt: '',
  privacyPrompt: '',
}

/** settings section 的替身：记账写入、可切换「Host 是否接受」。 */
export class StubForm {
  value: StubSection = { ...SECTION_DEFAULTS }
  /** 按顺序记下每一次写入。 */
  writes: Array<{ field: string; value: unknown }> = []
  /** 按顺序记下每一次字段清空（恢复默认走的是它）。 */
  resets: string[] = []
  /** Host 是否接受写入；置为 false 即模拟业务拒绝。 */
  accepted = true
  private readonly listeners = new Set<() => void>()

  getSnapshot(): {
    status: 'ready', value: StubSection, base: undefined, user: undefined
    revision: number, writable: boolean, mode: 'host'
  } {
    return { status: 'ready', value: this.value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<boolean> {
    this.writes.push({ field, value })
    if (!this.accepted) return false
    this.value = { ...this.value, [field]: value }
    this.#publish()
    return true
  }

  async unset(field: string): Promise<boolean> {
    this.resets.push(field)
    if (!this.accepted) return false
    this.value = { ...this.value, [field]: SECTION_DEFAULTS[field as keyof StubSection] }
    this.#publish()
    return true
  }

  #publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** 按发布契约把它当 `ConfigForm` 交出（夹具不需要 `ConfigForm` 的全部成员）。 */
  asConfigForm(): ConfigForm<StubSection> {
    return this as unknown as ConfigForm<StubSection>
  }
}

/** 一条被捕获的槽位注册。 */
export interface CapturedEntry {
  readonly slot: string
  readonly options: {
    readonly name: string
    readonly id?: string
    /** keyed 槽位的键（`plugins.bundle.config` 用包名）。 */
    readonly key?: string
    readonly order?: number
    readonly label?: string | (() => string)
    readonly locale?: string
    /** 注册者注入的业务面工厂（`slots.register` 的 `options.inject`）。 */
    readonly inject?: (() => unknown) | undefined
  }
  readonly component: unknown
}

/** 装好的一份浏览器半夹具。 */
export interface ClientFixture {
  readonly ctx: Context
  /** 当前语言下的文案读取器（照 `ctx.locale.bind(NS)` 的形状）。 */
  readonly t: (key: ResultClipperLocaleKey) => string
  /** 某一个槽位当前的注册条目。 */
  entries(slot: string): readonly CapturedEntry[]
  /** 切到另一种语言；页签名与描述是 thunk，会跟着变。 */
  setLocale(next: 'zh' | 'en'): void
  dispose(): Promise<void>
}

/**
 * 装出一份浏览器半。
 * @returns 夹具、settings 表单替身与注册表。
 */
export async function mountClient(): Promise<ClientFixture & { readonly form: StubForm }> {
  const configFormsEntry = new StubForm()
  const entries = new Map<string, CapturedEntry[]>()
  let active: 'zh' | 'en' = 'zh'
  const slots = {
    inject: (slot: string, register: () => () => void) => register(),
    register: (options: CapturedEntry['options'], component: unknown) => {
      const list = entries.get(options.name) ?? []
      list.push({ slot: options.name, options, component })
      entries.set(options.name, list)
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key: ResultClipperLocaleKey) => (active === 'zh' ? zh : en)[key],
  }
  const configForms = {
    get: () => configFormsEntry.asConfigForm(),
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
      register(new Set(namespaces)),
  }
  const ctx = new Context()
  ctx.reflect.provide('slots', slots)
  ctx.reflect.provide('locale', locale)
  ctx.reflect.provide('configForms', configForms)
  await ctx.plugin({ inject: [...client.inject], apply: client.apply as (ctx: Context) => void })
  return {
    ctx,
    form: configFormsEntry,
    t: (key) => (active === 'zh' ? zh : en)[key],
    entries: (slot) => entries.get(slot) ?? [],
    setLocale: (next) => { active = next },
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
