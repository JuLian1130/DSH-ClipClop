/**
 * 本插件的配置契约。
 *
 * 承载事件类型与两条 payload 的形状在 `carrier.ts`——它们与浏览器半共用，所以单独成模块以免把
 * schemastery 依赖带进客户端产物；本模块只负责配置。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

// 承载类型与 payload 形状的**唯一来源**：宿主半、浏览器半与用例都从 `carrier.ts` 取，这里只做转出，
// 免得每个 import 站点各写一遍路径。
export * from './carrier.ts'

/**
 * 本插件的配置。两个参数都取保守默认（偏大＝少干活、少伤质量），实测后收紧。
 *
 * **默认值必须保持 `everySteps ≥ keepRecentSteps + 2`**：第 `M` 步的 pre-step 上只有 `M - 1` 条已记录
 * 步骤，减掉保留窗口 `K` 必须为正，否则每次到点都是空批量、而写入侧禁止落一条 `targets` 为空的事件
 * （07 回填 `M`/`K` 时必须保持这条不变式；规格闸门 D 的「冲突时 `K` 取更大值」正会踩到它）。
 */
export interface Config {
  /** 每完成多少个步骤允许推进一次裁剪；由闸门 B（成本摊薄）背书。 */
  everySteps?: number
  /** 最近多少个步骤原样保留、不裁；由闸门 D（任务质量）背书。 */
  keepRecentSteps?: number
  /**
   * ④ 手动入口是否可用，默认给出（`交付约束与范围`：手动入口默认给出，由开关控制是否可用）。
   *
   * `volatile` 是 settings 写回路径的硬要求（写入拒绝非 volatile 路径），也是浏览器半读当前值的通路。
   * 它**只管 ④**：① 与 ② 是默认开启的自动路径，不由本字段控制。
   */
  manualPrune?: Volatile<boolean>
}

/**
 * 配置 schema：字段全部可选并在装载时解析成默认值，非法值在装载阶段大声失败。
 *
 * **不写 `z<Config, Required<Config>>` 注解**：`volatile` 字段读入的是普通值（profile patch 里写
 * `manualPrune: false`），读出的是稳定引用（`apply` 里 `config.manualPrune.get()`），两者是不同类型；照
 * 出厂先例（`packages/client/ui-settings/src/index.ts`）让 schema 自己推断，`Config` 接口只描述 `apply`
 * 收到的形状。
 */
export const Config = z.object({
  everySteps: z.number().step(1).min(1).default(50),
  keepRecentSteps: z.number().step(1).min(0).default(10),
  manualPrune: z.boolean().default(true).volatile(),
})
