/**
 * 票 16 判据 1/2/5/6/7/9/10/11/13：分派层接进 `tools/post-execute` 流水线。
 *
 * 观察面全是**端到端**的：`ctx.tools.execute` 交回给模型的正文、假 spill 后端收到的写入、debug JSONL 的
 * 「结果取值 + `condense` 观测」。夹具**不传**精简参数时走部署默认值（总开关开、下限 128 估算单位、净收益阈值
 * 24 估算单位、封顶头 50 / 尾 200 / 触发 300 行），「按命令语义精简」则默认**关**——所以每一条阳性对照都要
 * 显式把它打开，这正是判据 1 要钉的东西。
 *
 * 断言的正文都是**真实 `git diff` 的形态**（`@@` 头带尾部符号上下文、逐行标记列），不是自造的假 diff；族
 * 收窄后的聚合量形态（`  +N -M`）与通用链的收窄形态（`…[省略 N 行]`）在正文里互不相同，所以「走的是哪条
 * 路」可以直接从模型可见的正文看出来。
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { exec, mount, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { AGGREGATE_LINE, GIT_DIFF_ARGS, GIT_DIFF_BODY } from './support/gitdiff.ts'
import { FakeSpill } from './support/spill.ts'

/**
 * 一份合法但**省幅过不了净收益阈值**（24 估算单位）的 diff：只改一行，其余 41 行是 hunk 内被完整保留的上下文。
 *
 * `@@ -1,42 +1,42 @@` 的行数与正文严格一致（1 删 + 1 增 + 41 上下文 = 每侧 42 行），否则这一族的守卫会正确地放弃这次
 * 收窄（hunk 未耗尽）。族能省下的只有那几行文件头（约 60 字符），而闸门要把回退入口的预留上界
 * （`ENTRY_RESERVE = 256` 字符）算进被比较的那一侧——所以这份正文会落在 `condense-not-shorter` 上，正文逐字
 * 交回下游。
 */
const TINY_SAVING_DIFF = [
  'diff --git a/s.ts b/s.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/s.ts',
  '+++ b/s.ts',
  '@@ -1,42 +1,42 @@',
  '-const answer = 41',
  '+const answer = 42',
  ...Array.from({ length: 41 }, (_, index) => ` const keep${String(index).padStart(2, '0')} = ${index} // 这一行会被完整保留`),
].join('\n')

const open: HostFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-dispatch-pipeline-'))
  roots.push(root)
  return root
}

/**
 * 装一份被测插件并登记收场：debug 默认开启（本层的观测面就是它写出的那条记录）。
 * @param config - 覆盖默认的插件配置。
 * @param spill - 假 spill 后端；显式传 `null` 表示没有后端（有损替换的回退入口就此写不成）。
 * @returns 夹具与 debug 日志路径。
 */
async function mounted(
  config: Schemastery.TypeS<typeof Config> = {},
  spill: FakeSpill | null = new FakeSpill(),
): Promise<{ fixture: HostFixture, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const fixture = await mount({ debug: true, debugPath: path, ...config }, undefined, undefined, spill)
  open.push(fixture)
  return { fixture, path }
}

/** 读回一整份 JSONL，逐行解析。 */
function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 最后一条记录里的 `condense` 观测（每条用例都只发一次工具调用）。 */
function observation(path: string): Record<string, unknown> {
  return readRecords(path)[0]!.condense as Record<string, unknown>
}

/**
 * 一个像真实 shell 那样报告退出码与截断的工具：`value` 是 `{ exitCode, stdout, stderr }`，正文由 `render` 投影。
 *
 * `exitCode` 省略时**不放这个键**：判据 2 要的是「缺失的事实不在 map 里」，而「缺失」与「值为 0」在分派里
 * 必须分得开（`textTool` 那种 `value` 是内容数组的夹具就是完全缺这个事实的样子）。
 * @param name - 工具名。
 * @param body - 模型可见的正文。
 * @param value - `exitCode` 与 `truncated` 的取值；字段省略即事实缺失。
 * @returns 注册用的工具定义。
 */
