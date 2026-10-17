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
 * 票 17 的判据 1/2/3/5/6/7 接着同一张接缝：两族（`sedWindow` / `rawDump`）各自的开关、形态、回退入口与两条
 * 守卫。两族的输入都给 400 行——同时超过本族的应用期下限（60 行）与**通用链**的封顶触发线（300 行），于是
 * 族形态（`…[中段省略 N 行]…`）与通用链形态（`…[省略 N 行]`）在正文里分得开，判据 1 的交叉对照才有观察面。
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
import { RETRIEVAL_HINT, FakeSpill } from './support/spill.ts'

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

/**
 * 一份**不是 diff** 的长正文（320 行互不相同的纯文本）：命令串仍是 `git diff`，所以分派会命中这一族，而族
 * handler 在看懂正文之前就守卫放弃（`not-a-unified-diff`）。判据 10 的第 3、4 个去向（族放弃之后落通用链、
 * 落成哪条取值）要靠它构造——已发布的这一族**不会抛异常**，异常那一支只能在安全层的纯函数接缝上观察。
 */
const NOT_A_DIFF_BODY = Array.from({ length: 320 }, (_, index) => `line ${index}`).join('\n')

/** 同上，但末尾带一条上游位置说明：族放弃后通用链接手，说明保留、不再写本层入口（票 20）。 */
const NOT_A_DIFF_WITH_NOTICE = `${NOT_A_DIFF_BODY}\n\n(original result stored at: /tmp/entry.txt)`

/**
 * 票 17 的 `sed` 大窗口输入：请求打印 101 行的 `sed -n '1,101p'`，正文给 400 行。
 *
 * 400 行同时超过这一族的应用期下限（60 行）与**通用链**的封顶触发线（300 行），所以「走的是哪条路」在正文
 * 形态上直接看得出来：族给 `…[中段省略 N 行]…`，通用链给 `…[省略 N 行]`。
 */
const SED_WINDOW_ARGS = { command: "sed -n '1,101p' f" }
const SED_WINDOW_LINES = Array.from({ length: 400 }, (_, index) => `f line ${String(index + 1).padStart(3, '0')}`)
const SED_WINDOW_BODY = SED_WINDOW_LINES.join('\n')

/**
 * 票 17 的原始转储输入：400 行的大 `ls -la` 清单，中间夹两条命中「有意思的行」词表的行（第 101、251 行）。
 * 头段（1–15 行）与尾段（386–400 行）里不放命中行，于是「只从头尾之外挑」可以直接从输出看出来。
 */
const RAW_DUMP_ARGS = { command: 'ls -la /var/log' }
const RAW_DUMP_LINES = Array.from(
  { length: 400 },
  (_, index) => `-rw-r--r--  1 root root ${String(index).padStart(6, '0')} Jan  1 00:00 log-${String(index).padStart(3, '0')}.txt`,
)
RAW_DUMP_LINES[100] = '-rw-r--r--  1 root root   1024 Jan  1 00:00 error.log'
RAW_DUMP_LINES[250] = '-rw-r--r--  1 root root   2048 Jan  1 00:00 warn.log'
const RAW_DUMP_BODY = RAW_DUMP_LINES.join('\n')

/** 低于应用期尺寸下限（60 行）的小 `cat`：正文过得了尺寸下限（128 估算单位），但不该被这一族收窄。 */
const SMALL_CAT_ARGS = { command: 'cat small.txt' }
const SMALL_CAT_BODY = Array.from({ length: 50 }, (_, index) => `small.txt 第 ${index} 行：${'x'.repeat(30)}`).join('\n')

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

/** 一次端到端跑完的观察面：模型可见正文、`condense` 观测与整条 debug 记录。 */
interface RunResult {
  readonly text: string
  readonly condense: Record<string, unknown>
  readonly record: Record<string, unknown>
}

/**
 * 跑一次端到端：装一份配置、注册一个 `bash` 工具、执行一条命令，交回观察面。
 * @param config - 覆盖默认的插件配置。
 * @param body - 模型可见正文（下游决策的那一份）。
 * @param command - 调用参数里的命令串。
 * @param value - `exitCode` 与 `truncated` 的取值；字段省略即事实缺失。
 * @returns 正文、`condense` 观测与整条记录。
 */
