/**
 * ACP 入口腿（票据 12 第 3 条）：等待模式 `stop` 触发后 ACP 会话以 `end_turn` 收尾，且 ACP 更新流里
 * **不出现**复核说明的正文。
 *
 * 装配是发布态 CLI 的真实 `--profile acp`（ACP 协议服务端），客户端走 `@agentclientprotocol/sdk`；
 * 本包的构建产物由 `--patch` 覆盖按绝对路径装进同一棵树。机制、路线与版本见票据备注的前置核实结论。
 *
 * 负向那半不能是恒真句：本用例先用观察者条目证明那条停止说明**确实产生了**（正文含触发步骤），再在
 * ACP `session/update` 序列里搜它。为什么 ACP 看不到它（只转发助手消息与工具调用、不转发 user 消息）
 * 见设计文档「注入与停止机制」末条。
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { keepTurnAlive, startMockModel } from './support/mock-model.ts'
import {
  assertBuiltEntry,
  createLegHome,
  dshBinPath,
  legEnv,
  readObservedNotices,
  writeNavigatorPatch,
} from './support/runtime-entry.ts'

/** 第 1 步触发（锚点 0 + 间隔 1），所以停止说明的正文以「第 1 步」开头。 */
const STOP_REASON = '目标已经偏移，先停下确认'
const REVIEW = { verdict: 'stop', reason: STOP_REASON, recommendation: '先回滚到上一个检查点' }
const NOTICE_TEXT = `第 1 步的导航复核停止：${STOP_REASON}`

/** 收尾按登记顺序倒着跑：先关 mock，再杀子进程并等它真的退出，最后删临时 home。 */
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('ACP 入口腿', () => {
  it('等待模式 stop 之后以 end_turn 收尾，且更新流里没有那条停止说明的正文', async () => {
    assertBuiltEntry()
    const home = createLegHome('dsh-navigator-acp-')
    const noticesFile = join(home, 'notices.jsonl')
    const patch = writeNavigatorPatch(home, { triggerEverySteps: 1, noticesFile })
    const model = await startMockModel(({ isReview }, attempt) => isReview
      ? { text: JSON.stringify(REVIEW) }
      : attempt === 1 ? keepTurnAlive(attempt) : { text: '收到' })
    cleanups.push(() => { rmSync(home, { recursive: true, force: true }) })

    const child = spawn(process.execPath, [dshBinPath(), '--profile', 'acp', '--patch', patch], {
      cwd: home,
      env: legEnv(model.baseURL, home),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanups.push(() => model.close())
    cleanups.push(() => { child.kill('SIGKILL'); return waitForExit(child) })
    const stdin = requirePipe(child.stdin)
    const stdout = requirePipe(child.stdout)
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })

    const passthrough = new Readable({ read() { /* 由 stdout 的 data 事件推送 */ } })
    stdout.on('data', (chunk: Buffer) => { passthrough.push(chunk) })
    stdout.on('end', () => { passthrough.push(null) })
    const updates: SessionNotification['update'][] = []
    const clientApp = createAcpClientApp({ name: 'dsh-navigator-acp-leg' })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update)
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, () => Promise.resolve({ outcome: { outcome: 'cancelled' } }))
    const client = clientApp.connect(ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(passthrough) as ReadableStream<Uint8Array>,
    )).agent

    await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await client.request(methods.agent.session.new, { cwd: home, mcpServers: [] })
    const response = await client.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '先把这一步走完' }],
    })

    // 正向对照：那条停止说明确实由真实复核路径产生，正文含触发步骤。
    const observed = readObservedNotices(noticesFile)
    expect(observed, stderr).toHaveLength(1)
    expect(observed[0].text).toBe(NOTICE_TEXT)

    // 判据两半：end_turn 收尾 + 更新流里没有这条正文。先断更新流确实带上了这一步的内容
    // （工具调用），负向那半才不是「流本来就是空的」。
    expect(response.stopReason).toBe('end_turn')
    expect(updates.some(update => update.sessionUpdate === 'tool_call')).toBe(true)
    const stream = JSON.stringify(updates)
    expect(stream).not.toContain(NOTICE_TEXT)
    expect(stream).not.toContain(STOP_REASON)
  }, 180_000)
})

/** 取 spawn 出的管道；`stdio: pipe` 下必然存在，缺失就是装配写错了。 */
function requirePipe<T>(pipe: T | null): T {
  if (pipe === null) throw new Error('acp leg: child process pipe is missing')
  return pipe
}

/** 等子进程真的退出，避免临时目录删除与子进程收尾竞速。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => { child.once('exit', () => resolve()) })
}
