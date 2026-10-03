/**
 * 耐久落盘通路：把一次裁剪决策追加成承载类型事件，以及激活点② 的触发与选区。
 *
 * 这是本插件唯一的写入点。写出去的 payload **只有 seq 数组**（顶层是单个 `clipclop` 键），所以
 * `session-log-deepseek` 那类把 `data` 原样上传的消费者拿不到任何会话内容。形状校验不在写入侧——它由
 * `reasoningPrunerProjection` 在落盘**之前**执行（`planSurfaceEvent` 由 `surfaceManager.validateNext`
 * 调用、在 `log.push` 之前），所以非法 payload 会让 `append` 本身抛出、日志不留坏记录。
 *
 * 选区与触发都建在**已提交历史**上：候选、已裁集合、保留窗口、会话级步号四者都从日志读，所以重载后不需要
 * 任何外部状态就能继续推进，也不会重复声明同一个 seq。
 *
 * ⚠️ 本文件是全插件唯一读**同步历史**（`snapshotEvents()` / `ownEvents()`，带 `@deprecated`、Agent Note
 * 明写 new calls are prohibited）的生产代码，理由见 `recordedAssistantMessages`；三处的读法都只用「事件
 * 的类型与 seq」，而且都覆盖 fork 继承的前缀（`readPrunedSteps` 与 `sessionStepNumber` 直接读全量快照，
 * `recordedAssistantMessages` 读继承前缀 + `ownEvents()`）。除此之外生产源码一个被禁读取器都不碰，也不留
 * 任何事件引用。
 *
 * @module
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session'
import { isReasoningPrunable } from './replay.ts'
import { CARRIER_EVENT_TYPE } from './types.ts'
import type { Config, ReasoningPrunePayload, ReasoningSuspendPayload, RejectionWording } from './types.ts'

/**
 * 承载事件的自有封装：顶层带 `clipclop` 键的才是本插件的事件（宿主自己也在写同一个类型，它的事件没有这个
 * 键）。两条 payload 共用这个键，靠内层有没有 `restore` 判别。
 * @param event - 一条事件。
 * @returns 内层封装；不是本插件的事件或形状不是对象时为 `undefined`。
 */
function carrierEnvelope(event: SessionEvent): Record<string, unknown> | undefined {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const envelope = (data as Record<string, unknown>)['clipclop']
  return typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)
    ? envelope as Record<string, unknown>
    : undefined
}

/**
 * 选区与节流只读这两个数值参数：④ 的开关（`manualPrune`）与它们无关，所以这里的入参不要求调用方凑齐整个
 * 配置——`apply` 收到的完整配置结构上满足它。
 */
type PruneParameters = Pick<Required<Config>, 'everySteps' | 'keepRecentSteps'>

/** 一条已记录的 `assistant/message` 的 seq 与消息，按 seq 增序。 */
function recordedAssistantMessages(session: Session): Map<SessionSeq, AssistantMessage> {
  const recorded = new Map<SessionSeq, AssistantMessage>()
  // 破例读同步历史的两条理由，缺一条都不成立：
  // 1. 资格判定读的必须是**已提交**的消息，不是模型可见历史——后者可能已被本插件的投影改过，拿裁剪版去
  //    判资格是循环论证。
  // 2. 写入路径上没有任何非 deprecated 的「已提交消息」读取面：`SessionMessageProjectionContext` 只存在
  //    于折叠期。agent-loop 的 `appendUnstoredSuffix` 出于同型理由破同一条例。
  // 范围压到最小（只读类型与 seq，不留事件引用）；存储方向变化时这一处是唯一要改的地方。
  // 两半都要读：fork 继承的前缀不在 `ownEvents()` 里，而「已裁集合」与「保留窗口」都必须覆盖它。
  for (const events of [
    session.snapshotEvents(SessionLogOffset(0), session.inheritedEventCount),
    session.ownEvents(),
  ]) {
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      recorded.set(event.seq, event.data.message)
    }
  }
  return recorded
}