async function run(
  config: Schemastery.TypeS<typeof Config>,
  body: string,
  command: string,
  value: { exitCode?: number, truncated?: boolean } = {},
): Promise<RunResult> {
  const { fixture, path } = await mounted(config)
  fixture.ctx.tools.register(commandTool('bash', body, value))
  const result = await fixture.ctx.tools.execute(exec('bash', undefined, { command }))
  const record = readRecords(path)[0]!
  return { text: textOf(result.content), condense: record.condense as Record<string, unknown>, record }
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
      // 命令串不落任何一族（票 17 起 `ls -la` 是 `rawDump` 族的，不能再拿它当「族没命中」的样本）。
      const result = await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'node build.js' }))
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

  it('纯变量赋值段也被跳过：`PAGER=less; git diff …` 照样被这一族接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY))
    const args = { command: 'PAGER=less; git diff HEAD~1' }
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

describe('票 20 · 非零退出码不再整族挡下', () => {
  it('成功时被这一族接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { exitCode: 0 }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff' })
  })

  it('非零退出码时同样被这一族接手', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { exitCode: 1 }))
    const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))).content)

    expect(text).toMatch(AGGREGATE_LINE)
    expect(observation(path)).toMatchObject({ family: 'compactDiff', rules: ['compactDiff'] })
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

  it('族守卫放弃后落通用链：记录里 family 在场、rules 记的是通用链的 id，这次不是失败', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', NOT_A_DIFF_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))
    const record = readRecords(path)[0]!

    // 正文确实被通用链改过（尾部封顶），而 `rules` 里没有族 id——`compactDiff` 被命中却守卫放弃了。
    expect(textOf(result.content)).not.toBe(NOT_A_DIFF_BODY)
    expect(record).toMatchObject({
      action: 'condensed',
      condense: { family: 'compactDiff', rules: ['tail-cap'] },
    })
  })

  it('族守卫放弃后落通用链：上游入口保留，不再追加本层入口（票 20）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', NOT_A_DIFF_WITH_NOTICE))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))
    const text = textOf(result.content)

    expect(text).not.toBe(NOT_A_DIFF_WITH_NOTICE)
    expect(text).toContain('…[省略')
    expect(text).toContain('(original result stored at: /tmp/entry.txt)')
    expect(text).not.toContain('精简版')
    expect(fixture.spill?.saves).toHaveLength(0)
    expect(readRecords(path)[0]).toMatchObject({
      action: 'condensed',
      condense: { rules: ['tail-cap'], family: 'compactDiff' },
    })
  })
})

/** 票 17 两族的端到端用例共用这两条输入：一个族一条，族 id 与参数各自独立。 */
const GLANCE_CASES = [
  { command: SED_WINDOW_ARGS.command, body: SED_WINDOW_BODY, family: 'sedWindow' },
  { command: RAW_DUMP_ARGS.command, body: RAW_DUMP_BODY, family: 'rawDump' },
] as const

describe('票 17 判据 1：两族开关各自独立（2 输入 × 2 开关）', () => {
  const COMBOS = [
    { condenseSedWindow: false, condenseRawDump: false },
    { condenseSedWindow: true, condenseRawDump: false },
    { condenseSedWindow: false, condenseRawDump: true },
    { condenseSedWindow: true, condenseRawDump: true },
  ] as const

  /** 四个组合都在「按命令语义精简」打开的前提下跑。 */
  const at = (combo: typeof COMBOS[number]): Schemastery.TypeS<typeof Config> =>
    ({ condenseByCommand: true, ...combo })

  it('大窗口 `sed` 输入：只随 condenseSedWindow 变，另一族开关的两态逐字相同', async () => {
    const seen: RunResult[] = []
    for (const combo of COMBOS) seen.push(await run(at(combo), SED_WINDOW_BODY, SED_WINDOW_ARGS.command))

    // 关 → 通用链：不带族 id，正文是通用链的省略形态。
    expect(seen[0]!.condense).not.toHaveProperty('family')
    expect(seen[0]!.text).toContain('…[省略 ')
    expect(seen[0]!.text).not.toContain('…[中段省略 ')

    // 开 → 这一族的 id 与形态，且确实更短。
    expect(seen[1]!.condense).toMatchObject({ family: 'sedWindow', rules: ['sedWindow'] })
    expect(seen[1]!.text).toContain('…[中段省略 360 行]…')
    expect(seen[1]!.text.length).toBeLessThan(seen[0]!.text.length)

    // 交叉态：`condenseRawDump` 关/开时正文与观测逐字相同。
    expect(seen[2]!.text).toBe(seen[0]!.text)
    expect(seen[2]!.condense).toEqual(seen[0]!.condense)
    expect(seen[3]!.text).toBe(seen[1]!.text)
    expect(seen[3]!.condense).toEqual(seen[1]!.condense)
  })

  it('大 `ls -la` 清单：只随 condenseRawDump 变，另一族开关的两态逐字相同', async () => {
    const seen: RunResult[] = []
    for (const combo of COMBOS) seen.push(await run(at(combo), RAW_DUMP_BODY, RAW_DUMP_ARGS.command))

    expect(seen[0]!.condense).not.toHaveProperty('family')
    expect(seen[0]!.text).toContain('…[省略 ')

    expect(seen[2]!.condense).toMatchObject({ family: 'rawDump', rules: ['rawDump'] })
    expect(seen[2]!.text).toContain('…[中段省略 370 行]…')
    expect(seen[2]!.text.length).toBeLessThan(seen[0]!.text.length)

    // 交叉态：`condenseSedWindow` 关/开时正文与观测逐字相同。
    expect(seen[1]!.text).toBe(seen[0]!.text)
    expect(seen[1]!.condense).toEqual(seen[0]!.condense)
    expect(seen[3]!.text).toBe(seen[2]!.text)
    expect(seen[3]!.condense).toEqual(seen[2]!.condense)
  })
})

