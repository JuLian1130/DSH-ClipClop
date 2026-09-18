/**
 * 票据 09：失败与超时 —— 复核失败、超时、输出无法解析时主会话不被无故阻塞或打扰；只有等待模式配了
 * `failurePolicy: stop` 才因此停下；两种模式都不重试。
 *
 * 观察面按票面「共同读法」写死：
 *  - 失败记录按**原始存储文档**读、按该次复核的 `triggerStep` 定位，断该键上恰一条且 `status === 'failed'`；
 *  - 「对话里不留任何内容」只适用于不产生干预动作的格（等待 × `continue` 归 03 的既有用例、并行两格与
 *    1.8）：断 `deriveMessages()` 与主会话模型请求的 `messages` 里都没有本插件来源的 user 消息——等待 ×
 *    `stop` 那一格按规格恰恰要落一条停止说明，不套这句；
 *  - 「原样放行 / 主会话继续」断 `turnEndReasons()` 里没有 hook 触发的 `aborted`、且该 turn 以
 *    `completed` 收尾；
 *  - 「停止当前 turn」断 `turnEndReasons()` 出现 hook 触发的 `aborted`，停止说明按 id 从
 *    `deriveMessages()` 取到、正文以触发步骤开头并写明复核失败（`form: 'notice'` 与 `summary` 非空由 06
 *    定型，不重复断）。
 *
 * 构造写死两处：
 *  ① 触发点值是已完成步数 2（挂载早于第 1 步 + 间隔 2），各格都驱动到第 3 步：只驱动 2 步会停在步边界
 *     上、一次复核都不会发生；复核是本次驱动的第 3 条请求，排在第 3 步自己的主请求之前（`wait` 与
 *     `parallel` 两种模式实测同序），所以脚本里复核回复占第 3 槽。等待 × `stop` 各格必须让触发点那次
 *     pre-step 的批次为空（照抄 04 失败列的「间隔 1 + 真实 `followup`」构造会让规格的作废优先把这格读成
 *     取消态）。
 *  ② 并行各格与 1.8 用夹具的**复核收场回执** `settled(2)` 当唯一的收场同步点：并行续体已脱离本步，失败
 *     又不注入消息、没有 `agent/inbox/inserted` 可当同步点，`drive` 的步边界与 `whenIdle()` 都不覆盖它。
 *     回执在驱动之前先取回——并行续体那种「驱动先返回、记录后落盘」的格必须这样读。
 *
 * 第 2 条与 1.2 / 1.3 **共用同一组构造与读数**（票面明写这处重复不构成错误），所以不另写用例：规格整句的
 * 前三句正是 1.2 / 1.3 断的那三处，末句括注那一支由 2b 断。第 3 条的等待半边是 03 的既有用例（超时 →
 * 恰一条复核请求、主会话不被打断）的复跑，本票新增的只有并行半边与「两种输入都不抛错打断」。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as navigator from '../src/index.ts'
import {
  REVIEW_DOMAIN_NAME,
  REVIEW_TABLE,
  readReviewRecords,
  reviewRecordKey,
} from '../src/index.ts'
import {
  SCRIPTED_TOOL_NAME,
  userMessage,
  type ScriptedResponse,
} from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import { mountNavigatorLoop, type NavigatorLoop, type ObservedCall } from './support/loop-fixture.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-failures-'))
  roots.push(root)
  return root
}

/** 间隔 2：插件早于第 1 步就已挂载，第一次复核的触发点值是 2。 */
const EVERY_STEPS = 2

/**
 * 被读的那次复核的触发点值：触发点值是触发点那一刻的**已完成步数**，不指步号——复核在第 3 步的 pre-step
 * 发出，所以驱动要走满 3 步才轮到它，脚本里复核回复占第 3 槽。
 */
const TRIGGER_STEP = 2
const STEPS_TO_TRIGGER = 3

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** 让会话正常收尾的一步。 */
const DONE: ScriptedResponse = { text: '收到' }

/** 一段让请求挂住不放行的脚本：只有复核自己的 `reviewTimeoutMs` 能把它收场。 */
const HANG: ScriptedResponse = { hang: true }

