/**
 * `FiberState` 的数值镜像：它是 const enum，不能运行时具名导入。
 *
 * @module
 */

import type { FiberState } from '@deepseek-ai/cordis'

/** 条目在等它 `inject` 的服务，尚未激活。 */
export const PENDING = 0 as FiberState.PENDING
/** 条目已激活并完成接线。 */
export const ACTIVE = 2 as FiberState.ACTIVE
/** 条目在激活阶段报错。 */
export const FAILED = 3 as FiberState.FAILED
