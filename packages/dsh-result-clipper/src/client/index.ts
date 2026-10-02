/**
 * dsh-result-clipper 的浏览器半：把两项能力开关与 debug 开关注册成「设置 → 内置插件」里的一个页签，并把
 * debug 日志路径注册成插件详情卡片上的一个参数。
 *
 * 座位分两处的依据是设计文档「配置面与设置座位」：开关在插件页签，参数在插件自己的详情卡片；两处都经
 * `ctx.configForms.get(ns)` 取得同一个 settings 命名空间（命名空间 = profile patch 行的 `id`，本插件的入口
 * `name`，不是包名）。
 *
 * 当前值与写回全走 `ctx.configForms`：`getSnapshot()` 读、`set(field, value)` 写；`set` 在 Host 拒绝时
 * **resolve `false`**（不是 reject、也不抛），所以失败态由各控件在 await 之后核验返回值置位。注册包在
 * `whileServed([...])` 里：宿主从未 serve 该命名空间的部署不显示这两处，否则会出现没有写入目标的死页。
 *
 * 产物形状（CJS 闭包工厂）与打包步骤见 `scripts/build-client.mjs`；`import type` 一律只进类型图，产物里
 * 除平台模块外没有别的跨包值依赖。
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
// 类型专用：`plugins.item` 槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ResultClipperCard } from './card.tsx'
import { en, zh, type ResultClipperLocaleKey } from './locales.ts'
import { ResultClipperTab, type ResultClipperToggle } from './tab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本页签与卡片的文案字典。 */
    'resultClipper': ResultClipperLocaleKey
  }
}

/** settings 命名空间 = profile patch 行的 `id`（也是 host 半的入口 `name`）。 */
export const PREFERENCE_NAMESPACE = 'dsh-result-clipper'

/** 本页签在 `settings.plugins.tab` 里的注册 id。 */
const TAB_ID = 'result-clipper'

/** 本页签的排序位。 */
const TAB_ORDER = 30

/** 本卡片在 `plugins.item` 里的注册 id：插件管理器按它把这个 `plugins.item` 与插件本体对上。 */
const CARD_ID = PREFERENCE_NAMESPACE

/** 本卡片的排序位。 */
const CARD_ORDER = 50

/** 本插件在客户端 locale 里的字典命名空间。 */
const LOCALE_NAMESPACE = 'resultClipper'

/** 本命名空间在浏览器侧的形状（只声明本半读到的键）。 */
interface PreferenceSection {
  summarize: boolean
  privacyGate: boolean
  debug: boolean
  debugPath: string
}

/** 注册这两处所需的客户端服务（host 服务不在其中——它们在 host 半）。 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * 注册页签与详情卡片。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-result-clipper: dictionaries')
  // 页签名与卡片名是 thunk：内置插件那一节与插件管理器每次投影都重读它，所以语言切换不必重新注册。
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const form = ctx.configForms.get<PreferenceSection>(PREFERENCE_NAMESPACE)
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'settings.plugins.tab',
    () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: TAB_ID,
      order: TAB_ORDER,
      label: () => t('tab'),
      locale: LOCALE_NAMESPACE,
      inject: () => ({
        hooks: {
          summarize: booleanField(form, 'summarize'),
          privacyGate: booleanField(form, 'privacyGate'),
          debug: booleanField(form, 'debug'),
        },
        setToggle: (field: ResultClipperToggle, value: boolean) => form.set(field, value),
      }),
    }, ResultClipperTab),
  )), 'dsh-result-clipper: built-in plugins tab')
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'plugins.item',
    () => ctx.slots.register({
      name: 'plugins.item',
      id: CARD_ID,
      order: CARD_ORDER,
      label: () => t('title'),
      locale: LOCALE_NAMESPACE,
      inject: () => ({
        hooks: { debugPath: stringField(form, 'debugPath') },
        setDebugPath: (value: string) => form.set('debugPath', value),
      }),
    }, ResultClipperCard),
  )), 'dsh-result-clipper: plugin detail card')
}

/**
 * 一个布尔字段的读数：镜像还没给出 section 时回落到 schema 的默认（三个开关都默认关闭）。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @returns 供控件绑定的读数。
 */
function booleanField(
  form: ConfigForm<PreferenceSection>,
  field: 'summarize' | 'privacyGate' | 'debug',
): ObservableSnapshot<boolean> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? false,
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 一个字符串字段的读数：镜像还没给出 section 时回落到空串。
 * @param form - 本插件的 settings 表单。
 * @param field - 字段名。
 * @returns 供控件绑定的读数。
 */
function stringField(form: ConfigForm<PreferenceSection>, field: 'debugPath'): ObservableSnapshot<string> {
  return {
    getSnapshot: () => form.getSnapshot().value?.[field] ?? '',
    subscribe: (listener) => form.subscribe(listener),
  }
}