describe('票 17 判据 2：大窗口 `sed` 被收窄；不是区间打印的 `sed` 不接这一族', () => {
  it('阳性：`sed -n \'1,101p\'` 命中，正文按头 20 / 尾 20 变短、省略标记报出丢了多少行', async () => {
    const { text, condense } = await run({ condenseByCommand: true }, SED_WINDOW_BODY, SED_WINDOW_ARGS.command)
    const expected = [
      ...SED_WINDOW_LINES.slice(0, 20),
      '…[中段省略 360 行]…',
      ...SED_WINDOW_LINES.slice(-20),
    ].join('\n')

    expect(text.startsWith(expected)).toBe(true)
    expect(condense).toMatchObject({ family: 'sedWindow', rules: ['sedWindow'] })
  })

  it('阴性：替换 / `-i` 就地编辑 / 范围只写在替换文本里 / 脚本在文件里的 `-f`——正文 ≥60 行也不落这一族', async () => {
    const commands = [
      "sed 's/line/LINE/' bigf",
      "sed -i 's/line/LINE/' bigf",
      "sed -n 's/x/1,200p/p' bigf",
      // 替换文本里的 `;1,200p` 不是段首地址：走查器按定界符跳过 `s` 的两段参数（票 17 收口）。
      "sed -n 's/x/;1,200p/p' bigf",
      // GNU sed 把 `p` 后面的 `# 1,200p` 当注释（输出 100 行）：命令的自由文本不是地址（票 17 收口 2）。
      "sed -n '1,100p # 1,200p' bigf",
      // `-f` 的操作数是脚本**文件名**（内容是替换也一样）：命令行上没有脚本可看（票 17 收口 3）。
      "sed -n -f '1,200p' bigf",
    ]
    for (const command of commands) {
      const { text, condense } = await run({ condenseByCommand: true }, SED_WINDOW_BODY, command)
      expect(condense).not.toHaveProperty('family')
      expect(text).not.toContain('…[中段省略 ')
      // 阴性那次的输入真跑出了 400 行（≥60），所以它是被「不是窗口打印」挡下的，不是被应用期守卫挡下的；
      // 通用链照常收窄，这条对照因此不是空的。
      expect(text).toContain('…[省略 ')
    }
  })

  it('请求 101 行、正文却不足 60 行：命中这一族但守卫放弃，正文逐字交回（两个阈值不是一个量）', async () => {
    const shortBody = SED_WINDOW_LINES.slice(0, 50).join('\n')
    const { text, condense } = await run({ condenseByCommand: true }, shortBody, SED_WINDOW_ARGS.command)

    expect(condense).toMatchObject({ family: 'sedWindow', rules: [] })
    expect(text).toBe(shortBody)
  })
})

