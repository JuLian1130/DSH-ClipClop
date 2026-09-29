/**
 * 置灰读数：**当前路由不可能受益**时为 `true`（`激活点 ④` 的保守闸门：判不准就不给）。
 *
 * 判据需要三个事实，缺一个就判不准：
 *
 * 1. 路由目录——`ctx.remote.llm.listConfigurableProviders()` 的 `settingsNs` / `settingsPath`。
 * 2. 显式 route 级 `api`——按上一步的 `settingsPath` 从该命名空间的 settings 值里读一步。
 * 3. **当前是哪条路由**——`ctx.modelDirectories.directoryFor(sessionId)` 快照的 `current`：它取耐久投影的
 *    `next`、缺 `next` 时回退 catalog 的 `default`，正是「这条会话实际在用哪条路由」。**不得**改用
 *    `remote.session.modelCatalog()` 的 `default`——那是部署默认，会话中途换过路由时仍指向旧默认。
 *
 * `sessionId` 的来源：`settings.plugins.tab` 是 root 槽位、注册期拿不到会话 id，所以取
 * `ctx.uiSession.adapter.current` 快照的 `.key`（即 main view 那一条）。`.key === undefined`（确实没有
 * 选中会话）按判不准置灰——这条规则只覆盖「无选中会话」，不是「root 页签取不到会话」的兜底。
 *
 * 置灰的三个分支：命名空间是 `llm-deepseek`（Messages 传输，无裁剪资格）⇒ 置灰；命名空间是 `llm-pi-ai`
 * 且 profile 有**显式** `api` ⇒ 按那个值判；命名空间是 `llm-pi-ai` 但 profile 没有 `api` 键 ⇒ 置灰。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
// 类型专用：`currentSessionId` 的会话 id 品牌。
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** pi-ai 路由的 settings 命名空间：只有它的路由协议可由 profile 的显式 `api` 确定。 */
const PI_AI_NAMESPACE = 'llm-pi-ai'

/** 唯一有裁剪资格的传输（规格「裁剪资格」）；其余传输与判不准同结论。 */
const PRUNABLE_PROTOCOL = 'openai-completions'

/**
 * 当前 main view 那条会话的 id。
 *
 * `StandardSourceBinding.key` 是裸 `string`（`renderer.ts`），框架自身也这样断言（`publishMain` 直接把
 * `.key` 当会话 id 用），所以这里的断言与它同源而不是新的宽松。
 * @param ctx - 客户端插件 context。
 * @returns 会话 id；没有选中会话时为 `undefined`。
 */
function currentSessionId(ctx: Context): SessionId | undefined {
  return ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
}

/**
 * 从 settings 命名空间的值里按 `settingsPath` 取该路由的 profile 对象。
 * @param value - 该命名空间的完整 section 值。
 * @param path - 从 section 根到该路由 profile 的路径（`listConfigurableProviders()` 给出）。
 * @returns profile 对象；路径上缺任何一段时为 `undefined`。
 */
function profileAt(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/**
 * 建这个行的置灰读数。
 *
 * 路由目录只在装载期读一次：它答的是「哪些路由确定/判不准」，与跑过多少步骤无关。读失败或尚未返回时目录
 * 缺失 ⇒ 判不准 ⇒ 置灰（保守方向）。**不是「跑过一个步骤就自愈」**：置灰的三个输入里没有 replay 信封，
 * 跑步骤不改变其中任何一项。
 * @param ctx - 客户端插件 context。
 * @returns 置灰读数；任何输入变化都会通知订阅者。
 */
export function createDisabledSnapshot(ctx: Context): ObservableSnapshot<boolean> {
  const listeners = new Set<() => void>()
  let directory: readonly LlmConfigurableProvider[] | undefined
  let disabled = true

  const read = (): boolean => {
    const selected = currentSessionId(ctx)
    const current: ModelDirectoryState['current'] = selected === undefined
      ? null
      : ctx.modelDirectories.directoryFor(selected).store.getSnapshot().current
    const entry = directory?.find(candidate => candidate.provider === current?.provider)
    // 判不准的三种情形（目录缺失/找不到路由、没有选中会话、命名空间不是 pi-ai）给出同一结论。
    if (entry === undefined || entry.settingsNs !== PI_AI_NAMESPACE) return true
    const profile = profileAt(ctx.configForms.get(entry.settingsNs).getSnapshot().value, entry.settingsPath)
    return (profile as { api?: unknown } | undefined)?.api !== PRUNABLE_PROTOCOL
  }

  const publish = (): void => {
    const next = read()
    if (next === disabled) return
    disabled = next
    for (const listener of [...listeners]) listener()
  }

  void ctx.remote.llm.listConfigurableProviders().then((result) => {
    if (result.ok) directory = result.value
    publish()
  })

  // 两个独立的变化源：选中会话换了（会话的目录快照也要改订阅目标），以及 pi-ai 的 settings 值变了。
  ctx.effect(() => {
    let offDirectory: () => void = () => {}
    const sync = (): void => {
      offDirectory()
      const selected = currentSessionId(ctx)
      offDirectory = selected === undefined
        ? () => {}
        : ctx.modelDirectories.directoryFor(selected).store.subscribe(publish)
      publish()
    }
    const offSelection = ctx.uiSession.adapter.current.subscribe(sync)
    const offSettings = ctx.configForms.get(PI_AI_NAMESPACE).subscribe(publish)
    sync()
    return () => {
      offSettings()
      offSelection()
      offDirectory()
    }
  }, 'dsh-reasoning-pruner: availability subscriptions')

  return {
    getSnapshot: () => disabled,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