/**
 * 已推进过的边界位置：从日志里的承载事件重建，**不落任何外部状态**。
 *
 * 这个集合是日志的纯函数，所以重载后天然一致；反过来，若把「已裁过哪些步骤」记在内存或外部文件里，投影
 * 就不再是纯函数、结果还依赖重放顺序（设计文档「已核实但不采用的其他路径」第 4 条）。
 *
 * 读的是**全部**事件（含 fork 继承的前缀）：判定「已裁过」是全局事实，与归属无关。
 * @param session - 会话。
 * @returns 已被历史决策裁过的 seq 集合。
 */
export function readPrunedSteps(session: Session): Set<SessionSeq> {
  const pruned = new Set<SessionSeq>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== CARRIER_EVENT_TYPE) continue
    const targets = carrierEnvelope(event)?.['targets']
    // 没有 `targets` 的承载事件是**停用**那一笔（内层带 `restore`），不是裁剪决策。
    if (!Array.isArray(targets)) continue
    for (const target of targets) pruned.add(target as SessionSeq)
  }
  return pruned
}

/**
 * 本会话是否已停用裁剪（激活点 ⑤）。
 *
 * 停用是「日志里存在一条带 `restore` 的承载事件」这个**事实**，不落任何内存状态、也没有外部文件：于是它
 * 天然按会话生效（新会话的日志里没有这条）、天然被 fork 继承（子会话继承日志前缀）、重载后天然仍然成立。
 * 三个入口（①②④）共用这一条判定——它们都从 {@link persistReasoningPrune} 这一个写入漏斗落盘。
 * @param session - 会话。
 * @returns 已停用时为 true。
 */
export function isPruningSuspended(session: Session): boolean {
  for (const event of session.snapshotEvents()) {
    if (event.type !== CARRIER_EVENT_TYPE) continue
    const envelope = carrierEnvelope(event)
    if (envelope !== undefined && Object.hasOwn(envelope, 'restore')) return true
  }
  return false
}

/**
 * 第二把锁的三词：三词**同时**命中才算「拒的是推理没回传这件事」。任一不命中就不动作，避免把别的 400
 * （例如请求体别处越界）当成裁剪的锅。
 */
const REJECTION_WORDING_PATTERNS: readonly RegExp[] = [
  /reasoning[_ ]content/i,
  /thinking mode/i,
  /passed back/i,
]

/** 第一把锁的码面。与 `RejectionErrorCode` 是同一份取值，运行期这里只回答「属不属于这一支」。 */
const REJECTION_CODES: readonly string[] = ['INVALID_REQUEST', 'PI_AI_ERROR']

/** 第二把锁命中时的措辞类别（三词全中，所以是一元的）。 */
export const REJECTION_WORDING: RejectionWording = 'reasoning-content-required'

/**
 * 前两把锁（激活点 ⑤）：错误码属于「请求被拒」这一支，且正文同时命中三词。
 *
 * 第三把锁（本会话已存在裁剪事件）是调用方读 {@link readPrunedSteps} 得到的，因为它与写路径共用同一个
 * 「日志是唯一事实」的口径。
 * @param failure - `agent/request-error` 载荷里的失败。
 * @returns 两把锁都成立时为 true。
 */
export function isPruningRejection(failure: { readonly code: string, readonly message: string }): boolean {
  if (!REJECTION_CODES.includes(failure.code)) return false
  return REJECTION_WORDING_PATTERNS.every(pattern => pattern.test(failure.message))
}

/**
 * 落一条**还原 + 停用**决策（激活点 ⑤）。还原与停用是同一条事件，所以这里只有一次 `append`。
 *
 * 顺序写死：先判已停用（否则每一次后续拒收都会再落一条、并把会话拖回重试），再算还原范围。还原范围是
 * 「已裁过的 seq」∩「当前表面节点」：被 compaction 遮蔽过的步骤已不在模型可见历史里，既不是肇因、写回也
 * 无效（fold 不校验投影返回的键，把非节点写进投影只会留下一条永远不被读到的替换）。
 * @param session - 活跃会话。
 * @param diagnostics - 事后可查的四个字段；**不含错误原文**（网关正文可能回显请求内容）。
 * @returns 落盘的事件序号；本会话已停用时为 `undefined`（不重复落盘）。
 * @throws 投影校验不通过时（非法形状）。
 */