/** 正常收场、但过不了严格解析的文本。 */
const UNPARSEABLE: ScriptedResponse = { text: '这段不是 JSON' }

/** 超时配短，用例不必等缺省的两分钟。 */
const TIMEOUT_MS = 50

/** 停止说明里要写明的那一条（规格四格表：正文写明复核失败）。 */
const FAILURE_REASON = '复核失败'

/** 两种失败输入，各格各构造一次。 */
const FAILURES = [
  { name: '超时', response: HANG },
  { name: '输出无法解析', response: UNPARSEABLE },
] as const

/**
 * 本次驱动的脚本：第 3 槽是复核回复，其余是主会话自己的步。
 * @param review - 复核请求的回复。
 * @returns 按调用序位的脚本。
 */
function scriptWith(review: ScriptedResponse): ScriptedResponse[] {
  return [STEP, STEP, review, STEP, DONE]
}

/** 同一份合法结论的文本，严格解析三条用例都在这上面换包法。 */
const VALID_JSON = JSON.stringify({ verdict: 'continue', reason: '看起来正常', recommendation: '无' })

/** 规格「输出解析严格」的三例：代码块围栏、前后夹带说明文字、第二个顶层 JSON 值。 */
const STRICT_PARSE_CASES = [
  { name: '代码块围栏包裹', text: `\`\`\`json\n${VALID_JSON}\n\`\`\`` },
  { name: '前后夹带说明文字', text: `好的，结论如下：${VALID_JSON} 以上就是我的判断。` },
  { name: '第二个顶层 JSON 值', text: `${VALID_JSON}\n${VALID_JSON}` },
] as const

/**
 * 读某次复核的原始存储文档里的 `record`（不经读回入口、不复制 schema）。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 触发步骤。
 * @returns 文档里的 `record` 原值。
 */
async function rawRecord(
  root: string,
  sessionId: SessionId,
  triggerStep: number,
): Promise<Record<string, unknown>> {
  const path = join(root, REVIEW_DOMAIN_NAME, REVIEW_TABLE, `${reviewRecordKey(sessionId, triggerStep)}.json`)
  const document = JSON.parse(await readFile(path, 'utf8')) as { record: Record<string, unknown> }
  return document.record
}

/** 一条消息是不是本插件写入的 user 消息（`source.kind === 'plugin'` 且插件名是本插件）。 */
function isPluginUserMessage(message: Message): boolean {
  return message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === navigator.name
}

/** 一条请求是不是本插件的复核请求：末条是本插件注入的复核指令（带 `form` 的是干预消息，不是指令）。 */
function carriesReviewInstruction(call: ObservedCall): boolean {
  const last = call.request.messages.at(-1)
  return last?.role === 'user'
    && last.source.kind === 'plugin'
    && last.source.plugin === navigator.name
    && last.source.form === undefined
}

/**
 * 主会话自己的请求，按**复核指令**排除复核请求——不借夹具 `isReviewRequest` 的启发式（建议被同一次
 * claim 取走、又排在批次末尾时会与复核请求混淆）。
 * @param fixture - 夹具。
 * @returns 主会话自己的请求。
 */
function mainCalls(fixture: NavigatorLoop): readonly ObservedCall[] {
  return fixture.main.calls().filter(call => !carriesReviewInstruction(call))
}

/** 全表里有没有 hook 触发的 `aborted`（`{ kind: 'aborted', reason: { kind: 'hook' } }`）。 */
function hasHookAbort(fixture: NavigatorLoop): boolean {
  return fixture.main.turnEndReasons().some(
    reason => reason.kind === 'aborted' && reason.reason.kind === 'hook',
  )
}

/**
 * 「恰一条失败记录」：按会话 id 读回该次 `triggerStep` 上恰一条 `status === 'failed'`，并按原始存储文档
 * 复验（读回入口经声明 schema 解析、会剥掉未声明的键）。
 * @param root - JSON 后端根。
 * @param sessionId - 会话 id。
 * @param triggerStep - 该次复核的触发步骤。
 */
