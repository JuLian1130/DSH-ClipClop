/**
 * 复核记录：插件自有存储域里的读写两个入口（票据 04）。
 *
 * 记录不进会话日志，外部行为观察不到，所以「按会话 id 读回」只能由本模块导出的入口驱动。
 * 机制与理由见设计文档「复核记录的存放位置」：域在插件加载路径上 open、键是一会话多条、
 * 两个入口随包发布、运行时写入走 `apply` 持有的实例 writer。这里只落票据钉死的形状。
 *
 * @module
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 类型自足：`ctx.storageDomain` 的类型来自这个包的模块增强，与 index.ts 里那三行同一个用意。
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Config } from './types.ts'
import type { ReviewOutcome } from './verdict.ts'

/** 复核记录的状态，闭集。07、10、11 复用这三个字面量，不各写一份。 */
export const REVIEW_STATUSES = ['completed', 'failed', 'cancelled'] as const

/** 一次复核的最终状态。 */
export type ReviewStatus = typeof REVIEW_STATUSES[number]

/**
 * 取消原因，闭集——三条取消路径共用它，因此不必各写一份字符串字面量。
 * 07 提供 `invalidated`，10 提供 `task-ended` / `task-cancelled`，11 提供 `plugin-disposed`。
 */
export const REVIEW_CANCEL_REASONS = [
  'invalidated',
  'task-ended',
  'task-cancelled',
  'plugin-disposed',
] as const

/** 一条取消记录的原因。 */
export type ReviewCancelReason = typeof REVIEW_CANCEL_REASONS[number]

/**
 * 一条复核记录的完整形状：写入路径与三条取消路径共用，存储的 `record` 与它同形，
 * 域声明的 zod schema 就按它写（形状的出处是规格「记录与诊断」的记录表）。
 *
 * 逐状态不变式：完成态 `verdict` 必有、`usage` 在流里出现 usage 块时有值、两个原因缺省；失败态 `failureReason` 必有、
 * `verdict` 缺省；取消态 `cancelReason` 必有、`verdict` 与 `failureReason` 缺省。
 */
export interface ReviewRecordInput {
  /** 触发步骤：这条记录是哪一步的复核。 */
  readonly triggerStep: number
  /** 当次配置快照（触发那一刻的配置）。 */
  readonly config: Required<Config>
  /** 复核耗时。 */
  readonly durationMs: number
  /** 最终状态。 */
  readonly status: ReviewStatus
  /** 触发点那一刻快照里每条消息的 id，按原顺序；取到快照之前就结束则整个字段缺省。 */
  readonly messageIds?: readonly string[]
  /** 复核结论；完成态必有。 */
  readonly verdict?: ReviewOutcome
  /** 复核用量；完成态在流里出现 usage 块时有值，没有该块时整个字段缺省。 */
  readonly usage?: TokenUsage
  /** 失败原因（自由文本）；失败态必有。 */
  readonly failureReason?: string
  /** 取消原因；取消态必有。 */
  readonly cancelReason?: ReviewCancelReason
}

/** 记录域的声明名。 */
export const REVIEW_DOMAIN_NAME = 'clipclop_review'

/** 记录域的版本戳。 */
const REVIEW_DOMAIN_VERSION = 1

/** 记录表（域里唯一一张）。 */
export const REVIEW_TABLE = 'records'

const configSnapshotSchema = z.object({
  triggerEverySteps: z.number(),
  mode: z.enum(['wait', 'parallel']),
  reviewTimeoutMs: z.number(),
  maxOutputTokens: z.number(),
  failurePolicy: z.enum(['continue', 'stop']),
  prompt: z.string(),
})

const outcomeSchema = z.object({
  verdict: z.enum(['continue', 'adjust', 'stop']),
  reason: z.string().min(1),
  recommendation: z.string().min(1),
})

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
})

/** 按 `ReviewRecordInput` 写的域 schema：装载路径用它校验每一条读回来的记录。 */
const reviewRecordSchema: z.ZodType<ReviewRecordInput> = z.object({
  triggerStep: z.number(),
  config: configSnapshotSchema,
  durationMs: z.number(),
  status: z.enum(REVIEW_STATUSES),
  messageIds: z.array(z.string()).optional(),
  verdict: outcomeSchema.optional(),
  usage: usageSchema.optional(),
  failureReason: z.string().optional(),
  cancelReason: z.enum(REVIEW_CANCEL_REASONS).optional(),
})

/**
 * 记录域的声明。用裸对象字面量，不走 `defineDomain` / `domainTable`：两者都是运行期导出，
 * 会让本包产物多一个运行期 import（理由见设计文档「复核记录的存放位置」）。`open` 接受任何
 * `DomainSpec` 形状的对象，`invalidRecords` 也由域层直接从这个对象上读。
 */
