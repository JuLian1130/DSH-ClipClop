/**
 * dsh-system-one-channel 的浏览器半：设置页里注册一个「决策通道」页签（`settings.plugins.tab`），管四件事——
 * 总开关、选当前条目、切引导档位、开/设可信度门槛。
 *
 * **两个命名空间都写死，不做推导**：写回的是本行 patch 的 id `dsh-system-one-channel`（也是宿主半的入口
 * `name`）；「当前条目」的选项跨命名空间**只读**接入层那一行 `dsh-system-one` 的 `entries`（先例是
 * `dsh-reasoning-pruner` 的客户端读 pi-ai 的命名空间）。跨命名空间写没有先例，不做。
 *
 * 页面只在**本行被 serve 之后**注册：本行没装时没有写入目标，页就是死页。接入层没装时选项为空、页面照常
 * 可用——另三项与它无关，而不是整页消失。
 *
 * 写入只有一条路：四项都是 volatile 字段，由页面合成一次 `mutate`（宿主对非 volatile 路径直接拒绝，所以
 * 页面上不会有第二种写入）。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`ctx.locale` 的 Context 合并与文案字典。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型专用：`ctx.configForms` 的 Context 合并与 `settings.plugins.tab` 槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type ChannelLocaleKey } from './locales.ts'
import { ChannelPage, type ChannelPatch, type ChannelSettings, type EntriesSection } from './page.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 通道页的文案字典。 */
    'systemOneChannel': ChannelLocaleKey
  }
}

/** 写回用的命名空间 = 本行 patch 的 `id`（也是宿主半的入口 `name`）。 */
export const PREFERENCE_NAMESPACE = 'dsh-system-one-channel'

/** 只读用的命名空间 = 接入层那一行的 `id`：它的 `entries` 是「当前条目」的选项来源。 */
export const ENTRIES_NAMESPACE = 'dsh-system-one'

/** 页签在 `settings.plugins.tab` 里的注册 id。 */
const TAB_ID = 'decision-channel'

/** 页签的排序位：紧跟接入层的条目页（40）之后。 */
const TAB_ORDER = 41

/** 本插件在客户端 locale 里的字典命名空间。 */
const LOCALE_NAMESPACE = 'systemOneChannel'

/** 注册这一页所需的客户端服务。没有 `remote`：本页不碰凭据域，也不发别的远程调用。 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * 一个表单 → 渲染机认的读数：值来自快照，订阅照原样转发。
 * @param form - 某个命名空间的共享表单。
 * @returns 该表单的当前值与订阅。
 */
function snapshot<T>(form: ConfigForm<T>): ObservableSnapshot<T | undefined> {
  return {
    getSnapshot: () => form.getSnapshot().value,
    subscribe: listener => form.subscribe(listener),
  }
}

/**
 * 注册这一页。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-system-one-channel: dictionaries')
  // 页签名是 thunk：内置插件那一节每次投影都重读它，所以语言切换不必重新注册。
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const settings = ctx.configForms.get<ChannelSettings>(PREFERENCE_NAMESPACE)
  const entries = ctx.configForms.get<EntriesSection>(ENTRIES_NAMESPACE)
  /**
   * 把这次改动的一项写回（页面每次只提交一项；门槛的开关与数值是同一个字段，一起写）。
   *
   * 宿主拒绝时 `mutate` resolve `false`，传输层失败时它 **reject**——后者若不接住，页面上不会有任何提示，
   * 使用者会以为已经生效（承接方按结果与异常各报一句话）。
   * @param patch - 这一页能改的四项，只含这次改动的那一项。
   * @returns 宿主是否接受；不抛错（失败也是结果的一种）。
   */
  const save = async (patch: ChannelPatch): Promise<boolean> => {
    const ops: SettingsPathOpView[] = []
    if (patch.enabled !== undefined) ops.push({ op: 'set', path: ['enabled'], value: patch.enabled })
    if (patch.target !== undefined) ops.push({ op: 'set', path: ['target'], value: patch.target })
    if (patch.guidance !== undefined) ops.push({ op: 'set', path: ['guidance'], value: patch.guidance })
    if (patch.threshold !== undefined) {
      // 门槛是整字段 volatile：开关与数值必须一起写，否则打开开关却留下一个旧数值。
      ops.push({ op: 'set', path: ['threshold'], value: { enabled: patch.threshold.enabled, value: patch.threshold.value } })
    }
    try {
      return await settings.mutate(ops)
    } catch {
      return false
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
      inject: () => ({ hooks: { settings: snapshot(settings), entries: snapshot(entries) }, save }),
    }, ChannelPage),
  )), 'dsh-system-one-channel: channel page')
}