export function suspendPruningAndRestore(
  session: Session,
  diagnostics: Pick<ReasoningSuspendPayload['clipclop'], 'provider' | 'model' | 'errorCode' | 'wording'>,
): SessionSeq | undefined {
  if (isPruningSuspended(session)) return undefined
  const nodes = new Set<SessionSeq>(session.surface.nodes)
  const restore = [...readPrunedSteps(session)].filter(seq => nodes.has(seq)).sort((a, b) => a - b)
  const payload: ReasoningSuspendPayload = { clipclop: { restore, ...diagnostics } }
  return session.append(
    CARRIER_EVENT_TYPE,
    payload as unknown as SessionEventMap[typeof CARRIER_EVENT_TYPE],
  ).seq
}

/**
 * 本步骤的保留窗口从哪一条开始：保留窗口是「已记录历史里最近 `K` 个步骤」。
 *
 * 窗口的右端取「已记录条数」而不是由步号推算：`agent/pre-step` 载荷里的 `step` 是 turn 内步号，恢复的
 * 会话也会从 1 重数；以日志为准让「首个 turn」与「恢复的会话 + 新步骤」用同一条规则。
 * @param recordedCount - 已记录的 `assistant/message` 条数。
 * @param keep - 保留窗口 `K`。
 * @returns 保留窗口的第一条在已记录序列里的下标（可为负，表示全部都在窗口内）。
 */
function firstKeptIndex(recordedCount: number, keep: number): number {
  return recordedCount - keep
}

/**
 * 本步骤的**会话级**步号：日志里已提交的 `step/start` 条数 + 1。
 *
 * **不能用 `agent/pre-step` 载荷里的 `step`**：它是 turn 内从 1 重数的步号
 * （`agent-loop/src/agent.ts:315` 取 `phase.step + 1`、`:377` 在每个新 turn 前把 `phase.step` 归零）。
 * 用它取模会把「每 `M` 个步骤推进一次」退化成「每个 turn 内的每 `M` 步推进一次」——turn 长度不足 `M` 的
 * 会话（默认 `M = 50`）一次都不推进，而 ② 是本插件唯一的常规收益路径。
 *
 * 日志口径同时给出重载一致性：恢复的会话带着全部历史的 `step/start`，所以下一次触发点仍是会话级步数的
 * 下一个 `M` 的整数倍，不会因重载补打一次。
 * @param session - 会话。
 * @returns 本步骤的会话级步号（会话的第一个步骤为 1）。
 */
function sessionStepNumber(session: Session): number {
  let started = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'step/start') started += 1
  }
  return started + 1
}

/**
 * 激活点② 的选区：本步骤该推进到哪一批历史步骤。
 *
 * 已记录步骤里，最近 `K` 步原样保留，其余按 seq 升序返回；**已裁过的不再返回**（单向性的实现面），
 * **已不是当前表面节点的也不再返回**（见下）。
 *
 * **首次触发的批量必须非空**：第 `M` 步的 pre-step 上已有 `M - 1` 条已记录步骤，减掉保留窗口 `K`。这个
 * 不变式对默认值的要求是 `M ≥ K + 2`（`M = K + 1` 时首次触发恰好只剩保留窗口，见 `Config` 的注释）；
 * `K ≥ M` 会让每次到点都是空批量，而 `targets` 为空的事件被投影校验与写入侧同时禁止。
 *
 * **候选必须与当前表面节点取交集**：`recordedAssistantMessages` 读的是全量日志，而被压缩
 * （`surfaceOp: 'replace'`）遮蔽过的历史步骤不再是表面节点；把这样的 seq 写进 `targets` 会让投影校验
 * （`target seq N is not a current surface node`）在 `append` 时当场抛，把一个正常的 agent 步骤打断。
 * @param session - 会话。
 * @param config - 已解析的配置。
 * @returns 本批应裁的 seq，按 seq 升序；没有可推进的步骤时为空数组。
 */