async function expectFailedRecord(root: string, sessionId: SessionId, triggerStep: number): Promise<void> {
  const records = readReviewRecords(sessionId)
  expect(records.map(record => [record.triggerStep, record.status])).toEqual([[triggerStep, 'failed']])
  expect((await rawRecord(root, sessionId, triggerStep))['status']).toBe('failed')
}

/**
 * 停止说明：先从落盘的 `user/message` 事件取 id，再按 id 从 `deriveMessages()` 取回真实追加路径上的那条
 * 消息（不退化成消息构造函数）。
 * @param fixture - 夹具。
 * @returns 那条停止说明；还没落盘时为 undefined。
 */
function stopNotice(fixture: NavigatorLoop): Message | undefined {
  const event = fixture.events().find(
    candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'plugin'
      && candidate.data.source.plugin === navigator.name,
  )
  const id = event?.type === 'user/message' ? event.data.id : undefined
  return fixture.agent.session.deriveMessages().find(message => message.id === id)
}

/** 一条消息的正文文本。 */
function textOf(message: Message | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

describe('等待 × failurePolicy: stop 的失败（1.2 / 1.3，同一组构造即第 2 条）', () => {
  it.each(FAILURES)('$name：恰一条失败记录 + 停止说明写明复核失败 + 停止当前 turn', async ({ response }) => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, failurePolicy: 'stop', reviewTimeoutMs: TIMEOUT_MS },
      script: scriptWith(response),
      storageRoot: root,
    })
    // 触发点那次 pre-step 的批次为空：驱动期间没有新的真实用户消息，作废优先不会把这格读成取消态。
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')

    await expectFailedRecord(root, fixture.main.session.id, TRIGGER_STEP)

    const notice = stopNotice(fixture)
    expect(notice).toBeDefined()
    expect(textOf(notice).startsWith(`第 ${TRIGGER_STEP} 步`)).toBe(true)
    expect(textOf(notice)).toContain(FAILURE_REASON)

    // 「停止当前 turn」。
    expect(hasHookAbort(fixture)).toBe(true)
    expect(fixture.main.turnEndReasons().at(-1)).toMatchObject({ kind: 'aborted' })
  })
})

describe('并行 × 失败：两格同形（1.4–1.7）', () => {
  it.each(FAILURES)('continue × $name：恰一条失败记录 + 不留内容 + 主会话继续', async ({ response }) => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel', reviewTimeoutMs: TIMEOUT_MS },
      script: scriptWith(response),
      storageRoot: root,
    })
    // 并行续体脱离本步：先取回执，再驱动。
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled

    await expectFailedRecord(root, fixture.main.session.id, TRIGGER_STEP)
    // 「对话里不留任何内容」：失败不注入任何消息，对话里没有本插件来源的 user 消息。
    expect(fixture.agent.session.deriveMessages().filter(isPluginUserMessage)).toEqual([])

    // 主会话继续到该 turn 收尾：主会话自己的请求里也没有本插件消息。
    await fixture.main.drive(1)
    expect(mainCalls(fixture).flatMap(call => call.request.messages).some(isPluginUserMessage)).toBe(false)
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
  })

  it.each(FAILURES)('stop × $name：与 continue 相同——该取值在并行模式下不生效', async ({ response }) => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: {
        triggerEverySteps: EVERY_STEPS,
        mode: 'parallel',
        failurePolicy: 'stop',
        reviewTimeoutMs: TIMEOUT_MS,
      },
      script: scriptWith(response),
      storageRoot: root,
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled

    await expectFailedRecord(root, fixture.main.session.id, TRIGGER_STEP)
    expect(fixture.agent.session.deriveMessages().filter(isPluginUserMessage)).toEqual([])

    await fixture.main.drive(1)
    expect(mainCalls(fixture).flatMap(call => call.request.messages).some(isPluginUserMessage)).toBe(false)
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
  })
})

