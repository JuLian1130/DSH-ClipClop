/**
 * 三个推理档位的**取值**：按 route 的档位表解析/判定，表按 provider+model 缓存。
 *
 * 为什么要这一层：档位 id 由 route 声明，"不推理"在不同 route 上拼法不同（cline-pass 是 `none`、deepseek 是
 * `off`）；而取表要走异步的 `llm.resolveModelInfo`，不能每条结果查一次。
 *
 * 缓存语义（设计稿 §9）：一条 route 每进程只成功解析一次，之后每次判定都是内存查表；**解析失败不缓存失败**
 * （下次再试）；设置写入清空缓存；并发的同一张表只发一次查询。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { acceptsEffort, resolveNoReasoning, type DeclaredEffort } from './reasoning.ts'

/**
 * `llm` 服务上用到的最小面：只读某个 route 的档位表。服务缺席、没有这个方法或调用失败，一律算"表读不到"
 * （`LlmRuntime` 的类型面在别的包里，这里就地声明最小结构，与 `src/client/catalog.ts` 同一取舍）。
 */
interface EffortSource {
  resolveModelInfo?(provider: string, model: string): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly DeclaredEffort[]
      readonly defaultEffort?: string
    }
  } | undefined>
}

/** 一次查表的读数：`declared` 是该 route 声明的档位；`none` 是该模型不提供推理档位（带任何档位都会被拒）。 */
type Reading =
  | { readonly kind: 'declared'; readonly efforts: readonly DeclaredEffort[] }
  | { readonly kind: 'none' }

/** 档位读数：配置里的值 → 这次请求实际要发的 id。 */
export interface EffortChoice {
  /**
   * 这次请求该发哪个档位。
   * @param provider - 该 role 的 provider。
   * @param model - 该 role 的 model。
   * @param configured - 配置里的值；**空串表示"不推理"**，按该 route 的档位表拼出对应 id。
   * @returns 要发的 id；`undefined` 表示这次请求不带 `reasoningEffort` 字段。
   */
  choose(provider: string, model: string, configured: string): Promise<string | undefined>
}

/** 缓存键；`\u0000` 不会出现在 provider / model 里。 */
function keyOf(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * 建这份读数。
 * @param ctx - 插件 context；`llm` 缺席时每次都落回"表读不到"（不缓存失败，也不影响工具结果）。
 * @returns 档位读数。
 */
export function createEffortChoice(ctx: Context): EffortChoice {
  const readings = new Map<string, Promise<Reading | undefined>>()
  // 设置写入可能换 route、也可能改模型的档位声明，所以整份清掉。这类事件很少，清空比按 namespace 过滤更省心。
  ctx.on('settings/document-updated', (_ns: SettingsNamespace) => { readings.clear() })
  const source = (): EffortSource | undefined => ctx.get('llm') as unknown as EffortSource | undefined

  /**
   * 读一次档位表。成功（含"该模型不提供档位"）才留在缓存里，失败与缺席都不留——下一次还会再试。
   * @param provider - provider id。
   * @param model - model id。
   * @returns 读数；读不到时为 `undefined`。
   */
  const read = (provider: string, model: string): Promise<Reading | undefined> => {
    const key = keyOf(provider, model)
    const cached = readings.get(key)
    if (cached !== undefined) return cached
    const started = (async (): Promise<Reading | undefined> => {
      const llm = source()
      const resolve = llm?.resolveModelInfo
      if (llm === undefined || resolve === undefined) return undefined
      try {
        const info = await resolve.call(llm, provider, model)
        const reasoning = info?.reasoning
        return reasoning === undefined ? { kind: 'none' } : { kind: 'declared', efforts: reasoning.efforts }
      } catch {
        return undefined
      }
    })()
    readings.set(key, started)
    // 失败的读数不能留在缓存里（否则这条 route 会永远不再查表）；成功与"该模型不提供档位"都留。
    void started.then((reading) => { if (reading === undefined) readings.delete(key) })
    return started
  }

  return {
    async choose(provider, model, configured) {
      const reading = await read(provider, model)
      if (reading === undefined) {
        // 表读不到：显式值原样下发（DSH 的档位判定在前，错了还有"去掉字段重发"兜底）；"不推理"没有可拼的 id，不发。
        return configured === '' ? undefined : configured
      }
      // 该模型不声明任何档位：带值必被拒（DSH 在 provider I/O 之前就抛），所以一律不带。
      if (reading.kind === 'none') return undefined
      if (configured === '') return resolveNoReasoning(reading.efforts)
      // 表里没有这个值：它发出去只会被拒，按「不推理」解析——与卡片上显示的生效档位一致。
      if (!acceptsEffort(reading.efforts, configured)) return resolveNoReasoning(reading.efforts)
      return configured
    },
  }
}