export function pruneTargetsAtStep(session: Session, config: PruneParameters): SessionSeq[] {
  return candidateTargets(session, config.keepRecentSteps)
}

/**
 * 激活点④ 的选区：与 ② 同一条候选口径，但**不设保留窗口**。
 *
 * `K`（最近几个步骤不裁）是 ② 的参数（规格把它与 `M` 一起定义在 ② 名下）；④ 是用户当场要求的动作，不再
 * 按步数打折。资格判定不在选区内，仍由 {@link persistReasoningPrune} 逐步骤强制。
 * @param session - 会话。
 * @returns 本批应裁的 seq，按 seq 升序；没有可裁步骤时为空数组。
 */
export function pruneTargetsAtCommand(session: Session): SessionSeq[] {
  return candidateTargets(session, 0)
}

/**
 * 两个激活点共用的候选口径：已记录步骤里第 `keep` 个之前、仍是当前表面节点、且尚未裁过的那些。
 *
 * 已裁过的不再返回（单向性的实现面，`边界只能向新推进`）；已不是当前表面节点的也不再返回——被摘要
 * （`surfaceOp: 'replace'`）遮蔽过的步骤若进了 `targets`，投影校验会在 `append` 时当场抛
 * （`target seq N is not a current surface node`）。
 * @param session - 会话。
 * @param keep - 保留窗口 `K`；`0` 表示不设窗口。
 * @returns 本批应裁的 seq，按 seq 升序。
 */
function candidateTargets(session: Session, keep: number): SessionSeq[] {
  const recorded = [...recordedAssistantMessages(session).keys()].sort((a, b) => a - b)
  const pruned = readPrunedSteps(session)
  const nodes = new Set<SessionSeq>(session.surface.nodes)
  const firstKept = firstKeptIndex(recorded.length, keep)
  return recorded.filter((seq, index) => index < firstKept && nodes.has(seq) && !pruned.has(seq))
}

/**
 * 两个激活点共用的推进尾：信号已中止时不动作，否则按选区落盘一批。
 *
 * 两个触发点的差别**只在便宜的门禁**上——② 多一道步数节流，① 没有门禁（失败本身就是触发器）；选区与
 * 写入完全同一条路径。
 * @param session - 活跃会话。
 * @param signal - 该请求/该步的取消信号。
 * @param config - 已解析的配置。
 * @returns 落盘的事件序号；无可裁步骤或信号已中止时为 `undefined`。
 */
function advanceBoundary(
  session: Session,
  signal: AbortSignal,
  config: PruneParameters,
): SessionSeq | undefined {
  if (signal.aborted) return undefined
  return persistReasoningPrune(session, pruneTargetsAtStep(session, config))
}

/**
 * 激活点② 的触发：会话级步数到达 `M` 的整数倍时批量推进一次边界。
 *
 * **节奏只由本函数自己的步数口径决定**（日志里的 `step/start` 条数，见 `sessionStepNumber`），与上下文
 * 占比无关：`ctx.tokenMeter.measure()` 按**原始表面事件**定价、不读投影（`packages/llm/token-meter/src/index.ts:146-157`
 * 的 `priceSurface(state.surface, …)`），所以裁剪省下的钱不会让读数下降，用读数判压在这里是错的。表现是
 * 「省了钱、界面上的上下文占比不动」，这是机制事实而不是缺陷。
 * @param session - 活跃会话。
 * @param signal - 该步的取消信号；已中止时不动作。
 * @param config - 已解析的配置。
 * @returns 落盘的事件序号；未到点、无可推进步骤或信号已中止时为 `undefined`。
 */
export function pruneAtStepBoundary(
  session: Session,
  signal: AbortSignal,
  config: PruneParameters,
): SessionSeq | undefined {
  if (sessionStepNumber(session) % config.everySteps !== 0) return undefined
  return advanceBoundary(session, signal, config)
}

