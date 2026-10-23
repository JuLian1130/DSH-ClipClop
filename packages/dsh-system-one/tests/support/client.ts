/**
 * 浏览器半夹具：真 `Context` + 四个服务替身（`slots` / `locale` / `configForms` / `remote.credentials`），把
 * `apply` 注册出来的条目与它注入的业务面留给用例。
 *
 * 只替服务面、不替输入：槽位注册、`whileServed` 的 served 集合、settings section 的当前值与写入路径，以及
 * 凭据域的写入都按发布契约的形状提供——所以「密钥进凭据域、不进配置」「只写 volatile 路径」这些判据在这一层
 * 直接观察得到，不需要真宿主。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Entry } from '../../src/config.ts'
import * as client from '../../src/client/index.ts'
import { zh, type SystemOneLocaleKey } from '../../src/client/locales.ts'

/** 本插件的 settings section 值。 */
export interface StubSection {
  entries?: readonly Entry[]
}

/** 一次原子写入里的一个字段操作（形状与 settings 的 `SettingsPathOpView` 一致）。 */
export interface StubSettingOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** settings section 的替身：记账写入、可切换「宿主是否接受」。 */
export class StubForm {
  entries: readonly Entry[] = []
  /** 按顺序记下每一次原子写入：每个元素是一组 op（整份 `entries` 一次写入）。 */
  mutations: StubSettingOp[][] = []
  /** 宿主是否接受写入；置为 false 即模拟业务拒绝（`mutate` resolve false）。 */
  accepted = true
  /** 置为 true 即模拟传输层失败：`mutate` 直接 reject。 */
  throwOnMutate = false
  private readonly listeners = new Set<() => void>()

  getSnapshot(): {
    status: 'ready', value: StubSection, base: undefined, user: undefined
    revision: number, writable: boolean, mode: 'host'
  } {
    return {
      status: 'ready',
      value: { entries: this.entries },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 一次原子写入：全部 op 要么一起生效、要么一条都不生效（与宿主的语义一致）。
   * @param ops - 按顺序的字段操作。
   * @returns 宿主是否接受。
   */
  async mutate(ops: readonly StubSettingOp[]): Promise<boolean> {
    this.mutations.push(ops.map(op => ({ ...op, path: [...op.path] })))
    if (this.throwOnMutate) throw new Error('fixture: settings.mutate transport failure')
    if (!this.accepted) return false
    for (const op of ops) {
      if (op.path[0] !== 'entries') throw new Error(`fixture: unexpected setting path ${op.path.join('.')}`)
      if (op.op === 'set') this.entries = op.value as readonly Entry[]
    }
    for (const listener of [...this.listeners]) listener()
    return true
  }

  /** 按发布契约把它当 `ConfigForm` 交出（夹具不需要 `ConfigForm` 的全部成员）。 */
  asConfigForm(): ConfigForm<StubSection> {
    return this as unknown as ConfigForm<StubSection>
  }
}

/** 凭据域的替身：记账写入、可切换「宿主是否接受」。 */
export class StubCredentials {
  /** 按顺序记下每一次写入；`value` 就是密钥本身（真宿主只进不出，夹具要看得见才断言得到）。 */
  writes: Array<{ ref: string, value: string }> = []
  /** 置为 true 即模拟宿主拒绝这次写入。 */
  refuse = false

  /**
   * 写一个引用名的值。
   * @param ref - 引用名。
   * @param value - 密钥。
   */
  async set(ref: string, value: string): Promise<void> {
    this.writes.push({ ref, value })
    if (this.refuse) throw new Error('credentials.set refused')
  }
}

/** 一条被捕获的槽位注册。 */
export interface CapturedEntry {
  readonly options: {
    readonly name: string
    readonly id?: string
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
  readonly form: StubForm
  readonly credentials: StubCredentials
  /** 按顺序记下 `whileServed` 声明的命名空间。 */
  readonly served: readonly (readonly string[])[]
  /** 文案读取器（照 `ctx.locale.bind(NS)` 的形状）。 */
  readonly t: (key: SystemOneLocaleKey) => string
  /** 某一个槽位当前的注册条目。 */
  entries(slot: string): readonly CapturedEntry[]
  dispose(): Promise<void>
}

/**
 * 装出一份浏览器半。
 * @returns 夹具与注册表。
 */
export async function mountClient(): Promise<ClientFixture> {
  const form = new StubForm()
  const credentials = new StubCredentials()
  const entries = new Map<string, CapturedEntry[]>()
  const served: Array<readonly string[]> = []
  const slots = {
    inject: (slot: string, register: () => () => void) => register(),
    register: (options: CapturedEntry['options'], component: unknown) => {
      const list = entries.get(options.name) ?? []
      list.push({ options, component })
      entries.set(options.name, list)
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key: SystemOneLocaleKey) => zh[key],
  }
  const configForms = {
    get: () => form.asConfigForm(),
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
      served.push(namespaces)
      return register(new Set(namespaces))
    },
  }
  // `ctx.remote.<ns>` 读的是 remote 服务值上的属性，而 inject 的 `'remote.<ns>'` 走 cordis 的扁平服务名——
  // 两条路都要给（与 `dsh-reasoning-pruner` / `dsh-result-clipper` 的浏览器半夹具同一写法）。
  const remote = { credentials }
  const ctx = new Context()
  ctx.reflect.provide('slots', slots)
  ctx.reflect.provide('locale', locale)
  ctx.reflect.provide('configForms', configForms)
  ctx.reflect.provide('remote', remote)
  ctx.reflect.provide('remote.credentials', credentials)
  await ctx.plugin({ inject: [...client.inject], apply: client.apply as (ctx: Context) => void })
  return {
    form,
    credentials,
    served,
    t: (key) => zh[key],
    entries: (slot) => entries.get(slot) ?? [],
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
