/**
 * 票据 04：一次复核的收场结算成记录（三态表、配置快照、记录不进会话、不复制正文）。
 *
 * 观察面按票面写死：完成列与三态形状走本票导出的读回入口；失败列直接看 JSON 后端根下的
 * **原始存储文档**（读回入口经声明 schema 解析、会剥掉未知键）；「不存事件序号 / 不复制正文」
 * 同样只看原始文档。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  REVIEW_DOMAIN_NAME,
  REVIEW_TABLE,
  REVIEW_TIMEOUT_CODE,
  readReviewRecords,
  replayReviewRecord,
  reviewRecordKey,
  writeReviewRecord,
  type Config,
  type ReviewRecordInput,
} from '../src/index.ts'
import { SCRIPTED_USAGE, type ScriptedResponse } from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import { isReviewRequest, mountNavigatorLoop, type NavigatorLoop } from './support/loop-fixture.ts'

/** 每个用例一套独立 context；磁盘根也逐用例回收。 */
const roots: string[] = []

afterEach(async () => {
  await disposeTrackedContexts()
  await Promise.all(roots.splice(0).map(
    root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
})

/**
 * 造一个空的 JSON 后端根。
 * @returns 临时目录路径。
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-review-'))
  roots.push(root)
  return root
}

/** 一条主请求的脚本回复。 */
const OK = { text: '收到' }

/** 一段能过严格解析的复核结论。 */
const VERDICT_TEXT = '{"verdict":"continue","reason":"看起来正常","recommendation":"无"}'

/** 上一条的解析结果。 */
const VERDICT = { verdict: 'continue', reason: '看起来正常', recommendation: '无' } as const

/** 夹具配置的落值形态：`{ triggerEverySteps: 1 }` 之外全是 `Config` 的缺省值。 */
const RESOLVED_CONFIG = {
  triggerEverySteps: 1,
  mode: 'wait',
  reviewTimeoutMs: 120_000,
  maxOutputTokens: 4096,
  failurePolicy: 'continue',
  prompt: '',
} as const satisfies Required<Config>

/** 一次真实复核跑完之后的夹具、后端根与会话 id。 */
interface SettledReview {
  readonly root: string
  readonly fixture: NavigatorLoop
  readonly sessionId: SessionId
}

/**
 * 读某个会话某一步的原始存储文档里的 `record`（不经读回入口、不复制 schema）。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 触发步骤。
 * @returns 文档里的 `record` 原值。
 */
async function rawRecord(root: string, sessionId: SessionId, triggerStep: number): Promise<Record<string, unknown>> {
  const path = join(root, REVIEW_DOMAIN_NAME, REVIEW_TABLE, `${reviewRecordKey(sessionId, triggerStep)}.json`)
  const document = JSON.parse(await readFile(path, 'utf8')) as { record: Record<string, unknown> }
  return document.record
}

/**
 * 挂一套带真存储栈的夹具，跑完「触发一次真实复核」的两步。
 * @param options - 脚本与配置（缺省配置即 `{ triggerEverySteps: 1 }`）。
 * @returns 后端根、夹具与会话 id。
 */
async function settledReview(options: {
  readonly script?: readonly ScriptedResponse[]
  readonly config?: Config
} = {}): Promise<SettledReview> {
  const root = await tempRoot()
  const fixture = await mountNavigatorLoop({
    storageRoot: root,
    config: { triggerEverySteps: 1, ...options.config },
    script: options.script ?? [OK, { text: VERDICT_TEXT }],
  })
  await fixture.send('第一步')
  await fixture.send('第二步')
  return { root, fixture, sessionId: fixture.agent.session.id }
}

describe('复核结算：完成列与三态形状', () => {
  it('完成态记录的每一格都按记录表取值，且绑到触发点；重挂载后仍读得回', async () => {
    const { fixture, sessionId } = await settledReview({ script: [OK, { text: VERDICT_TEXT }] })
    const review = fixture.reviews()[0]
    expect(review).toBeDefined()
    const snapshotIds = [...(review?.snapshotIds ?? [])]

    // 第 1 条的读回：同一个后端根下重挂载之后，仍按会话 id 读回那条完成态记录。
    await fixture.remountPlugin()
    const records = readReviewRecords(sessionId)

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      triggerStep: review?.steps,
      config: RESOLVED_CONFIG,
      durationMs: expect.any(Number),
      status: 'completed',
      messageIds: snapshotIds,
      verdict: VERDICT,
      usage: SCRIPTED_USAGE,
    })
    // 「绑到触发点」：只断有值的话，实现落一个 id 也全绿，所以按原顺序逐项比。
    expect(records[0]?.messageIds).toEqual(snapshotIds)
  })

  it('取消列：不依赖取消路径的格子按写入入口的形状断，结论与失败原因正面为 undefined', async () => {
    const { fixture, sessionId } = await settledReview()
    const cancelled: ReviewRecordInput = {
      triggerStep: 4,
      config: RESOLVED_CONFIG,
      durationMs: 3,
      status: 'cancelled',
      cancelReason: 'task-ended',
    }

    await writeReviewRecord(sessionId, cancelled)
    const record = readReviewRecords(sessionId).find(candidate => candidate.triggerStep === 4)

    expect(record).toEqual(cancelled)
    // 正面断 `undefined`：只断「夹具没传」的话，实现把默认值一起写进去也绿。
    expect(record?.verdict).toBeUndefined()
    expect(record?.failureReason).toBeUndefined()
    // 取消列的正值格。
    expect(record?.durationMs).toBe(3)
    expect(record?.config).toEqual(RESOLVED_CONFIG)
    expect(record?.cancelReason).toBe('task-ended')
    expect(fixture.pluginFiber()?.state).toBeDefined()
  })
})