function commandTool(
  name: string,
  body: string,
  value: { exitCode?: number, truncated?: boolean } = {},
): ToolDefinition {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (): [{ type: 'text', text: string }] => [{ type: 'text', text: body }],
    },
    async execute() {
      return {
        ...value.exitCode === undefined ? {} : { exitCode: value.exitCode },
        stdout: { truncated: value.truncated ?? false },
        stderr: { truncated: false },
      }
    },
  })
}

describe('票 16 判据 1：默认关，关着时命令族那一步不发生', () => {
  it('默认部署下同一份 diff 只走通用链：没有族 id，正文是尾部封顶的形态', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toContain('…[省略')
    expect(text).not.toMatch(AGGREGATE_LINE)
    expect(observation(path)).not.toHaveProperty('family')
    expect(observation(path)).toMatchObject({ rules: ['tail-cap'] })
  })

  it('打开后同一份输入被命令族收窄（阳性对照），且比通用链更短', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(text).not.toContain('…[省略')
    expect(observation(path)).toMatchObject({ family: 'compactDiff', rules: ['compactDiff'] })
    expect(text.length).toBeLessThan(GIT_DIFF_BODY.length)
  })

  it('族没命中的调用，开关两态下的通用链取舍一字不差', async () => {
    const bodies: string[] = []
    for (const config of [{}, { condenseByCommand: true }]) {
      const { fixture, path } = await mounted(config)
      fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
      const result = await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'ls -la' }))
      bodies.push(textOf(result.content))
      expect(observation(path)).not.toHaveProperty('family')
      expect(observation(path)).toMatchObject({ rules: ['tail-cap'] })
    }
    expect(bodies[1]).toBe(bodies[0])
  })
})

describe('票 16 判据 9：族开关与三个封顶参数', () => {
  it('族开关关着时，即使总开关打开也按通用链走', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true, condenseGitDiff: false })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).not.toMatch(AGGREGATE_LINE)
    expect(observation(path)).not.toHaveProperty('family')
  })

  it('族开关打开后接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true, condenseGitDiff: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff' })
  })

  it('配置文件里改掉整体行数上限即按其取值生效', async () => {
    const lengths: number[] = []
    for (const maxLines of [200, 60]) {
      const { fixture } = await mounted({ condenseByCommand: true, condenseGitDiffMaxLines: maxLines })
      fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
      lengths.push(textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content).length)
    }
    expect(lengths[1]).toBeLessThan(lengths[0]!)
  })
})

describe('票 16 判据 5：脚手架链按首个实质命令命中', () => {
  it('cd + echo 标题 + 真命令 + 管道 也被这一族接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const args = { command: 'cd /repo && echo "=== 标题 ===" && git diff HEAD~1 | head -40' }
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, args))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff' })
  })
})

describe('票 16 判据 13：命令族只在 bash 结果上求值', () => {
  it('同一份内容与同一条 unix 命令串，只换工具名：bash 命中、pwsh 不命中', async () => {
    const seen: Array<Record<string, unknown>> = []
    for (const name of ['bash', 'pwsh'] as const) {
      const { fixture, path } = await mounted({ condenseByCommand: true })
      fixture.ctx.tools.register(commandTool(name, GIT_DIFF_BODY))
      const result = await fixture.ctx.tools.execute(exec(name, undefined, GIT_DIFF_ARGS))
      seen.push({ text: textOf(result.content), condense: observation(path) })
    }

    expect(seen[0]!.condense).toMatchObject({ family: 'compactDiff' })
    expect(seen[1]!.condense).not.toHaveProperty('family')
    expect(seen[0]!.text).toMatch(AGGREGATE_LINE)
    expect(seen[1]!.text).not.toMatch(AGGREGATE_LINE)
  })
})