/**
 * 激活点① 的触发：请求**已经**因 `CONTEXT_WINDOW_EXCEEDED` 失败时，按与 ② 相同的选区推进一次。
 *
 * 失败本身就是触发器，这里没有任何门禁。裁剪只改模型可见内容（投影推进 `contentGeneration`，不推进
 * `replaceGeneration`），因此它自己不会让 compaction-basic 判定为进展；搭车成立与否由它决定
 * （见设计文档「激活点 ①：溢出救援」）。
 * @param session - 活跃会话。
 * @param signal - 该 turn 的取消信号；已中止时不动作。
 * @param config - 已解析的配置。
 * @returns 落盘的事件序号；无可裁步骤或信号已中止时为 `undefined`。
 */
export function pruneAtRequestError(
  session: Session,
  signal: AbortSignal,
  config: PruneParameters,
): SessionSeq | undefined {
  return advanceBoundary(session, signal, config)
}

/**
 * 裁剪资格成立的子集，按传入顺序，且**逐步骤**判定。
 *
 * 同一会话中途换模型会混用传输，所以这里不按会话整体判定，也不接受「会话有资格」这种整体结论。资格读的
 * 是每条消息自己的耐久 replay 信封（见 `isReasoningPrunable`）。
 * @param session - 有已记录历史的活跃会话。
 * @param targets - 候选 seq。
 * @returns 资格成立的 seq；不是已记录的 `assistant/message`、或信封判不出资格的，一律丢弃。
 */
function eligiblePruneTargets(session: Session, targets: readonly SessionSeq[]): SessionSeq[] {
  const recorded = recordedAssistantMessages(session)
  const eligible: SessionSeq[] = []
  for (const target of targets) {
    const message = recorded.get(target)
    if (message !== undefined && isReasoningPrunable(message)) eligible.push(target)
  }
  return eligible
}

/**
 * 追加一条耐久裁剪决策。
 *
 * 承载类型的 payload 类型由宿主声明，而本插件的形状只能作包内接口（同名键再声明一次是接口合并的重复
 * 属性错误，实测 TS2717），所以写入侧只能 cast——这是「不修改 DSH 核心源码」在本设计里唯一要付的类型
 * 绕过。运行期的形状闸门是投影自己的校验，见模块头注释。
 *
 * **停用是这里的一道闸门，不是调用方的自觉**（激活点 ⑤）：①②④ 三个入口都从本函数落盘，所以「本会话已
 * 存在还原/停用事件」这一个判定就把三条路径一起停掉——只停其一没有意义，三个入口产生的是同一种事件与
 * 同一种线上形状。
 *
 * **资格判定落在本函数里而不是调用方的自觉上**：候选先过 {@link eligiblePruneTargets}，资格不成立时
 * 一个事件都不写。这是内外两个约束的同一端——投影校验要求 `targets` 非空，所以「无资格」不能落一条空
 * 记录；空记录会污染日志，并让闸门 C 的降级判据难以判断。
 * @param session - 活跃会话。
 * @param targets - 候选历史步骤，按各自的 `assistant/message` seq 列出。
 * @returns 落盘的事件序号；没有资格成立的候选、或本会话已停用时**不写任何东西**并返回 `undefined`。
 * @throws 投影校验不通过时（非法形状、非当前表面节点、不是 `assistant/message`、重复 seq）。
 */
export function persistReasoningPrune(
  session: Session,
  targets: readonly SessionSeq[],
): SessionSeq | undefined {
  if (isPruningSuspended(session)) return undefined
  const eligible = eligiblePruneTargets(session, targets)
  if (eligible.length === 0) return undefined
  const payload: ReasoningPrunePayload = { clipclop: { targets: eligible } }
  return session.append(
    CARRIER_EVENT_TYPE,
    payload as unknown as SessionEventMap[typeof CARRIER_EVENT_TYPE],
  ).seq
}