const reviewDomainSpec = {
  name: REVIEW_DOMAIN_NAME,
  version: REVIEW_DOMAIN_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { [REVIEW_TABLE]: { valueSchema: reviewRecordSchema } },
} satisfies DomainSpec

/** 本实例的 writer：运行时写入的唯一入口（绑到本实例的域与它自己的 disposer）。 */
export type ReviewWriter = (sessionId: SessionId, input: ReviewRecordInput) => Promise<void>

/**
 * 会话 id 的路径安全单射变换：UTF-8 十六进制。字母表落在 `[a-zA-Z0-9_-]` 内、不产出 `_`，
 * 且不同会话不会撞成同一个键（`per-record` 布局的 JSON 后端在写入时断言键匹配 `[a-zA-Z0-9_-]+`）。
 * @param sessionId - 主会话 id。
 * @returns 只含十六进制的会话判别段。
 */
function sessionKey(sessionId: SessionId): string {
  let hex = ''
  for (const byte of new TextEncoder().encode(String(sessionId))) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * 一条记录的键：会话判别段 + `_` + 按次递增的十进制判别值（触发步骤）。
 * @param sessionId - 主会话 id。
 * @param triggerStep - 这条记录的触发步骤。
 * @returns 存储域里该记录的键。
 */
export function reviewRecordKey(sessionId: SessionId, triggerStep: number): string {
  return `${sessionKey(sessionId)}_${String(triggerStep)}`
}

/** 已绑定到当前插件实例的记录域；由 `openReviewStore` 绑定、按身份解绑。 */
let boundStore: KvTable<string, ReviewRecordInput> | undefined

/**
 * 取当前实例的记录表。
 * @returns 记录表句柄。
 * @throws 当插件还没在加载路径上打开记录域时。
 */
function requireStore(): KvTable<string, ReviewRecordInput> {
  if (boundStore === undefined) {
    throw new Error('dsh-navigator: the review record domain is not open')
  }
  return boundStore
}

/**
 * 写入入口（随包发布的对外表面）：落一条记录。
 * @param sessionId - 记录归属的会话，只进键、不进记录值。
 * @param input - 完整记录。
 */
export async function writeReviewRecord(sessionId: SessionId, input: ReviewRecordInput): Promise<void> {
  await requireStore().put(reviewRecordKey(sessionId, input.triggerStep), input)
}

/**
 * 从一张记录表里读回某个会话的记录，按触发步骤升序。
 *
 * 按键的**最右**一个 `_` 解析出会话判别段再精确比较，不做前缀匹配——前缀会让会话 `a` 读到
 * 会话 `a_1` 的记录。
 * @param table - 记录表句柄。
 * @param sessionId - 要读回的会话。
 * @returns 已按声明 schema 解析过的记录列表，按触发步骤升序。
 */
function readFrom(
  table: KvTable<string, ReviewRecordInput>,
  sessionId: SessionId,
): readonly ReviewRecordInput[] {
  const discriminator = sessionKey(sessionId)
  const found: { step: number; record: ReviewRecordInput }[] = []
  for (const [key, record] of table.entries()) {
    const cut = key.lastIndexOf('_')
    if (cut <= 0 || key.slice(0, cut) !== discriminator) continue
    const step = Number(key.slice(cut + 1))
    if (!Number.isInteger(step)) continue
    found.push({ step, record })
  }
  return found.sort((left, right) => left.step - right.step).map(entry => entry.record)
}

/**
 * 读回入口（随包发布的对外表面）：按会话 id 返回该会话的记录列表，按触发步骤升序。
 * @param sessionId - 要读回的会话。
 * @returns 已按声明 schema 解析过的记录列表，按触发步骤升序。
 */
export function readReviewRecords(sessionId: SessionId): readonly ReviewRecordInput[] {
  return readFrom(requireStore(), sessionId)
}

/**
 * 在插件加载路径上打开记录域，并把本实例的 writer 与读回入口接上。
 *
 * 刻意不惰性打开：坏记录正是在 `open` 的装载路径上被 `invalidRecords: 'backup-and-skip'`
 * 跳过的，惰性打开会让「坏记录不挡加载」落空。释放次序由 `ctx.effect` 保证——fiber 释放
 * （`internal/update` 重启、卸载、重挂载）时先跑这个 disposer，域随之关闭，于是重新 `apply`
 * 能再 `open` 一次。
 * @param ctx - 插件的 context。
 * @returns 本实例的 writer：运行时写入的唯一入口。
 */
export async function openReviewStore(ctx: Context): Promise<ReviewWriter> {
  const domain = await ctx.storageDomain.open(reviewDomainSpec)
  const table = domain.table(REVIEW_TABLE)
  boundStore = table
  ctx.effect(() => () => {
    if (boundStore === table) boundStore = undefined
    return domain.close()
  }, 'dsh-navigator.reviewDomainClose')
  return async (sessionId, input) => {
    await table.put(reviewRecordKey(sessionId, input.triggerStep), input)
  }
}
