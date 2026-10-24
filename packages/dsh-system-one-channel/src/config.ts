/**
 * 决策通道子插件的配置契约。
 *
 * 四个字段都是 `.volatile()`：设置页的写回路径只接受 volatile 路径（理由同接入层的 `entries`），且这四项
 * 都按**每次现读**用——改完即生效，不需要重载插件。开关决定注册哪一批（工具、引导段、技能），换开关由插件
 * 自己在 `loader/volatile-update` 里整批换，机制见设计文档「决策通道」。
 *
 * 配置非法一律在装载期报错并点出键名：开关打开却没选条目、阈值越界。
 *
 * @module
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * 引导档位。
 *
 * `tool` 是第一档：工具描述 + 技能。`context` 是第二档：第一档再加一句常驻引导。档位只加一句固定
 * 引导，不做拦截或替换主模型判断的更强形态。
 */
export type Guidance = 'tool' | 'context'

/** 可信度门槛：开启后每道题按确定性标 `act`／`abstain`。数值 0–1，语义见 `decisions.ts`。 */
export interface Threshold {
  enabled: boolean
  /**
   * 低于它标 `abstain`。这一步的确定性是**我们**给的语义（是非题按与 0.5 的距离再乘 `labelMass`，
   * choice/score 用 provider 自报的 `confidence`），而各 provider 的 `confidence` 定义不同，同一数值
   * 不可跨 provider 比较。
   */
  value: number
}

/** 插件配置。 */
export interface Config {
  /** 总开关，设置页可改。默认关闭；关掉时工具、引导段与技能都不注册。 */
  enabled?: Volatile<boolean>
  /** 当前条目：接入层里那条决策模型的 `id`。开关打开时必填，否则装载期报错。 */
  target?: Volatile<string>
  /** 引导档位，默认第一档。 */
  guidance?: Volatile<Guidance>
  /** 可信度门槛：默认不设（`enabled: false`），数值只在开启后读取。 */
  threshold?: Volatile<Threshold>
}

/**
 * 配置 schema。
 *
 * 注解的两个类型参数是**读入**与**读出**的形状：四个字段在 patch 里是普通值，装载后是 volatile 引用；
 * 注解本身也是必需的，与接入层的 `Config` 同一个理由（`d.ts` 产出会因此报 TS2883）。
 */
export const Config: z<
  { enabled?: boolean; target?: string; guidance?: Guidance; threshold?: Threshold },
  Required<Config>
> = z.object({
  enabled: z.boolean().default(false).volatile(),
  target: z.string().default('').volatile(),
  guidance: z.union([z.const('tool'), z.const('context')]).default('tool').volatile(),
  threshold: z
    .object({
      enabled: z.boolean().default(false),
      value: z.number().min(0).max(1).default(0.5),
    })
    .default({})
    .volatile(),
})
