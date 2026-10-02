/**
 * dsh-result-clipper 的 Cordis 插件入口：具名导出 `name`、`inject`、`Config`、`apply`，按 DSH 原生插件
 * 写法由 profile 的 `cordis.patch.yml` 装载。
 *
 * 本票（02）交付的是骨架与观察面：监听器注册在 `tools/post-execute` 上并**一律放行**（`await next()` 后原样
 * 返回它的决策），装上插件后三类工具与其它工具的结果都与未装时逐字相同；`exec.parent !== undefined` 的
 * PTC 子派发直接 `next()`——它是程序内部的中途值，对它返回 `block` 会让沙箱程序抛错、替换 `content` 会改写
 * 持久日志副本。切换开关不改变这条放行路径，改的只是 debug 记录里的结果取值。
 *
 * debug 管道（本票的另一半交付）在放行路径之后按需追加一行 metadata JSONL：工具名、结果大小、调用耗时，
 * 以及结果取值。摘要能力关闭时每条结果记 `summary-off`；debug 关闭或路径为空时零写盘。摘要能力开启时的
 * 候选与透传取值由 03 起引入，本票在该状态下不产出取值记录。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import { appendDebugRecord, measureContent, type DebugOutcome, type DebugRecord } from './debug.ts'

export * from './config.ts'
export * from './debug.ts'

export const name = 'dsh-result-clipper'

/** 监听 `tools/post-execute` 需要工具运行时在场；装载顺序（在 spill-policy 之后）由 profile 侧保证。 */
export const inject = ['tools']

/**
 * 注册工具结果监听器。
 *
 * `{ prepend: true }` 是判据的一部分：本插件要与 spill-policy 一起排在最前，且必须**后注册**才能位于 spill
 * 外层（两个 prepend 监听器之间后注册的先跑），从而看到 spill 截断之后的正文。这一条由部署的装载顺序兑现，
 * 本票不新增检测。
 * @param ctx - 插件的 context；`tools` 已就绪。
 * @param config - 解析后的配置；四个字段都是 volatile 引用，每次调用时读当前值。
 */
export function apply(ctx: Context, config: Required<Config>): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    if (exec.parent !== undefined) return next()
    const startedAt = performance.now()
    const decision = await next()
    const outcome = summaryOutcome(config)
    if (outcome !== undefined) await record(config, exec.name, result, startedAt, outcome)
    return decision
  }, { prepend: true })
}

/**
 * 本条结果在摘要路径上的取值。本票没有摘要实现，因此能力关闭时每条结果都落 `summary-off`；能力开启时的
 * 候选判断与其余取值自 03 起引入。
 * @param config - 解析后的配置。
 * @returns 要记录的结果取值；本票还没有对应取值时为 `undefined`。
 */
function summaryOutcome(config: Required<Config>): DebugOutcome | undefined {
  return config.summarize.get() ? undefined : { action: 'unmodified', reason: 'summary-off' }
}

/**
 * 按配置追加一行 debug 记录。debug 关闭或路径为空时不写盘。
 * @param config - 解析后的配置。
 * @param toolName - 工具名。
 * @param result - 工具结果的原始投影。
 * @param startedAt - 拿到结果前的时间戳。
 * @param outcome - 本条结果的结果取值。
 */
async function record(
  config: Required<Config>,
  toolName: string,
  result: Readonly<ToolExecutionResult>,
  startedAt: number,
  outcome: DebugOutcome,
): Promise<void> {
  if (!config.debug.get()) return
  const path = config.debugPath.get()
  if (path === '') return
  const line: DebugRecord = {
    toolName,
    resultBytes: measureContent(result.content),
    durationMs: Math.round(performance.now() - startedAt),
    ...outcome,
  }
  try {
    await appendDebugRecord(path, line)
  } catch {
    // 诊断写入失败不得把工具调用变成错误结果（任何路径都不得抛）；路径由用户配置，插件不自动改用临时路径。
  }
}
