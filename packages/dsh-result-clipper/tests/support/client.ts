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

/** 本插件的 settings section 值。 */
export interface StubSection {
  summarize: boolean
  ruleSummary: boolean
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
  summaryReasoningEffort: string
  admissionReasoningEffort: string
  privacyReasoningEffort: string
  privacyConfirmedLocal: boolean
  failurePolicy: 'passthrough' | 'block'
  summaryPrompt: string
  admissionPrompt: string
  privacyPrompt: string
}

/** section 缺席时控件读到的默认值（与 host 半 schema 的默认一致）。 */
export const SECTION_DEFAULTS: StubSection = {
  summarize: false,
  // 规则摘要默认关闭（与 host 半 schema 的默认一致）：默认只摘要主模型主动请求摘要的调用。
  ruleSummary: false,
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
  // 档位默认留空＝「不推理」，具体发哪个 id 由该 route 的档位表在请求前决定。
  summaryReasoningEffort: '',
  admissionReasoningEffort: '',
  privacyReasoningEffort: '',
  privacyConfirmedLocal: false,
  failurePolicy: 'passthrough',
  summaryPrompt: '',
  admissionPrompt: '',
  privacyPrompt: '',
}

/** 一次原子写入里的一个字段操作（形状与 settings 的 `SettingsPathOpView` 一致）。 */
export interface StubSettingOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** settings section 的替身：记账写入、可切换「Host 是否接受」。 */
export class StubForm {
  value: StubSection = { ...SECTION_DEFAULTS }
  /** 按顺序记下每一次**单字段**写入（页签的开关走 `set`）。 */
  writes: Array<{ field: string; value: unknown }> = []
  /** 按顺序记下每一次字段清空（`unset`）。 */
  resets: string[] = []
  /** 按顺序记下每一次**原子写入**：每个元素是一组 op（配置区的分组保存走 `mutate`）。 */
  mutations: StubSettingOp[][] = []
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

  /**
   * 一次原子写入：全部 op 要么一起生效、要么一条都不生效（与 Host 的语义一致——被拒时整组不写）。
   * @param ops - 按顺序的字段操作。
   * @returns Host 是否接受。
   */
  async mutate(ops: readonly StubSettingOp[]): Promise<boolean> {
    this.mutations.push(ops.map(op => ({ ...op, path: [...op.path] })))
    if (!this.accepted) return false
    const next = { ...this.value }
    for (const op of ops) {
      const field = op.path[0] as keyof StubSection
      next[field] = (op.op === 'set' ? op.value : SECTION_DEFAULTS[field]) as never
    }
    this.value = next
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

/** 目录夹具里一个 provider 分组：与 `session.modelCatalog()` 返回的 `groups` 同形。 */export interface StubCatalogProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly {
    readonly id: string
    readonly name: string
    /** 该模型声明的推理档位；不给＝它不提供推理档位（与目录里 `reasoning` 缺席同义）。 */
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string }[]
      readonly defaultEffort?: string
    }
  }[]
}

/** 默认目录里各模型声明的档位；`none` 这一支与 cline-pass 的词汇表同形。 */
const EFFORTS_NONE_LOW_MEDIUM_HIGH = [
  { id: 'none', name: 'None' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
] as const

/** 默认目录：一条 route 两个模型——用例要看「候选来自 DSH 目录」时用得上，也可以整份换掉。 */
export const CATALOG_DEFAULT: readonly StubCatalogProvider[] = [
  {
    id: 'local', name: '本地 route',
    // 档位按 DSH 目录的形状声明（真实目录里 `reasoning` 缺席＝该模型不提供推理档位，所以这里要声明，
    // 否则卡片会把这两条模型画成"不提供档位"）。
    models: [
      { id: 'qwen3', name: 'Qwen3', reasoning: { efforts: EFFORTS_NONE_LOW_MEDIUM_HIGH } },
      { id: 'llama3', name: 'Llama3', reasoning: { efforts: EFFORTS_NONE_LOW_MEDIUM_HIGH } },
    ],
  },
  { id: 'remote', name: '远端 route', models: [{ id: 'big-model', name: 'Big Model', reasoning: { efforts: EFFORTS_NONE_LOW_MEDIUM_HIGH } }] },
]

/**
 * 装出一份浏览器半。
 * @param catalog - 模型目录替身给出的 provider 分组；默认 {@link CATALOG_DEFAULT}。
 * @returns 夹具、settings 表单替身与注册表。
 */
export async function mountClient(
  catalog: readonly StubCatalogProvider[] = CATALOG_DEFAULT,
): Promise<ClientFixture & { readonly form: StubForm, readonly catalogCalls: () => number }> {
  const configFormsEntry = new StubForm()
  const entries = new Map<string, CapturedEntry[]>()
  let active: 'zh' | 'en' = 'zh'
  let catalogCalls = 0
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
  // `ctx.remote.<ns>` 读的是 remote 服务值上的属性，而 inject 的 `'remote.<ns>'` 走 cordis 的扁平服务名——
  // 两条路都要给（与 `dsh-reasoning-pruner` 的浏览器半夹具同一写法）。
  const session = {
    modelCatalog: async () => {
      catalogCalls += 1
      return { ok: true, value: { groups: catalog } }
    },
  }
  const remote = { session }
  const ctx = new Context()
  ctx.reflect.provide('slots', slots)
  ctx.reflect.provide('locale', locale)
  ctx.reflect.provide('configForms', configForms)
  ctx.reflect.provide('remote', remote)
  ctx.reflect.provide('remote.session', session)
  await ctx.plugin({ inject: [...client.inject], apply: client.apply as (ctx: Context) => void })
  return {
    ctx,
    form: configFormsEntry,
    t: (key) => (active === 'zh' ? zh : en)[key],
    entries: (slot) => entries.get(slot) ?? [],
    setLocale: (next) => { active = next },
    catalogCalls: () => catalogCalls,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
