/**
 * 本包的配置契约：唯一的配置项是 `entries`——决策模型的条目。
 *
 * `id` 是内部标识（唯一、由系统生成/手写时自己给），`label` 只给人看、**不唯一**；`kind` 是协议枚举，
 * 经工厂表映射到 provider 实现。凭据只存引用名 `apiKeyEnv`，密钥本身不进配置。
 *
 * @module
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 条目的协议。枚举外的值在装载期报错；枚举内有值但没有工厂时同样报错并点出 `kind`。 */
export type Kind = 'systemone' | 'openai'

/** 一个决策模型条目。 */
export interface Entry {
  /** 内部标识：唯一、必填。`ask()` 的 `target` 用它指名条目。 */
  id: string
  /** 显示名称：只给人看，**可以不唯一**。 */
  label: string
  /** 协议，决定用哪个 provider 工厂。 */
  kind: Kind
  /** 端点地址。 */
  baseUrl: string
  /** 模型名。 */
  model: string
  /** 凭据的**引用名**（为空＝不带凭据）；密钥本身不写进配置。 */
  apiKeyEnv?: string
}

/**
 * 插件配置。
 *
 * `entries` 是整字段 `.volatile()`：设置页的写回路径只接受 volatile 路径，而 volatile 只能落在顶层固定
 * 字段上（数组元素内部再标记会被 schemastery 拒绝），所以标记打在整个 `entries` 上。
 */
export interface Config {
  entries?: Volatile<Entry[]>
}

/**
 * 配置 schema：非法配置在装载期大声失败并点出键名（缺 `id`、`kind` 不在枚举内等）。
 *
 * 注解的两个类型参数是**读入**与**读出**的形状：`entries` 在 patch 里是普通数组，装载后是 volatile
 * 引用。注解本身也是必需的——数组元素套对象时推断结果里带一个不可命名的类型，`tsc` 的 d.ts 产出会因此
 * 报 TS2883。
 */
export const Config: z<{ entries?: Entry[] }, Required<Config>> = z.object({
  entries: z
    .array(z.object({
      id: z.string().required(),
      label: z.string().required(),
      kind: z.union([z.const('systemone'), z.const('openai')]).required(),
      baseUrl: z.string().required(),
      model: z.string().required(),
      // 空串＝不带凭据；非空时由 provider 在请求时解析。引用名可以不给（默认 = 条目 id 是页面的口径）。
      apiKeyEnv: z.string().default(''),
    }))
    .default([])
    .volatile(),
})