describe('票 16 判据 6：非零退出码只放弃命令族那一步', () => {
  it('成功时被这一族接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { exitCode: 0 }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff' })
  })

  it('非零退出码时不接族，但通用链照常收窄（阳性对照二）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { exitCode: 1 }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).not.toMatch(AGGREGATE_LINE)
    expect(text).toContain('…[省略')
    expect(observation(path)).not.toHaveProperty('family')
    expect(observation(path)).toMatchObject({ rules: ['tail-cap'] })
  })

  it('缺失退出码事实时不由它挡下（缺失不是「失败」）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(textTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff' })
  })
})

describe('票 16 判据 7：输入已被工具自身截断时不输出跨文件聚合量', () => {
  it('截断为真时不接族、正文里没有任何聚合量，通用链照常收窄', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { truncated: true }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).not.toMatch(AGGREGATE_LINE)
    expect(text).toContain('…[省略')
    expect(observation(path)).not.toHaveProperty('family')
  })

  it('阳性对照：同一份完整输入照常输出增减量', async () => {
    const { fixture } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { truncated: false }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
  })
})

describe('票 16 判据 10：四个去向逐个从外部观察', () => {
  it('过不了净收益闸门时交回下游正文，取值记 condense-not-shorter', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', TINY_SAVING_DIFF))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))

    expect(textOf(result.content)).toBe(TINY_SAVING_DIFF)
    expect(readRecords(path)[0]).toMatchObject({
      action: 'unmodified',
      reason: 'condense-not-shorter',
      condense: { family: 'compactDiff', rules: ['compactDiff'] },
    })
  })

  it('有损但回退入口写不成时交回原文，取值记 condense-abstained，且不留下入口', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true }, null)
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toBe(GIT_DIFF_BODY)
    expect(text).not.toContain('精简版')
    expect(readRecords(path)[0]).toMatchObject({
      action: 'unmodified',
      reason: 'condense-abstained',
      condense: { family: 'compactDiff' },
    })
  })

  it('干跑只预报不替换：正文仍是下游正文，但取值记「本应替换」', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true, dryRun: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))

    expect(textOf(result.content)).toBe(GIT_DIFF_BODY)
    expect(readRecords(path)[0]).toMatchObject({
      action: 'condensed',
      condense: { family: 'compactDiff', rules: ['compactDiff'] },
    })
  })
})

describe('票 16 判据 11：诊断里记下命中的族与两条事实', () => {
  it('记录里 family 是族 id，facts 是扁平 map（含 command / exitCode / truncated / format / bytes / lines / estimated）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { exitCode: 0, truncated: false }))
    await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))

    expect(observation(path)).toMatchObject({
      family: 'compactDiff',
      facts: {
        command: 'git diff HEAD~1',
        exitCode: 0,
        truncated: false,
        format: 'text',
        bytes: Buffer.byteLength(GIT_DIFF_BODY, 'utf8'),
        lines: GIT_DIFF_BODY.split('\n').length,
        estimated: Math.ceil(GIT_DIFF_BODY.length / 4) + 4,
      },
    })
  })

  it('族没接手时 facts 照写（观察面不只在命中时才有）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(textTool('bash', GIT_DIFF_BODY))
    await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'ls -la' }))

    const observed = observation(path)
    expect(observed).not.toHaveProperty('family')
    // `textTool` 的 `value` 是内容数组：没有可读的 `exitCode`，于是**这个事实不在 map 里**（判据 2）；
    // `truncated` 与票 15 的诊断字段同源、形状读不到就当没有（`false`），所以它在。
    expect(observed.facts).toEqual({
      command: 'ls -la',
      truncated: false,
      format: 'text',
      bytes: Buffer.byteLength(GIT_DIFF_BODY, 'utf8'),
      lines: GIT_DIFF_BODY.split('\n').length,
      estimated: Math.ceil(GIT_DIFF_BODY.length / 4) + 4,
    })
  })
})
