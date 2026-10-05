/**
 * 票 02 第 2 条：「保存即生效、无需重启」。
 *
 * 走真 profile（真 `settings` + 真 Loader），因为这一条是两者的合力：写入落在 profile patch 上、装载期解析
 * 出的 volatile 引用原地更新。判据不是「引用变了」，而是**host 的行为跟着变了**——写完 debug 开关后，下一条
 * 工具结果立刻开始写日志，没有重挂载。
 *
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { exec, textTool } from './support/host.ts'
import { bootProfile, cleanupProfiles, PREFERENCE_NAMESPACE } from './support/profile.ts'
import type { LiveFixture } from './support/profile.ts'

const open: LiveFixture[] = []
const paths: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

afterAll(() => { cleanupProfiles() })

/** 一个新的临时目录（放 debug 日志）。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-live-'))
  paths.push(root)
  return root
}

/**
 * 装一条 profile 并登记收场。
 * @param config - 本插件那一行的 profile 配置。
 * @returns 夹具。
 */
async function booted(config: Record<string, unknown>): Promise<LiveFixture> {
  const fixture = await bootProfile(config)
  open.push(fixture)
  return fixture
}

describe('票 02 第 2 条：写设置立刻改变 host 行为', () => {
  it('debug 关闭时不写盘；写入 debug=true 后，下一条结果立刻写盘（不重挂载）', async () => {
    const root = tempRoot()
    const logPath = join(root, 'debug.jsonl')
    const fixture = await booted({ summarize: false, privacyGate: false, debug: false, debugPath: logPath })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(existsSync(logPath)).toBe(false)

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['debug'], value: true }])
    expect(fixture.config.debug.get()).toBe(true)
    await fixture.ctx.tools.execute(exec('bash'))
    expect(readFileSync(logPath, 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  it('写入 debugPath 后下一条结果写到新路径', async () => {
    const root = tempRoot()
    const first = join(root, 'first.jsonl')
    const second = join(root, 'second.jsonl')
    const fixture = await booted({ summarize: false, debug: true, debugPath: first })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(existsSync(first)).toBe(true)

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['debugPath'], value: second }])
    expect(fixture.config.debugPath.get()).toBe(second)
    await fixture.ctx.tools.execute(exec('bash'))
    expect(existsSync(second)).toBe(true)
    expect(readFileSync(first, 'utf8').trimEnd().split('\n')).toHaveLength(1)
    expect(readFileSync(second, 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  it('两个能力开关默认关闭，写入 summarize=true 后引用立刻为真（保存即生效的引用侧）', async () => {
    const fixture = await booted({})
    expect(fixture.config.summarize.get()).toBe(false)
    expect(fixture.config.privacyGate.get()).toBe(false)
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [
      { op: 'set', path: ['summarize'], value: true },
      { op: 'set', path: ['privacyGate'], value: true },
    ])
    expect(fixture.config.summarize.get()).toBe(true)
    expect(fixture.config.privacyGate.get()).toBe(true)
  })

  it('host 每次处理结果都重读 summarize，而不是装载期读一次', async () => {
    const root = tempRoot()
    const logPath = join(root, 'debug.jsonl')
    // 摘要关闭时每条结果记一条 `summary-off`；开启后短结果落 `not-candidate`——两次运行都写一行，
    // 但**取值不同**，这就是「重读开关」的可观察面（若 apply 在装载期把它捕获成常量，第二行仍是 summary-off）。
    const fixture = await booted({ summarize: false, privacyGate: false, debug: true, debugPath: logPath })
    fixture.ctx.tools.register(textTool('bash', 'body'))
    await fixture.ctx.tools.execute(exec('bash'))
    expect(readFileSync(logPath, 'utf8')).toContain('"summary-off"')

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['summarize'], value: true }])
    await fixture.ctx.tools.execute(exec('bash'))
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"not-candidate"')
  })

  it('写入摘要下限后 host 行为立刻跟着变（同一个长结果先落 failed、调高下限后落 not-candidate）', async () => {
    const root = tempRoot()
    const logPath = join(root, 'debug.jsonl')
    const fixture = await booted({ summarize: true, privacyGate: false, debug: true, debugPath: logPath })
    fixture.ctx.tools.register(textTool('bash', 'x'.repeat(5000)))
    // profile 里没有 llm 服务：候选命中后摘要路径失败，落 failed。
    await fixture.ctx.tools.execute(exec('bash'))
    expect(readFileSync(logPath, 'utf8')).toContain('"failed"')

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['minInlineTokens'], value: 999_999 }])
    await fixture.ctx.tools.execute(exec('bash'))
    // 同一条结果在新阈值下进不了候选：落 not-candidate（若阈值仍是装载期的常量，这里还会是 failed）。
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"not-candidate"')
  })

  it('写入三个角色的 route、阈值、推理档位与提示词后引用立刻变化（保存即生效的引用侧）', async () => {
    const fixture = await booted({})
    expect(fixture.config.routeProvider.get()).toBe('')
    expect(fixture.config.privacyProvider.get()).toBe('')
    expect(fixture.config.minInlineTokens.get()).toBe(1024)
    expect(fixture.config.maxSummarizeTokens.get()).toBe(12500)
    // 档位字段默认留空＝「不推理」，具体发哪个 id 在请求前按该 route 的档位表决定。
    expect(fixture.config.summaryReasoningEffort.get()).toBe('')
    expect(fixture.config.summaryPrompt.get()).toBe('')

    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [
      { op: 'set', path: ['routeProvider'], value: 'local' },
      { op: 'set', path: ['routeModel'], value: 'qwen' },
      { op: 'set', path: ['privacyProvider'], value: 'local-guard' },
      { op: 'set', path: ['privacyModel'], value: 'guard' },
      { op: 'set', path: ['minInlineTokens'], value: 256 },
      { op: 'set', path: ['maxSummarizeTokens'], value: 9000 },
      { op: 'set', path: ['summaryReasoningEffort'], value: 'medium' },
      { op: 'set', path: ['summaryPrompt'], value: '只看目标' },
    ])
    expect(fixture.config.routeProvider.get()).toBe('local')
    expect(fixture.config.routeModel.get()).toBe('qwen')
    expect(fixture.config.privacyProvider.get()).toBe('local-guard')
    expect(fixture.config.privacyModel.get()).toBe('guard')
    expect(fixture.config.minInlineTokens.get()).toBe(256)
    expect(fixture.config.maxSummarizeTokens.get()).toBe(9000)
    expect(fixture.config.summaryReasoningEffort.get()).toBe('medium')
    expect(fixture.config.summaryPrompt.get()).toBe('只看目标')
  })

  it('清掉摘要提示词的覆盖后回落到空串（= 用内置规则正文）', async () => {
    const fixture = await booted({})
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'set', path: ['summaryPrompt'], value: '只看目标' }])
    expect(fixture.config.summaryPrompt.get()).toBe('只看目标')
    await fixture.ctx.settings.mutate(PREFERENCE_NAMESPACE, [{ op: 'unset', path: ['summaryPrompt'] }])
    expect(fixture.config.summaryPrompt.get()).toBe('')
  })
})
