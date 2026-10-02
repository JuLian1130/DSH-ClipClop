/**
 * 原结果入口：把被替换的完整正文写进 spill 存储，拼出入口说明，并按会话记住写出的 `locator`。
 *
 * **写盘在长度比较之后**（设计文档「原结果入口与保留」的裁决 A）：本模块只提供预留上界
 * {@link ENTRY_RESERVE}，比较本身在 `index.ts` 的摘要路径里。理由：入口说明的实际值由 `saveText` 的返回值
 * 给出，写盘前取不到，所以比较用它的上界——上界性质使「有写盘 ⟹ 实际总长严格短于原文」成立，
 * `not-shorter` 只可能落在未写盘的一侧（不存在先写后弃）。
 *
 * **入口说明 = `locator` + 后端给的 `retrievalHint`，置于摘要正文最前**：默认组合里的旧结果裁剪器裁超长
 * 结果时只保留头 4096 / 尾 1024 字符，写在中间会被删掉。
 *
 * **读回识别只做字符串比对**：记住本会话写出的每个 `locator`，一条 `read` 的 `file_path` 命中即视为读回；
 * 不解析 `locator` 的结构或语义。台账按会话 id 分开，所以会话失效（重启或 fork 出新的会话 id）后同一入口
 * 会被当作普通 `read`。
 *
 * spill 服务与工具执行都只描述用到的结构，不为此新增依赖（照 spill-policy 的 `SpillPolicyExec` 做法）。
 *
 * @module
 */

/** 入口说明在长度比较里的预留上界（字符数，不可配）：本机后端是绝对路径加固定提示句，远低于它。 */
export const ENTRY_RESERVE = 256

/** 入口说明的两半：存储返回的定位符与后端给的取回方法。 */
export interface EntryRef {
  readonly locator: string
  readonly retrievalHint: string
}

/** 一次 `saveText` 请求里本插件用到的字段。 */
export interface SaveEntryInput {
  readonly owner: { readonly sessionId: string }
  readonly source: {
    readonly kind: 'tool'
    readonly toolName: string
    readonly callId: string
    readonly label: 'result'
  }
  readonly suggestedName: string
  readonly content: string
}

/** spill 存储服务的结构视图：只用到 `saveText`。 */
export interface SpillStoreLike {
  saveText(input: SaveEntryInput): Promise<EntryRef>
}

/** 工具执行里本模块要读的三处：调用身份、参数（`read` 的路径）与会话归属。 */
export interface EntryExec {
  readonly callId: string
  readonly arguments: unknown
  readonly agent?: { readonly session: { readonly header: { readonly id: string } } }
}

/** 写盘结果：交给模型的入口说明、要记进读回台账的 `locator`、以及它所属的会话。 */
export interface WrittenEntry {
  readonly entry: string
  readonly locator: string
  readonly sessionId: string
}

/** 按会话分开的「已写出 locator」台账：fork 出的新会话不复用父会话的入口。 */
export type ReadbackLedger = Map<string, Set<string>>

/**
 * 拼出入口说明。
 * @param ref - 存储后端返回的入口。
 * @returns 入口说明正文；调用方把它放在摘要正文最前。
 */
export function composeEntry(ref: EntryRef): string {
  return `原结果入口：${ref.locator}\n${ref.retrievalHint}\n\n`
}

/**
 * 取一次调用的会话归属。
 * @param exec - 工具执行。
 * @returns 会话 id；调用不带 agent（本机夹具或非 agent 派发）时为 `undefined`。
 */
function sessionIdOf(exec: EntryExec): string | undefined {
  return exec.agent?.session.header.id
}

/**
 * 读一条 `read` 的执行参数里的 `file_path`。
 * @param exec - 工具执行。
 * @returns 非空字符串的路径；其余形状为 `undefined`（不解析、不猜测）。
 */
function readPathOf(exec: EntryExec): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const filePath = (args as { file_path?: unknown }).file_path
  return typeof filePath === 'string' ? filePath : undefined
}

/**
 * 把完整正文写进存储并拼出入口说明。失败由调用方按「透传」处理（存储后端不可用时本函数不写、也不摘要）。
 * @param store - spill 存储服务。
 * @param exec - 工具执行（决定会话归属、工具来源与调用 id）。
 * @param toolName - 工具名。
 * @param content - 被替换掉的完整正文。
 * @returns 入口说明、`locator` 与会话 id；调用没有会话归属时为 `undefined`（没有入口就不摘要）。
 */
export async function writeEntry(
  store: SpillStoreLike,
  exec: EntryExec,
  toolName: string,
  content: string,
): Promise<WrittenEntry | undefined> {
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return undefined
  const ref = await store.saveText({
    owner: { sessionId },
    source: { kind: 'tool', toolName, callId: exec.callId, label: 'result' },
    suggestedName: `${toolName}.txt`,
    content,
  })
  return { entry: composeEntry(ref), locator: ref.locator, sessionId }
}

/**
 * 记下本会话写出的一个入口。
 * @param ledger - 读回台账。
 * @param written - {@link writeEntry} 的结果。
 */
export function noteReadback(ledger: ReadbackLedger, written: WrittenEntry): void {
  const known = ledger.get(written.sessionId)
  if (known === undefined) ledger.set(written.sessionId, new Set([written.locator]))
  else known.add(written.locator)
}

/**
 * 这条 `read` 是不是按入口读回。
 * @param ledger - 读回台账。
 * @param exec - 工具执行；调用方已确认工具名是 `read`。
 * @returns `file_path` 命中本会话写出的 `locator` 时为真。
 */
export function isReadBack(ledger: ReadbackLedger, exec: EntryExec): boolean {
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return false
  const path = readPathOf(exec)
  if (path === undefined) return false
  return ledger.get(sessionId)?.has(path) ?? false
}