describe('票 17 判据 3：原始转储按 glance 形态收窄；族名只作参数不算', () => {
  it('阳性：大 `ls -la` 清单命中、变短，有意思的行以「序号: 原行」插在头段之后', async () => {
    const { text, condense } = await run({ condenseByCommand: true }, RAW_DUMP_BODY, RAW_DUMP_ARGS.command)
    const expected = [
      ...RAW_DUMP_LINES.slice(0, 15),
      `101: ${RAW_DUMP_LINES[100]}`,
      `251: ${RAW_DUMP_LINES[250]}`,
      '…[中段省略 370 行]…',
      ...RAW_DUMP_LINES.slice(-15),
    ].join('\n')

    expect(text.startsWith(expected)).toBe(true)
    expect(condense).toMatchObject({ family: 'rawDump', rules: ['rawDump'] })
  })

  it('阴性：`grep cat f` 不落这一族；`git diff -- cat` 由更靠前的 `compactDiff` 接手、正文落通用链', async () => {
    const grepped = await run({ condenseByCommand: true }, RAW_DUMP_BODY, 'grep cat f')
    expect(grepped.condense).not.toHaveProperty('family')

    const git = await run({ condenseByCommand: true }, RAW_DUMP_BODY, 'git diff -- cat')
    expect(git.condense.family).toBe('compactDiff')
    expect(git.text).not.toContain('…[中段省略 ')
    expect(git.text).toContain('…[省略 ')
  })

  it('低于 60 行的小 `cat` 不被收窄：命中这一族、守卫放弃，正文逐字交回', async () => {
    const { text, condense } = await run({ condenseByCommand: true }, SMALL_CAT_BODY, SMALL_CAT_ARGS.command)
    expect(text).toBe(SMALL_CAT_BODY)
    expect(condense).toMatchObject({ family: 'rawDump', rules: [] })
  })
})

describe('票 17 判据 5：两族的替换都先把完整正文写进回退入口', () => {
  it('两族各跑一次：spill 后端收到替换前的完整正文，模型可见正文带着入口说明', async () => {
    for (const one of GLANCE_CASES) {
      const { fixture } = await mounted({ condenseByCommand: true })
      fixture.ctx.tools.register(commandTool('bash', one.body))
      const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, { command: one.command }))).content)

      // 「按入口能读回原文」：入口指向的那次写入就是替换前的完整正文。
      expect(fixture.spill?.saves.map(save => save.content)).toEqual([one.body])
      const ref = fixture.spill!.refs[0]!
      expect(text).toContain('结果的精简版')
      expect(text).toContain(ref.locator)
      expect(text).toContain(RETRIEVAL_HINT)
    }
  })

  it('入口写不成（没有 spill 后端）时两族都交回原文、不留入口', async () => {
    for (const one of GLANCE_CASES) {
      const { fixture, path } = await mounted({ condenseByCommand: true }, null)
      fixture.ctx.tools.register(commandTool('bash', one.body))
      const text = textOf((await fixture.ctx.tools.execute(exec('bash', undefined, { command: one.command }))).content)

      expect(text).toBe(one.body)
      expect(readRecords(path)[0]).toMatchObject({
        action: 'unmodified',
        reason: 'condense-abstained',
        condense: { family: one.family },
      })
    }
  })
})

describe('票 20 · 非零退出码不再整族挡下，内容守卫照常判断', () => {
  it('退出码 1 时两族照常接；合法 diff + `[exit code: 1]` 被 compactDiff 收窄且标记保留', async () => {
    for (const one of GLANCE_CASES) {
      const ok = await run({ condenseByCommand: true }, one.body, one.command, { exitCode: 0 })
      expect(ok.condense).toMatchObject({ family: one.family })

      const failed = await run({ condenseByCommand: true }, one.body, one.command, { exitCode: 1 })
      expect(failed.condense).toMatchObject({ family: one.family })
      expect(failed.text).toContain('…[中段省略 ')
    }

    // `git diff --exit-code` 的形态：合法 diff + 尾部退出标记；标记不能阻止解析，也不能被吞掉。
    const diff = await run(
      { condenseByCommand: true },
      `${GIT_DIFF_BODY}\n[exit code: 1]`,
      GIT_DIFF_ARGS.command,
      { exitCode: 1 },
    )
    expect(diff.condense).toMatchObject({ family: 'compactDiff', rules: ['compactDiff'] })
    expect(diff.text).toMatch(AGGREGATE_LINE)
    expect(diff.text).toContain('[exit code: 1]')
  })

  it('失败的正文不是 diff 时由 handler 放弃、落通用链；错误正文不被退出码整族跳过', async () => {
    const failed = await run(
      { condenseByCommand: true },
      `${NOT_A_DIFF_BODY}\n[exit code: 1]`,
      GIT_DIFF_ARGS.command,
      { exitCode: 1 },
    )
    expect(failed.condense).toMatchObject({ family: 'compactDiff', rules: ['tail-cap'] })
    expect(failed.text).toContain('…[省略')
    expect(failed.text).toContain('[exit code: 1]')
  })
})

