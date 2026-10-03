/**
 * dsh-reasoning-pruner 的浏览器半：把 ④ 的手动开关注册成「设置 → 内置插件」里的一个页签。
 *
 * 出厂没有「声明 Config 就自动长出 UI」的通路，所以这一半是必需的交付物，不是优化。五个契约点：
 *
 * - 命名空间 = profile patch 行的 `id`（`ctx.configForms.get(...)` 的 `namespace` 就是入口 id），本页签的
 *   **注册 id** 是另一个字符串（`settings.plugins.tab` 的页签键），两者不要互相推导。
 * - 注册包在 `ctx.configForms.whileServed([...])` 里：宿主从未 compose 该命名空间的部署不显示这一页，
 *   否则会出现一个没有写入目标的死页。
 * - `settings.plugins.tab` 由内置插件那一节在挂载时声明，注册同样要等声明上账。
 * - 当前值与写回全走 `ctx.configForms`：`getSnapshot()` 读、`set(field, value)` 写；`set` 在 Host 拒绝时
 *   **resolve `false`**（不是 reject、也不抛），所以失败态必须在 await 之后核验返回值。
 * - 关不掉服务端强制：本页签只是「入口可不可用」和提前告知，裁剪资格仍由 host 半逐步骤读 replay 信封强制。
 *
 * 产物形状（CJS 闭包工厂）与打包步骤见 `scripts/build-client.mjs`；`import type` 一律只进类型图，产物里
 * 除平台模块外没有别的跨包值依赖。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型专用：settings 槽位的声明、`ctx.configForms` 的 Context 合并与 `ConfigForm` 类型。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`ctx.locale` 的 Context 合并（页签名与页内文案的字典）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型专用：`ctx.remote.llm` 的 key 面（`listConfigurableProviders`）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// 类型专用：`ctx.uiSession` / `ctx.modelDirectories` 的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// 类型专用：`ctx.sessions` 的 Context 合并（停用提示只为当前显示的会话建引用）。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// 类型专用：`shell.overlay` 这个槽位的声明由 ui-layout（画整个 frame 的那一半）持有。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createDisabledSnapshot } from './availability.ts'
import { en, zh, type ReasoningPrunerLocaleKey } from './locales.ts'
import { ReasoningPrunerNotice, type RejectionNoticeInjected } from './Notice.tsx'
import { createRejectionNotice } from './notice.ts'
import { ReasoningPrunerTab } from './tab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本页签的文案字典。 */
    'reasoning-pruner': ReasoningPrunerLocaleKey
  }
}

/** settings 命名空间 = profile patch 行的 `id`（也是 host 半的入口 `name`）。 */
const PREFERENCE_NAMESPACE = 'dsh-reasoning-pruner'

/** 本页签在 `settings.plugins.tab` 里的注册 id。 */
const TAB_ID = 'reasoning-pruner'

/** 停用提示在 `shell.overlay` 里的注册 id。 */
const NOTICE_ID = 'reasoning-pruner-notice'

/** 本页签的排序位。只读清单页占 10，本页排在它之后。 */
const TAB_ORDER = 20

/** 本插件在客户端 locale 里的字典命名空间。 */
const LOCALE_NAMESPACE = 'reasoning-pruner'

/** 本命名空间在浏览器侧的形状：volatile 投影只带这一个字段（`describe` 给的是**解析后**的 section）。 */
interface PreferenceSection {
  manualPrune: boolean
}

/** 注册这一页与读置灰那三个事实所需的客户端服务（host 服务不在其中——它们在 host 半）。 */
export const inject = ['slots', 'locale', 'configForms', 'uiSession', 'modelDirectories', 'remote', 'remote.llm', 'sessions']

/**
 * 注册 ④ 的内置插件页签与 ⑤ 的停用提示。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-reasoning-pruner: dictionaries')
  // 页签名是 thunk：内置插件那一节每次投影都重读它，所以语言切换不必重新注册。
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const form = ctx.configForms.get<PreferenceSection>(PREFERENCE_NAMESPACE)
  const disabled = createDisabledSnapshot(ctx)
  // ⑤ 的用户可见提示：宿主侧没有提示面，唯一的合法瞬时面是这个 root 槽位；条目自己按当前会话过滤。
  const notice = createRejectionNotice(ctx)
  const noticeFace = (): RejectionNoticeInjected => ({
    hooks: { visible: notice },
    dismiss: () => { notice.dismiss() },
  })
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: NOTICE_ID,
    locale: LOCALE_NAMESPACE,
    inject: noticeFace,
  }, ReasoningPrunerNotice)), 'dsh-reasoning-pruner: rejection notice')
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
          enabled: {
            // 镜像还没给出 section 时回落到 schema 的默认（默认给出，不是默认关闭）。
            getSnapshot: () => form.getSnapshot().value?.manualPrune ?? true,
            subscribe: (listener: () => void) => form.subscribe(listener),
          },
          disabled,
        },
        setEnabled: (value: boolean) => form.set('manualPrune', value),
      }),
    }, ReasoningPrunerTab),
  )), 'dsh-reasoning-pruner: built-in plugins tab')
}
