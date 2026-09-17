/**
 * 票据 04：复核记录与回放——记录域、读写两个入口、键的形状。
 *
 * 观察面只取两样：本包导出的读写入口，以及 JSON 后端根下的原始文档（`per-record` 布局）。
 * 要用到原始文档或「同一个后端根下重挂载」的用例必须给 `storageRoot`：共享桩上没有磁盘，
 * 域 open / 关闭 / 重开那一串在桩上不成立。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  REVIEW_DOMAIN_NAME,
  REVIEW_TABLE,
  readReviewRecords,
  reviewRecordKey,
  writeReviewRecord,
  type ReviewRecordInput,
} from '../src/index.ts'
import { ACTIVE } from './support/fiber-state.ts'
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigator-records-'))
  roots.push(root)
  return root
}

/**
 * 一条合法的完成态记录。
 * @param triggerStep - 触发步骤。
 * @returns 满足声明 schema 的完成态记录。
 */
function completedRecord(triggerStep: number): ReviewRecordInput {
  return {
    triggerStep,
    config: {
      triggerEverySteps: 1,
      mode: 'wait',
      reviewTimeoutMs: 120_000,
      maxOutputTokens: 4096,
      failurePolicy: 'continue',
      prompt: '',
    },
    durationMs: 12,
    status: 'completed',
    messageIds: ['m1', 'm2'],
    verdict: { verdict: 'continue', reason: '还没到需要调整的程度', recommendation: '继续当前路径' },
    usage: { inputTokens: 11, outputTokens: 7 },
  }
}

describe('复核记录：写、读与域的生命周期', () => {
  it('同一后端根下重挂载插件之后，仍按会话 id 读回写下的那一条记录', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({ storageRoot: root })
    const sessionId = fixture.agent.session.id
    const record = completedRecord(1)

    await writeReviewRecord(sessionId, record)
    expect(readReviewRecords(sessionId)).toEqual([record])

    await fixture.remountPlugin()
    expect(fixture.pluginFiber()?.state).toBe(ACTIVE)
    expect(readReviewRecords(sessionId)).toEqual([record])
    // 「恰含写入的那条」：读到别的会话的记录也算失败，所以反方向也要断。
    expect(readReviewRecords(SessionId('navigator-review-other'))).toEqual([])
  })

  it('改配置（update 内部重跑 apply）之后记录仍在，且插件仍激活', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({ storageRoot: root })
    const sessionId = fixture.agent.session.id
    const record = completedRecord(3)

    await writeReviewRecord(sessionId, record)
    await fixture.updateConfig({ triggerEverySteps: 5 })

    expect(fixture.pluginFiber()?.state).toBe(ACTIVE)
    expect(readReviewRecords(sessionId)).toEqual([record])
  })

  it('一条不过声明 schema 的记录不挡加载：移走它、跳过它，好记录仍读得回', async () => {
    const root = await tempRoot()
    const fixture = await mountNavigatorLoop({ storageRoot: root })
    const sessionId = fixture.agent.session.id
    const good = completedRecord(7)
    await writeReviewRecord(sessionId, good)

    // 要读/写原始文档时先落一条好记录，再从它的信封里取版本戳——不写死一个数字。
    const tableDir = join(root, REVIEW_DOMAIN_NAME, REVIEW_TABLE)
    const goodKey = reviewRecordKey(sessionId, 7)
    const envelope = JSON.parse(await readFile(join(tableDir, `${goodKey}.json`), 'utf8')) as {
      version: number
    }

    // 只有「版本戳合法、record 不过 schema」才走 backup-and-skip；畸形或版本不符的文档在读路径上
    // 被静默读作 absent，根本到不了备份。
    const badKey = reviewRecordKey(sessionId, 99)
    await writeFile(
      join(tableDir, `${badKey}.json`),
      `${JSON.stringify({ version: envelope.version, record: { triggerStep: 'not-a-number' } }, null, 2)}\n`,
    )

    await fixture.remountPlugin()

    expect(fixture.pluginFiber()?.state).toBe(ACTIVE)
    expect(readReviewRecords(sessionId)).toEqual([good])
    const files = await readdir(tableDir)
    expect(files).toContain(`${goodKey}.json`)
    expect(files).not.toContain(`${badKey}.json`)
    expect(files.some(name => name.startsWith(`${badKey}.json.bak.`))).toBe(true)
  })
})
