/**
 * 复核收场的公开回执（09 的**前置**夹具能力）：夹具提供与「这次复核那唯一一条记录
 * 已落盘」对齐的同步点（`settled`）。并行续体脱离本步、失败与成功又都不注入消息，`drive` 的步边界与
 * `whenIdle()` 都不覆盖它，所以只有它当得了「等这次复核收场」的同步点——用例不轮询、不读时间窗。
 *
 * 兑现点是存储域自己的落盘事件 `domain/changed`（`put` 在 `await` 后端落盘之后发一次）。三条用例都按
 * 「回执兑现那一刻，原始存储文档已经读得到」断，这正是不轮询的替代：
 *  - 等待模式 + 超时（默认 `failurePolicy: continue`）：收场发生在本步之内，回执照样兑现——落盘之后
 *    才调用它也立刻兑现；
 *  - 并行模式 + 成功 `continue`：复核脱离本步、主会话正停在步边界上，回执仍兑现（09 的并行各格靠它）；
 *  - 并行模式 + 超时：同上，失败收场也兑现。
 * 第四条是能力边界：缺省桩档没有 `domain/changed`，回执直接报错，而不是把用例挂到超时。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { REVIEW_DOMAIN_NAME, REVIEW_TABLE, reviewRecordKey } from '../src/index.ts'
import {
  CONTINUE_VERDICT,
  SCRIPTED_TOOL_NAME,
  type ScriptedResponse,
} from './support/scripted-adapter.ts'
import { disposeTrackedContexts } from './support/mounted-contexts.ts'
import { mountNavigatorLoop } from './support/loop-fixture.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-settle-'))
  roots.push(root)
  return root
}

/**
 * 触发点值是**已完成步数**，不指步号：挂载早于第 1 步 + 间隔 2 → 第一次复核在「已完成 2 步」那一刻的
 * pre-step 发出，也就是第 3 步的 pre-step。所以驱动要走满 3 步才轮到它。
 */
const TRIGGER_STEP = 2
const STEPS_TO_TRIGGER = 3

/** 撑住 turn 的一步（这一步不结束 turn）。 */
const STEP: ScriptedResponse = { toolCall: SCRIPTED_TOOL_NAME }

/** 一段让请求挂住不放行的脚本：只有复核自己的 `reviewTimeoutMs` 能把它收场。 */
const HANG: ScriptedResponse = { hang: true }

/** 让会话正常收尾的后续步骤，避免脚本用尽后重复「挂住」那一段。 */
const DONE: ScriptedResponse = { text: '收到' }

/** 一条 `continue` 结论：不产生任何消息，但照样落一条完成态记录。 */
const CONTINUE: ScriptedResponse = { text: CONTINUE_VERDICT }

/** 超时配短，用例不必等缺省的两分钟。 */
const TIMEOUT_MS = 50

/**
 * 读某次复核的原始存储文档里的 `record`。回执兑现之后它必须已经读得到——`domain/changed` 的契约是
 * 「后端确认持久化之后」才发。
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

describe('复核收场的公开回执', () => {
  it('等待模式 + 超时：回执兑现时失败记录已经落盘', async () => {
    const root = await tempRoot()
    const loop = await mountNavigatorLoop({
      config: { triggerEverySteps: TRIGGER_STEP, reviewTimeoutMs: TIMEOUT_MS },
      script: [STEP, STEP, HANG, STEP, DONE],
      storageRoot: root,
    })

    // 等待模式的收场发生在本步之内：驱动返回时记录已经落盘，所以回执在它之后取也立刻兑现。
    await loop.main.drive(STEPS_TO_TRIGGER, '出发')
    await loop.main.settled(TRIGGER_STEP)

    expect(await rawRecord(root, loop.main.session.id, TRIGGER_STEP)).toMatchObject({
      triggerStep: TRIGGER_STEP,
      status: 'failed',
    })
  })

  it('并行模式 + 成功：主会话停在步边界上，脱离本步的续体收场也兑现', async () => {
    const root = await tempRoot()
    const loop = await mountNavigatorLoop({
      config: { triggerEverySteps: TRIGGER_STEP, mode: 'parallel' },
      script: [STEP, STEP, CONTINUE, STEP, DONE],
      storageRoot: root,
    })

    // 先取回执再驱动：并行续体在本步之外落盘，驱动返回时它通常还没落。
    const settled = loop.main.settled(TRIGGER_STEP)
    // 驱动停在步边界上就不管了：回执兑现不靠 `whenIdle()`，也不靠再推进一步。
    await loop.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled

    expect(await rawRecord(root, loop.main.session.id, TRIGGER_STEP)).toMatchObject({
      triggerStep: TRIGGER_STEP,
      status: 'completed',
    })
  })

  it('并行模式 + 超时：失败收场同样兑现', async () => {
    const root = await tempRoot()
    const loop = await mountNavigatorLoop({
      config: { triggerEverySteps: TRIGGER_STEP, mode: 'parallel', reviewTimeoutMs: TIMEOUT_MS },
      script: [STEP, STEP, HANG, STEP, DONE],
      storageRoot: root,
    })

    const settled = loop.main.settled(TRIGGER_STEP)
    await loop.main.drive(STEPS_TO_TRIGGER, '出发')
    await settled

    expect(await rawRecord(root, loop.main.session.id, TRIGGER_STEP)).toMatchObject({
      triggerStep: TRIGGER_STEP,
      status: 'failed',
    })
  })

  it('缺省桩档没有这个回执：直接报错，而不是把用例挂到超时', async () => {
    const loop = await mountNavigatorLoop({
      config: { triggerEverySteps: TRIGGER_STEP },
      script: [STEP],
    })

    await expect(loop.main.settled(TRIGGER_STEP)).rejects.toThrow('storageRoot')
  })
})
