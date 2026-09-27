/**
 * 票 07 第 9 条：适配器三样能力的落地判据（夹具自身的验收探针）。
 *
 * 本票只补第三样（**由请求内容派生的 `usage`**），所以这里断的是三样**都到得了消息层**：驱动一步后，
 * `assistant/message` 的 `message.content` 里确实有一个 `{type:'reasoning'}` 块、
 * `message.source.replayState.response.api === 'openai-completions'`、且事件上的 `data.usage` 三次计数等于
 * 按派生规则从该次请求算出的值。
 *
 * 缺任一样后续判据都空转：没有推理块就造不出可裁候选、没有信封就造不出裁剪资格、缓存字段恒为零就读不出
 * 命中。**`usage` 必须派生、不能照脚本回放**——写死的 token 数会让空转反例恒真，也让「被裁推理让后续请求
 * 少掉多少 token」读不出来。
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { estimateContent, ROLE_OVERHEAD } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ScriptedStep } from './support/session-harness.ts'
import { cleanupRoots, lifecycle, registerTool } from './support/session-harness.ts'
import { tokenReadings } from './support/gate-readings.ts'

afterEach(cleanupRoots)

/** 复算用：把一条消息的规范化内容按 DSH 的估价器定价（与 `LlmCall.requestTokens` 同一口径）。 */
function priceOf(content: string): number {
  return estimateContent(JSON.parse(content) as never) + ROLE_OVERHEAD
}

/** 四步脚本：每步推理文本不同，于是「由请求内容派生」有可分辨的输入。 */
const SCRIPT: ScriptedStep[] = Array.from({ length: 4 }, (_unused, index) => ({
  reasoning: `thinking ${index}`,
  text: `text ${index}`,
  calls: index < 3 ? [{ name: 'noop', arguments: '{}' }] : [],
}))

/** 该会话的 `assistant/message` 事件。 */
function assistantMessages(session: Session): SessionEvent<'assistant/message'>[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
}

/**
 * 驱动一个 turn 并取回现场。
 * @param script - 脚本。
 * @param id - 会话身份。
 * @returns 生命周期与会话。
 */
async function drive(script: readonly ScriptedStep[], id: string) {
  const lc = await lifecycle(script, { toolsThrough: 3 })
  registerTool(lc.ctx, 'noop')
  const { agent, session } = await lc.createSession(id)
  await lc.step(agent, 'go')
  return { lc, session }
}

describe('票 07 第 9 条：三样能力逐项到达消息层', () => {
  it('推理块、pi-ai 信封与派生的 usage 三样逐项可断', async () => {
    const { lc, session } = await drive(SCRIPT, 'abilities')
    const messages = assistantMessages(session)
    expect(messages.length).toBeGreaterThanOrEqual(4)

    // ① 推理块确实在**消息**里（不是只在适配器的脚本里）。
    const first = messages[0]!
    expect(first.data.message.content.some(block => block.type === 'reasoning')).toBe(true)
    // 每一步都有，且文本与脚本逐条对应。
    expect(messages.slice(0, 4).map(entry => entry.data.message.content
      .flatMap(block => block.type === 'reasoning' ? [block.text] : [])))
      .toEqual([['thinking 0'], ['thinking 1'], ['thinking 2'], ['thinking 3']])

    // ② 信封形状是 pi-ai 的、且 `api` 是唯一有裁剪资格的那个传输。
    // `replayState` 在 DSH 的类型里是 `unknown`（它按传输各自解释），所以这里按形状收窄再断——
    // 本票的资格判据（`src/replay.ts`）读的也正是这两个字段。
    const replayState = first.data.message.source.replayState as {
      readonly response: { readonly kind: string, readonly api: string }
    }
    expect(replayState.response.kind).toBe('pi-ai')
    expect(replayState.response.api).toBe('openai-completions')

    // ③ `usage` 由**请求内容**派生：断言值由该次请求独立复算，不是抄适配器的常量。
    // 复算走用例自己的读数面（`LlmCall.content` 是捕获下来的请求内容），只借估价器，不借适配器的 `deriveUsage`。
    const readings = tokenReadings(session)
    for (const [index, reading] of readings.slice(1).entries()) {
      const call = lc.calls[index + 1]!
      const previous = lc.calls[index]!
      // 派生规则：与前一次请求逐消息同字节的前缀计缓存命中，其后变更的后缀计未缓存输入。
      let cached = 0
      while (cached < call.content.length && cached < previous.content.length && call.content[cached] === previous.content[cached]) {
        cached += 1
      }
      // 至少一条消息相同（系统提示词），所以缓存命中非零——缓存字段不是恒零的常量。
      expect(cached).toBeGreaterThan(0)
      const perMessage = call.content.map(priceOf)
      const suffix = perMessage.slice(cached).reduce((total, price) => total + price, 0)
      // 三次计数逐项相等——不是「大于零」这种任何实现都过的写法。
      expect(reading.inputTokens).toBe(suffix)
      expect(reading.cacheReadTokens).toBe(perMessage.reduce((total, price) => total + price, 0) - suffix)
      expect(reading.cacheWriteTokens).toBe(0)
      // 未缓存输入就是变更后缀的价格，缓存命中就是其余部分：两者之和等于全量价格。
      expect(reading.billedInput).toBe(perMessage.reduce((total, price) => total + price, 0))
    }

    await lc.dispose()
  }, 120000)

  it('缓存场景由脚本声明：hit 与 cold 给出可分辨的读数', async () => {
    const hit = await drive(SCRIPT.map(step => ({ ...step, cache: 'hit' as const })), 'cache-hit')
    const cold = await drive(SCRIPT.map(step => ({ ...step, cache: 'cold' as const })), 'cache-cold')

    // `cold` 场景下没有命中：每次请求的缓存命中都为零。
    expect(tokenReadings(cold.session).every(reading => reading.cacheReadTokens === 0)).toBe(true)
    // `hit` 场景下首次之后的请求都命中（首次没有前一次请求可命中）。
    const hitReadings = tokenReadings(hit.session)
    expect(hitReadings[0]!.cacheReadTokens).toBe(0)
    expect(hitReadings.slice(1).every(reading => reading.cacheReadTokens > 0)).toBe(true)

    await hit.lc.dispose()
    await cold.lc.dispose()
  }, 180000)

  it('`cacheWriteTokens` 只在脚本声明 write 的步骤上非零，且该段尾部不再计入未缓存输入', async () => {
    const { lc, session } = await drive(SCRIPT.map(step => ({ ...step, cache: 'write' as const })), 'cache-write')
    const first = tokenReadings(session)[0]!
    // 写入场景下「变更的后缀」只计为缓存写入——三次计数互斥，不能再同时进 `inputTokens`，
    // 否则 `billedInput`（三者和）会把它算两次（`TokenUsage` 文档：inputTokens 只是 uncached input）。
    expect(first.cacheWriteTokens).toBeGreaterThan(0)
    expect(first.inputTokens).toBe(0)
    expect(first.billedInput).toBe(first.cacheWriteTokens)
    await lc.dispose()
  }, 120000)
})