describe('复核结算：失败列四种输入（按真实收场、看原始文档）', () => {
  it.each([
    { name: '适配器抛错', script: [OK, { error: '适配器炸了' }, OK] },
    { name: '输出无法解析', script: [OK, { text: '这段不是 JSON' }, OK] },
  ] as const)('$name', async ({ script }) => {
    const { root, fixture, sessionId } = await settledReview({ script: [...script] })
    const step = fixture.reviews()[0]?.steps ?? 0
    const record = await rawRecord(root, sessionId, step)

    expect(record['status']).toBe('failed')
    expect(typeof record['failureReason']).toBe('string')
    expect(record['failureReason']).not.toBe('')
    expect(record['verdict']).toBeUndefined()
    expect(record['cancelReason']).toBeUndefined()
    expect(typeof record['durationMs']).toBe('number')
    expect(record['triggerStep']).toBe(step)
    expect(record['config']).toBeDefined()
  })

  it('中间件 / 下游抛错：异常在调用点抛出，由结算自己收，失败原因取异常文本', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      storageRoot: root,
      config: { triggerEverySteps: 1 },
      script: [OK],
    })
    // 请求根本到不了适配器，所以触发点也从投影读——`reviews()` 在这里永远是空的。
    let step = 0
    // 中间件失败保持抛出、不会变成终态 chunk（机制见设计文档「测试决策」），与适配器返回的错误不同。
    fixture.ctx.on('llm/stream', (options, next) => {
      if (!isReviewRequest(options)) return next()
      step = fixture.ctx.sessionProjections.stateOf(fixture.agent.session, 'navigatorSteps')?.steps ?? 0
      throw new Error('中间件失败了')
    })
    await fixture.send('第一步')
    await fixture.send('第二步')

    const record = await rawRecord(root, fixture.agent.session.id, step)
    expect(step).toBe(1)
    expect(record['status']).toBe('failed')
    expect(String(record['failureReason'])).toContain('中间件失败了')
  })

  it('超时：复核自己的 signal 上命中超时代码，落一条失败记录', async () => {
    const { root, fixture, sessionId } = await settledReview({
      script: [OK, { hang: true }, OK],
      config: { reviewTimeoutMs: 50 },
    })
    const review = fixture.reviews()[0]
    const step = review?.steps ?? 0

    // 判别式落在复核自己的 signal（`deadline` 融合出来的那个）上，不是 pre-step 载荷的 `upstream`。
    const signal = review?.request.signal
    expect(signal).toBeDefined()
    expect(timeoutOf(signal ?? new AbortController().signal, REVIEW_TIMEOUT_CODE)).toBeDefined()
    const record = await rawRecord(root, sessionId, step)
    expect(record['status']).toBe('failed')
    expect(String(record['failureReason'])).not.toBe('')
  })
})

