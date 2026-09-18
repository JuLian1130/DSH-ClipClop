// @vitest-environment jsdom
/**
 * Web 入口腿（票据 12 第 1 条）：那条复核建议在**对话视图**里出现、展开后含正文，且**会话重载后仍在**。
 *
 * 两半都要真：notice 由真实复核路径产生——真实 CLI profile + 本包构建产物跑一轮，落下的会话事件直接
 * 就是客户端要装配的那份历史；对话视图由自建的最小客户端夹具渲染（见
 * `tests/support/client-conversation.ts`，为什么不能直接用官方的客户端测试设施也写在那里）。
 *
 * **重载**按票面写死：重新装配后再断，不用同一份 test-owned doubles 重挂——每条断言都重新读一次持久化
 * 条目（两个各自独立的数组）、各自 `bootConversation`（新模块表、新 context、新会话绑定与事件源）。
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { bootConversation, type ClientSessionEntry } from './support/client-conversation.ts'
import {
  assertBuiltEntry,
  createLegScope,
  dshBinPath,
  legEnv,
  mountNavigatorLeg,
  readObservedNotices,
} from './support/runtime-entry.ts'

/** 第 1 步触发（锚点 0 + 间隔 1），所以建议正文以「第 1 步」开头。 */
const RECOMMENDATION = '把范围收窄到入口联调'
const REVIEW = { verdict: 'adjust', reason: '目标已经偏移', recommendation: RECOMMENDATION }
const NOTICE_TEXT = `第 1 步的导航复核建议：${RECOMMENDATION}`

const scope = createLegScope()
afterEach(() => scope.dispose())

/**
 * 从持久化条目装配一次并断三件事：折叠行在、展开后含正文、展开前不显示正文。
 *
 * `[data-disclosure-row="true"]` 不止这一行（系统提示词、推理行等都是折叠行），所以按「这一行里那条
 * notice 的 `data-context-summary` 就是它的正文」定位；定位不到就硬失败，不取任意一行。
 * @param sessionId - 会话 id。
 * @param entries - 这次装配读入的历史条目。
 */
async function assertNoticeRow(sessionId: string, entries: readonly ClientSessionEntry[]): Promise<void> {
  const booted = await bootConversation(sessionId, entries)
  try {
    const row = [...booted.container.querySelectorAll<HTMLElement>('[data-disclosure-row="true"]')]
      .find(candidate => candidate.querySelector('[data-context-summary]')?.textContent === NOTICE_TEXT)
    if (row === undefined) throw new Error(`web leg: no notice row carrying summary ${JSON.stringify(NOTICE_TEXT)}`)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(booted.container.querySelector('[data-context-injection-body]')).toBeNull()

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const body = booted.container.querySelector('[data-context-injection-body]')
    expect(body?.getAttribute('data-context-form')).toBe('notice')
    expect(body?.textContent).toContain(NOTICE_TEXT)
  } finally {
    await booted.dispose()
  }
}

describe('Web 入口腿', () => {
  it('对话视图里出现那条折叠行、展开后含正文，且会话重载后仍在', async () => {
    assertBuiltEntry()
    const { home, noticesFile, patch, model } = await mountNavigatorLeg('dsh-navigator-web-', REVIEW, scope)

    const harness = new DeepSeekHarness({
      dshBin: dshBinPath(),
      patches: [patch],
      dshHome: home,
      cwd: home,
      env: legEnv(model.baseURL, home),
      initializeTimeoutMs: 60_000,
      requestTimeoutMs: 120_000,
    })
    scope.add(() => harness.close())

    // 真实复核路径：跑一轮，让插件到点复核并注入建议。
    const session = harness.session()
    const run = await session.run('先把这一步走完')
    const observed = readObservedNotices(noticesFile)
    expect(observed).toHaveLength(1)
    expect(observed[0].text).toBe(NOTICE_TEXT)

    // 会话历史就是这次运行落下的真实事件流；装配读的是它，不是手造的折叠行。
    const entries = run.events.map((event): ClientSessionEntry => ({ type: 'event', event }))
    const noticeEntry = entries.find((entry): entry is ClientSessionEntry & { event: SessionEvent<'user/message'> } =>
      entry.event.type === 'user/message'
      && entry.event.data.source.kind === 'plugin'
      && entry.event.data.source.form === 'notice')
    expect(noticeEntry?.event.data.id).toBe(observed[0].id)

    // 持久化物：重载两次都从它重新读入（两次读成两个独立数组）。
    const persisted = join(home, 'session-events.json')
    writeFileSync(persisted, JSON.stringify(entries))
    const readPersisted = (): ClientSessionEntry[] => JSON.parse(readFileSync(persisted, 'utf8')) as ClientSessionEntry[]

    await assertNoticeRow(session.id, readPersisted())
    // 「会话重载」：重新装配（新模块表 / 新 context / 新绑定与事件源），事件从同一份持久化物重新读入。
    await assertNoticeRow(session.id, readPersisted())
  }, 240_000)
})