describe('票 20 · 上游入口与截断按族', () => {
  const notice = '\n\n(original result stored at: /tmp/entry.txt)'

  it('通用链在上游入口存在时继续收窄，说明保留、不写本层入口', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(commandTool('bash', NOT_A_DIFF_WITH_NOTICE))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))
    const text = textOf(result.content)

    expect(text).toContain('…[省略')
    expect(text).toContain(notice.trim())
    expect(text).not.toContain('精简版')
    expect(fixture.spill?.saves).toHaveLength(0)
    expect(readRecords(path)[0]).toMatchObject({ action: 'condensed', condense: { rules: ['tail-cap'] } })
  })

  it('没有 spill 后端时，上游入口本身就够：替换照做、不记放弃', async () => {
    const { fixture, path } = await mounted({}, null)
    fixture.ctx.tools.register(commandTool('bash', NOT_A_DIFF_WITH_NOTICE))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))
    const text = textOf(result.content)

    expect(text).toContain('…[省略')
    expect(text).toContain(notice.trim())
    expect(readRecords(path)[0]).toMatchObject({ action: 'condensed', condense: { rules: ['tail-cap'] } })
  })

  it('命令族也不再追加第二条入口：rawDump 命中带上游说明的正文', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', `${RAW_DUMP_BODY}${notice}`))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, RAW_DUMP_ARGS))
    const text = textOf(result.content)

    expect(text).toContain('…[中段省略 ')
    expect(text).toContain(notice.trim())
    expect(text).not.toContain('精简版')
    expect(fixture.spill?.saves).toHaveLength(0)
    expect(readRecords(path)[0]).toMatchObject({
      action: 'condensed',
      condense: { family: 'rawDump', rules: ['rawDump'] },
    })
  })

  it('截断只挡 compactDiff；rawDump 照常接手，带路径的截断说明当上游入口', async () => {
    const marker = '\n[output truncated; full output: /tmp/full.txt]'
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', `${RAW_DUMP_BODY}${marker}`, { truncated: true }))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, RAW_DUMP_ARGS))
    const text = textOf(result.content)

    expect(text).toContain('…[中段省略 ')
    expect(text).toContain(marker.trim())
    expect(text).not.toContain('精简版')
    expect(fixture.spill?.saves).toHaveLength(0)
    expect(readRecords(path)[0]).toMatchObject({ action: 'condensed', condense: { family: 'rawDump' } })
  })

  it('截断说明的路径是 `(unavailable)` 时不算上游入口：照常写本层入口', async () => {
    const marker = '\n[output truncated; full output: (unavailable)]'
    const { fixture } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', `${RAW_DUMP_BODY}${marker}`, { truncated: true }))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, RAW_DUMP_ARGS))
    const text = textOf(result.content)

    expect(text).toContain('…[中段省略 ')
    expect(text).toContain(marker.trim())
    expect(text).toContain('精简版')
    expect(fixture.spill?.saves).toHaveLength(1)
  })

  it('截断的 diff 不让 compactDiff 接族，落通用链', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(commandTool('bash', GIT_DIFF_BODY, { truncated: true }))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, GIT_DIFF_ARGS))

    expect(textOf(result.content)).toContain('…[省略')
    expect(readRecords(path)[0]).toMatchObject({ action: 'condensed', condense: { rules: ['tail-cap'] } })
    expect(readRecords(path)[0]!.condense).not.toHaveProperty('family')
  })
})

describe('票 17 判据 7：两族在诊断记录里各自的族 id 可分辨', () => {
  it('两次结果分别记 `sedWindow` 与 `rawDump`，`rules` 也是各自的族 id', async () => {
    const windowed = await run({ condenseByCommand: true }, SED_WINDOW_BODY, SED_WINDOW_ARGS.command)
    const dumped = await run({ condenseByCommand: true }, RAW_DUMP_BODY, RAW_DUMP_ARGS.command)

    expect([windowed.condense.family, dumped.condense.family]).toEqual(['sedWindow', 'rawDump'])
    expect([windowed.condense.rules, dumped.condense.rules]).toEqual([['sedWindow'], ['rawDump']])
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
    await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'node build.js' }))

    const observed = observation(path)
    expect(observed).not.toHaveProperty('family')
    // `textTool` 的 `value` 是内容数组：没有可读的 `exitCode`，于是**这个事实不在 map 里**（判据 2）；
    // `truncated` 与票 15 的诊断字段同源、形状读不到就当没有（`false`），所以它在。
    expect(observed.facts).toEqual({
      command: 'node build.js',
      truncated: false,
      format: 'text',
      bytes: Buffer.byteLength(GIT_DIFF_BODY, 'utf8'),
      lines: GIT_DIFF_BODY.split('\n').length,
      estimated: Math.ceil(GIT_DIFF_BODY.length / 4) + 4,
    })
  })
})
