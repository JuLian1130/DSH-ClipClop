/**
 * dsh-reasoning-pruner 的浏览器半：把 ④ 的手动开关注册成 `settings.general.item` 的一行。
 *
 * 出厂没有「声明 Config 就自动长出 UI」的通路，所以这一半是必需的交付物，不是优化。四个契约点：
 *
 * - 命名空间 = profile patch 行的 `id`（`ctx.configForms.get(...)` 的 `namespace` 就是入口 id），本行的
 *   **注册 id** 是另一个字符串（list 槽位的行键），两者不要互相推导。
 * - 注册包在 `ctx.configForms.whileServed([...])` 里：宿主从未 compose 该命名空间的部署不显示这一行，
 *   否则会出现一个没有写入目标的死行。
 * - 当前值与写回全走 `ctx.configForms`：`getSnapshot()` 读、`set(field, value)` 写；`set` 在 Host 拒绝时
 *   **resolve `false`**（不是 reject、也不抛），所以失败态必须在 await 之后核验返回值。
 * - 关不掉服务端强制：本行只是「入口可不可用」和提前告知，裁剪资格仍由 host 半逐步骤读 replay 信封强制。
 *
 * 产物形状（CJS 闭包工厂）与打包步骤见 `scripts/build-client.mjs`；`import type` 一律只进类型图，产物里
 * 除平台模块外没有别的跨包值依赖。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型专用：settings 槽位的声明、`ctx.configForms` 的 Context 合并与 `ConfigForm` 类型。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型专用：`ctx.remote.llm` 的 key 面（`listConfigurableProviders`）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// 类型专用：`ctx.uiSession` / `ctx.modelDirectories` 的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// 类型专用：`ctx.slots` 的 Context 合并（槽位服务由渲染器提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createDisabledSnapshot } from './availability.ts'
import { ReasoningPrunerRow } from './row.tsx'

/** settings 命名空间 = profile patch 行的 `id`（也是 host 半的入口 `name`）。 */
const PREFERENCE_NAMESPACE = 'dsh-reasoning-pruner'

/** 本行在 `settings.general.item` 里的注册 id。 */
const ROW_ID = 'reasoning-pruner'

/** 本行的排序位。出厂行的 `current-version` 占 100，功能偏好行都在它之前。 */
const ROW_ORDER = 10

/** 本命名空间在浏览器侧的形状：volatile 投影只带这一个字段（`describe` 给的是**解析后**的 section）。 */
interface PreferenceSection {
  manualPrune: boolean
}

/** 注册这一行与读置灰那三个事实所需的客户端服务（host 服务不在其中——它们在 host 半）。 */
export const inject = ['slots', 'configForms', 'uiSession', 'modelDirectories', 'remote', 'remote.llm']

/**
 * 注册 ④ 的主界面开关行。
 * @param ctx - 客户端插件 context；上面 inject 的服务都已就绪。
 */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<PreferenceSection>(PREFERENCE_NAMESPACE)
  const disabled = createDisabledSnapshot(ctx)
  ctx.effect(() => ctx.configForms.whileServed([PREFERENCE_NAMESPACE], () => ctx.slots.inject(
    'settings.general.item',
    () => ctx.slots.register({
      name: 'settings.general.item',
      id: ROW_ID,
      order: ROW_ORDER,
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
    }, ReasoningPrunerRow),
  )), 'dsh-reasoning-pruner: general preference row')
}
