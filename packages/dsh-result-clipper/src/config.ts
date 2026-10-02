/**
 * 本插件的配置契约。
 *
 * 四个字段全部 `volatile`：settings 的写回路径只接受 volatile 路径（写入拒绝非 volatile 字段），这也正是
 * 「开关与参数保存即生效、不需要重启」的实现方式——host 半每次处理结果时读一次引用，读到的就是当前值。
 * 字段的默认值即规格「配置项」的首版默认：两项能力关闭、debug 关闭且不自动改用临时路径。
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/**
 * 本插件的配置。
 *
 * **不写 `z<Config, Required<Config>>` 注解**：volatile 字段读入的是普通值（profile patch 里写
 * `summarize: false`），读出的是稳定引用（`apply` 里 `config.summarize.get()`），两者是不同类型；照出厂
 * 先例让 schema 自己推断，`Config` 接口只描述 `apply` 收到的形状。
 */
export interface Config {
  /** 摘要能力开关，默认关闭（用户故事 1）。 */
  summarize?: Volatile<boolean>
  /** 隐私闸门开关，默认关闭（用户故事 2）。 */
  privacyGate?: Volatile<boolean>
  /** debug 记录开关，默认关闭；关闭时零写盘。 */
  debug?: Volatile<boolean>
  /** debug JSONL 路径；空串表示没有配置路径，此时不开 debug 也不写盘。 */
  debugPath?: Volatile<string>
}

/** 配置 schema：字段全部可选并在装载时解析成默认值。 */
export const Config = z.object({
  summarize: z.boolean().default(false).volatile(),
  privacyGate: z.boolean().default(false).volatile(),
  debug: z.boolean().default(false).volatile(),
  debugPath: z.string().default('').volatile(),
})
