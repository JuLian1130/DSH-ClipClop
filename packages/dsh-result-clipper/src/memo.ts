/**
 * 摘要 memo：隐私关闭时按（工具名, 正文 hash）在会话内复用同一条摘要。
 *
 * 命中的意义是**省下一次带正文的摘要请求**——查找发生在（06 的）准入判断之前，命中即整条摘要请求路径短路；
 * 命中仍走替换路径（长度比较、写入口说明、替换 `content`），只是不再问模型。`keep` 没有摘要可复用，因此
 * 不进 memo，重复读取照常重新判断。
 *
 * key 用正文 hash 而不是读取参数：`read → edit → read` 是高频序列，按（path, offset, limit）命中会把修改前
 * 的摘要返给修改后的内容；加上工具名是避免把另一工具语境下的摘要复用到同名内容上。
 *
 * 台账按会话 id 分开——重启或 fork 出的新会话看不到旧会话的摘要；每个会话是 LRU 上限 {@link MEMO_LIMIT} 条：
 * 命中刷新最近使用次序，超出上限淘汰最久未用的一条。
 *
 * @module
 */

import { createHash } from 'node:crypto'

/** memo 上限（固定常量，不可配）：每个会话 200 条。 */
export const MEMO_LIMIT = 200

/** 工具执行里 memo 要读的两处：工具名与会话归属。 */
export interface MemoExec {
  readonly name: string
  readonly agent?: { readonly session: { readonly header: { readonly id: string } } }
}

/** 按会话分开的摘要台账；每个会话是一张「插入次序即 LRU 次序」的表（`Map` 保序）。 */
export type SummaryMemo = Map<string, Map<string, string>>

/**
 * 取一次调用的会话归属。
 * @param exec - 工具执行。
 * @returns 会话 id；调用不带 agent（本机夹具或非 agent 派发）时为 `undefined`。
 */
function sessionIdOf(exec: MemoExec): string | undefined {
  return exec.agent?.session.header.id
}

/**
 * memo key：工具名 + 正文 hash。hash 变化即视为另一份正文、重新摘要。
 * @param toolName - 工具名。
 * @param body - 送入摘要请求的正文。
 * @returns 台账里的键。
 */
function memoKey(toolName: string, body: string): string {
  return `${toolName}\u0000${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

/**
 * 查一条 memo；命中即刷新它的最近使用次序。
 * @param memo - 会话台账。
 * @param exec - 工具执行（决定工具名与会话）。
 * @param body - 送入摘要请求的正文。
 * @returns 可复用的摘要；没有命中或调用没有会话归属时为 `undefined`。
 */
export function lookupMemo(memo: SummaryMemo, exec: MemoExec, body: string): string | undefined {
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return undefined
  const entries = memo.get(sessionId)
  if (entries === undefined) return undefined
  const key = memoKey(exec.name, body)
  const hit = entries.get(key)
  if (hit === undefined) return undefined
  entries.delete(key)
  entries.set(key, hit)
  return hit
}

/**
 * 记下一条摘要；超过上限时淘汰最久未用的一条。调用没有会话归属时不记（没有会话就没有复用的范围）。
 * @param memo - 会话台账。
 * @param exec - 工具执行（决定工具名与会话）。
 * @param body - 送入摘要请求的正文。
 * @param summary - 模型产出的摘要正文。
 */
export function noteMemo(memo: SummaryMemo, exec: MemoExec, body: string, summary: string): void {
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return
  const key = memoKey(exec.name, body)
  let entries = memo.get(sessionId)
  if (entries === undefined) {
    entries = new Map()
    memo.set(sessionId, entries)
  }
  entries.delete(key)
  entries.set(key, summary)
  if (entries.size > MEMO_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
}