describe('并行 × 成功 continue：不注入（1.8，认领 08 的移交读数）', () => {
  it('收场回执兑现那一刻与随后那次请求里都没有本插件消息', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel' },
      script: scriptWith({ text: VALID_JSON }),
      storageRoot: root,
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled

    // 非空转的前提：这一格确实是成功 `continue` 的收场（否则「不注入」会因为复核失败而侥幸通过）。
    expect(await rawRecord(root, fixture.main.session.id, TRIGGER_STEP)).toMatchObject({
      status: 'completed',
      verdict: { verdict: 'continue' },
    })
    // 两条待处理队列与对话里都没有本插件消息。
    expect([...fixture.agent.inbox.nextStep, ...fixture.agent.inbox.nextTurn].filter(isPluginUserMessage))
      .toEqual([])
    expect(fixture.agent.session.deriveMessages().filter(isPluginUserMessage)).toEqual([])
    // 随后那次模型请求的 messages 里也没有。
    await fixture.main.drive(1)
    expect(mainCalls(fixture).flatMap(call => call.request.messages).some(isPluginUserMessage)).toBe(false)
  })
})

describe('2b 作废优先：等待 × stop × 失败，本步已取走的消息里有真实用户消息', () => {
  it('落取消记录（取「取消」优先）、不追加说明、不停止', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, failurePolicy: 'stop', reviewTimeoutMs: TIMEOUT_MS },
      script: [STEP, STEP, UNPARSEABLE, DONE],
      storageRoot: root,
    })
    // 07 窗口二：停在第 3 步的步边界上送出真实用户消息，触发点那次 pre-step 的 claim 取走它。
    await fixture.main.drive(TRIGGER_STEP, '出发')
    expect(fixture.main.steps()).toBe(TRIGGER_STEP)
    const arriving = userMessage('换个方向')
    fixture.main.agent.steer(arriving)
    await fixture.main.drive(1)

    // 记录侧：落点必须先判作废、再决定落哪一条（同键 `put` 覆盖后本来就只见一条，「先落失败再覆盖」反证不了）。
    const record = await rawRecord(root, fixture.main.session.id, TRIGGER_STEP)
    expect(record['status']).toBe('cancelled')
    expect(record['cancelReason']).toBe('invalidated')
    expect(record['verdict']).toBeUndefined()
    expect(record['failureReason']).toBeUndefined()

    // 「不注入、不追加停止说明」：设计文档那一格写「命中就落取消记录，不加说明、不停止」。
    expect(fixture.agent.session.deriveMessages().filter(isPluginUserMessage)).toEqual([])

    // 「不停止」：只断记录的话，「照样停止 + 落一条取消记录」的实现同样绿。
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
  })
})

describe('两种模式都不重试、失败不抛错打断（第 3 条：并行半边）', () => {
  it.each(FAILURES)('并行 × 缺省 continue × $name：一次到点恰好一条复核请求、turn 正常收尾', async ({ response }) => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, mode: 'parallel', reviewTimeoutMs: TIMEOUT_MS },
      script: scriptWith(response),
      storageRoot: root,
    })
    const settled = fixture.main.settled(TRIGGER_STEP)
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled
    await fixture.main.drive(1)

    // 按**复核指令**计数，不借夹具 `isReviewRequest` 的启发式。
    expect(fixture.main.calls().filter(carriesReviewInstruction)).toHaveLength(1)
    // 「不抛错打断」：该 turn 不以 `error` 也不以 `aborted/hook` 收尾。
    expect(fixture.main.turnEndReasons().some(reason => reason.kind === 'error')).toBe(false)
    expect(hasHookAbort(fixture)).toBe(false)
    expect(fixture.main.turnEndReasons().at(-1)).toEqual({ kind: 'completed' })
  })
})

describe('真实 loop 上的严格解析与超时（第 4 条）', () => {
  it.each(STRICT_PARSE_CASES)('$name → 一条失败记录', async ({ text }) => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS },
      script: scriptWith({ text }),
      storageRoot: root,
    })
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')

    await expectFailedRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })

  it('超时 → 恰一条失败记录', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({
      config: { triggerEverySteps: EVERY_STEPS, reviewTimeoutMs: TIMEOUT_MS },
      script: scriptWith(HANG),
      storageRoot: root,
    })
    await fixture.main.drive(STEPS_TO_TRIGGER, '出发')

    await expectFailedRecord(root, fixture.main.session.id, TRIGGER_STEP)
  })
})
