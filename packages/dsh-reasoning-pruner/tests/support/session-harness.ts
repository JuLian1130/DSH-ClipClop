/**
 * 票 02 的集成夹具：一条**真实**会话（真 agent loop + 真会话存储 + 真 JSONL 落盘后端）与「重挂载」。
 *
 * 03、04、05、06、07 复用本文件，所以它建在 `tests/support/` 下而不是某个 spec 里。三样能力：
 *
 * - **可裁消息**：`ScriptedReasoningAdapter` 每一步产出一条**由 `openai-completions` 传输产生**的
 *   assistant 消息——含推理块、文本块、可选工具调用，并按「块数相等 + 逐位同类型」给出 replay 信封。
 *   这是裁剪资格与裁剪算子的真实输入（票 01 用的 `text-adapter.ts` 三者皆无，造不出可裁候选）。
 * - **耐久落盘**：挂真的 `JsonlSessionPersistence`，会话走 agent loop 的 `createStoredSession`，所以每次
 *   `session/event` 都被路由进写句柄；`dispose()` 排空并关闭句柄，换成第二个 context 就得到一次**真的
 *   重挂载**（投影注册真的再跑一次）。
 * - **冷读**：`coldRead` 走 `sessionPersistence.open(..., 'read').read()`，即未装载插件也走的那条
 *   `validateStoredEvents` + 关系折叠的读路径。
 *
 * 校准（不是验收判据）：比较「运行期折叠」与「重载全量折叠」时两边都要带上同一个系统提示词上下文——一个
 * 从未跑过请求的空会话不派生 `system/message`。因此运行期至少推进一个 turn 再比较。
 *
 * @module
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as plugin from '../../src/index.ts'

/** 脚本每一步的产出；`calls` 为空时该步以纯文本收尾。 */
export interface ScriptedStep {
  /** 推理块文本；缺省表示这一步不产出推理块。 */
  readonly reasoning?: string
  /** 文本块文本。 */
  readonly text: string
  /** 要发起的工具调用；非空时该步的 turn 不结束。 */
  readonly calls?: readonly { readonly name: string, readonly arguments: string }[]
}

/** 假传输名。资格判定不解析它，只要求信封带 `api: 'openai-completions'`。 */
const API = 'openai-completions'

/** 本文件创建过的落盘根；`cleanupRoots` 统一删除。 */
const createdRoots: string[] = []

/**
 * 每一步产出推理块、文本块与可选工具调用的脚本化适配器。
 *
 * `finish` 的 `replayState` 按**实际发出的块**逐位给条目（文本块的 `textSignature`、推理块的
 * `thinkingSignature`、工具调用块的 `thoughtSignature`），所以消息天然满足「信封与内容逐位对齐」。
 * 脚本用完后重复最后一段，调用次数由用例自己控制。
 */
export class ScriptedReasoningAdapter extends LlmAdapter {
  private call = 0

  /** @param script - 逐步脚本；最后一段在脚本用完后重复。 */
  constructor(private readonly script: readonly ScriptedStep[]) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.script[Math.min(this.call, this.script.length - 1)]
    this.call += 1

    const blocks: ContentBlock[] = []
    if (step.reasoning !== undefined) blocks.push({ type: 'reasoning', text: step.reasoning })
    blocks.push({ type: 'text', text: step.text })
    for (const [index, call] of (step.calls ?? []).entries()) {
      blocks.push({
        type: 'tool-call',
        id: ToolCallId(`${call.name}-${this.call}-${index}`),
        name: call.name,
        arguments: call.arguments,
      })
    }

    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield block.type === 'reasoning'
        ? { type: 'reasoning-delta', index, text: block.text }
        : { type: 'text-delta', index, text: block.type === 'text' ? block.text : '' }
      yield { type: 'block-end', index, block }
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
      },
    }
    yield {
      type: 'finish',
      reason: blocks.some(block => block.type === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' },
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: API,
          provider: options.provider,
          model: options.model,
          stopReason: 'stop',
        },
        blocks: blocks.map(block => block.type === 'reasoning'
          ? { type: 'reasoning', thinkingSignature: `sig-think-${block.text}` }
          : block.type === 'text'
            ? { type: 'text', textSignature: 'sig-text' }
            : { type: 'tool-call', thoughtSignature: 'sig-tool' }),
      },
    }
  }
}

/** 落盘后的一条已读日志。 */
export interface ColdLog {
  /** 读路径校验过的事件（未装载插件时正是这条路径决定「整段读不出来」）。 */
  readonly events: readonly SessionEvent[]
  /** 存下来的头。 */
  readonly header: SessionHeader
  /** 读路径给出的取值所有权状态。 */
  readonly eventState: 'detached' | 'shared-frozen'
}

/** 一个生命周期（一个 context + 一个落盘根）上的能力。 */
export interface PersistentLifecycle {
  readonly ctx: Context
  /** 该生命周期的落盘根；`remount` 用它换取一次真的重挂载。 */
  readonly root: string
  /** 建一条真实会话；`id` 是它在落盘根里的身份，也是重挂载时的入口。 */
  createSession(id: string): Promise<{ agent: Agent, session: Session }>
  /** 推进一个 turn（一条真实用户消息 + 等它收尾）。 */
  step(agent: Agent, text: string): Promise<void>
  /** 冷读落盘的日志；未装载插件时也走这条路径。 */
  coldRead(id: string): Promise<ColdLog>
  /** 排空写句柄并释放整个 context；**不删落盘根**（重挂载与读原始落盘文本都还要用它）。 */
  dispose(): Promise<void>
}