describe('复核结算：配置快照与记录的边界', () => {
  it('中途改配置后，已发生的记录逐字段不变，新记录用新配置', async () => {
    const { fixture, sessionId } = await settledReview()
    await fixture.updateConfig({ triggerEverySteps: 1, prompt: '改过的提示词' })
    // 改配置会重跑 `apply` 并从零重新推导触发点，所以再跑两步才轮到下一次复核。
    await fixture.send('第三步')
    await fixture.send('第四步')

    const records = readReviewRecords(sessionId)
    expect(records.map(record => record.triggerStep)).toEqual([1, 3])
    // 逐字段比较：域 schema 漏写或多写一个配置字段会在这里红，不需要另加键集断言。
    expect(records[0]?.config).toEqual(RESOLVED_CONFIG)
    expect(records[1]?.config).toEqual({ ...RESOLVED_CONFIG, prompt: '改过的提示词' })
  })

  it('记录不进会话：事件类型集合、deriveMessages 序列与子会话清单三样都不变', async () => {
    const root = await tempRoot()
    /** 本会话的事件类型，按顺序收一份，用来切基线窗口。 */
    const seen: string[] = []
    /** 基线窗口内的事件类型集合：上一个 `turn/end` 之后、本触发轮 `step/start` 之前。 */
    const windowTypes = (): string[] => {
      let start = 0
      for (const [index, type] of seen.entries()) if (type === 'turn/end') start = index + 1
      const types: string[] = []
      for (const type of seen.slice(start)) {
        if (type === 'step/start') break
        types.push(type)
      }
      return [...new Set(types)].sort()
    }
    const messageSignature = (): string[] =>
      fixture.agent.session.deriveMessages().map(message => `${message.id}:${JSON.stringify(message.content)}`)
    const agentIds = (): string[] => fixture.ctx.agents.list().map(agent => String(agent.session.id))
    const sample = (): { types: string[], messages: string[], agents: string[] } =>
      ({ types: windowTypes(), messages: messageSignature(), agents: agentIds() })

    let fixture: NavigatorLoop
    let before: ReturnType<typeof sample> | undefined
    let after: ReturnType<typeof sample> | undefined
    fixture = await mountNavigatorLoop({
      storageRoot: root,
      config: { triggerEverySteps: 1 },
      script: [OK, { text: VERDICT_TEXT }],
      observeRequest: (request) => {
        // 触发点的 pre-step 早于本步的 `step/start` / `assistant/message`：这里就是「复核之前」。
        if (isReviewRequest(request) && before === undefined) before = sample()
      },
    })
    fixture.ctx.on('session/event', (subject, event) => {
      if (subject !== fixture.agent.session) return
      seen.push(event.type)
      if (event.type === 'step/start' && before !== undefined && after === undefined) after = sample()
    })

    await fixture.send('第一步')
    await fixture.send('第二步')

    expect(before).toBeDefined()
    expect(after).toBeDefined()
    // 基线非空（本轮的 user 消息已在窗口里），否则「相等」是空转。
    expect(before?.types.length).toBeGreaterThan(0)
    expect(after?.types).toEqual(before?.types)
    expect(after?.messages).toEqual(before?.messages)
    expect(after?.agents).toEqual(before?.agents)
    expect(fixture.ctx.agents.roots()).toHaveLength(1)
  })

  it('回放：命中的 id 序列与记录一致，第二个列表能证伪', async () => {
    const { fixture, sessionId } = await settledReview()
    const [record] = readReviewRecords(sessionId)
    // 两样输入都不手搓：id 列表取自那次真实复核落下的完成态记录，消息取自同一 loop 的会话。
    const messageIds = [...(record?.messageIds ?? [])]
    expect(messageIds.length).toBeGreaterThan(0)

    const replayed = replayReviewRecord(messageIds, fixture.agent.session.deriveMessages())
    expect(replayed.hit).toEqual(messageIds)
    expect(replayed.missing).toEqual([])

    // 第二个列表要能证伪：只按原 id 列表定位时它恒为 `[]`，追加一个当前消息里不存在的 id 才测得出来。
    const ghost = 'ghost-message-id'
    const withGhost = replayReviewRecord([...messageIds, ghost], fixture.agent.session.deriveMessages())
    expect(withGhost.hit).toEqual(messageIds)
    expect(withGhost.missing).toEqual([ghost])
  })

  it('原始文档里不存事件序号、也不复制消息正文', async () => {
    const marker = 'MARKER-4f21'
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      storageRoot: root,
      config: { triggerEverySteps: 1 },
      script: [OK, { text: VERDICT_TEXT }],
    })
    await fixture.send(`第一步 ${marker}`)
    await fixture.send('第二步')

    const sessionId = fixture.agent.session.id
    const step = fixture.reviews()[0]?.steps ?? 0
    const marked = fixture.agent.session.deriveMessages().find(
      message => JSON.stringify(message.content).includes(marker),
    )
    expect(marked).toBeDefined()

    const path = join(root, REVIEW_DOMAIN_NAME, REVIEW_TABLE, `${reviewRecordKey(sessionId, step)}.json`)
    const text = await readFile(path, 'utf8')
    // 「不复制正文」：正文里的唯一标记串在原始文档里搜不到，且 messageIds 正好指到那条消息。
    expect(text).not.toContain(marker)
    const record = await rawRecord(root, sessionId, step)
    expect(record['messageIds'] as unknown[]).toContain(marked?.id)
    // 「不存事件序号」：原始文档的键集恰好是声明 schema 的那几个，没有多带的字段。
    expect(Object.keys(record).sort()).toEqual([
      'config', 'durationMs', 'messageIds', 'status', 'triggerStep', 'usage', 'verdict',
    ])
    expect(Object.keys(readReviewRecords(sessionId)[0] ?? {}).sort()).toEqual(Object.keys(record).sort())
  })
})
