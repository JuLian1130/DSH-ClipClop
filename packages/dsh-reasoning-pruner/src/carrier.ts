/**
 * 承载本插件耐久决策的**已知**事件类型，以及两条 payload 的形状。
 *
 * 单独成模块而不是留在 `types.ts`，理由是**两半都要用同一份判别口径**：`types.ts` 还带 `Config` 的
 * schemastery 依赖，而浏览器半的产物只把平台模块列为 external（`scripts/build-client.mjs`），值引用一个
 * 带依赖的模块会把 schemastery 内联进客户端 bundle。这里只有一个字符串与几个接口（`SessionSeq` 是类型
 * 导入，产物里被擦除），宿主半与浏览器半因此不可能各自写一份事件名或键名。
 *
 * @module
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * 承载本插件耐久决策的**已知**事件类型。
 *
 * 借用宿主自己也在写、且全仓没有 payload 读取者的 `web/deepseek-search-llm-request`：自建的新类型不在
 * `KNOWN_SESSION_EVENT_TYPES` 里，写入会静默成功而重载被整段拒绝，所以只能借用一个已在本仓声明的
 * 已知类型。它是 log-only（不带 `surfaceOp`），改动只由本插件的投影兑现。取舍与普查结论见设计文档
 * 「耐久记录的形状」。
 */
export const CARRIER_EVENT_TYPE = 'web/deepseek-search-llm-request'

/**
 * 裁剪决策的耐久 payload。
 *
 * **顶层只有 `clipclop` 一个键**：客户端时间线索引对每一个事件都读 `data.turn`/`data.step` 并用它重指
 * 游标（不看类型），单个命名空间键让时间线坐标在结构上不可能出现。`clipclop` 里只有 `targets`，
 * 两层的键集合相等由投影校验。
 *
 * 这个接口**只作包内类型**，不并入 `SessionEventMap`：宿主已经为同名键声明了
 * `DeepSeekSearchLlmRequest`，再声明一次是接口合并的重复属性错误（实测 TS2717）。写入侧因此只能
 * cast，见 `projection.ts`。
 */
export interface ReasoningPrunePayload {
  clipclop: {
    /** 要裁剪的历史步骤，按各自的 `assistant/message` seq 列出。 */
    targets: SessionSeq[]
  }
}

/**
 * 「请求被拒」这一支里本插件认识的恰好两个码（激活点 ⑤ 的第一把锁）。
 *
 * pi-ai 把 400 与 `invalid request` 归一成 `INVALID_REQUEST`（`packages/llm/llm-pi-ai/src/stream.ts:49`
 * 的行内字面量）；网关正文不含那两个字样时 `classifyPiAiError` 落到兜底的 `PI_AI_ERROR`
 * （同文件 `:67`）。两个码都只用来把「请求被拒」从 AUTH / QUOTA / RATE_LIMIT / SERVER / TIMEOUT /
 * TRANSPORT 里分出来——该路径上 `failure.status` 是空的（`stream.ts:125` 的 failure 只带
 * `message`/`code`），判据只能建在码 + 正文上。
 */
export type RejectionErrorCode = 'INVALID_REQUEST' | 'PI_AI_ERROR'

/**
 * 拒收正文的**类别**（激活点 ⑤ 的第二把锁）。
 *
 * 只记类别、不记原文：网关的 400 正文可能回显请求内容，而 `session-log-deepseek` 把 `data` 原样上传到
 * 远端。今天只认识一类——第二把锁要求 `reasoning[_ ]content`、`thinking mode`、`passed back` 三词同时
 * 命中，所以这个枚举是一元的。
 */
export type RejectionWording = 'reasoning-content-required'

/**
 * 裁剪拒收后的**还原 + 停用**决策（激活点 ⑤）的耐久 payload。
 *
 * 与 {@link ReasoningPrunePayload} 共用同一个承载类型、同一个顶层键，靠内层有没有 `restore` 判别是两条
 * 中的哪一条。还原与停用是**同一条**事件：一条 `append`，不存在「只还原未停用」的中间态。停用本身不需要
 * 载荷字段——它是「日志里存在这样一条事件」这个事实。
 */
export interface ReasoningSuspendPayload {
  clipclop: {
    /**
     * 要还原为原文的历史步骤，按各自的 `assistant/message` seq 列出，只含**写入时仍是当前表面节点**的那些
     * （被 compaction 遮蔽过的写回也无效）。可以是空数组：三个反例之外仍要落一次停用。
     */
    restore: SessionSeq[]
    /** 那次失败所在的 provider 路由（`agent/request-error` 载荷给出）。 */
    provider: string
    /** 那次失败所在的模型 id（`agent.options.model`，与 agent-loop 自己组路由时同源）。 */
    model: string
    /** 触发第一把锁的码。 */
    errorCode: RejectionErrorCode
    /** 触发第二把锁的措辞类别。 */
    wording: RejectionWording
  }
}
