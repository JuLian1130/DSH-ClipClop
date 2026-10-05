/**
 * 卡片要的模型目录：DSH 当前**可路由**的 provider 分组与它们的模型，取自 `remote.session.modelCatalog()`。
 *
 * 这是「设置 → 模型」那一页同一个来源，所以卡片里的候选与用户在那里配好的 route 一致；目录读失败或还没返回时
 * 候选为空，输入框退化成原来的手填行为（不阻塞配置）。**退化只覆盖读失败**：`remote` 与 `remote.session` 是按
 * DSH 惯例硬声明的依赖（读某个 namespace 的业务包要自己同时声明两者），服务缺席时整个客户端半不装载（页签与
 * 卡片都不出现），不会走到这里——所以下面那两处字段存在性判断防的是「读返回里没有这个方法」，不是「服务没挂」。
 *
 * **不为此加一个客户端依赖**：`@deepseek-ai/dsh-api-remotes` 只在本文件里用到一个方法、一个返回形状，为一个
 * 类型多挂一个包不值得，所以就地声明最小结构（与 `card.tsx` 的 `ResultClipperSettingOp` 同一取舍）。`ctx.remote`
 * 的读在 `inject` 声明之后才可能成立，这里的断言因此不是「绕过服务面」，只是省掉类型包。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** 目录里一个 provider 分组：卡片只用到 id、显示名与它的模型。 */
export interface ModelCatalogProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly {
    readonly id: string
    readonly name: string
    /** 该模型声明的推理档位；没有这个字段＝它不提供推理档位（DSH 的 `reasoning === undefined` 同义）。 */
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }[]
}

/** `remote.session.modelCatalog()` 的最小形状：RemoteResult 包一层，成功时给 `groups`。 */
interface ModelCatalogRemote {
  readonly session?: {
    modelCatalog?: () => Promise<{
      readonly ok: boolean
      readonly value?: { readonly groups?: readonly ModelCatalogProvider[] }
    }>
  }
}

/** 目录读数：provider 分组，加一次强制重读。 */
export interface ModelCatalogSnapshot extends ObservableSnapshot<readonly ModelCatalogProvider[]> {
  /** 重读目录；卡片挂载时调用，让刚在「设置 → 模型」里加好的 route 立刻出现在候选里。 */
  refresh(): void
}

/**
 * 建这份目录读数。
 *
 * 装载时先读一次（设置页多半会用到），卡片每次挂载再读一次（把刚配好的 route 带进来）。读失败或返回不成功都
 * 按「没有候选」处理并保留上一次的结果——候选缺失只是少了建议，手填仍然可用。
 * @param ctx - 浏览器半的 context；`remote` 已在 `inject` 里声明。
 * @returns 目录读数。
 */
export function createModelCatalog(ctx: Context): ModelCatalogSnapshot {
  const listeners = new Set<() => void>()
  let providers: readonly ModelCatalogProvider[] = []
  const remote = (ctx as unknown as { remote?: ModelCatalogRemote }).remote

  const load = (): void => {
    const session = remote?.session
    const read = session?.modelCatalog
    if (read === undefined) return
    void read.call(session).then((response) => {
      const groups = response.ok ? response.value?.groups : undefined
      if (groups === undefined) return
      // 拷贝成新引用：读数靠引用变化通知订阅者，直接改数组会让 React 看不到变化。
      providers = groups.map(group => ({ ...group, models: [...group.models] }))
      for (const listener of [...listeners]) listener()
    }).catch(() => { /* 目录读失败 = 没有候选；手填路径不受影响 */ })
  }

  load()
  return {
    getSnapshot: () => providers,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: load,
  }
}
