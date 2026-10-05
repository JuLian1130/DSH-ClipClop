/**
 * 推理档位的**兜底词表**与两条纯函数：host 半与浏览器半共用。
 *
 * 档位 id 由 route 声明（DSH 的 `ReasoningEffortId` 只是品牌字符串，没有全局词表），所以候选应当来自 route 的
 * 档位表（host 用 `llm.resolveModelInfo`、卡片用模型目录里的 `reasoning`）。这里的 8 项只在**读不到那张表**时兜底。
 *
 * 两条纯函数是这套语义的核心：配置里的空串表示"不推理"，由 {@link resolveNoReasoning} 按 route 的档位表拼出该发
 * 的 id（cline-pass 是 `none`、deepseek 是 `off`）；显式值由 {@link acceptsEffort} 判定能不能发。规则与依据见
 * `.scratch/dsh-result-clipper/design-draft-reasoning-effort.md`。
 *
 * 与 `rules.ts` 同理放在一个不 import 任何东西的模块里：浏览器半的产物不能把 host 模块打进去，抄一份就会漂移。
 *
 * @module
 */

/** 读不到 route 的档位表时的兜底候选，按从「不推理」到「最高」的升序；`off` 与 `none` 都表示不推理。 */
export const REASONING_EFFORT_IDS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 一个推理档位 id。 */
export type ReasoningEffort = (typeof REASONING_EFFORT_IDS)[number]

/**
 * 已知档位的次序：数字越小越不推理，`off` 与 `none` 同为 0（同一个含义的两种拼法）。
 *
 * 唯一用途是"`off` / `none` 都不在表里时挑出该 route 声明的最低档"。**不**假设 `efforts` 的声明顺序是升序——
 * 类型只承诺它是"适配器偏好的展示顺序"（`packages/llm/llm/src/types.ts` 的 `LlmModelReasoningInfo`）。
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** route 声明的一个档位；本模块只用得到 id。 */
export interface DeclaredEffort {
  readonly id: string
}

/**
 * 「不推理」在这张档位表上该发哪个 id。
 *
 * 顺序：`off` → `none` → 已知次序里最低的那一档 → `efforts[0]`（声明的档位全是未知 id 时才走这一档）。
 * @param efforts - route 声明的档位，顺序原样。
 * @returns 要发的 id；表为空时为 `undefined`。
 */
export function resolveNoReasoning(efforts: readonly DeclaredEffort[]): string | undefined {
  if (efforts.some(effort => effort.id === 'off')) return 'off'
  if (efforts.some(effort => effort.id === 'none')) return 'none'
  let lowest: string | undefined
  let lowestRank = Number.POSITIVE_INFINITY
  for (const effort of efforts) {
    const rank = EFFORT_RANK[effort.id]
    // 未知 id 不参与比较，也不会覆盖已选中的（`>=` 让同档位取先出现的那个）。
    if (rank === undefined || rank >= lowestRank) continue
    lowestRank = rank
    lowest = effort.id
  }
  return lowest ?? efforts[0]?.id
}

/**
 * 这个 id 在该 route 的档位表里吗。
 * @param efforts - route 声明的档位。
 * @param id - 要判定的档位 id。
 * @returns 在表里为 `true`；空表（读不到、或该模型不提供档位）为 `false`。
 */
export function acceptsEffort(efforts: readonly DeclaredEffort[], id: string): boolean {
  return efforts.some(effort => effort.id === id)
}
