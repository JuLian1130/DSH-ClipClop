/**
 * 浏览器半夹具：真 `Context` + 三个服务替身（`slots` / `locale` / `configForms`），把 `apply` 注册出来的页签与
 * 它注入的业务面留给用例。
 *
 * `configForms` 的替身按**命名空间**记账：每个命名空间各有一份值与一条写入路径，写入连同命名空间一起记下——
 * 「三件事写回自己的命名空间」「跨命名空间只读」这两条判据因此在这一层直接观察得到。写非 volatile 的字段
 * （`enabled`）会在这里就报错，而不是等到真宿主拒绝。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as client from '../../src/client/index.ts'
import { zh, type ChannelLocaleKey } from '../../src/client/locales.ts'

/** 一次原子写入里的一个字段操作（形状与 settings 的 `SettingsPathOpView` 一致）。 */
export interface StubSettingOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** 一次写入：写的是哪个命名空间、带了哪些操作。 */
export interface StubWrite {
  readonly namespace: string
  readonly ops: readonly StubSettingOp[]
}

/** 本页能写的三个字段；写别的（`enabled` 就不是 volatile）在这里直接报错。 */
const WRITABLE = new Set(['target', 'guidance', 'threshold'])

/** `configForms` 的替身：按命名空间存值、记账写入，可切换「宿主是否接受」与传输层失败。 */
export class StubForms {
  /** 按顺序记下每一次写入，连同命名空间。 */
  readonly writes: StubWrite[] = []
  /** 宿主是否接受写入；置为 false 即模拟业务拒绝（`mutate` resolve false）。 */
  accepted = true
  /** 置为 true 即模拟传输层失败：`mutate` 直接 reject。 */
  throwOnMutate = false
  /** 置为一个未 settle 的 promise 即模拟慢写回：`mutate` 等它 resolve 后再返回。 */
  hold: Promise<void> | null = null
  private readonly sections = new Map<string, Record<string, unknown> | undefined>()
  private readonly listeners = new Map<string, Set<() => void>>()

  /**
   * 换掉某个命名空间的值并通知订阅者（模拟宿主晚到、或外部改了配置）。
   * @param namespace - 命名空间。
   * @param value - 新值；`undefined` 表示快照还没到。
   */
  update(namespace: string, value: Record<string, unknown> | undefined): void {
    this.sections.set(namespace, value)
    for (const listener of [...(this.listeners.get(namespace) ?? [])]) listener()
  }

  /**
   * 按发布契约给某个命名空间一份表单。写入路径照宿主语义：一次写入全写或全不写。
   * @param namespace - 命名空间。
   * @returns 该命名空间的表单替身。
   */
  form<T>(namespace: string): ConfigForm<T> {
    return {
      getSnapshot: () => ({
        status: 'ready',
        value: this.sections.get(namespace) as T | undefined,
        revision: 1,
        writable: this.accepted,
      }),
      subscribe: (listener: () => void) => {
        const listeners = this.listeners.get(namespace) ?? new Set<() => void>()
        listeners.add(listener)
        this.listeners.set(namespace, listeners)
        return () => { listeners.delete(listener) }
      },
      mutate: async (ops: readonly StubSettingOp[]): Promise<boolean> => {
        this.writes.push({ namespace, ops: ops.map(op => ({ ...op, path: [...op.path] })) })
        if (this.hold !== null) await this.hold
        if (this.throwOnMutate) throw new Error('fixture: settings.mutate transport failure')
        if (!this.accepted) return false
        const next = { ...(this.sections.get(namespace) ?? {}) }
        for (const op of ops) {
          if (op.path.length !== 1 || !WRITABLE.has(op.path[0]!)) {
            throw new Error(`fixture: unexpected setting path ${op.path.join('.')} in ${namespace}`)
          }
          if (op.op === 'set') next[op.path[0]!] = op.value
        }
        this.update(namespace, next)
        return true
      },
    } as unknown as ConfigForm<T>
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
  readonly forms: StubForms
  /** 按顺序记下 `whileServed` 声明的命名空间。 */
  readonly served: readonly (readonly string[])[]
  /** 文案读取器（照 `ctx.locale.bind(NS)` 的形状）。 */
  readonly t: (key: ChannelLocaleKey) => string
  /** 某一个槽位当前的注册条目。 */
  entries(slot: string): readonly CapturedEntry[]
  dispose(): Promise<void>
}

/**
 * 装出一份浏览器半。
 * @returns 夹具与注册表。
 */
export async function mountClient(): Promise<ClientFixture> {
  const forms = new StubForms()
  const captured: CapturedEntry[] = []
  const served: Array<readonly string[]> = []
  const slots = {
    inject: (slot: string, register: () => () => void) => register(),
    register: (options: CapturedEntry['options'], component: unknown) => {
      captured.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key: ChannelLocaleKey) => zh[key],
  }
  const ctx = new Context()
  ctx.reflect.provide('slots', slots)
  ctx.reflect.provide('locale', locale)
  ctx.reflect.provide('configForms', {
    get: (namespace: string) => forms.form(namespace),
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
      served.push(namespaces)
      return register(new Set(namespaces))
    },
  })
  await ctx.plugin({ inject: [...client.inject], apply: client.apply as (ctx: Context) => void })
  return {
    forms,
    served,
    t: (key) => zh[key],
    entries: () => captured,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
