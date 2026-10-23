/**
 * dsh-system-one 的浏览器半：设置页里注册一个「决策模型」页签（`settings.plugins.tab`），管理 `entries` 的增删改。
 *
 * **命名空间写死为 `dsh-system-one`**：它是 profile patch 行的 id，也是 host 半的入口 `name`，还是设置页写回
 * 与 `whileServed` 的键——三者必须是同一个值（先例是 `dsh-reasoning-pruner` 的 `PREFERENCE_NAMESPACE`）。
 * 宿主从未 serve 该命名空间的部署不显示这一页，否则会出现没有写入目标的死页。
 *
 * **写回只有一条路**：`entries` 是整字段 volatile，页面把整份数组作为一次原子写回提交
 * （`{ op: 'set', path: ['entries'] }`）。本包没有别的可写字段，所以这条路径上不会出现非 volatile 的写入。
 *
 * **密钥不进配置**：保存时先把密钥写进凭据域（`ctx.remote.credentials.set`），拿到确认后才写配置，配置里只有
 * 引用名 `apiKeyEnv`——引用名的默认值是该条目的 `id`，所以 id 的字符集按凭据引用名的语法生成（见 `page.tsx`
 * 的 `newEntryId`）。凭据写失败就整次不保存，避免配置指向一个不存在的密钥。
 *
 * 产物形状（CJS 闭包工厂）与打包步骤见 `scripts/build-client.mjs`；`import type` 一律只进类型图，产物里除
 * 平台模块外没有别的跨包值依赖。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// 类型专用：`ctx.locale` 的 Context 合并与文案字典。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型专用：`ctx.configForms` 的 Context 合并、`ConfigForm` 类型与 `settings.plugins.tab` 槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型专用：`ctx.remote` 的 Context 合并与凭据域的客户端面。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Entry } from '../config.ts'
import { en, zh, type SystemOneLocaleKey } from './locales.ts'
import { EntriesPage, refOf, type EntryDraft, type SaveOutcome } from './page.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本页签的文案字典。 */
    'systemOne': SystemOneLocaleKey
  }
}

/** settings 命名空间 = profile patch 行的 `id`（也是 host 半的入口 `name`）。 */
export const PREFERENCE_NAMESPACE = 'dsh-system-one'

/** 页签在 `settings.plugins.tab` 里的注册 id。 */
const TAB_ID = 'system-one'

/** 页签的排序位：排在模型、插件清单这些内置页签之后。 */
const TAB_ORDER = 40

/** 本插件在客户端 locale 里的字典命名空间。 */
const LOCALE_NAMESPACE = 'systemOne'

/** 本命名空间在浏览器侧的形状（只声明本半读到的键）。 */
interface Section {
  entries?: readonly Entry[]
}

/** 注册这一页所需的客户端服务；凭据域缺席（profile 没装凭据子系统）时这一页根本不注册。 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * 一条草稿 → 配置里的一条。
 *
 * `apiKeyEnv` 只在「这次真写了密钥」或「条目本来就带引用名」时给出：空串在 schema 里就是"这个条目不使用
 * 凭据"，带上它会把这个不带密钥的条目变成"要用凭据却找不到"。
 * @param row - 页面上的一行。
 * @returns 配置里的条目（返回字面量的类型，才满足写回值 `JsonValue` 的索引签名要求）。
 */
function toEntry(row: EntryDraft) {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyEnv: row.key !== '' || row.apiKeyEnv !== '' ? refOf(row) : '',
  } satisfies Entry
}

/**
 * 注册这一页。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-system-one: dictionaries')
  // 页签名是 thunk：内置插件那一节每次投影都重读它，所以语言切换不必重新注册。
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const form: ConfigForm<Section> = ctx.configForms.get<Section>(PREFERENCE_NAMESPACE)
  const entries: ObservableSnapshot<Section | undefined> = {
    getSnapshot: () => form.getSnapshot().value,
    subscribe: listener => form.subscribe(listener),
  }
  /**
   * 保存整份条目：密钥先进凭据域，再把数组写回配置。
   *
   * 写回的两种失败都落成结果码：宿主拒绝时 `mutate` resolve `false`，传输层失败时它 **reject**——后者若不
   * 接住，页面上不会有任何提示，用户会以为已经保存。
   * @param rows - 页面上的全部行。
   * @returns 保存结果；不抛错（失败也是结果的一种）。
   */
  const saveRows = async (rows: readonly EntryDraft[]): Promise<SaveOutcome> => {
    for (const row of rows) {
      if (row.key === '') continue
      try {
        await ctx.remote.credentials.set(refOf(row), row.key)
      } catch {
        return 'credential'
      }
    }
    try {
      return await form.mutate([{ op: 'set', path: ['entries'], value: rows.map(toEntry) }]) ? 'saved' : 'refused'
    } catch {
      return 'refused'
    }
  }
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'settings.plugins.tab',
    () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: TAB_ID,
      order: TAB_ORDER,
      label: () => t('tab'),
      locale: LOCALE_NAMESPACE,
      inject: () => ({ hooks: { entries }, saveRows }),
    }, EntriesPage),
  )), 'dsh-system-one: entries page')
}
