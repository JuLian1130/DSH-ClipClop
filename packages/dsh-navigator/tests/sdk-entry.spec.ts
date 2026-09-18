/**
 * SDK 入口腿（票据 12 第 2 条）：复核建议出现在 **SDK 可读取的会话消息序列与事件流**里，并且后续多轮的
 * 模型可见上下文里含它。
 *
 * 装配是发布态 CLI 的真实 `--profile sdk`（SDK JSON-RPC 服务端），客户端走 `@deepseek-ai/dsh-sdk-client`
 * 的 `DeepSeekHarness`；本包的构建产物由 `--patch` 覆盖按绝对路径装进同一棵树。机制、路线与版本见票据
 * 备注的前置核实结论。
 *
 * **id 截获点**：`tests/support/notice-observer.mjs` 在子进程内、`user/message` 提交那一刻记下 notice 的
 * id 与正文；本用例断「SDK 读回的那条消息 id」等于这份落盘读数——两个读数来自不同路径（协议反读 vs
 * 会话事件提交点），所以不是恒真句。
 *
 * @module
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { keepTurnAlive, mainRequestsContaining, startMockModel } from './support/mock-model.ts'
import {
  assertBuiltEntry,
  createLegHome,
  dshBinPath,
  legEnv,
  readObservedNotices,
  writeNavigatorPatch,
} from './support/runtime-entry.ts'

/** 第 1 步触发（锚点 0 + 间隔 1），所以恢复出的正文以「第 1 步」开头。 */
const RECOMMENDATION = '把范围收窄到入口联调'
const REVIEW = { verdict: 'adjust', reason: '目标已经偏移', recommendation: RECOMMENDATION }
const NOTICE_TEXT = `第 1 步的导航复核建议：${RECOMMENDATION}`

/** 收尾按登记顺序倒着跑：先关 harness，再关 mock，最后删临时 home。 */
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** 一次运行里落盘的 notice 消息（`source.form === 'notice'`），按事件顺序。 */
function noticedMessages(events: readonly SessionEvent[]): { id: string, text: string }[] {
  return events
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => event.data)
    .filter(message => message.source.kind === 'plugin' && message.source.form === 'notice')
    .map(message => ({
      id: message.id,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }))
}

describe('SDK 入口腿', () => {
  it('SDK 读回的建议 id 等于落盘那一刻该消息自身的 id，且后续多轮的模型可见上下文含它', async () => {
    assertBuiltEntry()
    const home = createLegHome('dsh-navigator-sdk-')
    const noticesFile = join(home, 'notices.jsonl')
    const patch = writeNavigatorPatch(home, { triggerEverySteps: 1, noticesFile })
    const model = await startMockModel(({ isReview }, attempt) => isReview
      ? { text: JSON.stringify(REVIEW) }
      : attempt === 1 ? keepTurnAlive(attempt) : { text: '收到' })
    cleanups.push(() => { rmSync(home, { recursive: true, force: true }) })

    const harness = new DeepSeekHarness({
      dshBin: dshBinPath(),
      patches: [patch],
      dshHome: home,
      cwd: home,
      env: legEnv(model.baseURL, home),
      initializeTimeoutMs: 60_000,
      requestTimeoutMs: 120_000,
    })
    cleanups.push(() => harness.close())
    cleanups.push(() => model.close())

    const session = harness.session()
    const first = await session.run('先把这一步走完')
    const notices = noticedMessages(first.events)
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toBe(NOTICE_TEXT)

    // 独立读数：提交点截获的 id 与正文（不经过 SDK 协议）。
    const observed = readObservedNotices(noticesFile)
    expect(observed).toHaveLength(1)
    expect(notices[0].id).toBe(observed[0].id)
    expect(observed[0].text).toBe(NOTICE_TEXT)

    // 随后继续多轮：这次之后新发的主会话请求里，模型可见上下文含那条建议。
    const requestsBefore = model.requests.length
    await session.run('继续')
    const laterRequests = model.requests.slice(requestsBefore)
    expect(laterRequests.length).toBeGreaterThan(0)
    expect(mainRequestsContaining(laterRequests, NOTICE_TEXT).length).toBeGreaterThan(0)
  }, 180_000)
})