/**
 * 创建独立落盘根并挂载一整条真实链路。
 *
 * `withPlugin` 为 false 时**不装载本插件**，用来构造「未装载插件的读者」。
 * @param script - 适配器的脚本。
 * @param options - `withPlugin` 关闭本插件；`root` 复用已有落盘根（重挂载时给）。
 * @returns 该生命周期的能力对象。
 */
export async function lifecycle(
  script: readonly ScriptedStep[],
  options: { readonly withPlugin?: boolean, readonly root?: string } = {},
): Promise<PersistentLifecycle> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-reasoning-pruner-'))
  createdRoots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedReasoningAdapter(script))
  if (options.withPlugin ?? true) await ctx.plugin(plugin, {})
  // 后端必须**先于 loop** 挂载：活会话的写缓冲只在后端自己的 teardown effect 里排空（`session/disposed`
  // 只丢路由、不排空），而 Cordis 按挂载顺序的逆序拆卸。后端先挂 ⇒ loop 先退场 ⇒ 后端排空时写句柄
  // 还在。反过来挂会**静默丢盘**：loop 先退场关掉会话，后端再排空时路由已经没了。
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const harness = await mountAgentLoopTestHarness(ctx)
  /** 本生命周期建过的会话，`dispose` 时逐个过 durability checkpoint。 */
  const sessions: Session[] = []

  return {
    ctx,
    root,
    async createSession(id) {
      const agent = await harness.create(SessionId(id), { provider: 'mock', model: 'mock' })
      sessions.push(agent.session)
      return { agent, session: agent.session }
    },
    async step(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async coldRead(id) {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        const read = await handle.read()
        return { events: read.events, header: handle.header, eventState: read.eventState }
      } finally {
        await handle.close()
      }
    },
    async dispose() {
      // 活会话的写缓冲只在后端自己的 teardown 里排空，而挂载/拆卸顺序由 `Inject` 决定、不由本文件决定；
      // 显式过一次 `session/flush` 让「盘上有这条会话」与拆卸顺序无关，也让重挂载是确定的。
      for (const session of sessions) await ctx.sessions.flush(session)
      await ctx.fiber.dispose()
      // 落盘根不在这里删：重挂载与读原始落盘文本都要用它。删除统一由 {@link cleanupRoots} 负责。
    },
  }
}

/**
 * 删除本文件创建过的全部落盘根。用例在 `afterEach` 里调它，所以 `dispose()` 之后仍可以读盘。
 */
export async function cleanupRoots(): Promise<void> {
  await Promise.all(createdRoots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
}

/**
 * 在已有落盘根上做一次**真的重挂载**：新 context、新插件 fiber、投影注册真的再跑一次。
 *
 * 不复用「同一个已打开的会话再读一次」——那种写法在「投影只在写入进程的内存里生效」的实现下恒真。
 * @param root - 上一次生命周期用的落盘根。
 * @param script - 适配器脚本（重挂载后若还要继续驱动）。
 * @param options - 同 {@link lifecycle}。
 * @returns 该生命周期的能力对象。
 */
export function remount(
  root: string,
  script: readonly ScriptedStep[],
  options: { readonly withPlugin?: boolean } = {},
): Promise<PersistentLifecycle> {
  return lifecycle(script, { ...options, root })
}

/**
 * 把一条冷读日志按**模型可见路径**恢复成会话：`SessionStore.prepare` 正是正常重载走的那条路
 * （`Session.fromRestore(..., this.projections)`），用的是插件注册的投影。
 * @param lc - 提供 `sessions` 服务的生命周期。
 * @param id - 已落盘的会话身份。
 * @param log - {@link PersistentLifecycle.coldRead} 的结果。
 * @returns 一个**未进入 store** 的会话；`deriveMessages()` 即模型可见历史。
 */
export function restore(lc: PersistentLifecycle, id: string, log: ColdLog): Session {
  return lc.ctx.sessions.prepare(SessionId(id), {
    seed: [...log.events],
    meta: log.header,
    eventState: log.eventState,
    inheritedEventCount: SessionLogOffset(0),
  })
}

/** 一条消息里的推理块文本，按出现顺序。 */
export function reasoningTexts(session: Session): string[] {
  return session.deriveMessages().flatMap(message =>
    message.role === 'assistant'
      ? message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
      : [],
  )
}

/**
 * 读**未经 schema 解析的原始落盘文本**（`.jsonl` 每一行都是原样的 envelope）。
 *
 * 这是「payload 不含会话内容」唯一有效的观察面：`deriveMessages()` 只会投影后的消息，看不到原始
 * payload；而 `session-log-deepseek` 正是把这份 `data` 原样上传到远端的消费者。
 * @param root - 落盘根。
 * @returns 根下所有 `.jsonl` 文件的文本，按路径排序拼接。
 */
export async function rawLogText(root: string): Promise<string> {
  const files = (await readdir(root, { recursive: true, encoding: 'utf8' }))
    .filter(name => name.endsWith('.jsonl'))
    .sort()
  const parts: string[] = []
  for (const file of files) parts.push(await readFile(join(root, file), 'utf8'))
  return parts.join('\n')
}
